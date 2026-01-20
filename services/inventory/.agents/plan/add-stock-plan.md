# Implementation Plan: POST /inventory/products/{product_id}/stock - Add Stock

**Status: COMPLETE**

## Overview

This plan details the implementation of the Add Stock endpoint for the Inventory Service. This endpoint allows adding stock to an existing product with full idempotency support, audit trail, and proper error handling.

### Feature Summary
- **Endpoint**: `POST /inventory/products/{product_id}/stock`
- **Purpose**: Add stock to an existing product with idempotency via `Idempotency-Key` header
- **Key Concerns**: Idempotency, audit trail via `inventory_adjustments` table, race condition handling, Effect.js patterns

### API Contract (from engineering-design.md Section 8.3)

**Request**:
```
POST /inventory/products/{product_id}/stock
Content-Type: application/json
Idempotency-Key: {adjustment_request_id}

{
  "quantity": 100,
  "reason": "warehouse_receiving",  // warehouse_receiving | manual_adjustment | return_to_stock | correction
  "reference_id": "PO-2024-001",    // Optional: external reference (PO number, etc.)
  "notes": "Q1 restock shipment"    // Optional
}
```

**Response (200 OK)**:
```json
{
  "product_id": "uuid",
  "sku": "WIDGET-001",
  "previous_quantity": 50,
  "added_quantity": 100,
  "new_quantity": 150,
  "adjustment_id": "uuid",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**Response (404 Not Found)**:
```json
{
  "error": "product_not_found",
  "message": "Product with ID {product_id} does not exist"
}
```

**Response (409 Conflict - Idempotent Retry)**:
```json
{
  "adjustment_id": "uuid",
  "message": "This adjustment was already processed",
  "previous_quantity": 50,
  "added_quantity": 100,
  "new_quantity": 150
}
```

---

## Prerequisites

Before implementing, ensure:
1. PostgreSQL is running with the `products` and `inventory_adjustments` tables migrated
2. The `inventory_adjustments` table has a UNIQUE constraint on `idempotency_key`
3. The inventory service starts successfully
4. Familiarity with the existing codebase patterns (see `create-product-plan.md` for reference)

---

## Implementation Steps

### Step 1: Define Domain Types for Stock Adjustment

**File**: `services/inventory/src/domain/Adjustment.ts` (NEW FILE)

Create domain types for the add stock feature:

```typescript
import { Schema } from "effect"

export const AdjustmentId = Schema.UUID.pipe(Schema.brand("AdjustmentId"))
export type AdjustmentId = typeof AdjustmentId.Type

// Valid reasons for stock adjustments (discriminated union approach)
export const AdjustmentReason = Schema.Literal(
  "warehouse_receiving",
  "manual_adjustment",
  "return_to_stock",
  "correction"
)
export type AdjustmentReason = typeof AdjustmentReason.Type

// Domain model for an inventory adjustment (audit record)
export class InventoryAdjustment extends Schema.Class<InventoryAdjustment>("InventoryAdjustment")({
  id: AdjustmentId,
  idempotencyKey: Schema.String,
  productId: Schema.UUID.pipe(Schema.brand("ProductId")),
  quantityChange: Schema.Int,
  previousQuantity: Schema.Int,
  newQuantity: Schema.Int,
  reason: AdjustmentReason,
  referenceId: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc
}) {}

// Request schema with validation
export class AddStockRequest extends Schema.Class<AddStockRequest>("AddStockRequest")({
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" })
  ),
  reason: AdjustmentReason,
  referenceId: Schema.optionalWith(
    Schema.String.pipe(
      Schema.maxLength(255, { message: () => "Reference ID cannot exceed 255 characters" })
    ),
    { as: "Option" }
  ),
  notes: Schema.optionalWith(
    Schema.String.pipe(
      Schema.maxLength(1000, { message: () => "Notes cannot exceed 1000 characters" })
    ),
    { as: "Option" }
  )
}) {}

