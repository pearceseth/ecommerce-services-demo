import { Layer, Effect, DateTime, Schema } from "effect"
import { SqlClient } from "@effect/sql"
import { ReservationRepository, type ReserveItemInput } from "./ReservationRepository.js"
import { InventoryReservation, ReservationId, ReservationStatus } from "../domain/Reservation.js"
import { ProductId } from "../domain/Product.js"

// Row types for database results
interface ProductStockRow {
  id: string
  sku: string
  stock_quantity: number
}

interface ReservationRow {
  id: string
  order_id: string
  product_id: string
  quantity: number
  status: string
  created_at: Date
  released_at: Date | null
}

export const ReservationRepositoryLive = Layer.effect(
  ReservationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    // Helper function to map database row to domain model
    // Uses Schema.decodeUnknownSync for type-safe validation of branded types
    const mapRowToReservation = (row: ReservationRow): InventoryReservation => {
      return new InventoryReservation({
        id: Schema.decodeUnknownSync(ReservationId)(row.id),
        orderId: row.order_id,
        productId: Schema.decodeUnknownSync(ProductId)(row.product_id),
        quantity: row.quantity,
        status: Schema.decodeUnknownSync(ReservationStatus)(row.status),
        createdAt: DateTime.unsafeFromDate(row.created_at),
        releasedAt: row.released_at ? DateTime.unsafeFromDate(row.released_at) : null
      })
    }

    return {
      reserveStockAtomic: (orderId: string, items: ReadonlyArray<ReserveItemInput>) =>
        // IMPORTANT: Multiple SQL statements in Effect.gen do NOT automatically share a transaction.
        // We MUST use sql.withTransaction to ensure all operations are atomic.
        // Without this, SELECT FOR UPDATE locks would be released between statements, allowing oversell.
        sql.withTransaction(
          Effect.gen(function* () {
            // Sort product IDs to ensure consistent lock ordering (prevents deadlocks)
            const sortedItems = [...items].sort((a, b) =>
              a.productId.localeCompare(b.productId)
            )
            const productIds = sortedItems.map(item => item.productId)

            // Step 1: Check for existing reservations (idempotency)
            const existingReservations = yield* sql<ReservationRow>`
              SELECT id, order_id, product_id, quantity, status, created_at, released_at
              FROM inventory_reservations
              WHERE order_id = ${orderId}::uuid
                AND status = 'RESERVED'
            `

            if (existingReservations.length > 0) {
              // Idempotent retry - return existing reservations
              const mapped = existingReservations.map(row => mapRowToReservation(row))
              return { _tag: "AlreadyReserved", reservations: mapped } as const
            }

            // Step 2: Lock product rows and get current stock (SELECT FOR UPDATE)
            const products = yield* sql<ProductStockRow>`
              SELECT id, sku, stock_quantity
              FROM products
              WHERE id = ANY(${productIds}::uuid[])
              ORDER BY id
              FOR UPDATE
            `

            // Step 3: Verify all products exist
            const productMap = new Map(products.map(p => [p.id, p]))
            for (const item of sortedItems) {
              if (!productMap.has(item.productId)) {
                return { _tag: "ProductNotFound", productId: item.productId } as const
              }
            }

            // Step 4: Verify sufficient stock for all items
            for (const item of sortedItems) {
              const product = productMap.get(item.productId)!
              if (product.stock_quantity < item.quantity) {
                return {
                  _tag: "InsufficientStock",
                  productId: item.productId,
                  productSku: product.sku,
                  requested: item.quantity,
                  available: product.stock_quantity
                } as const
              }
            }

            // Step 5: Decrement stock for all products
            for (const item of sortedItems) {
              yield* sql`
                UPDATE products
                SET stock_quantity = stock_quantity - ${item.quantity},
                    updated_at = NOW()
                WHERE id = ${item.productId}::uuid
              `
            }

            // Step 6: Insert reservation records
            const reservations: InventoryReservation[] = []
            for (const item of sortedItems) {
              const inserted = yield* sql<ReservationRow>`
                INSERT INTO inventory_reservations (order_id, product_id, quantity, status)
                VALUES (${orderId}::uuid, ${item.productId}::uuid, ${item.quantity}, 'RESERVED')
                RETURNING id, order_id, product_id, quantity, status, created_at, released_at
              `
              // INSERT with RETURNING should always return exactly 1 row
              if (inserted.length !== 1) {
                return yield* Effect.die(
                  new Error(`INSERT reservation failed: expected 1 row, got ${inserted.length}`)
                )
              }
              reservations.push(mapRowToReservation(inserted[0]))
            }

            return { _tag: "Reserved", reservations } as const
          })
        ),

      findByOrderId: (orderId: string) =>
        Effect.gen(function* () {
          const rows = yield* sql<ReservationRow>`
            SELECT id, order_id, product_id, quantity, status, created_at, released_at
            FROM inventory_reservations
            WHERE order_id = ${orderId}::uuid
          `
          return rows.map(mapRowToReservation)
        }),

      releaseByOrderId: (orderId: string) =>
        // Transaction ensures stock restoration and status update are atomic
        sql.withTransaction(
          Effect.gen(function* () {
            // Step 1: Get reservations to release (lock for update)
            const reservations = yield* sql<ReservationRow>`
              SELECT id, order_id, product_id, quantity, status, created_at, released_at
              FROM inventory_reservations
              WHERE order_id = ${orderId}::uuid
                AND status = 'RESERVED'
              FOR UPDATE
            `

            // Early return if no reservations to release
            if (reservations.length === 0) {
              // Check if reservations exist but are already released
              const existingReleased = yield* sql<{ count: number }>`
                SELECT COUNT(*)::int AS count
                FROM inventory_reservations
                WHERE order_id = ${orderId}::uuid
                  AND status = 'RELEASED'
              `
              const wasAlreadyReleased = existingReleased[0]?.count > 0

              return {
                releasedCount: 0,
                totalQuantityRestored: 0,
                wasAlreadyReleased
              }
            }

            // Step 2: Calculate total quantity to restore
            const totalQuantityRestored = reservations.reduce(
              (sum, res) => sum + res.quantity,
              0
            )

            // Step 3: Restore stock for each reservation
            for (const res of reservations) {
              yield* sql`
                UPDATE products
                SET stock_quantity = stock_quantity + ${res.quantity},
                    updated_at = NOW()
                WHERE id = ${res.product_id}::uuid
              `
            }

            // Step 4: Mark reservations as released
            yield* sql`
              UPDATE inventory_reservations
              SET status = 'RELEASED',
                  released_at = NOW()
              WHERE order_id = ${orderId}::uuid
                AND status = 'RESERVED'
            `

            return {
              releasedCount: reservations.length,
              totalQuantityRestored,
              wasAlreadyReleased: false
            }
          })
        )
    }
  })
)
