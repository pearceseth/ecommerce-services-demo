import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { InventoryAdjustment, AdjustmentReason } from "../domain/Adjustment.js"
import type { ProductId } from "../domain/Product.js"

export interface AtomicAddStockParams {
  readonly idempotencyKey: string
  readonly productId: ProductId
  readonly quantity: number
  readonly reason: AdjustmentReason
  readonly referenceId: string | null
  readonly notes: string | null
  readonly createdBy: string | null
}

export type AtomicAddStockResult =
  | { readonly _tag: "Created"; readonly adjustment: InventoryAdjustment; readonly sku: string }
  | { readonly _tag: "AlreadyExists"; readonly adjustment: InventoryAdjustment }
  | { readonly _tag: "ProductNotFound" }

export class StockAdjustmentRepository extends Context.Tag("StockAdjustmentRepository")<
  StockAdjustmentRepository,
  {
    /**
     * Atomically adds stock to a product with idempotency guarantee.
     *
     * This operation is fully atomic - it either:
     * 1. Creates a new adjustment and updates stock (if idempotency key is new)
     * 2. Returns the existing adjustment (if idempotency key already used)
     * 3. Returns ProductNotFound (if product doesn't exist)
     *
     * There is NO race condition window - concurrent requests with the same
     * idempotency key will never double-increment stock.
     */
    readonly addStockAtomic: (
      params: AtomicAddStockParams
    ) => Effect.Effect<AtomicAddStockResult, SqlError.SqlError>
  }
>() {}