// Response schema
export class AddStockResponse extends Schema.Class<AddStockResponse>("AddStockResponse")({
  productId: Schema.UUID.pipe(Schema.brand("ProductId")),
  sku: Schema.String,
  previousQuantity: Schema.Int,
  addedQuantity: Schema.Int,
  newQuantity: Schema.Int,
  adjustmentId: AdjustmentId,
  createdAt: Schema.DateTimeUtc
}) {}
```

**Key Design Decisions**:
1. `AdjustmentReason` uses `Schema.Literal` to create a discriminated union - this ensures only valid reasons are accepted and enables exhaustive pattern matching
2. `referenceId` and `notes` use `Schema.optionalWith` with `{ as: "Option" }` to work with Effect's `Option` type
3. All IDs use branded types for type safety
4. Response includes `sku` for human-readable context

---

### Step 2: Define the Idempotency Key Error

**File**: `services/inventory/src/domain/errors.ts` (UPDATE)

Add or verify the `DuplicateAdjustmentError` exists (it should already be there from create-product):

```typescript
/**
 * Idempotency key was already used for a previous adjustment.
 * Includes the existing adjustment for idempotent response.
 */
export class DuplicateAdjustmentError extends Data.TaggedError("DuplicateAdjustmentError")<{
  readonly idempotencyKey: string
  readonly existingAdjustment: {
    readonly adjustmentId: string
    readonly previousQuantity: number
    readonly addedQuantity: number
    readonly newQuantity: number
  }
}> {}
```

**Note**: Update the existing error to include the full adjustment details, not just the ID. This enables returning the original response for idempotent retries.

---

### Step 3: Update Product Domain to Include Methods for Stock Operations

**File**: `services/inventory/src/domain/Product.ts` (UPDATE)

The existing `Product` class should be sufficient. No changes needed unless you want to add validation methods:

```typescript
// Optional: Add a helper method for stock validation
// This could be added if we need to encapsulate stock validation logic
```

---

### Step 4: Create AdjustmentRepository Interface

**File**: `services/inventory/src/repositories/AdjustmentRepository.ts` (NEW FILE)

Define the repository interface for inventory adjustments:

```typescript
import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { InventoryAdjustment, AdjustmentReason, AdjustmentId } from "../domain/Adjustment.js"
import type { ProductId } from "../domain/Product.js"

export interface CreateAdjustmentRow {
  readonly idempotencyKey: string
  readonly productId: ProductId
  readonly quantityChange: number
  readonly previousQuantity: number
  readonly newQuantity: number
  readonly reason: AdjustmentReason
  readonly referenceId: string | null
  readonly notes: string | null
  readonly createdBy: string | null
}

export class AdjustmentRepository extends Context.Tag("AdjustmentRepository")<
  AdjustmentRepository,
  {
    readonly insert: (row: CreateAdjustmentRow) => Effect.Effect<InventoryAdjustment, SqlError.SqlError>
    readonly findByIdempotencyKey: (key: string) => Effect.Effect<Option.Option<InventoryAdjustment>, SqlError.SqlError>
    readonly findById: (id: AdjustmentId) => Effect.Effect<Option.Option<InventoryAdjustment>, SqlError.SqlError>
    readonly findByProductId: (productId: ProductId, limit?: number) => Effect.Effect<readonly InventoryAdjustment[], SqlError.SqlError>
  }
