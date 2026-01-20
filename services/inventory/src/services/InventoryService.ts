import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { ProductId } from "../domain/Product.js"
import type { AddStockRequest, AddStockResponse } from "../domain/Adjustment.js"
import type {
  DuplicateAdjustmentError,
  InsufficientStockError,
  ProductNotFoundError
} from "../domain/errors.js"

export interface ReserveStockRequest {
  readonly orderId: string
  readonly items: ReadonlyArray<{
    readonly productId: ProductId
    readonly quantity: number
  }>
}

export class InventoryService extends Context.Tag("InventoryService")<
  InventoryService,
  {
    readonly addStock: (
      productId: ProductId,
      idempotencyKey: string,
      request: AddStockRequest
    ) => Effect.Effect<AddStockResponse, ProductNotFoundError | DuplicateAdjustmentError | SqlError.SqlError>

    readonly getAvailability: (
      productId: ProductId
    ) => Effect.Effect<number, ProductNotFoundError | SqlError.SqlError>

    readonly reserveStock: (
      request: ReserveStockRequest
    ) => Effect.Effect<ReadonlyArray<string>, InsufficientStockError | ProductNotFoundError | SqlError.SqlError>

    readonly releaseStock: (
      orderId: string
    ) => Effect.Effect<void, SqlError.SqlError>
  }
>() {}
