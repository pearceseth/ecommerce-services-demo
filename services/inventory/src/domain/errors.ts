import { Data } from "effect"

/**
 * Product was not found in the database.
 * Context includes how the search was performed to aid debugging.
 */
export class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
  readonly searchedBy: "id" | "sku"
}> {}

/**
 * Attempted to create a product with a SKU that already exists.
 * Includes the existing product ID for potential recovery/redirect.
 */
export class DuplicateSkuError extends Data.TaggedError("DuplicateSkuError")<{
  readonly sku: string
  readonly existingProductId: string
}> {}

/**
 * Insufficient stock to fulfill a reservation request.
 * Includes both requested and available quantities for user messaging.
 */
export class InsufficientStockError extends Data.TaggedError("InsufficientStockError")<{
  readonly productId: string
  readonly productSku: string
  readonly requested: number
  readonly available: number
}> {}

/**
 * Idempotency key was already used for a previous adjustment.
 * Includes the full existing adjustment details for idempotent response.
 */
export class DuplicateAdjustmentError extends Data.TaggedError("DuplicateAdjustmentError")<{
  readonly idempotencyKey: string
  readonly existingAdjustment: {
    readonly adjustmentId: string
    readonly previousQuantity: number
    readonly addedQuantity: number
    readonly newQuantity: number
  }
}> {}
