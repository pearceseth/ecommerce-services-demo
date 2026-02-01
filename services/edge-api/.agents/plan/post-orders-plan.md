# Implementation Plan: POST /orders - Create Order with Payment Authorization

# Status: COMPLETE

---

## Overview

Implement the `POST /orders` endpoint for the Edge API service. This endpoint is the entry point for customer order submissions. It performs synchronous payment authorization and creates a durable ledger entry for asynchronous saga processing by the Orchestrator.

**Key responsibilities:**
1. Validate request and extract Idempotency-Key header
2. Check for duplicate requests (idempotency via `client_request_id`)
3. Create order ledger entry with status `AWAITING_AUTHORIZATION`
4. Call Payment Service to authorize payment
5. If authorized: Update ledger to `AUTHORIZED`, write outbox event, NOTIFY
6. If declined: Update ledger to `AUTHORIZATION_FAILED`, return 402
7. Return 202 Accepted with `order_ledger_id`

---

## File Structure to Create

```
services/edge-api/src/
├── api/
│   └── orders.ts                    # Route handler for POST /orders
├── domain/
│   ├── OrderLedger.ts               # Domain models and schemas
│   └── errors.ts                    # Domain error types
├── repositories/
│   ├── OrderLedgerRepository.ts     # Repository interface
│   └── OrderLedgerRepositoryLive.ts # Repository implementation
├── services/
│   ├── OrderService.ts              # Service interface
│   ├── OrderServiceLive.ts          # Service implementation
│   ├── PaymentClient.ts             # HTTP client interface for Payment Service
│   └── PaymentClientLive.ts         # HTTP client implementation
└── layers.ts                        # Update to include new layers
```

---

## Step 1: Define Domain Models (`src/domain/OrderLedger.ts`)

### 1.1 Branded Types

Define branded types for type-safe identifiers:

```typescript
import { Schema } from "effect"

// Branded UUIDs for type safety
export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

### 1.2 Order Ledger Status Enum

Define status as a literal union matching the database constraint:

```typescript
export const OrderLedgerStatus = Schema.Literal(
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "AUTHORIZATION_FAILED",
  "ORDER_CREATED",
  "INVENTORY_RESERVED",
  "PAYMENT_CAPTURED",
  "COMPLETED",
  "COMPENSATING",
  "FAILED"
)
export type OrderLedgerStatus = typeof OrderLedgerStatus.Type
```

### 1.3 Request Schema

Define the request body schema with validation:

```typescript
// Line item in the order request
export class OrderItemRequest extends Schema.Class<OrderItemRequest>("OrderItemRequest")({
  product_id: Schema.UUID,
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" }),
    Schema.lessThanOrEqualTo(100, { message: () => "Quantity cannot exceed 100 per item" })
  )
}) {}

// Payment information
export class PaymentInfo extends Schema.Class<PaymentInfo>("PaymentInfo")({
  method: Schema.Literal("card"),
  token: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Payment token is required" })
  )
}) {}

// Full order request
export class CreateOrderRequest extends Schema.Class<CreateOrderRequest>("CreateOrderRequest")({
  user_id: Schema.UUID,
  email: Schema.String.pipe(
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: () => "Invalid email format" }),
    Schema.maxLength(255)
  ),
  items: Schema.Array(OrderItemRequest).pipe(
    Schema.minItems(1, { message: () => "Order must contain at least one item" }),
    Schema.maxItems(50, { message: () => "Order cannot exceed 50 items" })
  ),
  payment: PaymentInfo
}) {}
```

### 1.4 Domain Models

```typescript
// Order ledger item (line item in the ledger)
export class OrderLedgerItem extends Schema.Class<OrderLedgerItem>("OrderLedgerItem")({
  id: Schema.UUID,
  orderLedgerId: OrderLedgerId,
  productId: ProductId,
  quantity: Schema.Int,
  unitPriceCents: Schema.Int,
  createdAt: Schema.DateTimeUtc
}) {}

