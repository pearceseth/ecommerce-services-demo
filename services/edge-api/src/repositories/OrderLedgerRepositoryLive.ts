import { Layer, Effect, Option, DateTime } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  OrderLedgerRepository,
  type CreateOrderLedgerParams,
  type CreateOrderLedgerItemParams,
  type UpdateLedgerWithAuthorizationParams
} from "./OrderLedgerRepository.js"
import { OrderLedger, OrderLedgerItem, type OrderLedgerId, type OrderLedgerStatus, type UserId, type ProductId } from "../domain/OrderLedger.js"

// Row type for order_ledger table
interface OrderLedgerRow {
  id: string
  client_request_id: string
  user_id: string
  email: string
  status: string
  total_amount_cents: number
  currency: string
  payment_authorization_id: string | null
  retry_count: number
  next_retry_at: string | null
  created_at: string
  updated_at: string
}

// Row type for order_ledger_items table
interface OrderLedgerItemRow {
  id: string
  order_ledger_id: string
  product_id: string
  quantity: number
  unit_price_cents: number
  created_at: string
}

// Convert database row to domain model
const rowToOrderLedger = (row: OrderLedgerRow): OrderLedger =>
  new OrderLedger({
    id: row.id as OrderLedgerId,
    clientRequestId: row.client_request_id,
    userId: row.user_id as UserId,
    email: row.email,
    status: row.status as OrderLedgerStatus,
    totalAmountCents: row.total_amount_cents,
    currency: row.currency,
    paymentAuthorizationId: row.payment_authorization_id,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ? DateTime.unsafeFromDate(new Date(row.next_retry_at)) : null,
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at)),
    updatedAt: DateTime.unsafeFromDate(new Date(row.updated_at))
  })

// Convert database row to domain item model
const rowToOrderLedgerItem = (row: OrderLedgerItemRow): OrderLedgerItem =>
  new OrderLedgerItem({
    id: row.id,
    orderLedgerId: row.order_ledger_id as OrderLedgerId,
    productId: row.product_id as ProductId,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at))
  })

export const OrderLedgerRepositoryLive = Layer.effect(
  OrderLedgerRepository,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    return {
      findByClientRequestId: (clientRequestId: string) =>
        Effect.gen(function* () {
          const rows = yield* sql<OrderLedgerRow>`
            SELECT id, client_request_id, user_id, email, status,
                   total_amount_cents, currency, payment_authorization_id,
                   retry_count, next_retry_at, created_at, updated_at
            FROM order_ledger
            WHERE client_request_id = ${clientRequestId}
          `

          if (rows.length === 0) {
            return Option.none()
          }

          return Option.some(rowToOrderLedger(rows[0]))
        }),

      create: (params: CreateOrderLedgerParams) =>
        Effect.gen(function* () {
          const rows = yield* sql<OrderLedgerRow>`
            INSERT INTO order_ledger (client_request_id, user_id, email, total_amount_cents, currency)
            VALUES (${params.clientRequestId}, ${params.userId}, ${params.email}, ${params.totalAmountCents}, ${params.currency})
            RETURNING id, client_request_id, user_id, email, status,
                      total_amount_cents, currency, payment_authorization_id,
                      retry_count, next_retry_at, created_at, updated_at
          `

          return rowToOrderLedger(rows[0])
        }),

      createItems: (items: ReadonlyArray<CreateOrderLedgerItemParams>) =>
        sql.withTransaction(
          Effect.forEach(items, (item) =>
            Effect.gen(function* () {
              const rows = yield* sql<OrderLedgerItemRow>`
                INSERT INTO order_ledger_items (order_ledger_id, product_id, quantity, unit_price_cents)
                VALUES (${item.orderLedgerId}, ${item.productId}, ${item.quantity}, ${item.unitPriceCents})
                RETURNING id, order_ledger_id, product_id, quantity, unit_price_cents, created_at
              `
              return rowToOrderLedgerItem(rows[0])
            })
          )
        ),

      updateWithAuthorizationAndOutbox: (params: UpdateLedgerWithAuthorizationParams) =>
        Effect.gen(function* () {
          // CRITICAL: All operations must be in a single transaction
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              // 1. Update ledger status
              const ledgerRows = yield* sql<OrderLedgerRow>`
                UPDATE order_ledger
                SET status = ${params.newStatus},
                    payment_authorization_id = ${params.paymentAuthorizationId}
                WHERE id = ${params.orderLedgerId}
                RETURNING id, client_request_id, user_id, email, status,
                          total_amount_cents, currency, payment_authorization_id,
                          retry_count, next_retry_at, created_at, updated_at
              `

              const ledgerRow = ledgerRows[0]

              // 2. Write outbox event
              const outboxPayload = JSON.stringify({
                order_ledger_id: params.orderLedgerId,
                user_id: ledgerRow.user_id,
                email: ledgerRow.email,
                total_amount_cents: ledgerRow.total_amount_cents,
                currency: ledgerRow.currency,
                payment_authorization_id: params.paymentAuthorizationId
              })

              yield* sql`
                INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
                VALUES ('order_ledger', ${params.orderLedgerId}, 'OrderAuthorized', ${outboxPayload}::jsonb)
              `

              // 3. NOTIFY for real-time processing
              yield* sql`SELECT pg_notify('order_events', 'OrderAuthorized')`

              return rowToOrderLedger(ledgerRow)
            })
          )
        }),

      markAuthorizationFailed: (orderLedgerId: OrderLedgerId) =>
        Effect.gen(function* () {
          const rows = yield* sql<OrderLedgerRow>`
            UPDATE order_ledger
            SET status = 'AUTHORIZATION_FAILED'
            WHERE id = ${orderLedgerId}
            RETURNING id, client_request_id, user_id, email, status,
                      total_amount_cents, currency, payment_authorization_id,
                      retry_count, next_retry_at, created_at, updated_at
          `

          return rowToOrderLedger(rows[0])
        }),

      findByIdWithItems: (orderLedgerId: OrderLedgerId) =>
        Effect.gen(function* () {
          // Query the ledger entry
          const ledgerRows = yield* sql<OrderLedgerRow>`
            SELECT id, client_request_id, user_id, email, status,
                   total_amount_cents, currency, payment_authorization_id,
                   retry_count, next_retry_at, created_at, updated_at
            FROM order_ledger
            WHERE id = ${orderLedgerId}
          `

          if (ledgerRows.length === 0) {
            return Option.none()
          }

          const ledger = rowToOrderLedger(ledgerRows[0])

          // Query the items
          const itemRows = yield* sql<OrderLedgerItemRow>`
            SELECT id, order_ledger_id, product_id, quantity, unit_price_cents, created_at
            FROM order_ledger_items
            WHERE order_ledger_id = ${orderLedgerId}
          `

          const items = itemRows.map(rowToOrderLedgerItem)

          return Option.some({ ledger, items })
        })
    }
  })
)
