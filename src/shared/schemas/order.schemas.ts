import { z } from 'zod';

// Branch-facing payment methods (retail sales). Replaces the legacy cash/card/online set.
export const PAYMENT_METHOD_VALUES = ['cash', 'easypaisa', 'foodpanda', 'bank_account'] as const;

export const OrderItemSchema = z.object({
  productId: z.string().min(1, 'Product is required'),
  qty: z.number().int().positive('Quantity must be at least 1'),
  discount: z.number().min(0, 'Discount cannot be negative').default(0),
});

export const CreateOrderSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  customerId: z.string().min(1, 'Customer is required'),
  items: z.array(OrderItemSchema).min(1, 'At least one item is required'),
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
  deliveryCharges: z.number().min(0).default(0),
  notes: z.string().default(''),
});

// Retail POS sale: free-text customer (no customers-collection lookup), immediate completion.
export const CreatePosSaleSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  customerName: z.string().default(''),
  customerPhone: z.string().default(''),
  items: z.array(OrderItemSchema).min(1, 'At least one item is required'),
  paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
  // Cash tendered by the customer. Only meaningful for cash payments; the server
  // validates it covers the grand total and derives the change to return.
  receivedCash: z.number().min(0).optional(),
  notes: z.string().default(''),
});

export const UpdateOrderStatusSchema = z.object({
  status: z.enum(['pending', 'preparing', 'ready', 'delivered', 'cancelled']),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type CreatePosSaleInput = z.infer<typeof CreatePosSaleSchema>;
export type UpdateOrderStatusInput = z.infer<typeof UpdateOrderStatusSchema>;
