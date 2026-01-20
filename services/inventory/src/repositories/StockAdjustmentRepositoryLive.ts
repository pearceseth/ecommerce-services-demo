import { Layer, Effect, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { StockAdjustmentRepository, type AtomicAddStockParams } from "./StockAdjustmentRepository.js"
import { InventoryAdjustment, AdjustmentId, AdjustmentReason } from "../domain/Adjustment.js"
import type { ProductId } from "../domain/Product.js"

interface AtomicResultRow {
  // Discriminator for result type
  result_type: "created" | "already_exists" | "product_not_found"
  // Adjustment fields (null if product_not_found)
  adjustment_id: string | null
  idempotency_key: string | null
  product_id: string | null
  quantity_change: number | null
  previous_quantity: number | null
  new_quantity: number | null
  reason: string | null
  reference_id: string | null
  notes: string | null
  created_by: string | null
  created_at: Date | null
  // Product fields
  sku: string | null
}

export const StockAdjustmentRepositoryLive = Layer.effect(
  StockAdjustmentRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      addStockAtomic: (params: AtomicAddStockParams) =>
        Effect.gen(function* () {
          /**
           * Atomic CTE-based operation:
           *
           * 1. check_existing: Look for existing adjustment with this idempotency key
           * 2. check_product: Verify product exists (only if no existing adjustment)
           * 3. update_stock: Conditionally update stock (only if new and product exists)
           * 4. insert_adjustment: Conditionally insert adjustment record
           * 5. Final SELECT: Return appropriate result based on what happened
           *
           * The key insight is that all CTEs execute in a single statement,
           * so there's no window for concurrent requests to interleave.
           */
          const result = yield* sql<AtomicResultRow>`
            WITH check_existing AS (
              -- Check if this idempotency key was already used
              SELECT ia.*, p.sku
              FROM inventory_adjustments ia
              JOIN products p ON p.id = ia.product_id
              WHERE ia.idempotency_key = ${params.idempotencyKey}
            ),
            check_product AS (
              -- Get product info (only needed if no existing adjustment)
              SELECT id, sku, stock_quantity
              FROM products
              WHERE id = ${params.productId}::uuid
                AND NOT EXISTS (SELECT 1 FROM check_existing)
            ),
            update_stock AS (
              -- Update stock only if: no existing adjustment AND product exists
              UPDATE products
              SET
                stock_quantity = stock_quantity + ${params.quantity},
                updated_at = NOW()
              WHERE id = ${params.productId}::uuid
                AND NOT EXISTS (SELECT 1 FROM check_existing)
                AND EXISTS (SELECT 1 FROM check_product)
              RETURNING
                id,
                stock_quantity - ${params.quantity} AS previous_quantity,
                stock_quantity AS new_quantity
            ),
            insert_adjustment AS (
              -- Insert adjustment only if stock was updated
              INSERT INTO inventory_adjustments (
                idempotency_key, product_id, quantity_change,
                previous_quantity, new_quantity, reason,
                reference_id, notes, created_by
              )
              SELECT
                ${params.idempotencyKey},
                ${params.productId}::uuid,
                ${params.quantity},
                us.previous_quantity,
                us.new_quantity,
                ${params.reason},
                ${params.referenceId},
                ${params.notes},
                ${params.createdBy}
              FROM update_stock us
              RETURNING *
            )
            -- Return the appropriate result
            SELECT
              CASE
                WHEN EXISTS (SELECT 1 FROM check_existing) THEN 'already_exists'
                WHEN EXISTS (SELECT 1 FROM insert_adjustment) THEN 'created'
                ELSE 'product_not_found'
              END AS result_type,
              COALESCE(ia.id, ce.id)::text AS adjustment_id,
              COALESCE(ia.idempotency_key, ce.idempotency_key) AS idempotency_key,
              COALESCE(ia.product_id, ce.product_id)::text AS product_id,
              COALESCE(ia.quantity_change, ce.quantity_change) AS quantity_change,
              COALESCE(ia.previous_quantity, ce.previous_quantity) AS previous_quantity,
              COALESCE(ia.new_quantity, ce.new_quantity) AS new_quantity,
              COALESCE(ia.reason, ce.reason) AS reason,
              COALESCE(ia.reference_id, ce.reference_id) AS reference_id,
              COALESCE(ia.notes, ce.notes) AS notes,
              COALESCE(ia.created_by, ce.created_by) AS created_by,
              COALESCE(ia.created_at, ce.created_at) AS created_at,
              COALESCE(cp.sku, ce.sku) AS sku
            FROM (SELECT 1) AS dummy
            LEFT JOIN insert_adjustment ia ON true
            LEFT JOIN check_existing ce ON true
            LEFT JOIN check_product cp ON true
          `

          const row = result[0]

          if (row.result_type === "product_not_found") {
            return { _tag: "ProductNotFound" } as const
          }

          const adjustment = new InventoryAdjustment({
            id: row.adjustment_id as AdjustmentId,
            idempotencyKey: row.idempotency_key!,
            productId: row.product_id as ProductId,
            quantityChange: row.quantity_change!,
            previousQuantity: row.previous_quantity!,
            newQuantity: row.new_quantity!,
            reason: row.reason as AdjustmentReason,
            referenceId: row.reference_id,
            notes: row.notes,
            createdBy: row.created_by,
            createdAt: DateTime.unsafeFromDate(row.created_at!)
          })

          if (row.result_type === "already_exists") {
            return { _tag: "AlreadyExists", adjustment } as const
          }

          return { _tag: "Created", adjustment, sku: row.sku! } as const
        })
    }
  })
)
