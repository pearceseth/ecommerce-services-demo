# Implementation Plan: POST /orders - Create Order

## Status: COMPLETE

---

## Overview

Implement the `POST /orders` endpoint for the Orders Service. This endpoint creates an order from a ledger entry, supporting idempotency via `order_ledger_id`. The Orchestrator service calls this endpoint as Step 1 of the saga execution.

**Key Requirements:**
- Accept order creation requests with ledger entry data and line items
- Idempotent: if an order with the same `order_ledger_id` already exists, return the existing order
- Create both the `orders` record and associated `order_items` records atomically
- Return the created order with its items

---

## Pre-Implementation Checklist

Before writing any code, ensure:
- [ ] Database migration `004_create_orders_tables.sql` has been applied
- [ ] Orders service scaffold is working (`npm run dev:orders`)
- [ ] Health endpoint returns healthy status

---

## Step 1: Create Domain Types

### File: `services/orders/src/domain/Order.ts`

Define the domain model schemas and branded types following the Pattern in `services/inventory/src/domain/Product.ts`.

```typescript
import { Schema } from "effect"

// Branded types for type safety
export const OrderId = Schema.UUID.pipe(Schema.brand("OrderId"))
export type OrderId = typeof OrderId.Type

export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export const OrderItemId = Schema.UUID.pipe(Schema.brand("OrderItemId"))
export type OrderItemId = typeof OrderItemId.Type

// Order status enum - use Schema.Literal for exhaustive matching
export const OrderStatus = Schema.Literal("CREATED", "CONFIRMED", "CANCELLED")
export type OrderStatus = typeof OrderStatus.Type

// Domain models
export class OrderItem extends Schema.Class<OrderItem>("OrderItem")({
  id: OrderItemId,
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive()),
  unitPriceCents: Schema.Int.pipe(Schema.nonNegative()),
  createdAt: Schema.DateTimeUtc
}) {}

export class Order extends Schema.Class<Order>("Order")({
  id: OrderId,
  orderLedgerId: OrderLedgerId,
  userId: UserId,
  status: OrderStatus,
  totalAmountCents: Schema.Int.pipe(Schema.nonNegative()),
  currency: Schema.String.pipe(Schema.minLength(3), Schema.maxLength(3)),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

// Request schemas for API input
export class CreateOrderItemRequest extends Schema.Class<CreateOrderItemRequest>("CreateOrderItemRequest")({
  productId: ProductId,
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" })
  ),
  unitPriceCents: Schema.Int.pipe(
    Schema.nonNegative({ message: () => "Unit price cannot be negative" })
  )
}) {}

export class CreateOrderRequest extends Schema.Class<CreateOrderRequest>("CreateOrderRequest")({
  orderLedgerId: OrderLedgerId,
  userId: UserId,
  totalAmountCents: Schema.Int.pipe(
    Schema.nonNegative({ message: () => "Total amount cannot be negative" })
  ),
  currency: Schema.optionalWith(
    Schema.String.pipe(Schema.minLength(3), Schema.maxLength(3)),
    { default: () => "USD" }
  ),
  items: Schema.Array(CreateOrderItemRequest).pipe(
    Schema.minItems(1, { message: () => "Order must have at least one item" })
  )
}) {}

// Path parameter schema for routes
export const OrderIdParams = Schema.Struct({
  order_id: OrderId
})
```

**Key Design Points:**
- All IDs are branded types for compile-time type safety
- `OrderStatus` uses `Schema.Literal` for exhaustive pattern matching
- Request schemas include validation constraints with custom error messages
- Currency defaults to "USD" if not provided
- Items array must have at least one item

---

## Step 2: Create Error Types

### File: `services/orders/src/domain/errors.ts`

Define domain-specific errors following the tagged error pattern from best-practices.md.

