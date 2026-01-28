# Implementation Plan: PUT /orders/{order_id}/cancel & PUT /orders/{order_id}/confirm

## Status: COMPLETE

---

## Overview

Implement two idempotent status-transition endpoints for the Orders Service:

1. **PUT /orders/{order_id}/cancel** - Cancel an order (compensation action called by the Orchestrator during saga rollback) **EDIT** Changing this to POST /orders/:order_id/cancellation for better restful naming
2. **PUT /orders/{order_id}/confirm** - Confirm an order (final saga step after payment capture) **EDIT** Changing this to POST /orders/:order_id/confirmation for better restful naming.

Both endpoints are called by the Orchestrator Service as part of the saga lifecycle defined in `engineering-design.md` Section 4. They must be idempotent to support safe retries.

**Key Requirements:**
- Idempotent: calling cancel on an already-cancelled order returns success (not an error)
- Idempotent: calling confirm on an already-confirmed order returns success (not an error)
- Validate status transitions: only `CREATED` orders can be cancelled or confirmed
- Return the updated order with items in the response
- Follow all existing patterns established in the orders service codebase

**Valid State Transitions (from `engineering-design.md` Section 4.1):**
```
CREATED → CONFIRMED  (happy path, final saga step)
CREATED → CANCELLED  (compensation path)
```

Invalid transitions (e.g., `CONFIRMED → CANCELLED`, `CANCELLED → CONFIRMED`) should return an error.

---

## Pre-Implementation Checklist

Before writing any code, verify:
- [ ] The orders service builds and typechecks (`npm run typecheck --workspace=@ecommerce/orders`)
- [ ] Existing tests pass (`npm run test --workspace=@ecommerce/orders`)
- [ ] The `updateStatus` repository method already exists in `OrderRepositoryLive.ts` (it does - see line 158)
- [ ] The `InvalidOrderStatusError` already exists in `errors.ts` (it does - see line 25)
- [ ] The `OrderIdParams` schema already exists in `Order.ts` (it does - see line 71)

---

## What Already Exists (No Changes Needed)

These components are already implemented and can be reused directly:

| Component | File | Lines | Notes |
|-----------|------|-------|-------|
| `OrderIdParams` schema | `src/domain/Order.ts` | 71-73 | Path parameter validation for `order_id` |
| `OrderStatus` literal | `src/domain/Order.ts` | 20-21 | Already includes `"CREATED"`, `"CONFIRMED"`, `"CANCELLED"` |
| `InvalidOrderStatusError` | `src/domain/errors.ts` | 25-29 | Error for invalid state transitions |
| `OrderNotFoundError` | `src/domain/errors.ts` | 7-10 | Error for missing orders |
| `OrderRepository.updateStatus` | `src/repositories/OrderRepository.ts` | 53-59 | Updates status and returns updated order |
| `OrderRepository.findById` | `src/repositories/OrderRepository.ts` | 33-36 | Finds order by ID |
| `OrderRepository.getItems` | `src/repositories/OrderRepository.ts` | 46-50 | Gets items for an order |
| `OrderRepositoryLive.updateStatus` | `src/repositories/OrderRepositoryLive.ts` | 158-169 | SQL implementation |
| Row mappers | `src/repositories/OrderRepositoryLive.ts` | 38-58 | `mapRowToOrder`, `mapRowToOrderItem` |
| Test fixtures | `src/__tests__/createOrder.test.ts` | 20-44 | Reusable test order/item fixtures |

---

## Step 1: Add Service Methods

### File: `services/orders/src/services/OrderService.ts`

Add `cancel` and `confirm` methods to the `OrderService` interface. These methods should follow the same pattern as `findById`.

**What to add:**

