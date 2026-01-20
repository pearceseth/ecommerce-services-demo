import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { ProductId } from "../domain/Product.js"
import type { InventoryAdjustment, AdjustmentReason } from "../domain/Adjustment.js"

export interface CreateAdjustmentRow {
  readonly idempotencyKey: string
  readonly productId: ProductId
  readonly quantityChange: number
  readonly previousQuantity: number
  readonly newQuantity: number
  readonly reason: AdjustmentReason
  readonly referenceId: string | null
  readonly notes: string | null
  readonly createdBy: string | null
}

export interface CreateReservationRow {
  readonly orderId: string
  readonly productId: ProductId
  readonly quantity: number
}

export class InventoryRepository extends Context.Tag("InventoryRepository")<
  InventoryRepository,
  {
    readonly insertAdjustment: (row: CreateAdjustmentRow) => Effect.Effect<InventoryAdjustment, SqlError.SqlError>
    readonly findAdjustmentByKey: (key: string) => Effect.Effect<Option.Option<InventoryAdjustment>, SqlError.SqlError>
    readonly insertReservation: (row: CreateReservationRow) => Effect.Effect<string, SqlError.SqlError>
    readonly releaseReservations: (orderId: string) => Effect.Effect<void, SqlError.SqlError>
  }
>() {}