// Order ledger entry
export class OrderLedger extends Schema.Class<OrderLedger>("OrderLedger")({
  id: OrderLedgerId,
  clientRequestId: Schema.String,
  userId: UserId,
  email: Schema.String,
  status: OrderLedgerStatus,
  totalAmountCents: Schema.Int,
  currency: Schema.String,
  paymentAuthorizationId: Schema.NullOr(Schema.String),
  retryCount: Schema.Int,
  nextRetryAt: Schema.NullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}
```

### 1.5 Response Schemas

```typescript
// Success response (202 Accepted)
export class CreateOrderResponse extends Schema.Class<CreateOrderResponse>("CreateOrderResponse")({
  order_ledger_id: Schema.String,
  status: Schema.String,
  message: Schema.String
}) {}

// Idempotent duplicate response (409 Conflict)
export class DuplicateOrderResponse extends Schema.Class<DuplicateOrderResponse>("DuplicateOrderResponse")({
  error: Schema.Literal("duplicate_request"),
  order_ledger_id: Schema.String,
  status: Schema.String
}) {}
```

---

## Step 2: Define Domain Errors (`src/domain/errors.ts`)

Use `Data.TaggedError` for all error types with contextual information:

```typescript
import { Data } from "effect"

// Payment authorization was declined
export class PaymentDeclinedError extends Data.TaggedError("PaymentDeclinedError")<{
  readonly userId: string
  readonly amountCents: number
  readonly declineCode: string
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// Payment gateway unavailable
export class PaymentGatewayError extends Data.TaggedError("PaymentGatewayError")<{
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// Duplicate request (idempotency check)
export class DuplicateRequestError extends Data.TaggedError("DuplicateRequestError")<{
  readonly clientRequestId: string
  readonly existingOrderLedgerId: string
  readonly existingStatus: string
}> {}

// Product not found when looking up prices
export class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
}> {}

// Missing idempotency key header
export class MissingIdempotencyKeyError extends Data.TaggedError("MissingIdempotencyKeyError")<{}> {}

// Database transaction failed
export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly operation: string
  readonly cause: unknown
}> {}
```

---

## Step 3: Define Repository Interface (`src/repositories/OrderLedgerRepository.ts`)

```typescript
import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface CreateOrderLedgerParams {
  readonly clientRequestId: string
  readonly userId: string
  readonly email: string
  readonly totalAmountCents: number
  readonly currency: string
}

export interface CreateOrderLedgerItemParams {
  readonly orderLedgerId: OrderLedgerId
  readonly productId: string
  readonly quantity: number
  readonly unitPriceCents: number
}

export interface UpdateLedgerWithAuthorizationParams {
  readonly orderLedgerId: OrderLedgerId
  readonly paymentAuthorizationId: string
  readonly newStatus: OrderLedgerStatus
}

export class OrderLedgerRepository extends Context.Tag("OrderLedgerRepository")<
  OrderLedgerRepository,
  {
    /**
     * Find existing order ledger by client_request_id (for idempotency check)
     */
    readonly findByClientRequestId: (
      clientRequestId: string
    ) => Effect.Effect<Option.Option<OrderLedger>, SqlError.SqlError>

    /**
     * Create a new order ledger entry with AWAITING_AUTHORIZATION status
     */
    readonly create: (
      params: CreateOrderLedgerParams
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>

    /**
     * Create order ledger items (line items)
     */
    readonly createItems: (
      items: ReadonlyArray<CreateOrderLedgerItemParams>
    ) => Effect.Effect<ReadonlyArray<OrderLedgerItem>, SqlError.SqlError>

    /**
     * Atomically update ledger status, set authorization ID, write outbox event, and NOTIFY.
     * This is the critical transactional operation after payment authorization.
     */
    readonly updateWithAuthorizationAndOutbox: (
      params: UpdateLedgerWithAuthorizationParams
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>

    /**
     * Update ledger status to AUTHORIZATION_FAILED
     */
    readonly markAuthorizationFailed: (
      orderLedgerId: OrderLedgerId
    ) => Effect.Effect<OrderLedger, SqlError.SqlError>
  }
>() {}
```

---

## Step 4: Implement Repository (`src/repositories/OrderLedgerRepositoryLive.ts`)

### 4.1 Layer Setup

```typescript
import { Layer, Effect, Option, DateTime } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql"
import { OrderLedgerRepository, type CreateOrderLedgerParams, type CreateOrderLedgerItemParams, type UpdateLedgerWithAuthorizationParams } from "./OrderLedgerRepository.js"
import { OrderLedger, OrderLedgerItem, type OrderLedgerId, type OrderLedgerStatus } from "../domain/OrderLedger.js"
```

### 4.2 findByClientRequestId Implementation

```typescript
readonly findByClientRequestId: (clientRequestId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    const rows = yield* sql<{
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
    }>`
      SELECT id, client_request_id, user_id, email, status,
             total_amount_cents, currency, payment_authorization_id,
             retry_count, next_retry_at, created_at, updated_at
      FROM order_ledger
      WHERE client_request_id = ${clientRequestId}
    `

    if (rows.length === 0) {
      return Option.none()
    }

    const row = rows[0]
    return Option.some(
      new OrderLedger({
        id: row.id as OrderLedgerId,
        clientRequestId: row.client_request_id,
        userId: row.user_id,
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
    )
  })
```

### 4.3 create Implementation

```typescript
readonly create: (params: CreateOrderLedgerParams) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    const rows = yield* sql<{
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
    }>`
      INSERT INTO order_ledger (client_request_id, user_id, email, total_amount_cents, currency)
      VALUES (${params.clientRequestId}, ${params.userId}, ${params.email}, ${params.totalAmountCents}, ${params.currency})
      RETURNING id, client_request_id, user_id, email, status,
                total_amount_cents, currency, payment_authorization_id,
                retry_count, next_retry_at, created_at, updated_at
    `

    const row = rows[0]
    return new OrderLedger({
      id: row.id as OrderLedgerId,
      clientRequestId: row.client_request_id,
      userId: row.user_id,
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
  })
```

### 4.4 createItems Implementation

```typescript
readonly createItems: (items: ReadonlyArray<CreateOrderLedgerItemParams>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    // Use INSERT ... VALUES with multiple rows
    const results: OrderLedgerItem[] = []

    for (const item of items) {
      const rows = yield* sql<{
        id: string
        order_ledger_id: string
        product_id: string
        quantity: number
        unit_price_cents: number
        created_at: string
      }>`
        INSERT INTO order_ledger_items (order_ledger_id, product_id, quantity, unit_price_cents)
        VALUES (${item.orderLedgerId}, ${item.productId}, ${item.quantity}, ${item.unitPriceCents})
        RETURNING id, order_ledger_id, product_id, quantity, unit_price_cents, created_at
      `

      const row = rows[0]
      results.push(
        new OrderLedgerItem({
          id: row.id,
          orderLedgerId: row.order_ledger_id as OrderLedgerId,
          productId: row.product_id,
          quantity: row.quantity,
          unitPriceCents: row.unit_price_cents,
          createdAt: DateTime.unsafeFromDate(new Date(row.created_at))
        })
      )
    }

    return results
  })
```

### 4.5 updateWithAuthorizationAndOutbox Implementation (CRITICAL)

This is the most important method. It must be atomic and include:
- Update ledger status and authorization ID
- Write outbox event
- Execute NOTIFY

```typescript
readonly updateWithAuthorizationAndOutbox: (params: UpdateLedgerWithAuthorizationParams) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    // CRITICAL: All operations must be in a single transaction
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // 1. Update ledger status
        const ledgerRows = yield* sql<{
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
        }>`
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

        return new OrderLedger({
          id: ledgerRow.id as OrderLedgerId,
          clientRequestId: ledgerRow.client_request_id,
          userId: ledgerRow.user_id,
          email: ledgerRow.email,
          status: ledgerRow.status as OrderLedgerStatus,
          totalAmountCents: ledgerRow.total_amount_cents,
          currency: ledgerRow.currency,
          paymentAuthorizationId: ledgerRow.payment_authorization_id,
          retryCount: ledgerRow.retry_count,
          nextRetryAt: ledgerRow.next_retry_at ? DateTime.unsafeFromDate(new Date(ledgerRow.next_retry_at)) : null,
          createdAt: DateTime.unsafeFromDate(new Date(ledgerRow.created_at)),
          updatedAt: DateTime.unsafeFromDate(new Date(ledgerRow.updated_at))
        })
      })
    )
  })
```

### 4.6 markAuthorizationFailed Implementation

```typescript
readonly markAuthorizationFailed: (orderLedgerId: OrderLedgerId) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    const rows = yield* sql<{
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
    }>`
      UPDATE order_ledger
      SET status = 'AUTHORIZATION_FAILED'
      WHERE id = ${orderLedgerId}
      RETURNING id, client_request_id, user_id, email, status,
                total_amount_cents, currency, payment_authorization_id,
                retry_count, next_retry_at, created_at, updated_at
    `

    const row = rows[0]
    return new OrderLedger({
      id: row.id as OrderLedgerId,
      clientRequestId: row.client_request_id,
      userId: row.user_id,
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
  })
```

### 4.7 Export Layer

```typescript
export const OrderLedgerRepositoryLive = Layer.effect(
  OrderLedgerRepository,
  Effect.gen(function* () {
    return {
      findByClientRequestId: // implementation
      create: // implementation
      createItems: // implementation
      updateWithAuthorizationAndOutbox: // implementation
      markAuthorizationFailed: // implementation
    }
  })
)
```

---

## Step 5: Define Payment Client Interface (`src/services/PaymentClient.ts`)

This is an HTTP client to call the Payment Service:

```typescript
import { Context, Effect } from "effect"
import type { PaymentDeclinedError, PaymentGatewayError } from "../domain/errors.js"

export interface AuthorizePaymentParams {
  readonly userId: string
  readonly amountCents: number
  readonly currency: string
  readonly paymentToken: string
  readonly idempotencyKey: string
}

export interface AuthorizePaymentResult {
  readonly authorizationId: string
  readonly status: "AUTHORIZED"
  readonly amountCents: number
  readonly currency: string
  readonly createdAt: string
}

export class PaymentClient extends Context.Tag("PaymentClient")<
  PaymentClient,
  {
    /**
     * Authorize a payment via the Payment Service.
     * Returns authorization_id on success.
     * Fails with PaymentDeclinedError if payment is declined.
     * Fails with PaymentGatewayError if the gateway is unavailable.
     */
    readonly authorize: (
      params: AuthorizePaymentParams
    ) => Effect.Effect<AuthorizePaymentResult, PaymentDeclinedError | PaymentGatewayError>
  }
>() {}
```

---

## Step 6: Implement Payment Client (`src/services/PaymentClientLive.ts`)

Use Effect's HTTP client to make requests:

```typescript
import { Layer, Effect, Config, Duration } from "effect"
import { HttpClient, HttpClientRequest, HttpClientError } from "@effect/platform"
import { PaymentClient, type AuthorizePaymentParams, type AuthorizePaymentResult } from "./PaymentClient.js"
import { PaymentDeclinedError, PaymentGatewayError } from "../domain/errors.js"

export const PaymentClientLive = Layer.effect(
  PaymentClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("PAYMENT_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3002")
    )
    const client = yield* HttpClient.HttpClient

    return {
      authorize: (params: AuthorizePaymentParams) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${baseUrl}/payments/authorize`).pipe(
            HttpClientRequest.jsonBody({
              user_id: params.userId,
              amount_cents: params.amountCents,
              currency: params.currency,
              payment_token: params.paymentToken,
              idempotency_key: params.idempotencyKey
            })
          )

          const response = yield* client.execute(yield* request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", () =>
              Effect.fail(new PaymentGatewayError({
                reason: "Request timed out",
                isRetryable: true
              }))
            )
          )

          // Check response status
          if (response.status === 200) {
            const body = yield* response.json as Effect.Effect<AuthorizePaymentResult>
            return body
          }

          if (response.status === 402) {
            // Payment declined
            const body = yield* response.json as Effect.Effect<{
              error: string
              decline_code: string
              message: string
              is_retryable: boolean
            }>
            return yield* Effect.fail(new PaymentDeclinedError({
              userId: params.userId,
              amountCents: params.amountCents,
              declineCode: body.decline_code,
              reason: body.message,
              isRetryable: body.is_retryable
            }))
          }

          if (response.status === 503) {
            // Gateway unavailable
            const body = yield* response.json as Effect.Effect<{
              error: string
              message: string
              is_retryable: boolean
            }>
            return yield* Effect.fail(new PaymentGatewayError({
              reason: body.message,
              isRetryable: body.is_retryable
            }))
          }

          // Unexpected status
          return yield* Effect.fail(new PaymentGatewayError({
            reason: `Unexpected response status: ${response.status}`,
            isRetryable: false
          }))
        }).pipe(
          // Map HTTP client errors to domain errors
          Effect.catchTag("ResponseError", (error: HttpClientError.ResponseError) =>
            Effect.fail(new PaymentGatewayError({
              reason: `HTTP error: ${error.message}`,
              isRetryable: true
            }))
          ),
          Effect.catchTag("RequestError", (error: HttpClientError.RequestError) =>
            Effect.fail(new PaymentGatewayError({
              reason: `Connection error: ${error.message}`,
              isRetryable: true
            }))
          )
        )
    }
  })
)
```

---

## Step 7: Define Order Service Interface (`src/services/OrderService.ts`)

```typescript
import { Context, Effect } from "effect"
import type { CreateOrderRequest, OrderLedger } from "../domain/OrderLedger.js"
import type {
  PaymentDeclinedError,
  PaymentGatewayError,
  DuplicateRequestError,
  MissingIdempotencyKeyError
} from "../domain/errors.js"
import type { SqlError } from "@effect/sql"