```typescript
/**
 * Cancels an order (compensation action).
 * Idempotent: if order is already CANCELLED, returns the order without error.
 * Fails with OrderNotFoundError if order doesn't exist.
 * Fails with InvalidOrderStatusError if order is in CONFIRMED state.
 *
 * @param id - The order ID to cancel
 * @returns The order with items after cancellation
 */
readonly cancel: (
  id: OrderId
) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>

/**
 * Confirms an order (final saga step).
 * Idempotent: if order is already CONFIRMED, returns the order without error.
 * Fails with OrderNotFoundError if order doesn't exist.
 * Fails with InvalidOrderStatusError if order is in CANCELLED state.
 *
 * @param id - The order ID to confirm
 * @returns The order with items after confirmation
 */
readonly confirm: (
  id: OrderId
) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>
```

**Important:** Add the `InvalidOrderStatusError` import:
```typescript
import type { OrderNotFoundError, InvalidOrderStatusError } from "../domain/errors.js"
```

---

## Step 2: Implement Service Methods

### File: `services/orders/src/services/OrderServiceLive.ts`

Implement `cancel` and `confirm` in the service layer. Both follow the same pattern:

1. Look up the order by ID (fail with `OrderNotFoundError` if missing)
2. Check current status for idempotency (already in target state → return as-is)
3. Validate the transition is allowed (fail with `InvalidOrderStatusError` if not)
4. Call `repo.updateStatus` to perform the transition
5. Fetch items and return the full `OrderWithItems`

**Implementation for `cancel`:**

```typescript
cancel: (id: OrderId) =>
  Effect.gen(function* () {
    const orderOpt = yield* repo.findById(id)

    if (Option.isNone(orderOpt)) {
      return yield* Effect.fail(
        new OrderNotFoundError({ orderId: id, searchedBy: "id" })
      )
    }

    const order = orderOpt.value

    // Idempotency: already cancelled → return as-is
    if (order.status === "CANCELLED") {
      const items = yield* repo.getItems(order.id)
      return { order, items } as OrderWithItems
    }

    // Only CREATED orders can be cancelled
    if (order.status !== "CREATED") {
      return yield* Effect.fail(
        new InvalidOrderStatusError({
          orderId: id,
          currentStatus: order.status,
          attemptedStatus: "CANCELLED"
        })
      )
    }

    // Perform the status transition
    const updatedOpt = yield* repo.updateStatus(id, "CANCELLED")

    // This should not happen since we just found the order, but handle defensively
    if (Option.isNone(updatedOpt)) {
      return yield* Effect.fail(
        new OrderNotFoundError({ orderId: id, searchedBy: "id" })
      )
    }

    const items = yield* repo.getItems(id)
    return { order: updatedOpt.value, items } as OrderWithItems
  }),
```

**Implementation for `confirm`:**

```typescript
confirm: (id: OrderId) =>
  Effect.gen(function* () {
    const orderOpt = yield* repo.findById(id)

    if (Option.isNone(orderOpt)) {
      return yield* Effect.fail(
        new OrderNotFoundError({ orderId: id, searchedBy: "id" })
      )
    }

    const order = orderOpt.value

    // Idempotency: already confirmed → return as-is
    if (order.status === "CONFIRMED") {
      const items = yield* repo.getItems(order.id)
      return { order, items } as OrderWithItems
    }

    // Only CREATED orders can be confirmed
    if (order.status !== "CREATED") {
      return yield* Effect.fail(
        new InvalidOrderStatusError({
          orderId: id,
          currentStatus: order.status,
          attemptedStatus: "CONFIRMED"
        })
      )
    }

    // Perform the status transition
    const updatedOpt = yield* repo.updateStatus(id, "CONFIRMED")

    if (Option.isNone(updatedOpt)) {
      return yield* Effect.fail(
        new OrderNotFoundError({ orderId: id, searchedBy: "id" })
      )
    }

    const items = yield* repo.getItems(id)
    return { order: updatedOpt.value, items } as OrderWithItems
  })
```

**Important:** Add the `InvalidOrderStatusError` import:
```typescript
import { OrderNotFoundError, InvalidOrderStatusError } from "../domain/errors.js"
```

**Design Note - Why not use a shared helper:** While `cancel` and `confirm` have similar structure, avoid extracting a shared `transitionStatus` helper. The methods are simple enough that duplication is preferable to abstraction. If a third transition is added later, reconsider. See the "Avoid over-engineering" principle.