```typescript
import { Data } from "effect"

/**
 * Order with the given order_ledger_id already exists.
 * This is used for idempotency - the existing order should be returned.
 */
export class OrderAlreadyExistsError extends Data.TaggedError("OrderAlreadyExistsError")<{
  readonly orderLedgerId: string
  readonly existingOrderId: string
}> {}

/**
 * Order was not found in the database.
 */
export class OrderNotFoundError extends Data.TaggedError("OrderNotFoundError")<{
  readonly orderId: string
  readonly searchedBy: "id" | "orderLedgerId"
}> {}

/**
 * Invalid order status transition was attempted.
 */
export class InvalidOrderStatusError extends Data.TaggedError("InvalidOrderStatusError")<{
  readonly orderId: string
  readonly currentStatus: string
  readonly attemptedStatus: string
}> {}
```

**Key Design Points:**
- Each error includes context for debugging (IDs, current state)
- `OrderAlreadyExistsError` is used for idempotency checks
- `InvalidOrderStatusError` will be needed for status transitions (cancel/confirm)

---

## Step 3: Create Repository Interface

### File: `services/orders/src/repositories/OrderRepository.ts`

Define the repository interface using Context.Tag following the pattern in `services/inventory/src/repositories/ProductRepository.ts`.

```typescript
import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type {
  Order,
  OrderId,
  OrderLedgerId,
  OrderItem,
  OrderStatus
} from "../domain/Order.js"
import type { CreateOrderRequest } from "../domain/Order.js"

// Result type for atomic create operation (idempotency support)
export type CreateOrderResult =
  | { readonly _tag: "Created"; readonly order: Order; readonly items: readonly OrderItem[] }
  | { readonly _tag: "AlreadyExists"; readonly order: Order; readonly items: readonly OrderItem[] }

export class OrderRepository extends Context.Tag("OrderRepository")<
  OrderRepository,
  {
    /**
     * Creates an order with its items atomically.
     * If an order with the same order_ledger_id exists, returns the existing order.
     * Uses atomic CTE to prevent race conditions.
     */
    readonly createWithItems: (
      request: CreateOrderRequest
    ) => Effect.Effect<CreateOrderResult, SqlError.SqlError>

    /**
     * Finds an order by its ID.
     * Returns Option.none() if not found.
     */
    readonly findById: (
      id: OrderId
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>

    /**
     * Finds an order by its ledger ID.
     * Returns Option.none() if not found.
     */
    readonly findByLedgerId: (
      ledgerId: OrderLedgerId
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>

    /**
     * Gets all items for an order.
     */
    readonly getItems: (
      orderId: OrderId
    ) => Effect.Effect<readonly OrderItem[], SqlError.SqlError>

    /**
     * Updates the status of an order.
     * Returns the updated order if successful.
     */
    readonly updateStatus: (
      orderId: OrderId,
      status: OrderStatus
    ) => Effect.Effect<Option.Option<Order>, SqlError.SqlError>
  }
>() {}
```

**Key Design Points:**
- `createWithItems` returns a discriminated union for idempotency handling
- Repository methods return `Option<T>` for queries that may not find data
- All operations isolated from business logic (pure data access)

---

## Step 4: Implement Repository

### File: `services/orders/src/repositories/OrderRepositoryLive.ts`

Implement the repository with atomic CTE for idempotent creation.

```typescript
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
              }
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
```

**Key Design Points:**
- Uses `sql.withTransaction` for atomic order + items creation
- Check-first pattern is acceptable here because we're inside a transaction
- The UNIQUE constraint on `order_ledger_id` provides defense-in-depth
- Maps snake_case DB columns to camelCase domain properties

---

## Step 5: Create Service Interface

### File: `services/orders/src/services/OrderService.ts`

Define the service interface with business logic operations.

