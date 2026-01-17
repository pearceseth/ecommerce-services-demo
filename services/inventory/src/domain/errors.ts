import { Data } from "effect"

export class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
}> {}

export class DuplicateSkuError extends Data.TaggedError("DuplicateSkuError")<{
  readonly sku: string
}> {}

export class InsufficientStockError extends Data.TaggedError("InsufficientStockError")<{
  readonly productId: string
  readonly requested: number
  readonly available: number
}> {}

export class DuplicateAdjustmentError extends Data.TaggedError("DuplicateAdjustmentError")<{
  readonly idempotencyKey: string
}> {}