**Design Note - Race conditions:** The check-then-update pattern here has a small race window. For this service, this is acceptable because:
1. The Orchestrator is the only caller, and it processes one saga step at a time per order
2. The `updateStatus` repository method uses `RETURNING *` so we get the actual final state
3. If two concurrent cancel calls arrive, both will succeed (idempotent) - worst case one gets `OrderNotFoundError` from `updateStatus` returning empty (the order was already updated by the other call)

---

## Step 3: Add Route Handlers

### File: `services/orders/src/api/orders.ts`

Add two new route handlers following the existing `getOrderById` pattern, and register them in `OrderRoutes`.

**Helper function for response mapping:**

To avoid duplicating the order-to-response mapping logic (which already appears in `createOrder` and `getOrderById`), extract a small helper function at the top of the file:

```typescript
// Map domain order + items to snake_case API response
const toOrderResponse = (order: Order, items: readonly OrderItem[]) => ({
  id: order.id,
  order_ledger_id: order.orderLedgerId,
  user_id: order.userId,
  status: order.status,
  total_amount_cents: order.totalAmountCents,
  currency: order.currency,
  created_at: order.createdAt.toString(),
  updated_at: order.updatedAt.toString(),
  items: items.map(item => ({
    id: item.id,
    product_id: item.productId,
    quantity: item.quantity,
    unit_price_cents: item.unitPriceCents,
    created_at: item.createdAt.toString()
  }))
})
```

Add the necessary imports at the top of the file:
```typescript
import type { Order, OrderItem } from "../domain/Order.js"
```

**This helper should also be used by the existing `createOrder` and `getOrderById` handlers** to replace their inline mapping code. This is not adding abstraction - it's eliminating copy-paste duplication that already exists in the file.

**PUT /orders/:order_id/cancel handler:**

```typescript
// PUT /orders/:order_id/cancel - Cancel order (compensation)
const cancelOrder = Effect.gen(function* () {
  const service = yield* OrderService
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  const { order, items } = yield* service.cancel(orderId)

  return yield* HttpServerResponse.json(toOrderResponse(order, items))
}).pipe(
  Effect.catchTags({
    ParseError: () =>
      HttpServerResponse.json(
        { error: "validation_error", message: "Invalid order_id format. Must be a valid UUID." },
        { status: 400 }
      ),
    OrderNotFoundError: (error) =>
      HttpServerResponse.json(
        { error: "not_found", message: `Order with ID ${error.orderId} not found` },
        { status: 404 }
      ),
    InvalidOrderStatusError: (error) =>
      HttpServerResponse.json(
        {
          error: "invalid_status_transition",
          message: `Cannot cancel order in ${error.currentStatus} status`,
          current_status: error.currentStatus,
          attempted_status: error.attemptedStatus
        },
        { status: 409 }
      ),
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)
```

**PUT /orders/:order_id/confirm handler:**

```typescript
// PUT /orders/:order_id/confirm - Confirm order (final saga step)
const confirmOrder = Effect.gen(function* () {
  const service = yield* OrderService
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  const { order, items } = yield* service.confirm(orderId)

  return yield* HttpServerResponse.json(toOrderResponse(order, items))
}).pipe(
  Effect.catchTags({
    ParseError: () =>
      HttpServerResponse.json(
        { error: "validation_error", message: "Invalid order_id format. Must be a valid UUID." },
        { status: 400 }
      ),
    OrderNotFoundError: (error) =>
      HttpServerResponse.json(
        { error: "not_found", message: `Order with ID ${error.orderId} not found` },
        { status: 404 }
      ),
    InvalidOrderStatusError: (error) =>
      HttpServerResponse.json(
        {
          error: "invalid_status_transition",
          message: `Cannot confirm order in ${error.currentStatus} status`,
          current_status: error.currentStatus,
          attempted_status: error.attemptedStatus
        },
        { status: 409 }
      ),
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)
```

**Update route registration:**

