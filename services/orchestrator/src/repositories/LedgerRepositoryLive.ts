import { Layer, Effect, Option, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { LedgerRepository, type LedgerWithItems } from "./LedgerRepository.js"
import {
  OrderLedger,
  OrderLedgerItem,
  type OrderLedgerId,
  type OrderLedgerStatus,
  type UserId,
  type ProductId
} from "../domain/OrderLedger.js"

interface LedgerRow {
  id: string
  client_request_id: string
  user_id: string
  email: string
  status: string
  total_amount_cents: number
  currency: string
  payment_authorization_id: string | null
  order_id: string | null
  created_at: Date
  updated_at: Date
}

interface LedgerWithItemsRow extends LedgerRow {
  item_id: string | null
  product_id: string | null
  quantity: number | null
  unit_price_cents: number | null
  item_created_at: Date | null
}

const rowToLedger = (row: LedgerRow): OrderLedger =>
  new OrderLedger({
    id: row.id as OrderLedgerId,
    clientRequestId: row.client_request_id,
    userId: row.user_id as UserId,
    email: row.email,
    status: row.status as OrderLedgerStatus,
    totalAmountCents: row.total_amount_cents,
    currency: row.currency,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    updatedAt: DateTime.unsafeFromDate(row.updated_at)
  })

export const LedgerRepositoryLive = Layer.effect(
  LedgerRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      findByIdWithItems: (id: OrderLedgerId) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerWithItemsRow>`
            SELECT
              ol.id, ol.client_request_id, ol.user_id, ol.email, ol.status,
              ol.total_amount_cents, ol.currency, ol.payment_authorization_id,
              ol.order_id, ol.created_at, ol.updated_at,
              oli.id as item_id, oli.product_id, oli.quantity, oli.unit_price_cents,
              oli.created_at as item_created_at
            FROM order_ledger ol
            LEFT JOIN order_ledger_items oli ON oli.order_ledger_id = ol.id
            WHERE ol.id = ${id}
          `

          if (rows.length === 0) {
            return Option.none()
          }

          const ledger = rowToLedger(rows[0])
          const items = rows
            .filter((row): row is LedgerWithItemsRow & { item_id: string } => row.item_id !== null)
            .map((row) =>
              new OrderLedgerItem({
                id: row.item_id,
                orderLedgerId: row.id as OrderLedgerId,
                productId: row.product_id as ProductId,
                quantity: row.quantity!,
                unitPriceCents: row.unit_price_cents!,
                createdAt: DateTime.unsafeFromDate(row.item_created_at!)
              })
            )

          return Option.some({ ledger, items } satisfies LedgerWithItems)
        }).pipe(Effect.orDie),

      updateStatus: (id: OrderLedgerId, newStatus: OrderLedgerStatus) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerRow>`
            UPDATE order_ledger
            SET status = ${newStatus}
            WHERE id = ${id}
            RETURNING *
          `
          yield* Effect.logDebug("Updated ledger status", { id, newStatus })
          return rowToLedger(rows[0])
        }).pipe(Effect.orDie),

      updateStatusWithOrderId: (id: OrderLedgerId, newStatus: OrderLedgerStatus, orderId: string) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerRow>`
            UPDATE order_ledger
            SET status = ${newStatus}, order_id = ${orderId}
            WHERE id = ${id}
            RETURNING *
          `
          yield* Effect.logDebug("Updated ledger status with order ID", { id, newStatus, orderId })
          return rowToLedger(rows[0])
        }).pipe(Effect.orDie)
    }
  })
)
