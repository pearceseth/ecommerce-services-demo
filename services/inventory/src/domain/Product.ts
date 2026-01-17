import { Schema } from "effect"

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export class Product extends Schema.Class<Product>("Product")({
  id: ProductId,
  name: Schema.String,
  sku: Schema.String,
  price: Schema.BigDecimal,
  stockQuantity: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

export class CreateProductRequest extends Schema.Class<CreateProductRequest>("CreateProductRequest")({
  name: Schema.String,
  sku: Schema.String,
  price: Schema.String,
  initialStock: Schema.optionalWith(Schema.Int, { default: () => 0 })
}) {}