```typescript
export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder),
  HttpRouter.get("/orders/:order_id", getOrderById),
  HttpRouter.put("/orders/:order_id/cancel", cancelOrder),
  HttpRouter.put("/orders/:order_id/confirm", confirmOrder)
)
```

**HTTP Status Code Rationale:**
- `200 OK` - Successful transition (including idempotent retries)
- `400 Bad Request` - Invalid UUID in path parameter
- `404 Not Found` - Order doesn't exist
- `409 Conflict` - Invalid status transition (e.g., trying to cancel a CONFIRMED order)
- `500 Internal Server Error` - Database or unexpected errors

**Why 409 Conflict for invalid transitions:** A 409 indicates the request conflicts with the current state of the resource. This is the correct semantic - the order exists but its current status prevents the requested transition. The response includes `current_status` and `attempted_status` so the caller understands why.

---

## Step 4: Write Unit Tests

### Test File Organization

Create two new test files following the established pattern:

1. `src/__tests__/api/cancelOrder.test.ts` - API-level tests for the cancel endpoint
2. `src/__tests__/api/confirmOrder.test.ts` - API-level tests for the confirm endpoint

Also update the existing service test file:
3. `src/__tests__/OrderService.test.ts` - Add `cancel` and `confirm` test cases

### File: `src/__tests__/api/cancelOrder.test.ts`

Follow the exact test helper pattern established in `createOrder.test.ts`:

**Response type:**
```typescript
interface CancelOrderResponse {
  status: number
  body: {
    id?: string
    order_ledger_id?: string
    user_id?: string
    status?: string
    total_amount_cents?: number
    currency?: string
    created_at?: string
    updated_at?: string
    items?: Array<{
      id?: string
      product_id?: string
      quantity?: number
      unit_price_cents?: number
      created_at?: string
    }>
    error?: string
    message?: string
    current_status?: string
    attempted_status?: string
  }
}
```

**Mock service factory:**

Reuse the existing `createMockOrderService` pattern from `createOrder.test.ts` but extend it with `cancel` and `confirm` methods:

```typescript
const createMockOrderService = (overrides: {
  cancel?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(OrderService, {
    create: () => Effect.succeed({ order: testOrder, items: [testOrderItem] }),
    findById: () => Effect.succeed({ order: testOrder, items: [testOrderItem] }),
    cancel: overrides.cancel ?? (() =>
      Effect.succeed({ order: cancelledOrder, items: [testOrderItem] })
    ),
    confirm: () => Effect.succeed({ order: confirmedOrder, items: [testOrderItem] })
  })
}
```

Where `cancelledOrder` is a copy of `testOrder` with `status: "CANCELLED"`.

**Test helper:**

```typescript
const runCancelOrder = async (
  orderIdParam: string | undefined,
  orderService: Layer.Layer<OrderService>
): Promise<CancelOrderResponse> => {
  const routeContextLayer = createMockRouteContext({ order_id: orderIdParam })
  const testLayer = Layer.mergeAll(routeContextLayer, orderService)

  return Effect.gen(function* () {
    const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)
    const service = yield* OrderService
    const { order, items } = yield* service.cancel(orderId)

    return {
      status: 200,
      body: toOrderResponse(order, items)
    } as CancelOrderResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: { error: "validation_error", message: "Invalid order_id format. Must be a valid UUID." }
      } as CancelOrderResponse)
    ),
    Effect.catchTag("OrderNotFoundError", (error) =>
      Effect.succeed({
        status: 404,
        body: { error: "not_found", message: `Order with ID ${error.orderId} not found` }
      } as CancelOrderResponse)
    ),
    Effect.catchTag("InvalidOrderStatusError", (error) =>
      Effect.succeed({
        status: 409,
        body: {
          error: "invalid_status_transition",
          message: `Cannot cancel order in ${error.currentStatus} status`,
          current_status: error.currentStatus,
          attempted_status: error.attemptedStatus
        }
      } as CancelOrderResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: { error: "internal_error", message: "An unexpected error occurred" }
      } as CancelOrderResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}
```

**Test cases for PUT /orders/:order_id/cancel:**

