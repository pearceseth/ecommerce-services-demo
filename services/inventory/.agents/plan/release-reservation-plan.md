# Implementation Plan: DELETE /inventory/reservations/{order_id} - Release Reservation

## Status: COMPLETE

---

## 1. Overview

### 1.1 Feature Summary
Implement the `DELETE /inventory/reservations/{order_id}` endpoint that releases stock reservations for a given order. This is a compensation action called by the Orchestrator Service during saga rollback when a downstream step fails (e.g., payment capture failure).

### 1.2 Business Requirements
- Accept an `order_id` as a path parameter
- Find all `RESERVED` reservations for the order
- Atomically restore stock quantities to the products
- Update reservation status to `RELEASED` with a timestamp
- Support idempotency - calling DELETE multiple times should be safe
- Return appropriate response indicating what was released

### 1.3 Key Design Decisions
1. **Idempotent by design**: If reservations are already released (or don't exist), return success (not an error)
2. **Atomic transaction**: Stock restoration and status update must happen in a single transaction
3. **No-op is success**: An order with no reservations or already-released reservations returns 200 OK
4. **REST semantics**: DELETE on a resource releases/removes it, returning 200 (with body) or 204 (no content)

### 1.4 Current Implementation State
The repository layer (`ReservationRepositoryLive.ts`) already implements `releaseByOrderId`. The service layer (`InventoryServiceLive.ts`) delegates to it. **Only the HTTP API layer needs to be added.**

---

## 2. Files to Create/Modify

### 2.1 Files to Create
| File | Purpose |
|------|---------|
| `src/domain/Reservation.ts` | Add `OrderIdParams` schema for path parameter validation |
| `src/__tests__/api/releaseReservation.test.ts` | Unit tests for HTTP endpoint |

### 2.2 Files to Modify
| File | Changes |
|------|---------|
| `src/api/products.ts` | Add DELETE /reservations/:order_id route |
| `src/repositories/ReservationRepository.ts` | Update `releaseByOrderId` return type to provide release details |
| `src/repositories/ReservationRepositoryLive.ts` | Return release details (count, quantities released) |
| `src/services/InventoryService.ts` | Update `releaseStock` return type |
| `src/services/InventoryServiceLive.ts` | Map release result to service response |

---

## 3. Implementation Details

### 3.1 Step 1: Update Domain Layer

**File: `src/domain/Reservation.ts`**

Add a path parameter schema for order_id validation:

```typescript
// Add alongside existing schemas

// Path parameter schema for DELETE /reservations/:order_id
export class OrderIdParams extends Schema.Class<OrderIdParams>("OrderIdParams")({
  order_id: Schema.UUID
}) {}
```

**Design Notes:**
- Use `Schema.UUID` to validate the path parameter format
- The underscore in `order_id` matches the URL path parameter name (`:order_id`)
- This follows the same pattern as `ProductIdParams` in `Product.ts`

### 3.2 Step 2: Update Repository Layer

**File: `src/repositories/ReservationRepository.ts`**

Update the return type of `releaseByOrderId` to provide release details:

```typescript
// Add new result type for release operation
export interface ReleaseReservationResult {
  readonly releasedCount: number
  readonly totalQuantityRestored: number
  readonly wasAlreadyReleased: boolean
}

// Update the interface method signature
readonly releaseByOrderId: (
  orderId: string
) => Effect.Effect<ReleaseReservationResult, SqlError.SqlError>
```

**Design Notes:**
- `releasedCount`: Number of reservation records that were released (0 if none found or already released)
- `totalQuantityRestored`: Sum of quantities restored to stock
- `wasAlreadyReleased`: True if reservations existed but were already in RELEASED status (for logging/debugging)

**File: `src/repositories/ReservationRepositoryLive.ts`**

Update the implementation to return release details:

```typescript
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
```

**Critical Implementation Notes:**
1. **Transaction boundary**: The entire operation MUST be in `sql.withTransaction()` to ensure atomicity
2. **Idempotency**: If no RESERVED reservations exist, return success with zero counts
3. **Already released check**: Distinguish between "never existed" and "already released" for observability
4. **FOR UPDATE lock**: Prevents concurrent releases from double-restoring stock

### 3.3 Step 3: Update Service Layer

**File: `src/services/InventoryService.ts`**

Update the return type to match the new repository interface:

```typescript
// Add import at top
import type { ReleaseReservationResult } from "../repositories/ReservationRepository.js"

// Update method signature in interface
readonly releaseStock: (
  orderId: string
) => Effect.Effect<ReleaseReservationResult, SqlError.SqlError>
```

**File: `src/services/InventoryServiceLive.ts`**

The implementation already delegates to the repository, no changes needed if the types align. The return type will flow through automatically.

```typescript
// Should already work - just verify types compile
releaseStock: (orderId) =>
  reservationRepo.releaseByOrderId(orderId)
```

### 3.4 Step 4: Add API Route

**File: `src/api/products.ts`**

Add imports and the new route handler:

```typescript
// Add to imports at top
import { OrderIdParams } from "../domain/Reservation.js"

// Add new route handler
const releaseReservation = Effect.gen(function* () {
  // Extract and validate order_id from path parameters
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  // Get service and execute release
  const inventoryService = yield* InventoryService
  const result = yield* inventoryService.releaseStock(orderId)

  // Log the operation
  if (result.releasedCount > 0) {
    yield* Effect.logInfo("Reservations released", {
      orderId,
      releasedCount: result.releasedCount,
      totalQuantityRestored: result.totalQuantityRestored
    })
  } else if (result.wasAlreadyReleased) {
    yield* Effect.logInfo("Reservations already released (idempotent)", { orderId })
  } else {
    yield* Effect.logInfo("No reservations found to release", { orderId })
  }

  // Return response (snake_case for JSON)
  const response = {
    order_id: orderId,
    released_count: result.releasedCount,
    total_quantity_restored: result.totalQuantityRestored,
    message: result.releasedCount > 0
      ? `Released ${result.releasedCount} reservation(s), restored ${result.totalQuantityRestored} units to stock`
      : result.wasAlreadyReleased
        ? "Reservations were already released"
        : "No reservations found for this order"
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("DELETE /inventory/reservations/:order_id"),
  Effect.flatten,
  Effect.catchTags({
    // Path parameter validation errors (400 Bad Request)
    ParseError: (_error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid order_id format. Must be a valid UUID."
        },
        { status: 400 }
      ),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in releaseReservation", { error })
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

// Update ProductRoutes export to include the new route
export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct),
  HttpRouter.post("/products/:product_id/stock", addStock),
  HttpRouter.get("/products/:product_id/availability", getAvailability),
  HttpRouter.post("/reservations", reserveStock),
  HttpRouter.delete("/reservations/:order_id", releaseReservation)  // Add this line
)
```

**HTTP Status Code Rationale:**
- `200 OK`: Operation completed successfully (even if nothing was released - idempotent)
- `400 Bad Request`: Invalid order_id format
- `500 Internal Server Error`: Database errors

**Design Decision - Why 200 instead of 204:**
- 200 with response body provides useful feedback about what happened
- Helps with debugging and logging on the caller side
- The body indicates whether reservations existed and were released vs. already released vs. never existed

---

## 4. Testing Strategy

### 4.1 Create Unit Tests

**File: `src/__tests__/api/releaseReservation.test.ts`**

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqlError } from "@effect/sql"
import { InventoryService } from "../../services/InventoryService.js"
import { ProductService } from "../../services/ProductService.js"
import { OrderIdParams } from "../../domain/Reservation.js"
import type { ReleaseReservationResult } from "../../repositories/ReservationRepository.js"