```typescript
import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type {
  Order,
  OrderId,
  OrderItem,
  CreateOrderRequest
} from "../domain/Order.js"
import type { OrderNotFoundError } from "../domain/errors.js"

// Response type that includes order with its items
export interface OrderWithItems {
  readonly order: Order
  readonly items: readonly OrderItem[]
}

export class OrderService extends Context.Tag("OrderService")<
  OrderService,
  {
    /**
     * Creates a new order from a ledger entry.
     * Idempotent: if order with same order_ledger_id exists, returns existing.
     *
     * @param request - The order creation request with items
     * @returns The order with its items
     */
    readonly create: (
      request: CreateOrderRequest
    ) => Effect.Effect<OrderWithItems, SqlError.SqlError>

    /**
     * Finds an order by ID with its items.
     *
     * @param id - The order ID
     * @returns The order with items, or fails with OrderNotFoundError
     */
    readonly findById: (
      id: OrderId
    ) => Effect.Effect<OrderWithItems, OrderNotFoundError | SqlError.SqlError>
  }
>() {}
```

**Key Design Points:**
- Service interface is simpler than repository - focuses on use cases
- `create` doesn't fail on duplicate - returns existing (idempotent)
- `OrderWithItems` bundles order with items for complete responses

---

## Step 6: Implement Service

### File: `services/orders/src/services/OrderServiceLive.ts`

Implement the service with business logic.

```typescript
import { Layer, Effect, Option, Match } from "effect"
import { OrderService, type OrderWithItems } from "./OrderService.js"
import { OrderRepository } from "../repositories/OrderRepository.js"
import { OrderNotFoundError } from "../domain/errors.js"
import type { CreateOrderRequest, OrderId } from "../domain/Order.js"

export const OrderServiceLive = Layer.effect(
  OrderService,
  Effect.gen(function* () {
    const repo = yield* OrderRepository

    return {
      create: (request: CreateOrderRequest) =>
        Effect.gen(function* () {
          const result = yield* repo.createWithItems(request)

          // Both Created and AlreadyExists return the same shape
          // This is idempotent behavior - we don't distinguish at service level
          return Match.value(result).pipe(
            Match.tag("Created", ({ order, items }) => ({ order, items })),
            Match.tag("AlreadyExists", ({ order, items }) => ({ order, items })),
            Match.exhaustive
          )
        }),

      findById: (id: OrderId) =>
        Effect.gen(function* () {
          const orderOpt = yield* repo.findById(id)

          if (Option.isNone(orderOpt)) {
            return yield* Effect.fail(
              new OrderNotFoundError({ orderId: id, searchedBy: "id" })
            )
          }

          const order = orderOpt.value
          const items = yield* repo.getItems(order.id)

          return { order, items } as OrderWithItems
        })
    }
  })
)
```

**Key Design Points:**
- `create` is idempotent - always succeeds with the order (new or existing)
- Uses `Match.exhaustive` for pattern matching on discriminated union
- Service transforms repository results into API-friendly shapes

---

## Step 7: Create API Route

### File: `services/orders/src/api/orders.ts`

Implement the HTTP route handler.

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Match } from "effect"
import { OrderService } from "../services/OrderService.js"
import { CreateOrderRequest, OrderIdParams } from "../domain/Order.js"

// POST /orders - Create order from ledger entry
const createOrder = Effect.gen(function* () {
  const service = yield* OrderService
  const request = yield* HttpServerRequest.schemaBodyJson(CreateOrderRequest)

  const { order, items } = yield* service.create(request)

  // Map to API response format (snake_case for external API)
  const response = {
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
  }

  return yield* HttpServerResponse.json(response, { status: 201 })
}).pipe(
  Effect.catchTags({
    ParseError: (error) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid request body",
          details: error.message
        },
        { status: 400 }
      ),
    RequestError: (error) =>
      HttpServerResponse.json(
        { error: "request_error", message: "Failed to read request body" },
        { status: 400 }
      ),
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)

