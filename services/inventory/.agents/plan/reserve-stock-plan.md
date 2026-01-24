# Implementation Plan: POST /inventory/reservations - Reserve Stock for Order

## Status: PENDING

---

## 1. Overview

### 1.1 Feature Summary
Implement the `POST /inventory/reservations` endpoint that atomically reserves stock for an order. This endpoint is called by the Orchestrator Service during saga execution to ensure inventory is available before payment capture.

### 1.2 Business Requirements
- Accept an order ID and list of items (product ID + quantity)
- Verify all products exist before any reservation
- Verify sufficient stock is available for ALL items (all-or-nothing)
- Atomically decrement stock quantities and create reservation records
- Support idempotency via `order_id + product_id` unique constraint
- Return reservation IDs on success
- Return detailed error on insufficient stock (which product, requested vs available)

### 1.3 Key Design Decisions
1. **All-or-nothing semantics**: If ANY item has insufficient stock, the entire reservation fails (no partial reservations)
2. **Idempotency via unique constraint**: The `(order_id, product_id)` unique constraint in `inventory_reservations` handles retries
3. **SELECT FOR UPDATE**: Lock product rows in consistent order to prevent deadlocks and oversell
4. **Single transaction**: All checks and reservations happen in one database transaction
5. **Explicit transaction control via `sql.withTransaction`**: Multiple SQL statements in `Effect.gen` do NOT automatically share a transaction. You MUST wrap the operation with `sql.withTransaction()` to ensure atomicity.

---

## 2. Files to Create/Modify

### 2.1 Files to Create
| File | Purpose |
|------|---------|
| `src/repositories/ReservationRepository.ts` | Repository interface for reservation operations |
| `src/repositories/ReservationRepositoryLive.ts` | Implementation with atomic SQL operations |
| `src/__tests__/ReservationRepository.test.ts` | Unit tests for repository |
| `src/__tests__/reserveStock.service.test.ts` | Unit tests for service layer |
| `src/__tests__/api/reserveStock.test.ts` | Integration tests for HTTP endpoint |

### 2.2 Files to Modify
| File | Changes |
|------|---------|
| `src/domain/Reservation.ts` | Add domain types (create new file) |
| `src/domain/errors.ts` | Add `DuplicateReservationError` if needed |
| `src/services/InventoryService.ts` | Already has interface - no changes needed |
| `src/services/InventoryServiceLive.ts` | Implement `reserveStock` method |
| `src/api/products.ts` | Add POST /reserve route |
| `src/layers.ts` | Add ReservationRepositoryLive to layer composition |

---

## 3. Domain Layer Implementation

### 3.1 Create `src/domain/Reservation.ts`

```typescript
// Define branded types and schemas for reservations
import { Schema } from "effect"
import { ProductId } from "./Product.js"

// Branded type for reservation IDs
export const ReservationId = Schema.UUID.pipe(Schema.brand("ReservationId"))
export type ReservationId = typeof ReservationId.Type

// Reservation status enum
export const ReservationStatus = Schema.Literal("RESERVED", "RELEASED")
export type ReservationStatus = typeof ReservationStatus.Type

// Domain model for a reservation
export class InventoryReservation extends Schema.Class<InventoryReservation>("InventoryReservation")({
  id: ReservationId,
  orderId: Schema.String,
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive()),
  status: ReservationStatus,
  createdAt: Schema.DateTimeUtc,
  releasedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}

// Request schema for a single item in the reserve request
export class ReserveItemRequest extends Schema.Class<ReserveItemRequest>("ReserveItemRequest")({
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive())
}) {}

// Full request schema for the HTTP endpoint
export class ReserveStockHttpRequest extends Schema.Class<ReserveStockHttpRequest>("ReserveStockHttpRequest")({
  orderId: Schema.UUID,
  items: Schema.Array(ReserveItemRequest).pipe(Schema.minItems(1))
}) {}
```

**Design Notes:**
- Use `Schema.Int.pipe(Schema.positive())` to ensure quantities are positive integers
- Use `Schema.Array(...).pipe(Schema.minItems(1))` to ensure at least one item
- The `orderId` is a UUID string (not branded) since it comes from another service
- `ReservationStatus` uses `Schema.Literal` for type-safe enum values

