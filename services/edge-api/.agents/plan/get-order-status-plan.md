# Implementation Plan: GET /orders/{order_ledger_id} - Get Order Status and Details

## Status: COMPLETE

---

## 1. Overview

This endpoint allows clients to query the status and details of an order by its `order_ledger_id`. This is the companion read endpoint to the existing `POST /orders` endpoint. The response includes the current ledger status, order items, and conditionally includes the associated order details (if an order has been created through the saga).

### API Contract (from engineering-design.md)

```
GET /orders/{order_ledger_id}

Response (200 OK):
{
  "order_ledger_id": "uuid",
  "status": "COMPLETED",
  "order": {
    "id": "uuid",
    "items": [...],
    "total_amount_cents": 9999,
    "currency": "USD"
  }
}
```

### Key Design Decisions

1. **Single source of truth**: Query from `order_ledger` table (owned by Edge API)
2. **Include items from ledger**: Return `order_ledger_items` with the response
3. **Conditional order details**: If saga has progressed past `ORDER_CREATED`, include the order ID from a join or separate query
4. **No external service calls**: This is a read operation against Edge API's owned tables only

---

## 2. Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/domain/OrderLedger.ts` | MODIFY | Add `OrderLedgerIdParams` schema for path parameter validation |
| `src/domain/errors.ts` | MODIFY | Add `OrderLedgerNotFoundError` tagged error |
| `src/repositories/OrderLedgerRepository.ts` | MODIFY | Add `findByIdWithItems` method signature |
| `src/repositories/OrderLedgerRepositoryLive.ts` | MODIFY | Implement `findByIdWithItems` |
| `src/services/OrderService.ts` | MODIFY | Add `getOrderStatus` method signature |
| `src/services/OrderServiceLive.ts` | MODIFY | Implement `getOrderStatus` |
| `src/api/orders.ts` | MODIFY | Add GET route handler and mount to router |
| `src/__tests__/api/orders.test.ts` | MODIFY | Add tests for GET endpoint |

---

## 3. Implementation Steps

### Step 3.1: Add Path Parameter Schema

**File**: `src/domain/OrderLedger.ts`

Add a schema for validating the path parameter:

```typescript
// Path parameter schema for GET /orders/:order_ledger_id
export const OrderLedgerIdParams = Schema.Struct({
  order_ledger_id: OrderLedgerId
})
```

This follows the pattern established in `services/orders/src/domain/Order.ts` with `OrderIdParams`.

### Step 3.2: Add OrderLedgerNotFoundError

**File**: `src/domain/errors.ts`

Add a new tagged error for when the order ledger entry is not found:

```typescript
// Order ledger entry not found
export class OrderLedgerNotFoundError extends Data.TaggedError("OrderLedgerNotFoundError")<{
  readonly orderLedgerId: string
}> {}
```

**Design rationale**: Include `orderLedgerId` for debugging/logging. This follows the established pattern of other `NotFoundError` types in the codebase.

### Step 3.3: Add Repository Method

**File**: `src/repositories/OrderLedgerRepository.ts`

Add the new method signature to the repository interface:

```typescript
/**
 * Find order ledger by ID with its items.
 * Used for the GET /orders/{order_ledger_id} endpoint.
 */
readonly findByIdWithItems: (
  orderLedgerId: OrderLedgerId
) => Effect.Effect<Option.Option<{ ledger: OrderLedger; items: ReadonlyArray<OrderLedgerItem> }>, SqlError.SqlError>
```

**Design rationale**:
- Return `Option` to let the service layer decide how to handle not-found (converts to `OrderLedgerNotFoundError`)
- Return both `ledger` and `items` to enable a single service call
- Uses `ReadonlyArray` for immutability

### Step 3.4: Implement Repository Method

**File**: `src/repositories/OrderLedgerRepositoryLive.ts`

Implement the method:

```typescript
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
```