// GET /orders/:order_id - Get order by ID
const getOrderById = Effect.gen(function* () {
  const service = yield* OrderService
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  const { order, items } = yield* service.findById(orderId)

  // Map to API response format
  const response = {
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
  }

  return yield* HttpServerResponse.json(response)
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
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)

export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder),
  HttpRouter.get("/orders/:order_id", getOrderById)
)
```

**Key Design Points:**
- Uses `schemaBodyJson` for request validation
- Response uses snake_case for external API consistency
- Error handling maps domain errors to appropriate HTTP status codes
- Both POST and GET endpoints included (GET is part of todo.md)

---

## Step 8: Update Layer Composition

### File: `services/orders/src/layers.ts`

Update to include repository and service layers.

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrdersConfigLive } from "./config.js"
import { OrderRepositoryLive } from "./repositories/OrderRepositoryLive.js"
import { OrderServiceLive } from "./services/OrderServiceLive.js"

// Repository layer depends on database
const RepositoryLive = OrderRepositoryLive.pipe(
  Layer.provide(DatabaseLive)
)

// Service layer depends on repositories
const ServiceLive = OrderServiceLive.pipe(
  Layer.provide(RepositoryLive)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrdersConfigLive,
  ServiceLive
)
```

---

## Step 9: Update Server to Include Routes

### File: `services/orders/src/server.ts`

Add OrderRoutes to the router.

```typescript
// Add import
import { OrderRoutes } from "./api/orders.js"

// Update router composition
const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/", OrderRoutes)
)
```

---

## Step 10: Write Unit Tests

### Test Strategy

Following the pattern in `services/inventory/src/__tests__/api/*.test.ts`:

1. **Repository Tests** (`__tests__/OrderRepository.test.ts`)
   - Test SQL mapping logic with mocked SqlClient
   - Test idempotency behavior (Created vs AlreadyExists)
   - Test error handling

2. **Service Tests** (`__tests__/OrderService.test.ts`)
   - Test business logic with mocked repository
   - Test idempotent create behavior
   - Test not found error handling

3. **API Tests** (`__tests__/api/createOrder.test.ts`)
   - Test request validation
   - Test successful creation response format
   - Test error response formats

### File: `services/orders/src/__tests__/api/createOrder.test.ts`

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime } from "effect"
import { OrderService, type OrderWithItems } from "../../services/OrderService.js"
import {
  Order,
  OrderId,
  OrderLedgerId,
  UserId,
  OrderItem,
  OrderItemId,
  ProductId,
  CreateOrderRequest
} from "../../domain/Order.js"

// Test fixtures
const testOrderLedgerId = "550e8400-e29b-41d4-a716-446655440000" as OrderLedgerId
const testOrderId = "660e8400-e29b-41d4-a716-446655440001" as OrderId
const testUserId = "770e8400-e29b-41d4-a716-446655440002" as UserId
const testProductId = "880e8400-e29b-41d4-a716-446655440003" as ProductId
const testOrderItemId = "990e8400-e29b-41d4-a716-446655440004" as OrderItemId

const testOrder = new Order({
  id: testOrderId,
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  status: "CREATED",
  totalAmountCents: 5998,
  currency: "USD",
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testOrderItem = new OrderItem({
  id: testOrderItemId,
  orderId: testOrderId,
  productId: testProductId,
  quantity: 2,
  unitPriceCents: 2999,
  createdAt: DateTime.unsafeNow()
})

// Mock service factory
const createMockOrderService = (overrides: {
  create?: (request: CreateOrderRequest) => Effect.Effect<OrderWithItems>
} = {}) => {
  return Layer.succeed(OrderService, {
    create: overrides.create ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    ),
    findById: () => Effect.succeed({ order: testOrder, items: [testOrderItem] })
  })
}

describe("POST /orders", () => {
  describe("successful creation", () => {
    it("should return 201 with created order and items", async () => {
      // Implementation following inventory service test pattern
      // ...
    })

    it("should return same order on duplicate request (idempotency)", async () => {
      // ...
    })
  })

  describe("validation errors", () => {
    it("should return 400 for missing orderLedgerId", async () => {
      // ...
    })

    it("should return 400 for empty items array", async () => {
      // ...
    })

    it("should return 400 for negative quantity", async () => {
      // ...
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response", async () => {
      // ...
    })

    it("should include all order fields", async () => {
      // ...
    })
  })
})
```

### Coverage Target

Per the plan requirements, aim for **80%+ test coverage** on:
- `src/repositories/OrderRepositoryLive.ts`
- `src/services/OrderServiceLive.ts`

The vitest.config.ts is already configured to measure coverage on these files.

---

## Verification Steps

After implementation, verify:

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
Expected: All tests pass

### 4. Coverage
```bash
npm run test:coverage --workspace=@ecommerce/orders
```
Expected: 80%+ on Live implementation files

### 5. Manual Test (requires PostgreSQL)
```bash
# Start database
docker-compose up -d postgres

# Apply migration
docker-compose exec -T postgres psql -U ecommerce -d ecommerce < migrations/004_create_orders_tables.sql

# Start service
npm run dev:orders

# Create an order
curl -X POST http://localhost:3003/orders \
  -H "Content-Type: application/json" \
  -d '{
    "orderLedgerId": "550e8400-e29b-41d4-a716-446655440000",
    "userId": "660e8400-e29b-41d4-a716-446655440001",
    "totalAmountCents": 5998,
    "currency": "USD",
    "items": [
      {
        "productId": "770e8400-e29b-41d4-a716-446655440002",
        "quantity": 2,
        "unitPriceCents": 2999
      }
    ]
  }'