### 3.2 Update `src/domain/errors.ts`

Add a new error type for duplicate reservation attempts (idempotent retry):

```typescript
/**
 * Reservation already exists for this order and product combination.
 * This indicates an idempotent retry - return the existing reservation.
 */
export class DuplicateReservationError extends Data.TaggedError("DuplicateReservationError")<{
  readonly orderId: string
  readonly productId: string
  readonly existingReservationId: string
}> {}
```

**Note:** This error may not be needed if we handle idempotency purely at the SQL level by returning existing reservations. Evaluate during implementation.

---

## 4. Repository Layer Implementation

### 4.1 Create `src/repositories/ReservationRepository.ts`

```typescript
import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { ProductId } from "../domain/Product.js"
import type { InventoryReservation, ReservationId } from "../domain/Reservation.js"
import type { InsufficientStockError, ProductNotFoundError } from "../domain/errors.js"

// Input type for a single reservation item
export interface ReserveItemInput {
  readonly productId: ProductId
  readonly quantity: number
}

// Result type for atomic reserve operation - discriminated union
export type AtomicReserveResult =
  | { readonly _tag: "Reserved"; readonly reservations: ReadonlyArray<InventoryReservation> }
  | { readonly _tag: "AlreadyReserved"; readonly reservations: ReadonlyArray<InventoryReservation> }
  | { readonly _tag: "InsufficientStock"; readonly productId: string; readonly productSku: string; readonly requested: number; readonly available: number }
  | { readonly _tag: "ProductNotFound"; readonly productId: string }

export class ReservationRepository extends Context.Tag("ReservationRepository")<
  ReservationRepository,
  {
    /**
     * Atomically reserve stock for multiple items in a single transaction.
     * Uses SELECT FOR UPDATE to prevent oversell.
     * Returns discriminated union indicating success or specific failure reason.
     */
    readonly reserveStockAtomic: (
      orderId: string,
      items: ReadonlyArray<ReserveItemInput>
    ) => Effect.Effect<AtomicReserveResult, SqlError.SqlError>

    /**
     * Find all reservations for an order.
     */
    readonly findByOrderId: (
      orderId: string
    ) => Effect.Effect<ReadonlyArray<InventoryReservation>, SqlError.SqlError>

    /**
     * Release all reservations for an order (compensation action).
     * Updates status to RELEASED and restores stock quantities.
     */
    readonly releaseByOrderId: (
      orderId: string
    ) => Effect.Effect<void, SqlError.SqlError>
  }
>() {}
```

**Design Notes:**
- Use discriminated union (`AtomicReserveResult`) for the result type, following the established pattern from `StockAdjustmentRepository`
- Include `AlreadyReserved` tag for idempotent retry handling
- Include all context needed for error responses in the failure tags

### 4.2 Create `src/repositories/ReservationRepositoryLive.ts`

This is the most complex part of the implementation. The SQL must:
1. Lock all requested product rows (in ID order to prevent deadlocks)
2. Verify all products exist
3. Verify all products have sufficient stock
4. Decrement stock quantities
5. Insert reservation records
6. Handle idempotent retries (return existing reservations)

**Implementation approach: Multi-step transaction with Effect.acquireUseRelease**