**Implementation notes**:
- Two queries (ledger + items) is acceptable for this use case
- Could use a single JOIN query for optimization if needed, but separate queries are clearer
- Reuses existing `rowToOrderLedger` and `rowToOrderLedgerItem` converters

### Step 3.5: Add Service Method Signature

**File**: `src/services/OrderService.ts`

Add the new method signature. Create a new result type for the response:

```typescript
// Result type for getOrderStatus
export interface OrderStatusResult {
  readonly orderLedgerId: string
  readonly clientRequestId: string
  readonly status: string
  readonly userId: string
  readonly email: string
  readonly totalAmountCents: number
  readonly currency: string
  readonly paymentAuthorizationId: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly items: ReadonlyArray<{
    readonly productId: string
    readonly quantity: number
    readonly unitPriceCents: number
  }>
}
```

Add to the service interface:

```typescript
/**
 * Get order status and details by order_ledger_id.
 * Returns full ledger info including items.
 */
readonly getOrderStatus: (
  orderLedgerId: string
) => Effect.Effect<
  OrderStatusResult,
  | OrderLedgerNotFoundError
  | SqlError.SqlError
>
```

**Design rationale**:
- Uses a dedicated result type for clarity
- Includes all relevant fields from the ledger
- Items are flattened to a simple structure (no nested IDs that aren't useful to the client)
- Timestamps as ISO strings for easy serialization

### Step 3.6: Implement Service Method

**File**: `src/services/OrderServiceLive.ts`

Add the import for `OrderLedgerNotFoundError` and implement the method:

```typescript
import { OrderLedgerNotFoundError } from "../domain/errors.js"

// Inside the service implementation:
getOrderStatus: (orderLedgerId: string) =>
  Effect.gen(function* () {
    const repo = yield* OrderLedgerRepository

    // Cast to branded type
    const ledgerId = orderLedgerId as OrderLedgerId

    // Fetch ledger with items
    const result = yield* repo.findByIdWithItems(ledgerId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new OrderLedgerNotFoundError({ orderLedgerId })),
          onSome: Effect.succeed
        })
      )
    )

    // Map to response format
    return {
      orderLedgerId: result.ledger.id,
      clientRequestId: result.ledger.clientRequestId,
      status: result.ledger.status,
      userId: result.ledger.userId,
      email: result.ledger.email,
      totalAmountCents: result.ledger.totalAmountCents,
      currency: result.ledger.currency,
      paymentAuthorizationId: result.ledger.paymentAuthorizationId,
      createdAt: result.ledger.createdAt.toString(),
      updatedAt: result.ledger.updatedAt.toString(),
      items: result.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents
      }))
    }
  }).pipe(Effect.withSpan("OrderService.getOrderStatus"))
```

**Implementation notes**:
- Uses `Option.match` pattern from best-practices.md
- Adds OpenTelemetry span for observability
- Formats DateTime to ISO string at service boundary

### Step 3.7: Add Route Handler

**File**: `src/api/orders.ts`

Add the GET route handler:

```typescript
import { OrderLedgerIdParams } from "../domain/OrderLedger.js"
import type { OrderLedgerNotFoundError } from "../domain/errors.js"

// GET /orders/:order_ledger_id - Get order status and details
export const getOrderStatus = Effect.gen(function* () {
  // 1. Parse and validate path parameter
  const { order_ledger_id: orderLedgerId } = yield* HttpRouter.schemaPathParams(OrderLedgerIdParams)

  // 2. Fetch order status from service
  const orderService = yield* OrderService
  const result = yield* orderService.getOrderStatus(orderLedgerId)

  yield* Effect.logInfo("Order status retrieved", {
    orderLedgerId: result.orderLedgerId,
    status: result.status
  })

  // 3. Return 200 OK with snake_case response
  return HttpServerResponse.json({
    order_ledger_id: result.orderLedgerId,
    status: result.status,
    user_id: result.userId,
    email: result.email,
    total_amount_cents: result.totalAmountCents,
    currency: result.currency,
    payment_authorization_id: result.paymentAuthorizationId,
    created_at: result.createdAt,
    updated_at: result.updatedAt,
    items: result.items.map(item => ({
      product_id: item.productId,
      quantity: item.quantity,
      unit_price_cents: item.unitPriceCents
    }))
  })
}).pipe(
  Effect.withSpan("GET /orders/:order_ledger_id"),
  Effect.flatten,
  Effect.catchTags({
    // Path parameter validation errors (400 Bad Request)
    ParseError: () =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid order_ledger_id format. Must be a valid UUID."
        },
        { status: 400 }
      ),

    // Order ledger not found (404 Not Found)
    OrderLedgerNotFoundError: (error: OrderLedgerNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "not_found",
          message: `Order with ID ${error.orderLedgerId} not found`
        },
        { status: 404 }
      ),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in getOrderStatus", { error })
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
```

**Implementation notes**:
- Uses `HttpRouter.schemaPathParams` for path parameter validation (pattern from orders service)
- Converts camelCase domain model to snake_case API response at the boundary
- Includes span for distributed tracing
- Follows established error handling patterns from the existing `createOrder` handler

### Step 3.8: Register Route in Router

**File**: `src/api/orders.ts`

Update the `OrderRoutes` export:

```typescript
// Export routes
export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder),
  HttpRouter.get("/orders/:order_ledger_id", getOrderStatus)
)
```

**Note**: The path parameter uses `:order_ledger_id` syntax which Effect Platform's router handles.

---

## 4. Test Plan

### Step 4.1: Add Tests

**File**: `src/__tests__/api/orders.test.ts`

Add the following test cases:

```typescript
describe("GET /orders/:order_ledger_id", () => {
  describe("success cases", () => {
    it("should return order status and items for existing AUTHORIZED order", async () => {
      // Setup: Create an order via POST /orders first
      // Assert: Response includes all expected fields
      // Assert: Status code is 200
      // Assert: Items array contains correct data
    })

    it("should return order with AWAITING_AUTHORIZATION status", async () => {
      // Test early stage status before payment auth
    })

    it("should return order with AUTHORIZATION_FAILED status", async () => {
      // Test failed payment auth case
    })

    it("should return order with COMPLETED status", async () => {
      // Test final success state (requires saga completion)
    })
  })

  describe("error cases", () => {
    it("should return 404 for non-existent order_ledger_id", async () => {
      // Use a valid UUID that doesn't exist in DB
      // Assert: 404 status
      // Assert: error: "not_found"
    })

    it("should return 400 for invalid UUID format", async () => {
      // Use "not-a-uuid" as path parameter
      // Assert: 400 status
      // Assert: error: "validation_error"
    })

    it("should return 400 for empty order_ledger_id", async () => {
      // Test edge case of missing/empty parameter
    })
  })

  describe("response format", () => {
    it("should use snake_case for all response fields", async () => {
      // Verify: order_ledger_id, not orderLedgerId
      // Verify: total_amount_cents, not totalAmountCents
      // etc.
    })

    it("should include empty items array when order has no items", async () => {
      // Edge case: ledger exists but items table has no rows
      // Note: This shouldn't happen in practice but test defensive behavior
    })

    it("should return timestamps in ISO format", async () => {
      // Verify created_at and updated_at are valid ISO timestamps
    })
  })
})
```

### Step 4.2: Unit Tests for Service Layer

**File**: `src/__tests__/services/OrderService.test.ts`

Add tests for the new `getOrderStatus` method:

```typescript
describe("getOrderStatus", () => {
  it("should return order status when found", async () => {
    // Mock repository to return Option.some with test data
    // Assert service returns correctly mapped result
  })

  it("should fail with OrderLedgerNotFoundError when not found", async () => {
    // Mock repository to return Option.none
    // Assert service fails with correct error type
  })
})
```

---

## 5. Response Format Details

### Successful Response (200 OK)

```json
{
  "order_ledger_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "AUTHORIZED",
  "user_id": "123e4567-e89b-12d3-a456-426614174000",
  "email": "customer@example.com",
  "total_amount_cents": 9999,
  "currency": "USD",
  "payment_authorization_id": "auth_abc123",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:05.000Z",
  "items": [
    {
      "product_id": "789e0123-e89b-12d3-a456-426614174000",
      "quantity": 2,
      "unit_price_cents": 2999
    },
    {
      "product_id": "890e1234-e89b-12d3-a456-426614174000",
      "quantity": 1,
      "unit_price_cents": 4001
    }
  ]
}
```

### Error Responses

**400 Bad Request (Invalid UUID)**
```json
{
  "error": "validation_error",
  "message": "Invalid order_ledger_id format. Must be a valid UUID."
}
```

**404 Not Found**
```json
{
  "error": "not_found",
  "message": "Order with ID 550e8400-e29b-41d4-a716-446655440000 not found"
}
```

**500 Internal Server Error**
```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred"
}
```

---

## 6. Validation Requirements

| Field | Validation | Error Response |
|-------|------------|----------------|
| `order_ledger_id` (path) | Must be valid UUID v4 | 400: validation_error |

---

## 7. Observability

### Logging

Log the following events:
- **INFO**: "Order status retrieved" with `{ orderLedgerId, status }`
- **ERROR**: Database errors with full error details (internal only)

### Tracing

Add spans for:
- `GET /orders/:order_ledger_id` - route handler span
- `OrderService.getOrderStatus` - service method span

### Metrics (future enhancement)

Consider adding:
- `edge_api_order_status_requests_total` counter
- `edge_api_order_status_by_status` counter (partitioned by status value)

---

## 8. Dependencies

This implementation has NO new external dependencies. All required packages are already present:
- `@effect/platform` - HTTP routing, request handling
- `@effect/sql-pg` - Database queries
- `effect` - Core Effect utilities

---

## 9. Checklist for Implementer

- [ ] Add `OrderLedgerIdParams` schema to `domain/OrderLedger.ts`
- [ ] Add `OrderLedgerNotFoundError` to `domain/errors.ts`
- [ ] Add `findByIdWithItems` signature to `repositories/OrderLedgerRepository.ts`
- [ ] Implement `findByIdWithItems` in `repositories/OrderLedgerRepositoryLive.ts`
- [ ] Add `OrderStatusResult` type to `services/OrderService.ts`
- [ ] Add `getOrderStatus` signature to `services/OrderService.ts`
- [ ] Implement `getOrderStatus` in `services/OrderServiceLive.ts`
- [ ] Add `getOrderStatus` route handler in `api/orders.ts`
- [ ] Register GET route in `OrderRoutes`
- [ ] Add unit tests for service layer
- [ ] Add integration tests for API endpoint
- [ ] Run `npm run typecheck` to verify no type errors
- [ ] Run `npm run test` to verify all tests pass
- [ ] Test manually with curl/httpie

---

## 10. Manual Testing Commands

```bash
# Start the service
npm run dev:edge-api

# Create an order first (to get an order_ledger_id)
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(uuidgen)" \
  -d '{
    "user_id": "123e4567-e89b-12d3-a456-426614174000",
    "email": "test@example.com",
    "items": [{ "product_id": "789e0123-e89b-12d3-a456-426614174000", "quantity": 2 }],
    "payment": { "method": "card", "token": "tok_test123" }
  }'

# Get order status (use order_ledger_id from POST response)
curl http://localhost:3000/orders/{order_ledger_id}

# Test 404
curl http://localhost:3000/orders/00000000-0000-0000-0000-000000000000

# Test 400 (invalid UUID)
curl http://localhost:3000/orders/not-a-uuid
```