export interface CreateOrderResult {
  readonly orderLedgerId: string
  readonly status: string
}

export class OrderService extends Context.Tag("OrderService")<
  OrderService,
  {
    /**
     * Process a new order request.
     *
     * 1. Check for duplicate (idempotency)
     * 2. Create ledger entry
     * 3. Authorize payment
     * 4. Update ledger with authorization result
     *
     * Returns order_ledger_id and status on success.
     */
    readonly createOrder: (
      idempotencyKey: string,
      request: CreateOrderRequest
    ) => Effect.Effect<
      CreateOrderResult,
      | DuplicateRequestError
      | PaymentDeclinedError
      | PaymentGatewayError
      | SqlError.SqlError
    >
  }
>() {}
```

---

## Step 8: Implement Order Service (`src/services/OrderServiceLive.ts`)

### 8.1 Core Implementation

```typescript
import { Layer, Effect, Option, Match } from "effect"
import { OrderService, type CreateOrderResult } from "./OrderService.js"
import { OrderLedgerRepository } from "../repositories/OrderLedgerRepository.js"
import { PaymentClient } from "./PaymentClient.js"
import type { CreateOrderRequest, OrderLedgerId } from "../domain/OrderLedger.js"
import { DuplicateRequestError, PaymentDeclinedError } from "../domain/errors.js"

