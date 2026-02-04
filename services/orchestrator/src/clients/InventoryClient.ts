import { Context, Effect } from "effect"
import type { InventoryReservationError, InventoryReleaseError, ServiceConnectionError } from "../domain/errors.js"

export interface ReserveStockParams {
  readonly orderId: string
  readonly items: readonly {
    readonly productId: string
    readonly quantity: number
  }[]
}

export interface ReserveStockResult {
  readonly orderId: string
  readonly reservationIds: readonly string[]
  readonly lineItemsReserved: number
  readonly totalQuantityReserved: number
}

export interface ReleaseStockParams {
  readonly orderId: string
}

export interface ReleaseStockResult {
  readonly orderId: string
  readonly releasedCount: number
  readonly totalQuantityRestored: number
}

export class InventoryClient extends Context.Tag("InventoryClient")<
  InventoryClient,
  {
    /**
     * Reserve stock for an order.
     * Uses SELECT FOR UPDATE to prevent oversell.
     * Idempotent: returns existing reservation if already reserved.
     */
    readonly reserveStock: (
      params: ReserveStockParams
    ) => Effect.Effect<ReserveStockResult, InventoryReservationError | ServiceConnectionError>

    /**
     * Release stock reservations for an order (compensation).
     * Idempotent: returns success if already released or no reservations exist.
     */
    readonly releaseStock: (
      params: ReleaseStockParams
    ) => Effect.Effect<ReleaseStockResult, InventoryReleaseError | ServiceConnectionError>
  }
>() {}