```typescript
import { Layer, Effect, DateTime, Option } from "effect"
import { PgClient, SqlError } from "@effect/sql-pg"
import { ReservationRepository, type AtomicReserveResult, type ReserveItemInput } from "./ReservationRepository.js"
import { InventoryReservation, ReservationId } from "../domain/Reservation.js"
import type { ProductId } from "../domain/Product.js"

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
    const sql = yield* PgClient.PgClient

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
              WHERE order_id = ${orderId}
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
              if (inserted.length > 0) {
                reservations.push(mapRowToReservation(inserted[0]))
              }
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
        // Also requires transaction to ensure stock restoration and status update are atomic
        sql.withTransaction(
          Effect.gen(function* () {
            // Get reservations to release
            const reservations = yield* sql<ReservationRow>`
              SELECT id, order_id, product_id, quantity, status, created_at, released_at
              FROM inventory_reservations
              WHERE order_id = ${orderId}::uuid
                AND status = 'RESERVED'
              FOR UPDATE
            `

            // Restore stock for each reservation
            for (const res of reservations) {
              yield* sql`
                UPDATE products
                SET stock_quantity = stock_quantity + ${res.quantity},
                    updated_at = NOW()
                WHERE id = ${res.product_id}::uuid
              `
            }

            // Mark reservations as released
            yield* sql`
              UPDATE inventory_reservations
              SET status = 'RELEASED',
                  released_at = NOW()
              WHERE order_id = ${orderId}::uuid
                AND status = 'RESERVED'
            `
          })
        )
    }

    // Helper function to map database row to domain model
    function mapRowToReservation(row: ReservationRow): InventoryReservation {
      return new InventoryReservation({
        id: row.id as ReservationId,
        orderId: row.order_id,
        productId: row.product_id as ProductId,
        quantity: row.quantity,
        status: row.status as "RESERVED" | "RELEASED",
        createdAt: DateTime.unsafeFromDate(row.created_at),
        releasedAt: row.released_at ? DateTime.unsafeFromDate(row.released_at) : null
      })
    }
  })
)
```

**Critical Implementation Notes:**

1. **Lock Ordering**: Products are sorted by ID before locking to prevent deadlock scenarios where two concurrent requests lock products in different orders.

2. **SELECT FOR UPDATE**: This acquires row-level locks that block other transactions from reading (with FOR UPDATE) or modifying these rows until the transaction completes.

3. **All-or-nothing validation**: Check ALL products exist and have sufficient stock BEFORE making any changes.

4. **Idempotency check first**: Check for existing reservations before acquiring locks to avoid unnecessary contention on idempotent retries.

5. **Transaction boundary**: The entire `reserveStockAtomic` method MUST execute within a single transaction. With @effect/sql-pg, **multiple SQL statements in `Effect.gen` do NOT automatically share a transaction** - each statement gets its own connection from the pool. You MUST wrap the operation with `sql.withTransaction(effect)` to ensure all statements (SELECT FOR UPDATE, UPDATE, INSERT) execute atomically. Without this, locks are released between statements and oversell becomes possible.

**Alternative: Single CTE approach**

If you prefer the single-statement CTE pattern used in `StockAdjustmentRepositoryLive`, it's possible but significantly more complex for multi-item reservations. The multi-step approach above is clearer and the `SELECT FOR UPDATE` still provides the necessary concurrency control.

---

## 5. Service Layer Implementation

### 5.1 Update `src/services/InventoryServiceLive.ts`

Replace the placeholder `reserveStock` and `releaseStock` implementations:

```typescript
// Add import
import { ReservationRepository } from "../repositories/ReservationRepository.js"
import { InsufficientStockError, ProductNotFoundError } from "../domain/errors.js"
import { Match } from "effect"

// In the Layer.effect generator, add:
const reservationRepo = yield* ReservationRepository

// Replace reserveStock implementation:
reserveStock: (request) =>
  Effect.gen(function* () {
    const result = yield* reservationRepo.reserveStockAtomic(
      request.orderId,
      request.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    )

    // Handle the discriminated union result
    return yield* Match.value(result).pipe(
      Match.tag("ProductNotFound", ({ productId }) =>
        Effect.fail(new ProductNotFoundError({ productId, searchedBy: "id" }))
      ),
      Match.tag("InsufficientStock", ({ productId, productSku, requested, available }) =>
        Effect.fail(new InsufficientStockError({
          productId,
          productSku,
          requested,
          available
        }))
      ),
      Match.tag("AlreadyReserved", ({ reservations }) =>
        // Idempotent retry - return existing reservation IDs
        Effect.succeed(reservations.map(r => r.id))
      ),
      Match.tag("Reserved", ({ reservations }) =>
        Effect.succeed(reservations.map(r => r.id))
      ),
      Match.exhaustive
    )
  }),

// Replace releaseStock implementation:
releaseStock: (orderId) =>
  reservationRepo.releaseByOrderId(orderId)
```