# Get the order
curl http://localhost:3003/orders/{order_id}

# Test idempotency - same request should return same order
curl -X POST http://localhost:3003/orders \
  -H "Content-Type: application/json" \
  -d '{ same payload }'
```

---

## Files to Create/Modify Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/domain/Order.ts` | Create | Domain types and schemas |
| `src/domain/errors.ts` | Create | Domain error types |
| `src/repositories/OrderRepository.ts` | Create | Repository interface |
| `src/repositories/OrderRepositoryLive.ts` | Create | Repository implementation |
| `src/services/OrderService.ts` | Create | Service interface |
| `src/services/OrderServiceLive.ts` | Create | Service implementation |
| `src/api/orders.ts` | Create | HTTP route handlers |
| `src/layers.ts` | Modify | Add repository/service layers |
| `src/server.ts` | Modify | Mount order routes |
| `src/__tests__/api/createOrder.test.ts` | Create | API tests |
| `src/__tests__/OrderService.test.ts` | Create | Service tests |
| `src/__tests__/OrderRepository.test.ts` | Create | Repository tests |

---

## Design Decisions & Rationale

### Idempotency Strategy

The `POST /orders` endpoint is idempotent via `order_ledger_id`:
- If the order exists, return the existing order (201 Created, same response)
- This allows the Orchestrator to safely retry without creating duplicates
- The UNIQUE constraint on `order_ledger_id` provides database-level protection

### Transaction Scope

Order and items are created in a single transaction:
- Ensures atomicity - no partial orders
- The idempotency check is inside the transaction to prevent race conditions
- Uses `sql.withTransaction` per best-practices.md

### Status Transitions

Order status follows the state machine from engineering-design.md:
- `CREATED` → `CONFIRMED` (happy path)
- `CREATED` → `CANCELLED` (compensation)

Status transition validation will be added in subsequent endpoints (cancel/confirm).

### Response Format

- External API uses snake_case (matches existing patterns)
- Internal domain uses camelCase
- Timestamps are ISO 8601 strings in responses

---

## Patterns Applied

| Pattern | Application |
|---------|-------------|
| Tagged Errors | `OrderNotFoundError`, `OrderAlreadyExistsError` |
| Discriminated Union | `CreateOrderResult` with `Created` / `AlreadyExists` tags |
| Context.Tag | Dependency injection for repository and service |
| Schema Validation | Request validation with branded types |
| Option for Queries | Repository returns `Option<Order>` for find operations |
| Match.exhaustive | Pattern matching on repository results |
| Atomic Transaction | Order + items created atomically |

---

## Next Steps (Out of Scope)

After this plan is implemented:
1. `PUT /orders/{order_id}/cancel` - Cancel order (compensation)
2. `PUT /orders/{order_id}/confirm` - Confirm order (final step)

Both will use the `updateStatus` repository method already defined.
