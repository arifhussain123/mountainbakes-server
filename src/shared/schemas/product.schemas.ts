import { z } from 'zod';

export const CreateProductSchema = z.object({
  name: z.string().min(2, 'Product name is required'),
  categoryId: z.string().min(1, 'Category is required'),
  sku: z.string().min(2, 'SKU is required'),
  price: z.number().positive('Price must be positive'),
  costPrice: z.number().min(0, 'Cost price must be non-negative'),
  description: z.string().default(''),
});

export const UpdateProductSchema = z.object({
  name: z.string().min(2).optional(),
  categoryId: z.string().min(1).optional(),
  sku: z.string().min(2).optional(),
  price: z.number().positive().optional(),
  costPrice: z.number().min(0).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const CreateCategorySchema = z.object({
  name: z.string().min(2, 'Category name is required'),
  sortOrder: z.number().int().min(0).default(0),
});

export const UpdateCategorySchema = z.object({
  name: z.string().min(2).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof UpdateCategorySchema>;
