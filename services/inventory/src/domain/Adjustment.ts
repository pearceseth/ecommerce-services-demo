import { Schema } from "effect"
import { ProductId } from "./Product.js"

export const AdjustmentId = Schema.UUID.pipe(Schema.brand("AdjustmentId"))
export type AdjustmentId = typeof AdjustmentId.Type

// Valid reasons for stock adjustments (discriminated union approach)
export const AdjustmentReason = Schema.Literal(
  "warehouse_receiving",
  "manual_adjustment",
  "return_to_stock",
  "correction"
)
export type AdjustmentReason = typeof AdjustmentReason.Type

// Domain model for an inventory adjustment (audit record)
export class InventoryAdjustment extends Schema.Class<InventoryAdjustment>("InventoryAdjustment")({
  id: AdjustmentId,
  idempotencyKey: Schema.String,
  productId: ProductId,
  quantityChange: Schema.Int,
  previousQuantity: Schema.Int,
  newQuantity: Schema.Int,
  reason: AdjustmentReason,
  referenceId: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc
}) {}

// Request schema with validation
export class AddStockRequest extends Schema.Class<AddStockRequest>("AddStockRequest")({
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" })
  ),
  reason: AdjustmentReason,
  referenceId: Schema.optionalWith(
    Schema.String.pipe(
      Schema.maxLength(255, { message: () => "Reference ID cannot exceed 255 characters" })
    ),
    { as: "Option" }
  ),
  notes: Schema.optionalWith(
    Schema.String.pipe(
      Schema.maxLength(1000, { message: () => "Notes cannot exceed 1000 characters" })
    ),
    { as: "Option" }
  )
}) {}

// Response type for add stock operation
export interface AddStockResponse {
  readonly productId: ProductId
  readonly sku: string
  readonly previousQuantity: number
  readonly addedQuantity: number
  readonly newQuantity: number
  readonly adjustmentId: AdjustmentId
  readonly createdAt: typeof Schema.DateTimeUtc.Type
}