// Test fixtures
const testOrderId = "550e8400-e29b-41d4-a716-446655440000"

// Response type for our helper function
interface ReleaseResponse {
  status: number
  body: {
    order_id?: string
    released_count?: number
    total_quantity_restored?: number
    message?: string
    error?: string
  }
}

// Mock services
const createMockInventoryService = (overrides: {
  releaseStock?: (orderId: string) => Effect.Effect<ReleaseReservationResult, SqlError.SqlError>
} = {}) => {
  return Layer.succeed(InventoryService, {
    addStock: () => Effect.succeed({} as any),
    getAvailability: () => Effect.succeed(100),
    reserveStock: () => Effect.succeed([]),
    releaseStock: overrides.releaseStock ?? (() => Effect.succeed({
      releasedCount: 0,
      totalQuantityRestored: 0,
      wasAlreadyReleased: false
    }))
  })
}

const createMockProductService = () => {
  return Layer.succeed(ProductService, {
    create: () => Effect.succeed({} as any),
    findById: () => Effect.succeed({} as any),
    findBySku: () => Effect.succeed({} as any)
  })
}

// Helper to run the release logic with mocks
const runReleaseReservation = async (
  orderId: string,
  inventoryService: Layer.Layer<InventoryService>
): Promise<ReleaseResponse> => {
  const productService = createMockProductService()
  const testLayer = Layer.mergeAll(productService, inventoryService)

  return Effect.gen(function* () {
    // Validate path parameter
    const params = yield* Schema.decodeUnknown(OrderIdParams)({ order_id: orderId })

    // Get service and execute release
    const svc = yield* InventoryService
    const result = yield* svc.releaseStock(params.order_id)

    const response = {
      order_id: params.order_id,
      released_count: result.releasedCount,
      total_quantity_restored: result.totalQuantityRestored,
      message: result.releasedCount > 0
        ? `Released ${result.releasedCount} reservation(s), restored ${result.totalQuantityRestored} units to stock`
        : result.wasAlreadyReleased
          ? "Reservations were already released"
          : "No reservations found for this order"
    }

    return { status: 200, body: response } as ReleaseResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid order_id format. Must be a valid UUID."
        }
      } as ReleaseResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as ReleaseResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("DELETE /inventory/reservations/:order_id", () => {
  describe("successful requests", () => {
    it("should return 200 when reservations are released", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 2,
          totalQuantityRestored: 5,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.order_id).toBe(testOrderId)
      expect(result.body.released_count).toBe(2)
      expect(result.body.total_quantity_restored).toBe(5)
      expect(result.body.message).toContain("Released 2 reservation(s)")
    })

    it("should return 200 when no reservations exist (idempotent)", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.released_count).toBe(0)
      expect(result.body.total_quantity_restored).toBe(0)
      expect(result.body.message).toBe("No reservations found for this order")
    })

    it("should return 200 when reservations already released (idempotent)", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: true
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.released_count).toBe(0)
      expect(result.body.message).toBe("Reservations were already released")
    })
  })

  describe("error handling", () => {
    it("should return 400 for invalid order_id format", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReleaseReservation("not-a-uuid", mockInventoryService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
      expect(result.body.message).toContain("Invalid order_id format")
    })

    it("should return 500 for SQL errors", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response body", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 1,
          totalQuantityRestored: 3,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.body).toHaveProperty("order_id")
      expect(result.body).toHaveProperty("released_count")
      expect(result.body).toHaveProperty("total_quantity_restored")
      expect(result.body).not.toHaveProperty("orderId")
      expect(result.body).not.toHaveProperty("releasedCount")
    })
  })

  describe("OrderIdParams schema validation", () => {
    it("should accept valid UUID", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({
        order_id: testOrderId
      })
      expect(result._tag).toBe("Right")
    })

    it("should reject invalid UUID", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({
        order_id: "not-a-uuid"
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject missing order_id", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({})
      expect(result._tag).toBe("Left")
    })
  })
})
```

### 4.2 Test Cases Summary

| Test Case | Expected Status | Description |
|-----------|-----------------|-------------|
| Reservations released | 200 | Normal release with count and quantity |
| No reservations exist | 200 | Idempotent - order never had reservations |
| Already released | 200 | Idempotent - reservations were previously released |
| Invalid order_id | 400 | UUID validation failure |
| SQL error | 500 | Database failure |

---

## 5. API Contract

### 5.1 Request

```
DELETE /inventory/reservations/550e8400-e29b-41d4-a716-446655440000
```

No request body required.

### 5.2 Response (200 OK - Reservations Released)

```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "released_count": 2,
  "total_quantity_restored": 5,
  "message": "Released 2 reservation(s), restored 5 units to stock"
}
```

### 5.3 Response (200 OK - Already Released / Idempotent)

```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "released_count": 0,
  "total_quantity_restored": 0,
  "message": "Reservations were already released"
}
```

### 5.4 Response (200 OK - No Reservations Found)

```json
{
  "order_id": "550e8400-e29b-41d4-a716-446655440000",
  "released_count": 0,
  "total_quantity_restored": 0,
  "message": "No reservations found for this order"
}
```

### 5.5 Response (400 Bad Request)

```json
{
  "error": "validation_error",
  "message": "Invalid order_id format. Must be a valid UUID."
}
```

---

## 6. Implementation Order

Execute in this order to maintain a working codebase at each step:

1. **Update domain layer** - Add `OrderIdParams` schema to `Reservation.ts`
2. **Update repository interface** - Add `ReleaseReservationResult` type to `ReservationRepository.ts`
3. **Update repository implementation** - Modify `releaseByOrderId` in `ReservationRepositoryLive.ts`
4. **Update service interface** - Modify `releaseStock` return type in `InventoryService.ts`
5. **Verify service implementation** - Ensure `InventoryServiceLive.ts` compiles (should just work)
6. **Add API endpoint** - Add route handler and route to `products.ts`
7. **Create tests** - Add `releaseReservation.test.ts`
8. **Run tests** - Verify all tests pass with `npm test`
9. **Manual testing** - Test with curl against running service

---

## 7. Validation Checklist

Before considering implementation complete:

- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] All new code follows existing patterns (Effect.gen, catchTags, Data.TaggedError)
- [ ] Idempotency works (multiple DELETE calls are safe)
- [ ] Atomic transaction ensures stock restoration and status update are consistent
- [ ] Response uses snake_case for JSON keys
- [ ] Telemetry span added (`Effect.withSpan`)
- [ ] Structured logging for all outcomes (released, already released, not found)
- [ ] Unit tests pass (`npm test`)
- [ ] Manual curl test against running service succeeds

---

## 8. Alignment with Engineering Design Document

This implementation aligns with the engineering design document:

| Design Principle | Implementation |
|------------------|----------------|
| **Idempotency** | DELETE is safe to call multiple times; returns success regardless of prior state |
| **Atomicity** | `sql.withTransaction()` ensures stock restoration and status update are atomic |
| **Compensation pattern** | This endpoint IS the compensation action for the reserve step |
| **REST semantics** | DELETE on `/reservations/{order_id}` releases the resource |
| **Error handling** | Uses tagged errors and exhaustive catchTags |

### 8.1 Reference from Engineering Design (Section 8.2)

```
Inventory Service
ReleaseStock(order_id) → void
```

The implementation returns release details instead of void to provide better observability, but the core behavior matches the specification.

---

## 9. Edge Cases and Considerations

### 9.1 Concurrent Release Calls
- **Scenario**: Two orchestrator instances call DELETE simultaneously
- **Protection**: `SELECT FOR UPDATE` locks reservations during the transaction
- **Result**: First call releases, second call sees RELEASED status (idempotent return)

### 9.2 Order With Partial Reservations
- **Scenario**: An order has some RESERVED and some already RELEASED reservations
- **Behavior**: Only RESERVED reservations are released; counts reflect only what was released
- **Note**: This could happen if a previous release was interrupted mid-transaction

### 9.3 Non-existent Order
- **Scenario**: DELETE called with an order_id that never had reservations
- **Behavior**: Returns 200 with `released_count: 0` and appropriate message
- **Rationale**: This is idempotent - the caller wanted reservations released, and they aren't reserved

### 9.4 Product Deleted After Reservation
- **Scenario**: Product was reserved, then product was deleted, now release is called
- **Behavior**: UPDATE on products will affect 0 rows (product doesn't exist)
- **Impact**: Stock not restored (product doesn't exist anyway), reservation marked RELEASED
- **Note**: This is acceptable for a demo; production might want FK CASCADE behavior

---

## 10. Future Considerations

Items explicitly out of scope for this implementation:

1. **Partial release** - Releasing only some items from an order (not needed for saga compensation)
2. **Release by reservation_id** - DELETE /reservations/{reservation_id} for individual releases
3. **Release reason tracking** - Recording why a release happened (compensation, cancellation, etc.)
4. **Metrics** - Could add `Effect.Metric` counter for reservations released

---

## 11. Reference: Existing Patterns

Refer to these files for established patterns:

| Pattern | Reference File | Lines |
|---------|----------------|-------|
| Path parameter schema | `src/domain/Product.ts` | `ProductIdParams` |
| DELETE route handling | Follow same pattern as POST handlers |
| Idempotent response | `src/api/products.ts` | `addStock` (409 response for duplicate) |
| Service delegation | `src/services/InventoryServiceLive.ts` | `releaseStock` |
| Transaction handling | `src/repositories/ReservationRepositoryLive.ts` | `releaseByOrderId` |
