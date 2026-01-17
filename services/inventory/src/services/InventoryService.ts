import { Context, Effect } from "effect"
import type { ProductId } from "../domain/Product.js"
import type {
  DuplicateAdjustmentError,
  InsufficientStockError,
  ProductNotFoundError
} from "../domain/errors.js"

export interface StockAdjustment {
  readonly id: string
  readonly productId: ProductId
  readonly quantityChange: number
  readonly previousQuantity: number
  readonly newQuantity: number
  readonly reason: string
  readonly referenceId?: string
  readonly notes?: string
  readonly createdAt: Date
}

export interface AddStockRequest {
  readonly productId: ProductId
  readonly quantity: number
  readonly reason: string
  readonly idempotencyKey: string
  readonly referenceId?: string
  readonly notes?: string
}

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
      request: AddStockRequest
    ) => Effect.Effect<StockAdjustment, ProductNotFoundError | DuplicateAdjustmentError>

    readonly getAvailability: (
      productId: ProductId
    ) => Effect.Effect<number, ProductNotFoundError>

    readonly reserveStock: (
      request: ReserveStockRequest
    ) => Effect.Effect<ReadonlyArray<string>, InsufficientStockError | ProductNotFoundError>

    readonly releaseStock: (
      orderId: string
    ) => Effect.Effect<void>
  }
>() {}