>() {}
```

**Key Design Decisions**:
1. `findByIdempotencyKey` returns `Option` - used for idempotency check
2. `insert` assumes the caller has already verified no duplicate exists (DB constraint is final guard)
3. `findByProductId` returns array for audit history queries (future use)

---

### Step 5: Implement AdjustmentRepositoryLive

**File**: `services/inventory/src/repositories/AdjustmentRepositoryLive.ts` (NEW FILE)

```typescript
import { Layer, Effect, Option, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { AdjustmentRepository, type CreateAdjustmentRow } from "./AdjustmentRepository.js"
import { InventoryAdjustment, AdjustmentId, AdjustmentReason } from "../domain/Adjustment.js"
import type { ProductId } from "../domain/Product.js"

interface AdjustmentRow {
  id: string
  idempotency_key: string
  product_id: string
  quantity_change: number
  previous_quantity: number
  new_quantity: number
  reason: string
  reference_id: string | null
  notes: string | null
  created_by: string | null
  created_at: Date
}

const mapRowToAdjustment = (row: AdjustmentRow): InventoryAdjustment =>
  new InventoryAdjustment({
    id: row.id as AdjustmentId,
    idempotencyKey: row.idempotency_key,
    productId: row.product_id as ProductId,
    quantityChange: row.quantity_change,
    previousQuantity: row.previous_quantity,
    newQuantity: row.new_quantity,
    reason: row.reason as AdjustmentReason,
    referenceId: row.reference_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: DateTime.unsafeFromDate(row.created_at)
  })

export const AdjustmentRepositoryLive = Layer.effect(
  AdjustmentRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      insert: (row: CreateAdjustmentRow) =>
        Effect.gen(function* () {
          const result = yield* sql<AdjustmentRow>`
            INSERT INTO inventory_adjustments (
              idempotency_key, product_id, quantity_change,
              previous_quantity, new_quantity, reason,
              reference_id, notes, created_by
            )
            VALUES (
              ${row.idempotencyKey}, ${row.productId}, ${row.quantityChange},
              ${row.previousQuantity}, ${row.newQuantity}, ${row.reason},
              ${row.referenceId}, ${row.notes}, ${row.createdBy}
            )
            RETURNING *
          `
          return mapRowToAdjustment(result[0])
        }),

      findByIdempotencyKey: (key: string) =>
        Effect.gen(function* () {
          const result = yield* sql<AdjustmentRow>`
            SELECT * FROM inventory_adjustments WHERE idempotency_key = ${key}
          `
          return result.length > 0
            ? Option.some(mapRowToAdjustment(result[0]))
            : Option.none()
        }),

      findById: (id: AdjustmentId) =>
        Effect.gen(function* () {
          const result = yield* sql<AdjustmentRow>`
            SELECT * FROM inventory_adjustments WHERE id = ${id}
          `
          return result.length > 0
            ? Option.some(mapRowToAdjustment(result[0]))
            : Option.none()
        }),

      findByProductId: (productId: ProductId, limit = 100) =>
        Effect.gen(function* () {
          const result = yield* sql<AdjustmentRow>`
            SELECT * FROM inventory_adjustments
            WHERE product_id = ${productId}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `
          return result.map(mapRowToAdjustment)
        })
    }
  })
)
```

**Key Implementation Notes**:
1. Uses parameterized queries to prevent SQL injection
2. Maps snake_case DB columns to camelCase domain properties
3. `findByIdempotencyKey` is used for queries; atomic operations use the pattern in Step 5b
4. The DB's UNIQUE constraint on `idempotency_key` provides defense-in-depth

---

### Step 5b: Create Atomic Stock Adjustment Repository

**File**: `services/inventory/src/repositories/StockAdjustmentRepository.ts` (NEW FILE)

This repository handles the atomic "add stock with idempotency" operation using a single SQL statement with CTEs. This eliminates the race condition that exists with check-then-insert patterns.

```typescript
import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { InventoryAdjustment, AdjustmentReason } from "../domain/Adjustment.js"
import type { ProductId } from "../domain/Product.js"

export interface AtomicAddStockParams {
  readonly idempotencyKey: string
  readonly productId: ProductId
  readonly quantity: number
  readonly reason: AdjustmentReason
  readonly referenceId: string | null
  readonly notes: string | null
  readonly createdBy: string | null
}

export type AtomicAddStockResult =
  | { readonly _tag: "Created"; readonly adjustment: InventoryAdjustment; readonly sku: string }
  | { readonly _tag: "AlreadyExists"; readonly adjustment: InventoryAdjustment }
  | { readonly _tag: "ProductNotFound" }

export class StockAdjustmentRepository extends Context.Tag("StockAdjustmentRepository")<
  StockAdjustmentRepository,
  {
    /**
     * Atomically adds stock to a product with idempotency guarantee.
     *
     * This operation is fully atomic - it either:
     * 1. Creates a new adjustment and updates stock (if idempotency key is new)
     * 2. Returns the existing adjustment (if idempotency key already used)
     * 3. Returns ProductNotFound (if product doesn't exist)
     *
     * There is NO race condition window - concurrent requests with the same
     * idempotency key will never double-increment stock.
     */
    readonly addStockAtomic: (
      params: AtomicAddStockParams
    ) => Effect.Effect<AtomicAddStockResult, SqlError.SqlError>
  }
