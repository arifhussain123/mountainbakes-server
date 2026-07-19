export interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
}

export interface Product {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  sku: string;
  price: number;
  costPrice: number;
  description: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProductPayload {
  name: string;
  categoryId: string;
  sku: string;
  price: number;
  costPrice: number;
  description: string;
}

export interface UpdateProductPayload {
  name?: string;
  categoryId?: string;
  sku?: string;
  price?: number;
  costPrice?: number;
  description?: string;
  isActive?: boolean;
}

export interface CreateCategoryPayload {
  name: string;
  sortOrder?: number;
}
