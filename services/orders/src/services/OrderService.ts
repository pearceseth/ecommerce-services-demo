import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type {
  Order,
  OrderId,
  OrderItem,
  CreateOrderRequest
} from "../domain/Order.js"
import type { OrderNotFoundError } from "../domain/errors.js"

// Response type that includes order with its items
export interface OrderWithItems {
  readonly order: Order
  readonly items: readonly OrderItem[]
}

export class OrderService extends Context.Tag("OrderService")<
  OrderService,
  {
    /**
     * Creates a new order from a ledger entry.
     * Idempotent: if order with same order_ledger_id exists, returns existing.
     *
     * @param request - The order creation request with items
     * @returns The order with its items
     */
    readonly create: (
      request: CreateOrderRequest
    ) => Effect.Effect<OrderWithItems, SqlError.SqlError>

    /**
     * Finds an order by ID with its items.
     *
     * @param id - The order ID
     * @returns The order with items, or fails with OrderNotFoundError
     */
    readonly findById: (
      id: OrderId
    ) => Effect.Effect<OrderWithItems, OrderNotFoundError | SqlError.SqlError>
  }
>() {}