>() {}
```

**File**: `services/inventory/src/repositories/StockAdjustmentRepositoryLive.ts` (NEW FILE)

```typescript
import { Layer, Effect, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { StockAdjustmentRepository, type AtomicAddStockParams, type AtomicAddStockResult } from "./StockAdjustmentRepository.js"
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
              WHERE id = ${params.productId}
                AND NOT EXISTS (SELECT 1 FROM check_existing)
            ),
            update_stock AS (
              -- Update stock only if: no existing adjustment AND product exists
              UPDATE products
              SET
                stock_quantity = stock_quantity + ${params.quantity},
                updated_at = NOW()
              WHERE id = ${params.productId}
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
                ${params.productId},
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
```

**Why This Works (No Race Condition)**:

The entire CTE executes as a single SQL statement. PostgreSQL guarantees that:
1. All CTEs see the same snapshot of data
2. The UPDATE in `update_stock` only runs if `check_existing` found nothing
3. The INSERT in `insert_adjustment` only runs if `update_stock` succeeded
4. If two concurrent requests arrive, PostgreSQL's row-level locking ensures only one UPDATE succeeds

```
Time    Request A                      Request B
─────────────────────────────────────────────────────────────
T1      Execute CTE (single statement)
        - check_existing: None
        - update_stock: OK (acquires row lock)
        - insert_adjustment: OK
        → Returns "created"

T2                                     Execute CTE (single statement)
                                       - check_existing: finds A's adjustment
                                       - update_stock: SKIPPED (check_existing exists)
                                       - insert_adjustment: SKIPPED
                                       → Returns "already_exists"
```

Even if both start simultaneously, the row lock on the `products` table during UPDATE serializes them.

---

### Step 6: Update ProductRepository for Stock Operations

**File**: `services/inventory/src/repositories/ProductRepository.ts` (UPDATE)

Add method for atomic stock update with locking:

```typescript
import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { Product, ProductId } from "../domain/Product.js"

export interface CreateProductRow {
  readonly name: string
  readonly sku: string
  readonly priceCents: number
  readonly stockQuantity: number
}

export class ProductRepository extends Context.Tag("ProductRepository")<
  ProductRepository,
  {
    readonly insert: (row: CreateProductRow) => Effect.Effect<Product, SqlError.SqlError>
    readonly findById: (id: ProductId) => Effect.Effect<Option.Option<Product>, SqlError.SqlError>
    readonly findBySku: (sku: string) => Effect.Effect<Option.Option<Product>, SqlError.SqlError>
    readonly updateStock: (id: ProductId, quantity: number) => Effect.Effect<void, SqlError.SqlError>
    // NEW: Atomic increment with current value return (for adjustment record)
    readonly incrementStock: (
      id: ProductId,
      amount: number
    ) => Effect.Effect<{ previousQuantity: number; newQuantity: number }, SqlError.SqlError>
  }
>() {}
```

---

### Step 7: Update ProductRepositoryLive with incrementStock

**File**: `services/inventory/src/repositories/ProductRepositoryLive.ts` (UPDATE)

Add the `incrementStock` implementation:

```typescript
// Add to the existing repository implementation:

incrementStock: (id: ProductId, amount: number) =>
  Effect.gen(function* () {
    // Use a single atomic UPDATE with RETURNING to get both old and new values
    // This avoids race conditions without explicit locking for simple increments
    const result = yield* sql<{ previous_quantity: number; new_quantity: number }>`
      UPDATE products
      SET
        stock_quantity = stock_quantity + ${amount},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING
        stock_quantity - ${amount} AS previous_quantity,
        stock_quantity AS new_quantity
    `

    if (result.length === 0) {
      // Product not found - this will be handled by service layer
      // Return sentinel values (service should check product exists first)
      return { previousQuantity: -1, newQuantity: -1 }
    }

    return {
      previousQuantity: result[0].previous_quantity,
      newQuantity: result[0].new_quantity
    }
  })
```

**Key Design Decision**: Using a single UPDATE with arithmetic in the SET clause is atomic. We don't need SELECT FOR UPDATE for simple increments because:
1. `stock_quantity = stock_quantity + amount` is atomic in PostgreSQL
2. We get both values via RETURNING with arithmetic
3. No read-then-write race condition

**Alternative (if explicit lock needed)**: For operations that need to validate current stock (like reservations), use SELECT FOR UPDATE. For simple additions, the atomic UPDATE is sufficient.

---

### Step 8: Create InventoryService Interface

**File**: `services/inventory/src/services/InventoryService.ts` (UPDATE or CREATE)

If InventoryService.ts already exists, add the `addStock` method. Otherwise create:

```typescript
import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { ProductId } from "../domain/Product.js"
import type { AddStockRequest, AddStockResponse } from "../domain/Adjustment.js"
import type { ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"

export class InventoryService extends Context.Tag("InventoryService")<
  InventoryService,
  {
    readonly addStock: (
      productId: ProductId,
      idempotencyKey: string,
      request: AddStockRequest
    ) => Effect.Effect<
      AddStockResponse,
      ProductNotFoundError | DuplicateAdjustmentError | SqlError.SqlError
    >
  }
>() {}
```

---

### Step 9: Implement InventoryServiceLive

**File**: `services/inventory/src/services/InventoryServiceLive.ts` (NEW FILE or UPDATE)

```typescript
import { Layer, Effect, Option } from "effect"
import { InventoryService } from "./InventoryService.js"
import { StockAdjustmentRepository } from "../repositories/StockAdjustmentRepository.js"
import { ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"
import type { ProductId } from "../domain/Product.js"
import type { AddStockRequest, AddStockResponse, AdjustmentId } from "../domain/Adjustment.js"

export const InventoryServiceLive = Layer.effect(
  InventoryService,
  Effect.gen(function* () {
    const stockAdjustmentRepo = yield* StockAdjustmentRepository

    return {
      addStock: (productId: ProductId, idempotencyKey: string, request: AddStockRequest) =>
        Effect.gen(function* () {
          // Execute the atomic operation - this handles:
          // 1. Idempotency check
          // 2. Product existence check
          // 3. Stock update
          // 4. Adjustment record creation
          // All in a single SQL statement with no race condition window
          const result = yield* stockAdjustmentRepo.addStockAtomic({
            idempotencyKey,
            productId,
            quantity: request.quantity,
            reason: request.reason,
            referenceId: Option.getOrNull(request.referenceId),
            notes: Option.getOrNull(request.notes),
            createdBy: null // Could be populated from auth context in future
          })

          // Handle the three possible outcomes using pattern matching
          switch (result._tag) {
            case "ProductNotFound":
              return yield* Effect.fail(new ProductNotFoundError({
                productId,
                searchedBy: "id"
              }))

            case "AlreadyExists":
              // Return as error - the API handler converts to 409 with original result
              return yield* Effect.fail(new DuplicateAdjustmentError({
                idempotencyKey,
                existingAdjustment: {
                  adjustmentId: result.adjustment.id,
                  previousQuantity: result.adjustment.previousQuantity,
                  addedQuantity: result.adjustment.quantityChange,
                  newQuantity: result.adjustment.newQuantity
                }
              }))

            case "Created":
              // Success - build and return response
              return {
                productId: result.adjustment.productId,
                sku: result.sku,
                previousQuantity: result.adjustment.previousQuantity,
                addedQuantity: result.adjustment.quantityChange,
                newQuantity: result.adjustment.newQuantity,
                adjustmentId: result.adjustment.id as AdjustmentId,
                createdAt: result.adjustment.createdAt
              } as AddStockResponse
          }
        })
    }
  })
)
```

**Key Implementation Notes**:

1. **Single Atomic Operation**: The entire add-stock operation (idempotency check, product validation, stock update, and audit record) is performed in a single SQL statement via `addStockAtomic`. There is NO race condition window.

2. **Discriminated Union Result**: The repository returns a tagged union (`Created | AlreadyExists | ProductNotFound`) that enables exhaustive pattern matching. TypeScript will error if we don't handle all cases.

3. **Clean Service Layer**: The service layer becomes thin - it delegates to the atomic repository and maps results to domain errors/responses. Business logic complexity is pushed to the SQL layer where atomicity is guaranteed.

4. **Return Existing Result on Duplicate**: When `AlreadyExists` is returned, we convert to `DuplicateAdjustmentError` containing the original adjustment data. The API handler returns this as a 409 with the original result, achieving true idempotency.

5. **Option Handling**: Use `Option.getOrNull` when converting Effect Options to nullable values for the DB.

---

### Step 10: Update Layers Composition

**File**: `services/inventory/src/layers.ts` (UPDATE)

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { ProductRepositoryLive } from "./repositories/ProductRepositoryLive.js"
import { AdjustmentRepositoryLive } from "./repositories/AdjustmentRepositoryLive.js"
import { StockAdjustmentRepositoryLive } from "./repositories/StockAdjustmentRepositoryLive.js"
import { ProductServiceLive } from "./services/ProductServiceLive.js"
import { InventoryServiceLive } from "./services/InventoryServiceLive.js"

// Repository layer depends on database
const RepositoryLive = Layer.mergeAll(
  ProductRepositoryLive,
  AdjustmentRepositoryLive,
  StockAdjustmentRepositoryLive
).pipe(Layer.provide(DatabaseLive))

// Service layer depends on repositories
const ServiceLive = Layer.mergeAll(
  ProductServiceLive,
  InventoryServiceLive
).pipe(Layer.provide(RepositoryLive))

// Export composed application layer
export const AppLive = Layer.mergeAll(DatabaseLive, ServiceLive)
```

---

### Step 11: Implement the HTTP Route Handler

**File**: `services/inventory/src/api/products.ts` (UPDATE)

Add the stock route to the existing ProductRoutes:

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, DateTime, ParseResult, Option } from "effect"
import { CreateProductRequest, ProductId } from "../domain/Product.js"
import { AddStockRequest } from "../domain/Adjustment.js"
import { ProductService } from "../services/ProductService.js"
import { InventoryService } from "../services/InventoryService.js"
import type { DuplicateSkuError, ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"

// Existing createProduct handler...

// POST /products/:product_id/stock - Add stock to a product
const addStock = Effect.gen(function* () {
  // Extract product_id from path parameters
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = request.url.split("/")
  // URL format: /inventory/products/{product_id}/stock
  const productIdIndex = params.indexOf("products") + 1
  const productId = params[productIdIndex] as ProductId

  // Validate product_id is a valid UUID
  if (!productId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) {
    return yield* HttpServerResponse.json(
      {
        error: "validation_error",
        message: "Invalid product_id format. Must be a valid UUID."
      },
      { status: 400 }
    )
  }

  // Extract Idempotency-Key header
  const idempotencyKey = request.headers["idempotency-key"]
  if (!idempotencyKey) {
    return yield* HttpServerResponse.json(
      {
        error: "missing_idempotency_key",
        message: "Idempotency-Key header is required"
      },
      { status: 400 }
    )
  }

  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(AddStockRequest)

  // Get the service and add stock
  const inventoryService = yield* InventoryService
  const result = yield* inventoryService.addStock(productId, idempotencyKey, body)

  yield* Effect.logInfo("Stock added", {
    productId: result.productId,
    sku: result.sku,
    addedQuantity: result.addedQuantity,
    newQuantity: result.newQuantity
  })

  // Map to response
  const response = {
    product_id: result.productId,
    sku: result.sku,
    previous_quantity: result.previousQuantity,
    added_quantity: result.addedQuantity,
    new_quantity: result.newQuantity,
    adjustment_id: result.adjustmentId,
    created_at: DateTime.formatIso(result.createdAt)
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("POST /inventory/products/:product_id/stock"),
  Effect.flatten,
  Effect.catchTags({
    // Schema validation errors (400 Bad Request)
    ParseError: (error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid request data",
          details: error.message
        },
        { status: 400 }
      ),

    // Product not found (404 Not Found)
    ProductNotFoundError: (error: ProductNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        },
        { status: 404 }
      ),

    // Duplicate idempotency key (409 Conflict - idempotent retry)
    // Return the ORIGINAL result for true idempotency
    DuplicateAdjustmentError: (error: DuplicateAdjustmentError) =>
      HttpServerResponse.json(
        {
          adjustment_id: error.existingAdjustment.adjustmentId,
          message: "This adjustment was already processed",
          previous_quantity: error.existingAdjustment.previousQuantity,
          added_quantity: error.existingAdjustment.addedQuantity,
          new_quantity: error.existingAdjustment.newQuantity
        },
        { status: 409 }
      ),

    // Request body parsing errors (400 Bad Request)
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        {
          error: "request_error",
          message: "Failed to parse request body"
        },
        { status: 400 }
      ),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in addStock", { error })
        return HttpServerResponse.json(
          {
            error: "internal_error",
            message: "An unexpected error occurred"
          },
          { status: 500 }
        )
      }).pipe(Effect.flatten)
  })
)