export const OrderServiceLive = Layer.effect(
  OrderService,
  Effect.gen(function* () {
    const ledgerRepo = yield* OrderLedgerRepository
    const paymentClient = yield* PaymentClient

    return {
      createOrder: (idempotencyKey: string, request: CreateOrderRequest) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Processing order request", {
            idempotencyKey,
            userId: request.user_id,
            itemCount: request.items.length
          })

          // Step 1: Check for duplicate request (idempotency)
          const existingLedger = yield* ledgerRepo.findByClientRequestId(idempotencyKey)

          if (Option.isSome(existingLedger)) {
            const existing = existingLedger.value
            yield* Effect.logInfo("Duplicate request detected", {
              idempotencyKey,
              existingOrderLedgerId: existing.id,
              existingStatus: existing.status
            })
            return yield* Effect.fail(new DuplicateRequestError({
              clientRequestId: idempotencyKey,
              existingOrderLedgerId: existing.id,
              existingStatus: existing.status
            }))
          }

          // Step 2: Calculate total amount
          // Note: In production, we would look up prices from Inventory Service
          // For now, use a placeholder that must be replaced with actual price lookup
          const totalAmountCents = yield* calculateTotalAmount(request.items)

          // Step 3: Create ledger entry with AWAITING_AUTHORIZATION status
          const ledger = yield* ledgerRepo.create({
            clientRequestId: idempotencyKey,
            userId: request.user_id,
            email: request.email,
            totalAmountCents,
            currency: "USD"
          })

          yield* Effect.logInfo("Order ledger created", {
            orderLedgerId: ledger.id,
            status: ledger.status
          })

          // Step 4: Create ledger items
          const itemParams = request.items.map((item, index) => ({
            orderLedgerId: ledger.id,
            productId: item.product_id,
            quantity: item.quantity,
            // TODO: Replace with actual price lookup from Inventory Service
            unitPriceCents: 0 // Placeholder - needs price lookup
          }))

          yield* ledgerRepo.createItems(itemParams)

          // Step 5: Authorize payment
          const authResult = yield* paymentClient.authorize({
            userId: request.user_id,
            amountCents: totalAmountCents,
            currency: "USD",
            paymentToken: request.payment.token,
            idempotencyKey
          }).pipe(
            Effect.catchTag("PaymentDeclinedError", (error) =>
              Effect.gen(function* () {
                // Mark ledger as failed before re-throwing
                yield* ledgerRepo.markAuthorizationFailed(ledger.id)
                yield* Effect.logWarning("Payment declined", {
                  orderLedgerId: ledger.id,
                  declineCode: error.declineCode,
                  reason: error.reason
                })
                return yield* Effect.fail(error)
              })
            )
          )

          yield* Effect.logInfo("Payment authorized", {
            orderLedgerId: ledger.id,
            authorizationId: authResult.authorizationId
          })

          // Step 6: Update ledger with authorization and write outbox event
          const updatedLedger = yield* ledgerRepo.updateWithAuthorizationAndOutbox({
            orderLedgerId: ledger.id,
            paymentAuthorizationId: authResult.authorizationId,
            newStatus: "AUTHORIZED"
          })

          yield* Effect.logInfo("Order authorized successfully", {
            orderLedgerId: updatedLedger.id,
            status: updatedLedger.status,
            paymentAuthorizationId: updatedLedger.paymentAuthorizationId
          })

          return {
            orderLedgerId: updatedLedger.id,
            status: updatedLedger.status
          } satisfies CreateOrderResult
        })
    }
  })
)