**Design Notes:**
- The service layer translates repository results into domain errors
- Both `AlreadyReserved` and `Reserved` return the same shape (reservation IDs) for seamless idempotency
- `releaseStock` delegates directly to the repository

---

## 6. API Layer Implementation

### 6.1 Update `src/api/products.ts`

Add the new route handler and register it:

```typescript
// Add imports
import { ReserveStockHttpRequest } from "../domain/Reservation.js"
import type { InsufficientStockError } from "../domain/errors.js"

// Add route handler
const reserveStock = Effect.gen(function* () {
  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(ReserveStockHttpRequest)

  // Get service and execute reservation
  const inventoryService = yield* InventoryService
  const reservationIds = yield* inventoryService.reserveStock({
    orderId: body.orderId,
    items: body.items.map(item => ({
      productId: item.productId,
      quantity: item.quantity
    }))
  })

  yield* Effect.logInfo("Stock reserved", {
    orderId: body.orderId,
    itemCount: body.items.length,
    reservationIds
  })

  // Return response
  const response = {
    order_id: body.orderId,
    reservation_ids: reservationIds,
    items_reserved: body.items.length
  }

  return HttpServerResponse.json(response, { status: 201 })
}).pipe(
  Effect.withSpan("POST /inventory/reservations"),
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

    // Insufficient stock (409 Conflict)
    // Using 409 because the request conflicts with current resource state
    InsufficientStockError: (error: InsufficientStockError) =>
      HttpServerResponse.json(
        {
          error: "insufficient_stock",
          message: `Insufficient stock for product ${error.productSku}`,
          product_id: error.productId,
          product_sku: error.productSku,
          requested: error.requested,
          available: error.available
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
        yield* Effect.logError("Database error in reserveStock", { error })
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

// Update ProductRoutes export
export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct),
  HttpRouter.post("/products/:product_id/stock", addStock),
  HttpRouter.get("/products/:product_id/availability", getAvailability),
  HttpRouter.post("/reservations", reserveStock)  // Add this line
)
```

**HTTP Status Code Rationale:**
- `201 Created`: Reservation successfully created
- `400 Bad Request`: Invalid request format or validation errors
- `404 Not Found`: Product doesn't exist
- `409 Conflict`: Insufficient stock (state conflict) - the request is valid but cannot be fulfilled due to current state

---

## 7. Layer Composition

### 7.1 Update `src/layers.ts`

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { ProductRepositoryLive } from "./repositories/ProductRepositoryLive.js"
import { StockAdjustmentRepositoryLive } from "./repositories/StockAdjustmentRepositoryLive.js"
import { ReservationRepositoryLive } from "./repositories/ReservationRepositoryLive.js"  // Add
import { ProductServiceLive } from "./services/ProductServiceLive.js"
import { InventoryServiceLive } from "./services/InventoryServiceLive.js"