// Update router to include both routes
export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct),
  HttpRouter.post("/products/:product_id/stock", addStock)
)
```

**Key Implementation Notes**:

1. **Path Parameter Extraction**: Extract `product_id` from the URL path. Validate it's a valid UUID format.

2. **Idempotency-Key Header**: Required header for idempotency. Return 400 if missing.

3. **409 Response for Duplicates**: When `DuplicateAdjustmentError` is caught, return the original result with 409 status. This achieves true idempotency - clients get the same result on retry.

4. **Response Field Naming**: Use snake_case in JSON responses to match the API contract in engineering-design.md.

5. **Logging**: Log successful stock additions with context for observability.

---

### Step 12: Alternative Path Parameter Handling with HttpRouter.params

**File**: `services/inventory/src/api/products.ts` (ALTERNATIVE)

Effect platform may provide better path parameter handling. Check if `HttpRouter.params` is available:

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Schema } from "effect"

// Define path params schema
const StockPathParams = Schema.Struct({
  product_id: Schema.UUID.pipe(Schema.brand("ProductId"))
})

const addStock = HttpRouter.params(StockPathParams).pipe(
  Effect.flatMap((params) =>
    Effect.gen(function* () {
      const productId = params.product_id
      // ... rest of handler
    })
  )
)
```

