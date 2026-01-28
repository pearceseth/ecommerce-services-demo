import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type {
  Order,
  OrderId,
  OrderLedgerId,
  OrderItem,
  OrderStatus
} from "../domain/Order.js"
import type { CreateOrderRequest } from "../domain/Order.js"

// Result type for atomic create operation (idempotency support)
export type CreateOrderResult =
  | { readonly _tag: "Created"; readonly order: Order; readonly items: readonly OrderItem[] }
  | { readonly _tag: "AlreadyExists"; readonly order: Order; readonly items: readonly OrderItem[] }

export class OrderRepository extends Context.Tag("OrderRepository")<
  OrderRepository,
  {
    /**
     * Creates an order with its items atomically.
     * If an order with the same order_ledger_id exists, returns the existing order.
     * Uses atomic CTE to prevent race conditions.
     */
    readonly createWithItems: (
      request: CreateOrderRequest
    ) => Effect.Effect<CreateOrderResult, SqlError.SqlError>

    /**
     * Finds an order by its ID.
     * Returns Option.none() if not found.
     */
    readonly findById: (
      id: OrderId
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>

    /**
     * Finds an order by its ledger ID.
     * Returns Option.none() if not found.
     */
    readonly findByLedgerId: (
      ledgerId: OrderLedgerId
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>

    /**
     * Gets all items for an order.
     */
    readonly getItems: (
      orderId: OrderId
    ) => Effect.Effect<readonly OrderItem[], SqlError.SqlError>

    /**
     * Updates the status of an order.
     * Returns the updated order if successful.
     */
    readonly updateStatus: (
      orderId: OrderId,
      status: OrderStatus
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>
  }
>() {}
