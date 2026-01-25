import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { ProductId } from "../domain/Product.js"
import type { InventoryReservation } from "../domain/Reservation.js"

// Input type for a single reservation item
export interface ReserveItemInput {
  readonly productId: ProductId
  readonly quantity: number
}

// Result type for atomic reserve operation - discriminated union
export type AtomicReserveResult =
  | { readonly _tag: "Reserved"; readonly reservations: ReadonlyArray<InventoryReservation> }
  | { readonly _tag: "AlreadyReserved"; readonly reservations: ReadonlyArray<InventoryReservation> }
  | { readonly _tag: "InsufficientStock"; readonly productId: string; readonly productSku: string; readonly requested: number; readonly available: number }
  | { readonly _tag: "ProductNotFound"; readonly productId: string }

// Result type for release operation
export interface ReleaseReservationResult {
  readonly releasedCount: number
  readonly totalQuantityRestored: number
  readonly wasAlreadyReleased: boolean
}

export class ReservationRepository extends Context.Tag("ReservationRepository")<
  ReservationRepository,
  {
    /**
     * Atomically reserve stock for multiple items in a single transaction.
     * Uses SELECT FOR UPDATE to prevent oversell.
     * Returns discriminated union indicating success or specific failure reason.
     */
    readonly reserveStockAtomic: (
      orderId: string,
      items: ReadonlyArray<ReserveItemInput>
    ) => Effect.Effect<AtomicReserveResult, SqlError.SqlError>

    /**
     * Find all reservations for an order.
     */
    readonly findByOrderId: (
      orderId: string
    ) => Effect.Effect<ReadonlyArray<InventoryReservation>, SqlError.SqlError>

    /**
     * Release all reservations for an order (compensation action).
     * Updates status to RELEASED and restores stock quantities.
     * Returns details about what was released for logging/debugging.
     */
    readonly releaseByOrderId: (
      orderId: string
    ) => Effect.Effect<ReleaseReservationResult, SqlError.SqlError>
  }
>() {}