// Helper function to calculate total amount
// TODO: This should call Inventory Service to get actual prices
const calculateTotalAmount = (items: ReadonlyArray<{ product_id: string; quantity: number }>) =>
  Effect.gen(function* () {
    // Placeholder: In production, call Inventory Service GET /products/:id/availability
    // to get product prices and validate products exist
    yield* Effect.logWarning("Using placeholder price calculation - implement price lookup")

    // For now, return a placeholder that will need to be replaced
    // This should fetch prices from inventory service and calculate total
    return 0 // TODO: Implement actual price lookup
  })
```

### 8.2 Price Lookup Implementation Note

The `calculateTotalAmount` function needs to:
1. Call Inventory Service for each unique product ID to get `price_cents`
2. Validate all products exist (fail with ProductNotFoundError if not)
3. Calculate: `SUM(quantity * price_cents)`

This can be implemented as a separate InventoryClient or batched lookup.

---

## Step 9: Implement Route Handler (`src/api/orders.ts`)

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, type ParseResult } from "effect"
import { CreateOrderRequest } from "../domain/OrderLedger.js"
import { OrderService } from "../services/OrderService.js"
import type {
  PaymentDeclinedError,
  PaymentGatewayError,
  DuplicateRequestError,
  MissingIdempotencyKeyError
} from "../domain/errors.js"

// POST /orders - Create a new order
const createOrder = Effect.gen(function* () {
  // 1. Extract Idempotency-Key header
  const request = yield* HttpServerRequest.HttpServerRequest
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

  // 2. Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(CreateOrderRequest)

  // 3. Execute order creation
  const orderService = yield* OrderService
  const result = yield* orderService.createOrder(idempotencyKey, body)

  yield* Effect.logInfo("Order created", {
    orderLedgerId: result.orderLedgerId,
    status: result.status
  })

  // 4. Return 202 Accepted
  return HttpServerResponse.json(
    {
      order_ledger_id: result.orderLedgerId,
      status: result.status,
      message: "Order received, processing"
    },
    { status: 202 }
  )
}).pipe(
  Effect.withSpan("POST /orders"),
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

    // Request body parsing errors (400 Bad Request)
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        {
          error: "request_error",
          message: "Failed to parse request body"
        },
        { status: 400 }
      ),

    // Duplicate request (409 Conflict - idempotent response)
    DuplicateRequestError: (error: DuplicateRequestError) =>
      HttpServerResponse.json(
        {
          error: "duplicate_request",
          order_ledger_id: error.existingOrderLedgerId,
          status: error.existingStatus
        },
        { status: 409 }
      ),

    // Payment declined (402 Payment Required)
    PaymentDeclinedError: (error: PaymentDeclinedError) =>
      HttpServerResponse.json(
        {
          error: "payment_declined",
          decline_code: error.declineCode,
          message: error.reason,
          is_retryable: error.isRetryable
        },
        { status: 402 }
      ),

    // Payment gateway unavailable (503 Service Unavailable)
    PaymentGatewayError: (error: PaymentGatewayError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Payment gateway error", { reason: error.reason })
        return HttpServerResponse.json(
          {
            error: "gateway_error",
            message: "Payment service temporarily unavailable",
            is_retryable: error.isRetryable
          },
          { status: 503 }
        )
      }).pipe(Effect.flatten),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in createOrder", { error })
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

// Export routes
export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder)
)
```

