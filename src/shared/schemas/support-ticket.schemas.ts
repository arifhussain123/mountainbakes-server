import { z } from 'zod';

// Support / Query ticket system. Byte-identical-mirrored into the frontend repo.

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const CreateTicketSchema = z.object({
  subject: z.string().min(3, 'Subject is required'),
  categoryId: z.string().min(1, 'Category is required'),
  description: z.string().min(5, 'Please describe the issue'),
  priority: z.enum(TICKET_PRIORITIES).default('medium'),
});

export const AddTicketMessageSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
});

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;
export type AddTicketMessageInput = z.infer<typeof AddTicketMessageSchema>;
