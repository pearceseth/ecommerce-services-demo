import { Context, Effect } from "effect"
import type { ProductId } from "../domain/Product.js"
import type { StockAdjustment } from "../services/InventoryService.js"

export interface CreateAdjustmentRow {
  readonly idempotencyKey: string
  readonly productId: ProductId
  readonly quantityChange: number
  readonly previousQuantity: number
  readonly newQuantity: number
  readonly reason: string
  readonly referenceId?: string
  readonly notes?: string
}

export interface CreateReservationRow {
  readonly orderId: string
  readonly productId: ProductId
  readonly quantity: number
}

export class InventoryRepository extends Context.Tag("InventoryRepository")<
  InventoryRepository,
  {
    readonly insertAdjustment: (row: CreateAdjustmentRow) => Effect.Effect<StockAdjustment>
    readonly findAdjustmentByKey: (key: string) => Effect.Effect<StockAdjustment | null>
    readonly insertReservation: (row: CreateReservationRow) => Effect.Effect<string>
    readonly releaseReservations: (orderId: string) => Effect.Effect<void>
  }
>() {}
