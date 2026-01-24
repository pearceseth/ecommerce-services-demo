import { Schema } from "effect"

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

// Schema for extracting and validating product_id from path parameters
export const ProductIdParams = Schema.Struct({
  product_id: ProductId
})

export class Product extends Schema.Class<Product>("Product")({
  id: ProductId,
  name: Schema.String,
  sku: Schema.String,
  priceCents: Schema.Int,
  stockQuantity: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

export class CreateProductRequest extends Schema.Class<CreateProductRequest>("CreateProductRequest")({
  name: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Product name cannot be empty" }),
    Schema.maxLength(255, { message: () => "Product name cannot exceed 255 characters" })
  ),
  sku: Schema.String.pipe(
    Schema.minLength(1, { message: () => "SKU cannot be empty" }),
    Schema.maxLength(100, { message: () => "SKU cannot exceed 100 characters" }),
    Schema.pattern(/^[A-Za-z0-9\-_]+$/, {
      message: () => "SKU can only contain alphanumeric characters, hyphens, and underscores"
    })
  ),
  priceCents: Schema.Int.pipe(
    Schema.positive({ message: () => "Price must be positive" })
  ),
  initialStock: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.nonNegative({ message: () => "Initial stock cannot be negative" })
    ),
    { default: () => 0 }
  )
}) {}