```
describe("PUT /orders/:order_id/cancel")
  describe("successful cancellation")
    it("should return 200 with cancelled order")
      - Mock service returns order with status "CANCELLED"
      - Verify response status is 200
      - Verify response body.status is "CANCELLED"
      - Verify items are included

    it("should return 200 on idempotent retry (already cancelled)")
      - Mock service returns order with status "CANCELLED"
      - Verify response status is 200
      - Verify body.status is "CANCELLED"

  describe("validation errors")
    it("should return 400 for invalid order_id format")
      - Pass "not-a-uuid" as order_id
      - Verify 400 with error "validation_error"

    it("should return 400 for undefined order_id")
      - Pass undefined as order_id
      - Verify 400 with error "validation_error"

  describe("not found")
    it("should return 404 when order does not exist")
      - Mock service fails with OrderNotFoundError
      - Verify 404 with error "not_found"

  describe("invalid status transition")
    it("should return 409 when order is already confirmed")
      - Mock service fails with InvalidOrderStatusError (currentStatus: "CONFIRMED", attemptedStatus: "CANCELLED")
      - Verify 409 with error "invalid_status_transition"
      - Verify response includes current_status and attempted_status

  describe("response format")
    it("should use snake_case keys in response")
      - Verify order_ledger_id, user_id, total_amount_cents, created_at, updated_at
      - Verify items use product_id, unit_price_cents

    it("should include all order fields")
      - Verify all fields present: id, order_ledger_id, user_id, status, total_amount_cents, currency, created_at, updated_at, items

  describe("error handling")
    it("should return 500 for SQL errors")
      - Mock service fails with SqlError
      - Verify 500 with error "internal_error"
```

### File: `src/__tests__/api/confirmOrder.test.ts`

Mirror the exact same structure as `cancelOrder.test.ts` but for the confirm endpoint:

**Test cases for PUT /orders/:order_id/confirm:**

```
describe("PUT /orders/:order_id/confirm")
  describe("successful confirmation")
    it("should return 200 with confirmed order")
      - Mock service returns order with status "CONFIRMED"
      - Verify response status is 200, body.status is "CONFIRMED"

    it("should return 200 on idempotent retry (already confirmed)")
      - Same as above - idempotent behavior

  describe("validation errors")
    it("should return 400 for invalid order_id format")
    it("should return 400 for undefined order_id")

  describe("not found")
    it("should return 404 when order does not exist")

  describe("invalid status transition")
    it("should return 409 when order is already cancelled")
      - InvalidOrderStatusError with currentStatus: "CANCELLED", attemptedStatus: "CONFIRMED"

  describe("response format")
    it("should use snake_case keys in response")
    it("should include all order fields")

  describe("error handling")
    it("should return 500 for SQL errors")
```

### Updates to: `src/__tests__/OrderService.test.ts`

Add test cases for the new service methods. The mock repository factory (`createMockRepo`) already supports all needed methods.

**Test cases to add:**

```
describe("cancel")
  it("should cancel a CREATED order")
    - Mock repo.findById returns order with status "CREATED"
    - Mock repo.updateStatus returns order with status "CANCELLED"
    - Verify result.order.status is "CANCELLED"

  it("should return existing order when already CANCELLED (idempotent)")
    - Mock repo.findById returns order with status "CANCELLED"
    - repo.updateStatus should NOT be called
    - Verify result.order.status is "CANCELLED"

  it("should fail with InvalidOrderStatusError when order is CONFIRMED")
    - Mock repo.findById returns order with status "CONFIRMED"
    - Verify exit is failure with InvalidOrderStatusError
    - Verify currentStatus is "CONFIRMED", attemptedStatus is "CANCELLED"

  it("should fail with OrderNotFoundError when order does not exist")
    - Mock repo.findById returns Option.none()
    - Verify exit is failure with OrderNotFoundError

  it("should call updateStatus with correct arguments")
    - Capture arguments passed to repo.updateStatus
    - Verify orderId and status "CANCELLED"

describe("confirm")
  it("should confirm a CREATED order")
  it("should return existing order when already CONFIRMED (idempotent)")
  it("should fail with InvalidOrderStatusError when order is CANCELLED")
  it("should fail with OrderNotFoundError when order does not exist")
  it("should call updateStatus with correct arguments")
```