---

## Step 10: Update Layers (`src/layers.ts`)

Add the new services and repositories to the layer composition:

```typescript
import { Layer } from "effect"
import { HttpClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseLive } from "./db.js"
import { EdgeApiConfigLive } from "./config.js"
import { OrderLedgerRepositoryLive } from "./repositories/OrderLedgerRepositoryLive.js"
import { OrderServiceLive } from "./services/OrderServiceLive.js"
import { PaymentClientLive } from "./services/PaymentClientLive.js"

// Repository layer depends on database
const RepositoryLive = Layer.mergeAll(
  OrderLedgerRepositoryLive
).pipe(Layer.provide(DatabaseLive))

// HTTP client layer for making external requests
const HttpClientLive = NodeHttpClient.layer

// Payment client depends on HTTP client
const PaymentClientLayer = PaymentClientLive.pipe(
  Layer.provide(HttpClientLive)
)

// Service layer depends on repositories and clients
const ServiceLive = Layer.mergeAll(
  OrderServiceLive
).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(PaymentClientLayer)
)

// Combined application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  EdgeApiConfigLive,
  ServiceLive
)
```

---

## Step 11: Update Server (`src/server.ts`)

Mount the new order routes:

```typescript
import { OrderRoutes } from "./api/orders.js"

const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/", OrderRoutes)  // Add order routes
)
```

