import { z } from 'zod';

export const CreateBranchSchema = z.object({
  name: z.string().min(2, 'Branch name is required'),
  location: z.string().min(2, 'Location is required'),
  phone: z.string().min(10, 'Invalid phone number'),
  address: z.string().min(5, 'Address is required'),
  city: z.string().min(2, 'City is required'),
  dailyBudget: z.number().min(0).optional(),
  weeklyBudget: z.number().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
});

export const UpdateBranchSchema = z.object({
  name: z.string().min(2).optional(),
  location: z.string().min(2).optional(),
  phone: z.string().min(10).optional(),
  address: z.string().min(5).optional(),
  city: z.string().min(2).optional(),
  managerId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  dailyBudget: z.number().min(0).optional(),
  weeklyBudget: z.number().min(0).optional(),
  monthlyBudget: z.number().min(0).optional(),
});

export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