**Fixture additions needed:**

```typescript
const cancelledOrder = new Order({
  ...testOrder,
  status: "CANCELLED" as OrderStatus
})

const confirmedOrder = new Order({
  ...testOrder,
  status: "CONFIRMED" as OrderStatus
})
```

Note: `Schema.Class` instances don't support spread syntax directly. Use the constructor with explicit fields:

```typescript
const cancelledOrder = new Order({
  id: testOrderId,
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  status: "CANCELLED",
  totalAmountCents: 5998,
  currency: "USD",
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})
```

---

## Step 5: Update Mock Service in Existing Tests

### File: `src/__tests__/api/createOrder.test.ts`

The `createMockOrderService` factory function needs to be updated to include the new `cancel` and `confirm` methods. Without this, TypeScript will report type errors because the `OrderService` interface now requires these methods.

Add default implementations:

```typescript
const createMockOrderService = (overrides: {
  create?: (request: CreateOrderRequest) => Effect.Effect<OrderWithItems, SqlError.SqlError>
  findById?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | SqlError.SqlError>
  cancel?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>
  confirm?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(OrderService, {
    create: overrides.create ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    ),
    findById: overrides.findById ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    ),
    cancel: overrides.cancel ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    ),
    confirm: overrides.confirm ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    )
  })
}
```

Also add the `InvalidOrderStatusError` import if not already present.

---

## Verification Steps

After implementation, run all verification in this order:

### 1. Type Check
```bash
npm run typecheck --workspace=@ecommerce/orders
```
Expected: No errors

### 2. Build
```bash
npm run build --workspace=@ecommerce/orders
```
Expected: Compiles successfully

### 3. Tests
```bash
npm run test --workspace=@ecommerce/orders
```
Expected: All tests pass (existing + new)

### 4. Coverage
```bash
npm run test:coverage --workspace=@ecommerce/orders
```
Expected: 80%+ on `OrderServiceLive.ts` and `OrderRepositoryLive.ts`

### 5. Manual Test (requires PostgreSQL)
```bash
# Start database
docker-compose up -d postgres

# Start service
npm run dev:orders

# Create an order first
curl -s -X POST http://localhost:3003/orders \
  -H "Content-Type: application/json" \
  -d '{
    "orderLedgerId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "660e8400-e29b-41d4-a716-446655440001",
    "totalAmountCents": 5998,
    "items": [{"productId": "770e8400-e29b-41d4-a716-446655440002", "quantity": 2, "unitPriceCents": 2999}]
  }' | jq .

# Get the order_id from the response, then:

# Test cancel
curl -s -X PUT http://localhost:3003/orders/{order_id}/cancel | jq .
# Expected: 200, status: "CANCELLED"

# Test idempotent cancel
curl -s -X PUT http://localhost:3003/orders/{order_id}/cancel | jq .
# Expected: 200, status: "CANCELLED" (same result)

# Test invalid transition: confirm a cancelled order
curl -s -X PUT http://localhost:3003/orders/{order_id}/confirm | jq .
# Expected: 409, error: "invalid_status_transition"

# Create another order and test confirm
curl -s -X POST http://localhost:3003/orders \
  -H "Content-Type: application/json" \
  -d '{
    "orderLedgerId": "550e8400-e29b-41d4-a716-446655440099",
    "userId": "660e8400-e29b-41d4-a716-446655440001",
    "totalAmountCents": 2999,
    "items": [{"productId": "770e8400-e29b-41d4-a716-446655440002", "quantity": 1, "unitPriceCents": 2999}]
  }' | jq .

curl -s -X PUT http://localhost:3003/orders/{order_id}/confirm | jq .
# Expected: 200, status: "CONFIRMED"

# Test 404
curl -s -X PUT http://localhost:3003/orders/00000000-0000-0000-0000-000000000000/cancel | jq .
# Expected: 404

# Test 400
curl -s -X PUT http://localhost:3003/orders/not-a-uuid/cancel | jq .
# Expected: 400
```

