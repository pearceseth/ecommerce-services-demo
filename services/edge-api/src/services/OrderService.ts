import { Context, Effect } from "effect"
import type { CreateOrderRequest } from "../domain/OrderLedger.js"
import type {
  PaymentDeclinedError,
  PaymentGatewayError,
  DuplicateRequestError
} from "../domain/errors.js"
import type { SqlError } from "@effect/sql"

export interface CreateOrderResult {
  readonly orderLedgerId: string
  readonly status: string
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
  }
>() {}
