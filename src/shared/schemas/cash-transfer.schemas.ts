import { z } from 'zod';
import { cashTransferTotal, type CashTransferMethod } from '../types/cash-transfer.types';
import { optionalAttachmentIds } from './attachment.schemas';
import { optionalBusinessDate } from './business-date.schemas';

// ── Cash transfers ───────────────────────────────────────────────────────────
//
// `branchId` is NEVER in any schema here: it is derived server-side from the
// caller's JWT, the same rule CreateBranchDiscountSchema follows. Nor are
// `status`, `voucherNo` or any approver field — those are the server's alone.

/**
 * One channel figure: money to the paisa, zero allowed (an unused channel),
 * negative refused. Zero is never BOOKED — the approval posts only figures
 * above 0 (migration 121) — but it is a valid thing to type.
 */
const channelAmount = z
  .number({ message: 'Enter a valid amount' })
  .min(0, 'Amount cannot be negative')
  .max(10_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'Amount can have at most 2 decimal places');

/**
 * A pre-121 client sent `{ amount, paymentMethod }`. Mapped onto the matching
 * channel so a browser still running the old bundle during a deploy keeps
 * working — the one method becomes the one channel, exactly as migration 121
 * backfilled the old rows. Ignored when any channel figure is present.
 */
function fromLegacyBody(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const b = raw as Record<string, unknown>;
  const hasChannel = ['cashAmount', 'easypaisaAmount', 'bankAmount', 'fuelCharges'].some((k) => b[k] !== undefined);
  if (hasChannel || typeof b['paymentMethod'] !== 'string' || typeof b['amount'] !== 'number') return raw;
  const key = { cash: 'cashAmount', easypaisa: 'easypaisaAmount', bank_account: 'bankAmount' }[
    b['paymentMethod'] as CashTransferMethod
  ];
  if (!key) return raw;
  const { amount, paymentMethod: _legacy, ...rest } = b;
  return { ...rest, [key]: amount };
}

/**
 * Cash + Easypaisa + Bank = Total Amount; Fuel Charges beside it, never in it.
 *
 * The server is the authority on the Total: `totalAmount` is OPTIONAL and, when
 * a client sends the figure it displayed, it must equal the sum or the request
 * is refused — so a screen showing one Total can never save another.
 *
 * The photo is required whenever money other than fuel is claimed. A
 * Fuel-Charges-only deposit may go without one (the owner's rule).
 */
export const CreateCashTransferSchema = z.preprocess(
  fromLegacyBody,
  z
    .object({
      cashAmount: channelAmount.default(0),
      easypaisaAmount: channelAmount.default(0),
      bankAmount: channelAmount.default(0),
      fuelCharges: channelAmount.default(0),
      totalAmount: z.number().optional(),
      note: z.string().trim().max(500).optional(),
      /** Photos uploaded first to POST /api/attachments. See the refinement for when one is required. */
      attachmentIds: optionalAttachmentIds,
      // The deposit's business date; see business-date.schemas.ts. The server
      // bounds it (7 business days, not the future, not a closed day).
      businessDate: optionalBusinessDate,
    })
    .superRefine((v, ctx) => {
      const total = cashTransferTotal(v);
      if (total <= 0 && v.fuelCharges <= 0) {
        ctx.addIssue({ code: 'custom', path: ['cashAmount'], message: 'Enter at least one amount greater than 0' });
      }
      if (v.totalAmount !== undefined && Math.round(v.totalAmount * 100) !== Math.round(total * 100)) {
        ctx.addIssue({
          code: 'custom',
          path: ['totalAmount'],
          message: 'Total Amount must equal Cash + Easypaisa + Bank',
        });
      }
      if (total > 0 && v.attachmentIds.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['attachmentIds'], message: 'Payment proof photo is required.' });
      }
    }),
);

export const ApproveCashTransferSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const RejectCashTransferSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this transfer is refused').max(500),
});

/**
 * A branch correcting a REJECTED deposit and sending the same CT- back. No
 * branch and no business date: a rejection does not move a deposit to another
 * branch or day. The slip photo already on it stays (it is the evidence the
 * rejection was about); a new photo is added beside it, not instead of it.
 */
export const ResubmitCashTransferSchema = z
  .object({
    cashAmount: channelAmount.default(0),
    easypaisaAmount: channelAmount.default(0),
    bankAmount: channelAmount.default(0),
    fuelCharges: channelAmount.default(0),
    totalAmount: z.number().optional(),
    note: z.string().trim().max(500).optional(),
    attachmentIds: optionalAttachmentIds,
  })
  .superRefine((v, ctx) => {
    const total = cashTransferTotal(v);
    if (total <= 0 && v.fuelCharges <= 0) {
      ctx.addIssue({ code: 'custom', path: ['cashAmount'], message: 'Enter at least one amount greater than 0' });
    }
    if (v.totalAmount !== undefined && Math.round(v.totalAmount * 100) !== Math.round(total * 100)) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalAmount'],
        message: 'Total Amount must equal Cash + Easypaisa + Bank',
      });
    }
  });

export type CreateCashTransferInput = z.infer<typeof CreateCashTransferSchema>;
export type ResubmitCashTransferInput = z.infer<typeof ResubmitCashTransferSchema>;
export type ApproveCashTransferInput = z.infer<typeof ApproveCashTransferSchema>;
export type RejectCashTransferInput = z.infer<typeof RejectCashTransferSchema>;
