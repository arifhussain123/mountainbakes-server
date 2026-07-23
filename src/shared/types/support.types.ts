// Support tickets — the Help Desk (branches / production) → Support Center (admin)
// query queue. A ticket is always raised against ONE reference ID (a sale
// MB-######, an expense EXP-######, or a product's stock STK-######); the
// reference's figures are snapshotted onto the ticket at submit time so the
// admin sees exactly what the raiser saw.

export type SupportReferenceType = 'sale' | 'expense' | 'stock';
export type SupportTicketStatus = 'open' | 'resolved' | 'rejected';

/** One key/value line of the auto-shown reference detail. */
export interface SupportDetailField {
  label: string;
  value: string;
}

/** A field the admin may directly correct on the underlying record. */
export interface SupportEditableField {
  key: string;
  label: string;
  kind: 'number' | 'text';
  value: string | number;
}

/**
 * The resolved detail for a reference ID. Rendered auto-adjusted in both the
 * Help Desk (before submit) and the Support Center (on the ticket), and stored
 * on the ticket as `referenceSnapshot`.
 */
export interface SupportReference {
  type: SupportReferenceType;
  referenceId: string;
  /** Human summary line, e.g. "Sale MB-000125 — Ali Raza · Rs.1,250". */
  title: string;
  fields: SupportDetailField[];
  /** Directly editable fields (live mutation applies to expenses only). */
  editableFields: SupportEditableField[];
  /** Internal uuid of the underlying row, used when applying a figure edit. */
  entityId: string;
  /** For expenses: which table the row lives in, so the figure edit hits the right one. */
  entityTable?: string;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  referenceType: SupportReferenceType;
  referenceId: string;
  referenceSnapshot: SupportReference | null;
  message: string;
  status: SupportTicketStatus;
  resolutionNote: string | null;
  branchId: string | null;
  branchName: string | null;
  raisedBy: string | null;
  raisedByName: string | null;
  raisedByRole: string | null;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
