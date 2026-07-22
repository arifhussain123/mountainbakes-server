// Support / Query ticket system. Values mirror the Postgres enums in
// migration 19 exactly. This file is byte-identical-mirrored into the frontend
// repo (src/shared) — edit both trees.

export type TicketStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_user'
  | 'resolved'
  | 'closed'
  | 'reopened';

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface SupportTicketCategory {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketMessage {
  id: string;
  ticketId: string;
  senderId: string | null;
  senderName: string | null;
  senderRole: string | null;
  message: string;
  createdAt: string;
  // Attachments belonging to this message, hydrated by GET /:id.
  attachments?: SupportTicketAttachment[];
}

export interface SupportTicketAttachment {
  id: string;
  ticketId: string;
  messageId: string | null;
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  createdAt: string;
}

export interface SupportTicketHistory {
  id: string;
  ticketId: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  performedBy: string | null;
  performedByName: string | null;
  performedAt: string;
}

export interface SupportTicket {
  id: string;
  ticketNo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdByRole: string | null;
  branchId: string | null;
  department: string | null;
  categoryId: string | null;
  categoryName: string | null;
  subject: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  deletedAt: string | null;
  // Hydrated only by GET /:id.
  messages?: SupportTicketMessage[];
  history?: SupportTicketHistory[];
  // Attachments on the opening post (message_id is null); reply attachments hang
  // off their SupportTicketMessage instead.
  attachments?: SupportTicketAttachment[];
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  highPriority: number;
  today: number;
}
