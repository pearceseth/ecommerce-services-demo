import { Context, Effect } from "effect"
import type { CreateOrderRequest } from "../domain/OrderLedger.js"
import type {
  PaymentDeclinedError,
  PaymentGatewayError,
  DuplicateRequestError,
  OrderLedgerNotFoundError
} from "../domain/errors.js"
import type { SqlError } from "@effect/sql"

export interface CreateOrderResult {
  readonly orderLedgerId: string
  readonly status: string
}

// Result type for getOrderStatus
export interface OrderStatusResult {
  readonly orderLedgerId: string
  readonly clientRequestId: string
  readonly status: string
  readonly userId: string
  readonly email: string
  readonly totalAmountCents: number
  readonly currency: string
  readonly paymentAuthorizationId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly items: ReadonlyArray<{
    readonly productId: string
    readonly quantity: number
    readonly unitPriceCents: number
  }>
}

export class OrderService extends Context.Tag("OrderService")<
  OrderService,
  {
    /**
     * Process a new order request.
     *
     * 1. Check for duplicate (idempotency)
     * 2. Create ledger entry
     * 3. Authorize payment
     * 4. Update ledger with authorization result
     *
     * Returns order_ledger_id and status on success.
     */
    readonly createOrder: (
      idempotencyKey: string,
      request: CreateOrderRequest
    ) => Effect.Effect<
      CreateOrderResult,
      | DuplicateRequestError
      | PaymentDeclinedError
      | PaymentGatewayError
      | SqlError.SqlError
    >

    /**
     * Get order status and details by order_ledger_id.
     * Returns full ledger info including items.
     */
    readonly getOrderStatus: (
      orderLedgerId: string
    ) => Effect.Effect<
      OrderStatusResult,
      | OrderLedgerNotFoundError
      | SqlError.SqlError
    >
  }
>() {}