If this pattern isn't available in the current version, use the manual URL parsing approach in Step 11.

---

### Step 13: Update Error Types (if needed)

**File**: `services/inventory/src/domain/errors.ts` (UPDATE)

Ensure `DuplicateAdjustmentError` has the structure needed for the 409 response:

```typescript
import { Data } from "effect"

// ... existing errors ...

/**
 * Idempotency key was already used for a previous adjustment.
 * Includes the full existing adjustment details for idempotent response.
 */
export class DuplicateAdjustmentError extends Data.TaggedError("DuplicateAdjustmentError")<{
  readonly idempotencyKey: string
  readonly existingAdjustment: {
    readonly adjustmentId: string
    readonly previousQuantity: number
    readonly addedQuantity: number
    readonly newQuantity: number
  }
}> {}
```

---

## Testing Plan

### Manual Testing with curl

```bash
# Start the service
npm run dev:inventory

# First, create a product to test with
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Widget",
    "sku": "TEST-WIDGET-001",
    "priceCents": 2999,
    "initialStock": 50
  }'

# Save the product_id from the response

# Add stock (success case)
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-001" \
  -d '{
    "quantity": 100,
    "reason": "warehouse_receiving",
    "reference_id": "PO-2024-001",
    "notes": "Q1 restock shipment"
  }'

# Expected: 200 OK with adjustment details
# {
#   "product_id": "...",
#   "sku": "TEST-WIDGET-001",
#   "previous_quantity": 50,
#   "added_quantity": 100,
#   "new_quantity": 150,
#   "adjustment_id": "...",
#   "created_at": "..."
# }

# Retry with same Idempotency-Key (idempotent retry)
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-001" \
  -d '{
    "quantity": 100,
    "reason": "warehouse_receiving"
  }'

# Expected: 409 Conflict with original result
# {
#   "adjustment_id": "...",
#   "message": "This adjustment was already processed",
#   "previous_quantity": 50,
#   "added_quantity": 100,
#   "new_quantity": 150
# }

# Add stock with different idempotency key
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-002" \
  -d '{
    "quantity": 25,
    "reason": "return_to_stock",
    "notes": "Customer return - order #12345"
  }'

# Expected: 200 OK
# previous_quantity: 150, new_quantity: 175

# Test with non-existent product
curl -X POST http://localhost:3001/inventory/products/00000000-0000-0000-0000-000000000000/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-003" \
  -d '{
    "quantity": 10,
    "reason": "manual_adjustment"
  }'

# Expected: 404 Not Found

# Test missing idempotency key
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 10,
    "reason": "manual_adjustment"
  }'

# Expected: 400 Bad Request - missing idempotency key

# Test invalid reason
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-004" \
  -d '{
    "quantity": 10,
    "reason": "invalid_reason"
  }'

# Expected: 400 Bad Request - validation error

# Test negative quantity
curl -X POST http://localhost:3001/inventory/products/{product_id}/stock \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: adj-2024-005" \
  -d '{
    "quantity": -10,
    "reason": "correction"
  }'

# Expected: 400 Bad Request - quantity must be positive
```