---

## Step 12: Configuration Updates

### 12.1 Update `src/config.ts`

Add Payment Service URL configuration:

```typescript
export class EdgeApiConfig extends Context.Tag("EdgeApiConfig")<
  EdgeApiConfig,
  {
    readonly port: number
    readonly paymentServiceUrl: string
  }
>() {}

export const EdgeApiConfigLive = Layer.effect(
  EdgeApiConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3000)),
      paymentServiceUrl: yield* Config.string("PAYMENT_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      )
    }
  })
)
```

### 12.2 Environment Variables

Document in README or docker-compose:
- `PAYMENT_SERVICE_URL` - URL of Payment Service (default: `http://localhost:3002`)

---

## Step 13: Testing Strategy

### 13.1 Unit Tests

Create `src/__tests__/api/orders.test.ts`:

**Test cases:**
1. Happy path: Valid request returns 202 with order_ledger_id
2. Missing Idempotency-Key header returns 400
3. Invalid request body (schema validation) returns 400
4. Duplicate request returns 409 with existing order details
5. Payment declined returns 402 with decline details
6. Payment gateway timeout returns 503

**Mocking approach:**
- Mock `OrderLedgerRepository` via Layer.succeed
- Mock `PaymentClient` via Layer.succeed
- Use Effect.runPromise for assertions