---

## Files to Create/Modify Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/services/OrderService.ts` | **Modify** | Add `cancel` and `confirm` method signatures |
| `src/services/OrderServiceLive.ts` | **Modify** | Implement `cancel` and `confirm` methods |
| `src/api/orders.ts` | **Modify** | Add `cancelOrder` and `confirmOrder` handlers, add `toOrderResponse` helper, register new routes |
| `src/__tests__/api/cancelOrder.test.ts` | **Create** | API tests for cancel endpoint |
| `src/__tests__/api/confirmOrder.test.ts` | **Create** | API tests for confirm endpoint |
| `src/__tests__/OrderService.test.ts` | **Modify** | Add cancel/confirm service tests |
| `src/__tests__/api/createOrder.test.ts` | **Modify** | Update mock service factory with new methods |

**No changes needed to:**
- `src/domain/Order.ts` - OrderStatus already includes CANCELLED/CONFIRMED
- `src/domain/errors.ts` - InvalidOrderStatusError already exists
- `src/repositories/OrderRepository.ts` - updateStatus already defined
- `src/repositories/OrderRepositoryLive.ts` - updateStatus already implemented
- `src/layers.ts` - No new layers needed
- `src/server.ts` - Routes are already mounted via OrderRoutes
- `src/config.ts` - No config changes
- `src/db.ts` - No database changes
- Database migrations - No schema changes

---

## Design Decisions & Rationale

### Idempotency Strategy

Both `cancel` and `confirm` are idempotent:
- Calling cancel on a `CANCELLED` order → returns the order (200 OK)
- Calling confirm on a `CONFIRMED` order → returns the order (200 OK)
- This supports safe retries from the Orchestrator without special error handling

### HTTP Method: PUT vs POST

Using `PUT` because:
- The operation is idempotent (calling it multiple times has the same effect)
- PUT semantics: "set this resource to this state"
- POST would imply creating a new resource, which is not what's happening
- Engineering design document's todo.md uses PUT for these endpoints

### Status Transition Validation

Only `CREATED → CANCELLED` and `CREATED → CONFIRMED` are valid. This prevents:
- Cancelling a confirmed order (business rule: confirmed orders are final)
- Confirming a cancelled order (business rule: cancelled orders can't be revived)
- The Orchestrator should never attempt these invalid transitions, but defense-in-depth is good practice

### 409 Conflict for Invalid Transitions

Using 409 rather than 400 because:
- 400 indicates a malformed request (bad syntax, invalid UUID)
- 409 indicates the request is well-formed but conflicts with the current resource state
- The response includes `current_status` and `attempted_status` for debugging

### No Request Body Required

Neither endpoint requires a request body because:
- The order ID comes from the URL path
- The target status is implicit in the endpoint name (cancel → CANCELLED, confirm → CONFIRMED)
- There's no additional data needed for these transitions

---

## Patterns Applied

| Pattern | Application |
|---------|-------------|
| Tagged Errors | `InvalidOrderStatusError` for invalid transitions, `OrderNotFoundError` for missing orders |
| Idempotency | Return success for already-transitioned orders |
| Context.Tag | Extended `OrderService` interface with new methods |
| Schema Path Params | `OrderIdParams` validates UUID format |
| Effect.catchTags | Maps domain errors to HTTP status codes |
| Option for Queries | Repository's `findById` and `updateStatus` return `Option<Order>` |
| Snake_case API | Response format consistent with existing endpoints |
| Response Helper | `toOrderResponse` eliminates mapping duplication |

---

## Next Steps (Out of Scope)

After this plan is implemented, the Orders Service will be feature-complete per `todo.md`. The next service to implement is the Edge API:
1. Add database connection and health check endpoint
2. Create database migration for order_ledger, order_ledger_items, outbox tables
3. POST /orders - Validate, create ledger entry, authorize payment, write outbox event