### Database Verification

```sql
-- Check product stock was updated
SELECT id, sku, stock_quantity FROM products WHERE sku = 'TEST-WIDGET-001';

-- Check adjustment records
SELECT * FROM inventory_adjustments WHERE product_id = '{product_id}' ORDER BY created_at;

-- Verify idempotency key uniqueness
SELECT idempotency_key, COUNT(*) FROM inventory_adjustments GROUP BY idempotency_key;
```

### Unit Tests

**File**: `services/inventory/src/__tests__/InventoryService.test.ts` (NEW FILE)

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime, Exit } from "effect"
import { InventoryService } from "../services/InventoryService.js"
import { InventoryServiceLive } from "../services/InventoryServiceLive.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { AdjustmentRepository } from "../repositories/AdjustmentRepository.js"
import { Product, ProductId } from "../domain/Product.js"
import { InventoryAdjustment, AdjustmentId, AddStockRequest } from "../domain/Adjustment.js"
import { ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"

// Test fixtures
const testProductId = "550e8400-e29b-41d4-a716-446655440000" as ProductId
const testProduct = new Product({
  id: testProductId,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 50,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testAddStockRequest = new AddStockRequest({
  quantity: 100,
  reason: "warehouse_receiving",
  referenceId: Option.some("PO-2024-001"),
  notes: Option.some("Q1 restock")
})

describe("InventoryService.addStock", () => {
  it("should add stock successfully with new idempotency key", async () => {
    // Mock repositories...
    // Test implementation...
  })

  it("should return existing adjustment for duplicate idempotency key", async () => {
    // Test idempotency...
  })

  it("should fail with ProductNotFoundError for non-existent product", async () => {
    // Test error case...
  })
})
```

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/domain/Adjustment.ts` | CREATE | Domain types for adjustments (AdjustmentId, AdjustmentReason, InventoryAdjustment, AddStockRequest, AddStockResponse) |
| `src/domain/errors.ts` | UPDATE | Update DuplicateAdjustmentError to include full adjustment details |
| `src/repositories/AdjustmentRepository.ts` | CREATE | Interface for adjustment CRUD operations |
| `src/repositories/AdjustmentRepositoryLive.ts` | CREATE | SQL implementation of AdjustmentRepository |
| `src/repositories/StockAdjustmentRepository.ts` | CREATE | Interface for atomic stock adjustment operation |
| `src/repositories/StockAdjustmentRepositoryLive.ts` | CREATE | **Atomic CTE-based implementation** - handles idempotency, stock update, and audit in single SQL statement |
| `src/services/InventoryService.ts` | CREATE or UPDATE | Add addStock method signature |
| `src/services/InventoryServiceLive.ts` | CREATE | Thin service layer that delegates to atomic repository |
| `src/api/products.ts` | UPDATE | Add POST /products/:product_id/stock route handler |
| `src/layers.ts` | UPDATE | Add StockAdjustmentRepository and InventoryService layers |
| `src/__tests__/InventoryService.test.ts` | CREATE | Unit tests for addStock

---

## Checklist for Implementation

- [ ] Create `Adjustment.ts` domain types (AdjustmentId, AdjustmentReason, InventoryAdjustment, AddStockRequest, AddStockResponse)
- [ ] Update `errors.ts` - ensure DuplicateAdjustmentError includes full adjustment details
- [ ] Create `AdjustmentRepository.ts` interface
- [ ] Create `AdjustmentRepositoryLive.ts` implementation
- [ ] Update `ProductRepository.ts` - add incrementStock signature
- [ ] Update `ProductRepositoryLive.ts` - add incrementStock implementation
- [ ] Create/Update `InventoryService.ts` - add addStock signature
- [ ] Create `InventoryServiceLive.ts` with idempotency logic
- [ ] Update `layers.ts` - compose new repositories and services
- [ ] Update `api/products.ts` - add POST /products/:product_id/stock handler
- [ ] Test with curl commands
- [ ] Verify database entries and idempotency
- [ ] Run TypeScript type check (`npm run typecheck`)
- [ ] Create unit tests

---

## Potential Issues and Mitigations

| Issue | Mitigation |
|-------|------------|
| Race condition on idempotency check | **Eliminated** - Atomic CTE executes check, update, and insert as single statement. Row-level locking serializes concurrent requests. See engineering-design.md Section 6.5. |
| Path parameter extraction | Validate UUID format before using |
| Missing Idempotency-Key header | Return 400 with clear error message |
| Idempotency key reused across products | The atomic operation returns existing adjustment regardless of product - caller should verify if needed |
| Stock goes negative | For addStock, quantity must be positive (validated by schema) |
| SQL injection | Use parameterized queries via sql template literals |
| Complex CTE debugging | The CTE returns `result_type` discriminator for clear outcome identification |

---

## References

- Engineering Design Document: `engineering-design.md` sections 3.4 (inventory_adjustments schema), 8.3 (API Contract)
- Project Best Practices: `.claude/resources/best-practices.md`
- Create Product Plan: `services/inventory/.agents/plan/create-product-plan.md` (reference patterns)
- Effect.js Platform docs: https://effect.website/docs/platform/introduction/
- Effect Schema docs: https://effect.website/docs/schema/introduction/
