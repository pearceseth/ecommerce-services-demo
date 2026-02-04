import { Context, Effect } from "effect"
import type { OrderCreationError, OrderConfirmationError, OrderCancellationError, ServiceConnectionError } from "../domain/errors.js"

export interface CreateOrderParams {
  readonly orderLedgerId: string
  readonly userId: string
  readonly totalAmountCents: number
  readonly currency: string
  readonly items: readonly {
    readonly productId: string
    readonly quantity: number
    readonly unitPriceCents: number
  }[]
}

export interface CreateOrderResult {
  readonly orderId: string
  readonly status: string
}

export interface ConfirmOrderResult {
  readonly orderId: string
  readonly status: "CONFIRMED"
}

export interface CancelOrderResult {
  readonly orderId: string
  readonly status: "CANCELLED"
}

export class OrdersClient extends Context.Tag("OrdersClient")<
  OrdersClient,
  {
    /**
     * Create an order from a ledger entry.
     * Idempotent: if order already exists for this ledger entry, returns existing order.
     */
    readonly createOrder: (
      params: CreateOrderParams
    ) => Effect.Effect<CreateOrderResult, OrderCreationError | ServiceConnectionError>

    /**
     * Confirm an order (final saga step).
     * Idempotent: returns success if already confirmed.
     */
    readonly confirmOrder: (
      orderId: string
    ) => Effect.Effect<ConfirmOrderResult, OrderConfirmationError | ServiceConnectionError>

    /**
     * Cancel an order (compensation).
     * Idempotent: returns success if already cancelled.
     */
    readonly cancelOrder: (
      orderId: string
    ) => Effect.Effect<CancelOrderResult, OrderCancellationError | ServiceConnectionError>
  }
>() {}
