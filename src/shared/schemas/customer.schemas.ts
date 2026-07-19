import { z } from 'zod';

export const CreateCustomerSchema = z.object({
  name: z.string().min(2, 'Customer name is required'),
  phone: z.string().min(10, 'Invalid phone number'),
  email: z.string().email('Invalid email').or(z.literal('')).default(''),
  address: z.string().default(''),
  branchId: z.string().min(1, 'Branch is required'),
});

export const UpdateCustomerSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  email: z.string().email().or(z.literal('')).optional(),
  address: z.string().optional(),
});

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
