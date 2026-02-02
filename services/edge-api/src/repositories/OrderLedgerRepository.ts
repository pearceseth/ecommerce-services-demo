import { Context, Effect, Option } from "effect"
import type { SqlError } from "@effect/sql"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface CreateOrderLedgerParams {
  readonly clientRequestId: string
  readonly userId: string
  readonly email: string
  readonly totalAmountCents: number
  readonly currency: string
}

export interface CreateOrderLedgerItemParams {
  readonly orderLedgerId: OrderLedgerId
  readonly productId: string
  readonly quantity: number
  readonly unitPriceCents: number
}

export interface UpdateLedgerWithAuthorizationParams {
  readonly orderLedgerId: OrderLedgerId
  readonly paymentAuthorizationId: string
  readonly newStatus: OrderLedgerStatus
}

export class OrderLedgerRepository extends Context.Tag("OrderLedgerRepository")<
  OrderLedgerRepository,
  {
    /**
     * Find existing order ledger by client_request_id (for idempotency check)
     */
    readonly findByClientRequestId: (
      clientRequestId: string
    ) => Effect.Effect<Option.Option<OrderLedger>, SqlError.SqlError>

    /**
     * Create a new order ledger entry with AWAITING_AUTHORIZATION status
     */
    readonly create: (
      params: CreateOrderLedgerParams
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>

    /**
     * Create order ledger items (line items)
     */
    readonly createItems: (
      items: ReadonlyArray<CreateOrderLedgerItemParams>
    ) => Effect.Effect<ReadonlyArray<OrderLedgerItem>, SqlError.SqlError>

    /**
     * Atomically update ledger status, set authorization ID, write outbox event, and NOTIFY.
     * This is the critical transactional operation after payment authorization.
     */
    readonly updateWithAuthorizationAndOutbox: (
      params: UpdateLedgerWithAuthorizationParams
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>

    /**
     * Update ledger status to AUTHORIZATION_FAILED
     */
    readonly markAuthorizationFailed: (
      orderLedgerId: OrderLedgerId
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>

    /**
     * Find order ledger by ID with its items.
     * Used for the GET /orders/{order_ledger_id} endpoint.
     */
    readonly findByIdWithItems: (
      orderLedgerId: OrderLedgerId
    ) => Effect.Effect<Option.Option<{ ledger: OrderLedger; items: ReadonlyArray<OrderLedgerItem> }>, SqlError.SqlError>
  }
>() {}