// Repository layer depends on database
const RepositoryLive = Layer.mergeAll(
  ProductRepositoryLive,
  StockAdjustmentRepositoryLive,
  ReservationRepositoryLive  // Add
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

## 8. Testing Strategy

### 8.1 Unit Tests for Service Layer

Create `src/__tests__/reserveStock.service.test.ts`:

**Test cases:**
1. Successfully reserve stock for single item
2. Successfully reserve stock for multiple items
3. Fail with `ProductNotFoundError` when product doesn't exist
4. Fail with `InsufficientStockError` when stock is insufficient
5. Return existing reservations on idempotent retry
6. Verify correct parameters passed to repository

**Mock pattern:**
```typescript
const createMockReservationRepo = (overrides = {}) => {
  return Layer.succeed(ReservationRepository, {
    reserveStockAtomic: overrides.reserveStockAtomic ?? (() =>
      Effect.succeed({ _tag: "Reserved", reservations: [...] } as const)),
    findByOrderId: overrides.findByOrderId ?? (() => Effect.succeed([])),
    releaseByOrderId: overrides.releaseByOrderId ?? (() => Effect.void)
  })
}
```

### 8.2 Integration Tests for HTTP Endpoint

Create `src/__tests__/api/reserveStock.test.ts`:

**Test cases:**
1. `201` - Successfully reserve stock
2. `400` - Invalid request body (missing orderId, empty items array, negative quantity)
3. `404` - Product not found
4. `409` - Insufficient stock
5. `409` - Idempotent retry returns same result

### 8.3 Repository Tests (Optional)

If testing against a real database is desired, create `src/__tests__/ReservationRepository.test.ts` with integration tests that verify:
1. Concurrent reservations don't oversell
2. Lock ordering prevents deadlocks
3. Idempotency via unique constraint

---

## 9. API Contract

### 9.1 Request

```
POST /inventory/reservations
Content-Type: application/json

{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "productId": "660e8400-e29b-41d4-a716-446655440001",
      "quantity": 2
    },
    {
      "productId": "770e8400-e29b-41d4-a716-446655440002",
      "quantity": 1
    }
  ]
}
```

### 9.2 Response (201 Created)

```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "reservation_ids": [
    "880e8400-e29b-41d4-a716-446655440003",
    "990e8400-e29b-41d4-a716-446655440004"
  ],
  "items_reserved": 2
}
```

### 9.3 Response (409 Conflict - Insufficient Stock)

```json
{
  "error": "insufficient_stock",
  "message": "Insufficient stock for product WIDGET-001",
  "product_id": "660e8400-e29b-41d4-a716-446655440001",
  "product_sku": "WIDGET-001",
  "requested": 5,
  "available": 3
}
```

### 9.4 Response (404 Not Found)

```json
{
  "error": "product_not_found",
  "message": "Product with ID 660e8400-e29b-41d4-a716-446655440001 does not exist"
}
```

---

## 10. Implementation Order

Execute in this order to maintain a working codebase at each step:

1. **Domain layer** - Create `Reservation.ts` with types and schemas
2. **Repository interface** - Create `ReservationRepository.ts`
3. **Repository implementation** - Create `ReservationRepositoryLive.ts`
4. **Update layers** - Add repository to `layers.ts`
5. **Service implementation** - Update `InventoryServiceLive.ts`
6. **Service tests** - Create and verify `reserveStock.service.test.ts`
7. **API endpoint** - Add route to `products.ts`
8. **API tests** - Create and verify `reserveStock.test.ts`
9. **Manual testing** - Test with curl/httpie against running service

---

## 11. Validation Checklist

Before considering implementation complete:

- [ ] All new code follows existing patterns (Effect.gen, Match.tag, Data.TaggedError)
- [ ] Idempotency works (same request returns same response)
- [ ] Concurrency is safe (SELECT FOR UPDATE prevents oversell)
- [ ] Lock ordering prevents deadlocks (products locked by ID order)
- [ ] All-or-nothing semantics (partial reservation is impossible)
- [ ] Error responses include context for debugging
- [ ] Telemetry spans added (`Effect.withSpan`)
- [ ] Structured logging added (`Effect.logInfo`, `Effect.logError`)
- [ ] Unit tests pass
- [ ] TypeScript compiles without errors
- [ ] Snake_case used for JSON responses, camelCase for internal code

---

## 12. Future Considerations

Items explicitly out of scope for this implementation:

1. **Reservation expiration** - Reservations don't expire; they're released via compensation
2. **Partial reservations** - Business requirement is all-or-nothing
3. **Batch optimization** - Single INSERT with UNNEST could be more efficient for many items
4. **Metrics** - Could add `Effect.Metric` counters for reservations created/failed

---

## 13. Reference: Existing Patterns

Refer to these files for established patterns:

| Pattern | Reference File | Lines |
|---------|----------------|-------|
| Atomic CTE operation | `StockAdjustmentRepositoryLive.ts` | 46-118 |
| Discriminated union result | `StockAdjustmentRepository.ts` | 24-28 |
| Match.tag pattern matching | `InventoryServiceLive.ts` | 35-62 |
| HTTP error handling | `api/products.ts` | 36-81 |
| Service unit tests | `InventoryService.test.ts` | Full file |
| Mock repository factory | `InventoryService.test.ts` | 48-74 |
