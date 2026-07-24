import { supabaseAdmin } from '../config/supabase';
import {
  businessDaysAgoStr,
  type ClosingReport,
  type ClosingDispatchResult,
  type NotificationChannel,
} from '../shared';
import { getAppSettings } from './settings.service';
import { notify } from './push.service';
import { getMessageProvider, getRetryPolicy, type OutboundChannel } from './messaging';
import {
  generateClosingReports,
  formatBranchMessage,
  formatProductionMessage,
  formatCompanyMessage,
} from './closing-report.service';

const REPORTS = 'daily_closing_reports';
const RECIPIENTS = 'notification_recipients';
const LOGS = 'notification_logs';

interface DispatchOptions {
  /** Defaults to the business day that just ended. */
  businessDate?: string;
  /** 'scheduler' respects the closingNotificationsEnabled toggle; 'manual' always runs. */
  trigger: 'scheduler' | 'manual';
  /** Re-send even to recipients already marked sent for this date. */
  resend?: boolean;
}

interface RecipientRow {
  id: string;
  branch_id: string | null;
  department: string | null;
  recipient_name: string;
  mobile_number: string;
  channel: NotificationChannel;
}

/** A report that has been persisted, paired with its rendered message body. */
interface Deliverable {
  reportId: string;
  branchId: string | null;
  scope: 'branch' | 'production' | 'company';
  body: string;
}

/**
 * Generate the day's closing reports, persist them, and send each recipient ONLY
 * the summary they are entitled to.
 *
 * Delivery is best-effort per recipient: one bad number never stops the rest of
 * the run. Every attempt lands in notification_logs, and any failure (generation
 * or delivery) escalates to the Admin via an in-app notification plus an
 * auto-opened Support Center ticket.
 */
