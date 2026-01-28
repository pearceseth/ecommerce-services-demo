import { Layer, Effect, Option, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { OrderRepository, type CreateOrderResult } from "./OrderRepository.js"
import {
  Order,
  OrderId,
  OrderLedgerId,
  OrderItem,
  OrderItemId,
  UserId,
  ProductId,
  type OrderStatus,
  type CreateOrderRequest
} from "../domain/Order.js"

// Database row types (snake_case)
interface OrderRow {
  id: string
  order_ledger_id: string
  user_id: string
  status: string
  total_amount_cents: number
  currency: string
  created_at: Date
  updated_at: Date
}

interface OrderItemRow {
  id: string
  order_id: string
  product_id: string
  quantity: number
  unit_price_cents: number
  created_at: Date
}

// Row to domain mappers
const mapRowToOrder = (row: OrderRow): Order =>
  new Order({
    id: row.id as OrderId,
    orderLedgerId: row.order_ledger_id as OrderLedgerId,
    userId: row.user_id as UserId,
    status: row.status as OrderStatus,
    totalAmountCents: row.total_amount_cents,
    currency: row.currency,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    updatedAt: DateTime.unsafeFromDate(row.updated_at)
  })

const mapRowToOrderItem = (row: OrderItemRow): OrderItem =>
  new OrderItem({
    id: row.id as OrderItemId,
    orderId: row.order_id as OrderId,
    productId: row.product_id as ProductId,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    createdAt: DateTime.unsafeFromDate(row.created_at)
  })

export const OrderRepositoryLive = Layer.effect(
  OrderRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      createWithItems: (request: CreateOrderRequest) =>
        Effect.gen(function* () {
          // Use transaction to ensure atomicity
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              // First, check if order already exists (idempotency)
              const existing = yield* sql<OrderRow>`
                SELECT * FROM orders
                WHERE order_ledger_id = ${request.orderLedgerId}
              `

              if (existing.length > 0) {
                // Order exists - return existing (idempotent)
                const order = mapRowToOrder(existing[0])
                const itemRows = yield* sql<OrderItemRow>`
                  SELECT * FROM order_items WHERE order_id = ${order.id}
                `
                return {
                  _tag: "AlreadyExists" as const,
                  order,
                  items: itemRows.map(mapRowToOrderItem)
                }
              }

              // Create new order
              const orderResult = yield* sql<OrderRow>`
                INSERT INTO orders (
                  order_ledger_id,
                  user_id,
                  status,
                  total_amount_cents,
                  currency
                )
                VALUES (
                  ${request.orderLedgerId},
                  ${request.userId},
                  'CREATED',
                  ${request.totalAmountCents},
                  ${request.currency}
                )
                RETURNING *
              `
              const order = mapRowToOrder(orderResult[0])

              // Insert order items
              const itemResults: OrderItem[] = []
              for (const item of request.items) {
                const itemRow = yield* sql<OrderItemRow>`
                  INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
                  VALUES (${order.id}, ${item.productId}, ${item.quantity}, ${item.unitPriceCents})
                  RETURNING *
                `
                itemResults.push(mapRowToOrderItem(itemRow[0]))
              }

              return {
                _tag: "Created" as const,
                order,
                items: itemResults
              } satisfies CreateOrderResult
            })
          )
        }),

      findById: (id: OrderId) =>
        Effect.gen(function* () {
          const result = yield* sql<OrderRow>`
            SELECT * FROM orders WHERE id = ${id}
          `
          return result.length > 0
            ? Option.some(mapRowToOrder(result[0]))
            : Option.none()
        }),

      findByLedgerId: (ledgerId: OrderLedgerId) =>
        Effect.gen(function* () {
          const result = yield* sql<OrderRow>`
            SELECT * FROM orders WHERE order_ledger_id = ${ledgerId}
          `
          return result.length > 0
            ? Option.some(mapRowToOrder(result[0]))
            : Option.none()
        }),

      getItems: (orderId: OrderId) =>
        Effect.gen(function* () {
          const result = yield* sql<OrderItemRow>`
            SELECT * FROM order_items WHERE order_id = ${orderId}
          `
          return result.map(mapRowToOrderItem)
        }),

      updateStatus: (orderId: OrderId, status: OrderStatus) =>
        Effect.gen(function* () {
          const result = yield* sql<OrderRow>`
            UPDATE orders
            SET status = ${status}, updated_at = NOW()
            WHERE id = ${orderId}
            RETURNING *
          `
          return result.length > 0
            ? Option.some(mapRowToOrder(result[0]))
            : Option.none()
        })
    }
  })
)