### 13.2 Integration Tests

Test full flow with real database (test container):
1. Create order, verify ledger entry created
2. Verify outbox event written
3. Duplicate request returns existing ledger
4. Payment failure updates ledger to AUTHORIZATION_FAILED

---

## Step 14: Implementation Checklist

- [ ] Create `src/domain/OrderLedger.ts` with all schemas
- [ ] Create `src/domain/errors.ts` with tagged errors
- [ ] Create `src/repositories/OrderLedgerRepository.ts` interface
- [ ] Create `src/repositories/OrderLedgerRepositoryLive.ts` implementation
- [ ] Create `src/services/PaymentClient.ts` interface
- [ ] Create `src/services/PaymentClientLive.ts` implementation
- [ ] Create `src/services/OrderService.ts` interface
- [ ] Create `src/services/OrderServiceLive.ts` implementation
- [ ] Create `src/api/orders.ts` route handler
- [ ] Update `src/layers.ts` with new dependencies
- [ ] Update `src/server.ts` to mount order routes
- [ ] Update `src/config.ts` with payment service URL
- [ ] Create unit tests for route handler
- [ ] Verify with integration test

---

## API Contract Reference

### Request

```
POST /orders
Content-Type: application/json
Idempotency-Key: {client_request_id}

{
  "user_id": "uuid",
  "email": "customer@example.com",
  "items": [
    {
      "product_id": "uuid",
      "quantity": 2
    }
  ],
  "payment": {
    "method": "card",
    "token": "tok_xxx"
  }
}
```

### Responses

**202 Accepted** (Success):
```json
{
  "order_ledger_id": "uuid",
  "status": "AUTHORIZED",
  "message": "Order received, processing"
}
```

**400 Bad Request** (Validation error):
```json
{
  "error": "validation_error",
  "message": "Invalid request data",
  "details": "..."
}
```

**400 Bad Request** (Missing header):
```json
{
  "error": "missing_idempotency_key",
  "message": "Idempotency-Key header is required"
}
```

**402 Payment Required** (Declined):
```json
{
  "error": "payment_declined",
  "decline_code": "insufficient_funds",
  "message": "Card has insufficient funds",
  "is_retryable": false
}
```

**409 Conflict** (Duplicate):
```json
{
  "error": "duplicate_request",
  "order_ledger_id": "uuid",
  "status": "AUTHORIZED"
}
```

**503 Service Unavailable** (Gateway error):
```json
{
  "error": "gateway_error",
  "message": "Payment service temporarily unavailable",
  "is_retryable": true
}
```

---

## Open Questions / Future Considerations

1. **Price Lookup**: The current plan includes a placeholder for price calculation. A proper implementation should call the Inventory Service to:
   - Validate all product IDs exist
   - Retrieve current `price_cents` for each product
   - Calculate total and store `unit_price_cents` in ledger items

2. **Product Validation**: Consider whether to validate product existence before creating the ledger entry, or handle it asynchronously in the saga.

3. **Rate Limiting**: Consider adding rate limiting per user_id or IP to prevent abuse.

4. **Request Timeout**: The Payment Service call has a 10-second timeout. Consider if this is appropriate for the expected latency.