export async function dispatchClosingSummaries(opts: DispatchOptions): Promise<ClosingDispatchResult> {
  const businessDate = opts.businessDate ?? businessDaysAgoStr(1);
  const settings = await getAppSettings();

  // The scheduler respects the admin toggle; a manual run always proceeds (same
  // rule runDailyClosing applies to autoCloseBusiness).
  if (opts.trigger === 'scheduler' && !settings.closingNotificationsEnabled) {
    return { businessDate, reportsGenerated: 0, messagesSent: 0, messagesFailed: 0, skipped: 'closingNotificationsEnabled is off' };
  }

  const companyName = settings.companyName || 'Mountain Bakes';
  const symbol = settings.currencySymbol || 'Rs.';

  // ── 1. Generate + persist the reports ────────────────────────────────────
  let deliverables: Deliverable[];
  try {
    const { branches, production, company } = await generateClosingReports(businessDate);

    const desired = [
      ...branches.map((r) => ({
        scope: 'branch' as const, branchId: r.branchId, department: null as string | null,
        json: r as ClosingReport, body: formatBranchMessage(r, companyName, symbol),
      })),
      {
        scope: 'production' as const, branchId: null as string | null, department: 'production' as string | null,
        json: production as ClosingReport, body: formatProductionMessage(production, companyName, symbol),
      },
      {
        scope: 'company' as const, branchId: null as string | null, department: 'admin' as string | null,
        json: company as ClosingReport, body: formatCompanyMessage(company, companyName, symbol),
      },
    ];

    // Re-running a date must UPDATE each report in place rather than
    // delete-and-reinsert. The row id is what notification_logs points at and what
    // the "already sent" guard keys on — minting fresh ids on every run would
    // orphan the logs (report_id is ON DELETE SET NULL) and re-send to everyone.
    const { data: existingRows, error: exErr } = await supabaseAdmin
      .from(REPORTS)
      .select('id, scope, branch_id')
      .eq('business_date', businessDate);
    if (exErr) throw exErr;

    const keyOf = (scope: string, branchId: string | null) => `${scope}:${branchId ?? ''}`;
    const existing = new Map(
      ((existingRows ?? []) as { id: string; scope: string; branch_id: string | null }[])
        .map((r) => [keyOf(r.scope, r.branch_id), r.id]),
    );

    deliverables = [];
    const keptIds = new Set<string>();
    for (const d of desired) {
      const existingId = existing.get(keyOf(d.scope, d.branchId));
      let reportId: string;
      if (existingId) {
        const { error } = await supabaseAdmin
          .from(REPORTS)
          .update({ report_json: d.json, generated_at: new Date().toISOString() })
          .eq('id', existingId);
        if (error) throw error;
        reportId = existingId;
      } else {
        const { data, error } = await supabaseAdmin
          .from(REPORTS)
          .insert({
            business_date: businessDate, scope: d.scope, branch_id: d.branchId,
            department: d.department, report_json: d.json,
          })
          .select('id')
          .single();
        if (error) throw error;
        reportId = (data as { id: string }).id;
      }
      keptIds.add(reportId);
      deliverables.push({ reportId, branchId: d.branchId, scope: d.scope, body: d.body });
    }

    // Drop reports that no longer apply (e.g. a branch deactivated since last run).
    const stale = ((existingRows ?? []) as { id: string }[]).map((r) => r.id).filter((id) => !keptIds.has(id));
    if (stale.length > 0) {
      const { error } = await supabaseAdmin.from(REPORTS).delete().in('id', stale);
      if (error) throw error;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await escalate(businessDate, 'Closing summary generation failed', detail, 0);
    return { businessDate, reportsGenerated: 0, messagesSent: 0, messagesFailed: 0, skipped: `generation failed: ${detail}` };
  }

  // ── 2. Fan out to recipients ─────────────────────────────────────────────
  const { data: recipientRows, error: recErr } = await supabaseAdmin
    .from(RECIPIENTS)
    .select('id, branch_id, department, recipient_name, mobile_number, channel')
    .eq('active', true);
  if (recErr) throw recErr;
  const recipients = (recipientRows ?? []) as RecipientRow[];

  // Already-delivered pairs, so a re-run does not spam anyone.
  const alreadySent = new Set<string>();
  if (!opts.resend) {
    const { data: sentLogs } = await supabaseAdmin
      .from(LOGS)
      .select('recipient_id, report_id, channel')
      .eq('business_date', businessDate)
      .eq('status', 'sent');
    for (const l of (sentLogs ?? []) as { recipient_id: string; report_id: string; channel: string }[]) {
      alreadySent.add(`${l.recipient_id}:${l.report_id}:${l.channel}`);
    }
  }

  const provider = getMessageProvider();
  const policy = getRetryPolicy();
  let messagesSent = 0;
  let messagesFailed = 0;
  const failures: string[] = [];

  for (const recipient of recipients) {
    // Which reports is this recipient entitled to? A branch recipient gets only
    // its own branch; production gets the production report; admin gets
    // everything (company + production + every branch).
    const targets = deliverables.filter((d) => {
      if (recipient.branch_id) return d.scope === 'branch' && d.branchId === recipient.branch_id;
      if (recipient.department === 'production') return d.scope === 'production';
      if (recipient.department === 'admin') return true;
      return false;
    });

    const channels: OutboundChannel[] =
      recipient.channel === 'both' ? ['whatsapp', 'sms'] : [recipient.channel as OutboundChannel];

    for (const target of targets) {
      for (const channel of channels) {
        if (alreadySent.has(`${recipient.id}:${target.reportId}:${channel}`)) continue;

        const result = await sendWithRetry(
          () => provider.send({ to: recipient.mobile_number, body: target.body, channel }),
          policy.maxAttempts,
          policy.baseDelayMs,
        );

        await supabaseAdmin.from(LOGS).insert({
          report_id: target.reportId,
          recipient_id: recipient.id,
          business_date: businessDate,
          channel,
          status: result.ok ? 'sent' : 'failed',
          provider: provider.name,
          provider_message_id: result.messageId ?? null,
          error_message: result.error ?? null,
          retry_count: result.attempts - 1,
          sent_at: result.ok ? new Date().toISOString() : null,
        });

        if (result.ok) {
          messagesSent += 1;
        } else {
          messagesFailed += 1;
          failures.push(`${recipient.recipient_name} (${recipient.mobile_number}, ${channel}): ${result.error}`);
        }
      }
    }
  }

  if (messagesFailed > 0) {
    await escalate(
      businessDate,
      `${messagesFailed} closing summary message(s) failed to send`,
      failures.join('\n'),
      policy.maxAttempts,
    );
  }

  console.log(`[closing-notify] ${businessDate}: ${deliverables.length} reports, ${messagesSent} sent, ${messagesFailed} failed (provider=${provider.name}).`);
  return { businessDate, reportsGenerated: deliverables.length, messagesSent, messagesFailed };
}

/** Retry a send per the configured policy; never throws. */
async function sendWithRetry(
  op: () => Promise<{ ok: boolean; messageId?: string; error?: string }>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<{ ok: boolean; messageId?: string; error?: string; attempts: number }> {
  let last: { ok: boolean; messageId?: string; error?: string } = { ok: false, error: 'not attempted' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      last = await op();
    } catch (err) {
      last = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (last.ok) return { ...last, attempts: attempt };
    if (attempt < maxAttempts && baseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
  return { ...last, attempts: maxAttempts };
}

/**
 * Surface an unattended failure to the Admin: an in-app notification plus an
 * auto-opened Support Center ticket.
 *
 * The ticket uses reference_type 'system' — it has no MB-/EXP-/STK- record behind
 * it and no human raiser, so referenceSnapshot stays null and the detail lives in
 * the message. Escalation is best-effort: it must never throw back into the
 * closing job and turn a delivery problem into a failed close.
 */
async function escalate(businessDate: string, title: string, detail: string, retryCount: number): Promise<void> {
  const message = [
    `Business date: ${businessDate}`,
    `Retries attempted: ${retryCount}`,
    `Time: ${new Date().toISOString()}`,
    '',
    detail,
  ].join('\n');

  try {
    const { data: ticket, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        reference_type: 'system',
        reference_id: `CLOSING-${businessDate}`,
        reference_snapshot: null,
        message: `${title}\n\n${message}`,
        status: 'open',
        raised_by: null,
        raised_by_name: 'System',
        raised_by_role: 'system',
      })
      .select('id, ticket_number')
      .single();
    if (error) throw error;

    await notify({
      type: 'support_query',
      title: `Closing summary issue — ${ticket.ticket_number}`,
      message: `${title} (${businessDate})`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: ticket.id,
    });
  } catch (err) {
    // Last resort — the run itself must still complete and report its result.
    console.error('[closing-notify] escalation failed:', err instanceof Error ? err.message : err);
  }
}
