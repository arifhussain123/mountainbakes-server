import { templateSafe } from '../whatsapp/meta.provider';
import { whatsappConfig } from '../whatsapp/config';
import { day, qty, rs, waId, type IssuedLink } from './common';

/**
 * What a supplier (or a Production phone) is told at each step, in both forms
 * the outbox may need: free text for inside the 24-hour window, and the
 * approved template's variables for outside it. The worker chooses at send
 * time (services/whatsapp/outbox.ts).
 *
 * The two templates that must be approved in WhatsApp Manager before live use
 * (WHATSAPP-PURCHASING.md has the exact wording to submit):
 *
 *   mb_purchase_demand  (Utility) 6 variables:
 *     supplier name, demand id, priority, required date, items, link
 *   mb_purchase_update  (Utility) 2 variables:
 *     demand id, the update (link included when there is one)
 *
 * A token-bearing link is stored masked: `maskedText` / `maskedParams` replace
 * the outbox's copy once the message is accepted, and `display` (always
 * masked) is what the conversation view shows.
 */

export interface QueuedMessage {
  toWaId: string;
  text: string | null;
  template: string | null;
  language: string;
  params: string[];
  maskedText: string | null;
  maskedParams: string[] | null;
  display: string;
  dedupeKey: string;
  supplierId: string | null;
  demandId: string | null;
}

interface DemandLike {
  id: string;
  demand_no: string;
  supplier_id: string;
  supplier_name: string;
  supplier_whatsapp: string;
  priority: string;
  required_date: string;
  items?: Array<{ item_name: string; requested_qty: number; unit: string }>;
}

function mask(s: string, link: IssuedLink | null): string {
  return link ? s.split(link.url).join(link.maskedUrl) : s;
}

function build(
  d: DemandLike,
  dedupeKey: string,
  text: string,
  template: string,
  params: string[],
  link: IssuedLink | null,
): QueuedMessage {
  const cfg = whatsappConfig();
  const safe = params.map(templateSafe);
  return {
    toWaId: waId(d.supplier_whatsapp),
    text,
    template,
    language: cfg.templateLanguage,
    params: safe,
    maskedText: link ? mask(text, link) : null,
    maskedParams: link ? safe.map((p) => mask(p, link)) : null,
    display: mask(text, link),
    dedupeKey,
    supplierId: d.supplier_id,
    demandId: d.id,
  };
}

export function itemSummary(items: DemandLike['items'] = [], max = 600): string {
  const s = items.map((i) => `${i.item_name} ${qty(i.requested_qty)} ${i.unit}`).join(', ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Room for the update's text in {{2}}, which the link must also fit into. */
const UPDATE_PARAM_MAX = 900;

/** Update template: "Mountain Bakes — purchase {{1}}: {{2}}". */
function update(d: DemandLike, dedupeKey: string, body: string, link: IssuedLink | null): QueuedMessage {
  // A long reason is cut, never the link after it: templateSafe truncates the
  // whole variable, and outside the 24-hour window the template is all that goes.
  const room = UPDATE_PARAM_MAX - (link ? link.url.length + 1 : 0);
  const short = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  const withLink = link ? `${short} ${link.url}` : short;
  const text = `Mountain Bakes — purchase ${d.demand_no}\n\n${link ? `${body}\n${link.url}` : body}`;
  return build(d, dedupeKey, text, whatsappConfig().templateUpdate, [d.demand_no, withLink], link);
}

export function demandSentMessage(d: DemandLike, link: IssuedLink): QueuedMessage {
  const priority = d.priority === 'urgent' ? 'URGENT' : 'Normal';
  const lines = (d.items ?? []).map((i) => `• ${i.item_name} — ${qty(i.requested_qty)} ${i.unit}`).join('\n');
  const text =
    `Assalam o Alaikum ${d.supplier_name},\n\n` +
    `Mountain Bakes has a purchase demand for you.\n` +
    `Demand: ${d.demand_no}\nPriority: ${priority}\nRequired by: ${day(d.required_date)}\n\n${lines}\n\n` +
    `Please confirm what you have, your rates and delivery, here:\n${link.url}\n\n` +
    `You can change quantities, mark items unavailable or offer a substitute on that page.`;
  return build(
    d,
    `demand:${d.id}:sent`,
    text,
    whatsappConfig().templateDemand,
    [d.supplier_name, d.demand_no, priority, day(d.required_date), itemSummary(d.items), link.url],
    link,
  );
}

export function linkResentMessage(d: DemandLike, link: IssuedLink): QueuedMessage {
  return update(d, `demand:${d.id}:link:${link.hash.slice(0, 16)}`, 'Here is a new link to this demand (older links no longer work):', link);
}

export function changesRequestedMessage(d: DemandLike, version: number, reason: string, link: IssuedLink): QueuedMessage {
  return update(
    d,
    `demand:${d.id}:changes:v${version}`,
    `We have looked at your quotation (version ${version}) and would like changes: ${reason}. Please send a revised quotation:`,
    link,
  );
}

export function quotationApprovedMessage(d: DemandLike, version: number, total: number, link: IssuedLink): QueuedMessage {
  return update(
    d,
    `demand:${d.id}:approved:v${version}`,
    `Your quotation (version ${version}, ${rs(total)}) is approved. Please send your final bill here:`,
    link,
  );
}

export function quotationRejectedMessage(d: DemandLike, version: number, reason: string): QueuedMessage {
  return update(d, `demand:${d.id}:rejected:v${version}`, `Your quotation (version ${version}) was not accepted: ${reason}. No further action is needed. Thank you.`, null);
}

export function billApprovedMessage(d: DemandLike, billNo: string, total: number, billId: string): QueuedMessage {
  return update(d, `bill:${billId}:approved`, `Your bill ${billNo} for ${rs(total)} is approved. We will arrange delivery and payment.`, null);
}

export function billRejectedMessage(d: DemandLike, billNo: string, reason: string, billId: string, link: IssuedLink): QueuedMessage {
  return update(d, `bill:${billId}:rejected`, `Your bill ${billNo} was returned: ${reason}. Please send a corrected bill:`, link);
}

export function cancelledMessage(d: DemandLike, reason: string): QueuedMessage {
  return update(d, `demand:${d.id}:cancelled`, `This demand has been cancelled: ${reason}. No further action is needed.`, null);
}

/** A staff reply in the conversation: free text only, within the window. */
export function replyMessage(toWaId: string, body: string, opts: { supplierId: string | null; demandId: string | null; dedupeKey: string }): QueuedMessage {
  return {
    toWaId,
    text: body,
    template: null,
    language: whatsappConfig().templateLanguage,
    params: [],
    maskedText: null,
    maskedParams: null,
    display: body,
    dedupeKey: opts.dedupeKey,
    supplierId: opts.supplierId,
    demandId: opts.demandId,
  };
}

/** WhatsApp alerts to Production staff phones (WHATSAPP_PRODUCTION_ALERT_TO), template only. */
export function productionAlerts(d: DemandLike, kind: string, uniq: string, body: string): QueuedMessage[] {
  const cfg = whatsappConfig();
  return cfg.productionAlertTo.map((to) => ({
    toWaId: to,
    text: `Mountain Bakes — purchase ${d.demand_no}\n\n${body}`,
    template: cfg.templateUpdate,
    language: cfg.templateLanguage,
    params: [d.demand_no, body].map(templateSafe),
    maskedText: null,
    maskedParams: null,
    display: `Mountain Bakes — purchase ${d.demand_no}\n\n${body}`,
    dedupeKey: `alert:${kind}:${uniq}:${to}`,
    supplierId: null,
    demandId: d.id,
  }));
}
