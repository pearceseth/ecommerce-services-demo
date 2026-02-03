import { Context, Effect, Option } from "effect"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface LedgerWithItems {
  readonly ledger: OrderLedger
  readonly items: readonly OrderLedgerItem[]
}

export class LedgerRepository extends Context.Tag("LedgerRepository")<
  LedgerRepository,
  {
    /**
     * Find a ledger entry by ID, including its items.
     */
    readonly findByIdWithItems: (id: OrderLedgerId) => Effect.Effect<Option.Option<LedgerWithItems>>

    /**
     * Update the ledger status.
     * Also updates the `updated_at` timestamp automatically via trigger.
     */
    readonly updateStatus: (id: OrderLedgerId, newStatus: OrderLedgerStatus) => Effect.Effect<OrderLedger>

    /**
     * Update ledger status and store the created order ID.
     * Used after Step 1 (create order) to record the order reference.
     */
    readonly updateStatusWithOrderId: (
      id: OrderLedgerId,
      newStatus: OrderLedgerStatus,
      orderId: string
    ) => Effect.Effect<OrderLedger>
  }
>() {}
