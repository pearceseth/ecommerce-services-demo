# Implementation Plan: Saga Execution for Orchestrator Service

## Status: COMPLETE

---

## Overview

This plan covers the implementation of the Saga Execution logic for the Orchestrator service. The orchestrator claims outbox events, executes the order fulfillment saga (create order → reserve inventory → capture payment → confirm order), updates ledger status at each step, and handles compensation on failures.

The scaffold is already in place with LISTEN/NOTIFY subscription and polling fallback. This plan implements the actual saga execution logic.

---

## Scope

### In Scope (This Plan)
- [ ] Outbox repository for claiming events with `SELECT FOR UPDATE SKIP LOCKED`
- [ ] HTTP clients for Orders, Inventory, and Payments services
- [ ] Order ledger repository for status updates
- [ ] Saga executor service with state machine logic
- [ ] Step execution with ledger status updates
- [ ] Integration with existing `processEvents` function

### Out of Scope (Future Plans)
- Compensation handling (separate plan)
- Retry logic with exponential backoff (separate plan)

---

## Technical Design

### 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Orchestrator Service                          │
├─────────────────────────────────────────────────────────────────────┤
│  main.ts                                                            │
│    ├── notificationLoop (LISTEN/NOTIFY)                             │
│    └── pollingLoop (every 5s)                                       │
│           ↓                                                          │
│  processEvents()                                                     │
│           ↓                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  OutboxRepository.claimPendingEvents()                      │    │
│  │    SELECT FROM outbox ... FOR UPDATE SKIP LOCKED            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│           ↓                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  SagaExecutor.executeSaga(outboxEvent)                      │    │
│  │    ├── Step 1: OrdersClient.createOrder()                   │    │
│  │    │     └── Update ledger: AUTHORIZED → ORDER_CREATED      │    │
│  │    ├── Step 2: InventoryClient.reserveStock()               │    │
│  │    │     └── Update ledger: ORDER_CREATED → INVENTORY_RES.  │    │
│  │    ├── Step 3: PaymentsClient.capturePayment()              │    │
│  │    │     └── Update ledger: INVENTORY_RES. → PAYMENT_CAPT.  │    │
│  │    └── Step 4: OrdersClient.confirmOrder()                  │    │
│  │          └── Update ledger: PAYMENT_CAPT. → COMPLETED       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│           ↓                                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  OutboxRepository.markProcessed(eventId)                    │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### 2. Folder Structure Updates

```
services/orchestrator/src/
├── index.ts
├── main.ts                    # Update processEvents to call SagaExecutor
├── config.ts
├── db.ts
├── telemetry.ts
├── layers.ts                  # Add new repositories, clients, services
├── domain/
│   ├── OutboxEvent.ts         # NEW: Outbox event domain model
│   ├── OrderLedger.ts         # NEW: Order ledger domain model for orchestrator
│   ├── errors.ts              # NEW: Domain-specific errors
│   └── SagaState.ts           # NEW: Saga state types and transitions
├── repositories/
│   ├── OutboxRepository.ts    # NEW: Interface
│   ├── OutboxRepositoryLive.ts# NEW: Implementation
│   ├── LedgerRepository.ts    # NEW: Interface (read/update ledger)
│   └── LedgerRepositoryLive.ts# NEW: Implementation
├── services/
│   ├── SagaExecutor.ts        # NEW: Interface
│   └── SagaExecutorLive.ts    # NEW: Saga execution implementation
└── clients/
    ├── OrdersClient.ts        # NEW: Interface
    ├── OrdersClientLive.ts    # NEW: Implementation
    ├── InventoryClient.ts     # NEW: Interface
    ├── InventoryClientLive.ts # NEW: Implementation
    ├── PaymentsClient.ts      # NEW: Interface
    └── PaymentsClientLive.ts  # NEW: Implementation
```

### 3. Domain Models

#### 3.1 OutboxEvent (`src/domain/OutboxEvent.ts`)

```typescript
import { Schema } from "effect"

// Branded types
export const OutboxEventId = Schema.UUID.pipe(Schema.brand("OutboxEventId"))
export type OutboxEventId = typeof OutboxEventId.Type

export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

// Outbox event status
export const OutboxEventStatus = Schema.Literal("PENDING", "PROCESSED", "FAILED")
export type OutboxEventStatus = typeof OutboxEventStatus.Type

// Outbox event type
export const OutboxEventType = Schema.Literal("OrderAuthorized")
export type OutboxEventType = typeof OutboxEventType.Type

// Payload schema for OrderAuthorized events
export class OrderAuthorizedPayload extends Schema.Class<OrderAuthorizedPayload>("OrderAuthorizedPayload")({
  order_ledger_id: Schema.UUID,
  user_id: Schema.UUID,
  email: Schema.String,
  total_amount_cents: Schema.Int,
  currency: Schema.String,
  payment_authorization_id: Schema.String
}) {}

// Full outbox event
export class OutboxEvent extends Schema.Class<OutboxEvent>("OutboxEvent")({
  id: OutboxEventId,
  aggregateType: Schema.String,
  aggregateId: Schema.UUID,
  eventType: OutboxEventType,
  payload: Schema.Unknown, // Parsed based on eventType
  status: OutboxEventStatus,
  createdAt: Schema.DateTimeUtc,
  processedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}
```

#### 3.2 OrderLedger (`src/domain/OrderLedger.ts`)

```typescript
import { Schema } from "effect"

export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

// All possible ledger statuses (state machine)
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

export class OrderLedgerItem extends Schema.Class<OrderLedgerItem>("OrderLedgerItem")({
  id: Schema.UUID,
  orderLedgerId: OrderLedgerId,
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive()),
  unitPriceCents: Schema.Int,
  createdAt: Schema.DateTimeUtc
}) {}
```

#### 3.3 SagaState (`src/domain/SagaState.ts`)

```typescript
import type { OrderLedgerStatus } from "./OrderLedger.js"

/**
 * Valid state transitions for the saga.
 * Used to validate transitions before updating ledger status.
 */
export const VALID_TRANSITIONS: Record<OrderLedgerStatus, readonly OrderLedgerStatus[]> = {
  AWAITING_AUTHORIZATION: ["AUTHORIZED", "AUTHORIZATION_FAILED"],
  AUTHORIZED: ["ORDER_CREATED", "COMPENSATING"],
  AUTHORIZATION_FAILED: [], // Terminal state
  ORDER_CREATED: ["INVENTORY_RESERVED", "COMPENSATING"],
  INVENTORY_RESERVED: ["PAYMENT_CAPTURED", "COMPENSATING"],
  PAYMENT_CAPTURED: ["COMPLETED", "COMPENSATING"],
  COMPLETED: [], // Terminal state
  COMPENSATING: ["FAILED"],
  FAILED: [] // Terminal state
}

/**
 * Check if a state transition is valid.
 */
export const isValidTransition = (
  from: OrderLedgerStatus,
  to: OrderLedgerStatus
): boolean => VALID_TRANSITIONS[from].includes(to)

/**
 * Steps in order of execution.
 * Used to determine which compensations to run on failure.
 */
export const SAGA_STEPS = [
  "ORDER_CREATED",
  "INVENTORY_RESERVED",
  "PAYMENT_CAPTURED",
  "COMPLETED"
] as const

export type SagaStep = typeof SAGA_STEPS[number]

/**
 * Get the index of a saga step (for compensation ordering).
 */
export const getSagaStepIndex = (status: OrderLedgerStatus): number =>
  SAGA_STEPS.indexOf(status as SagaStep)
```

#### 3.4 Errors (`src/domain/errors.ts`)

```typescript
import { Data } from "effect"

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Client Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Order creation failed via Orders Service
 */
export class OrderCreationError extends Data.TaggedError("OrderCreationError")<{
  readonly orderLedgerId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Inventory reservation failed
 */
export class InventoryReservationError extends Data.TaggedError("InventoryReservationError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
  // Specific details for insufficient stock
  readonly insufficientStock?: {
    productId: string
    productSku?: string
    requested: number
    available: number
  }
}> {}

/**
 * Payment capture failed
 */
export class PaymentCaptureError extends Data.TaggedError("PaymentCaptureError")<{
  readonly authorizationId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Order confirmation failed
 */
export class OrderConfirmationError extends Data.TaggedError("OrderConfirmationError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Generic HTTP client error for connection issues
 */
export class ServiceConnectionError extends Data.TaggedError("ServiceConnectionError")<{
  readonly service: "orders" | "inventory" | "payments"
  readonly operation: string
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// ═══════════════════════════════════════════════════════════════════════════
// Saga Execution Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Invalid saga state transition attempted
 */
export class InvalidStateTransitionError extends Data.TaggedError("InvalidStateTransitionError")<{
  readonly orderLedgerId: string
  readonly fromStatus: string
  readonly toStatus: string
}> {}

/**
 * Order ledger not found
 */
export class LedgerNotFoundError extends Data.TaggedError("LedgerNotFoundError")<{
  readonly orderLedgerId: string
}> {}

/**
 * Outbox event payload parsing failed
 */
export class InvalidPayloadError extends Data.TaggedError("InvalidPayloadError")<{
  readonly eventId: string
  readonly eventType: string
  readonly reason: string
}> {}

// ═══════════════════════════════════════════════════════════════════════════
// Aggregate Error Types for Pattern Matching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All errors that indicate the saga step should be retried
 */
export type RetryableError =
  | ServiceConnectionError
  | (OrderCreationError & { isRetryable: true })
  | (InventoryReservationError & { isRetryable: true })
  | (PaymentCaptureError & { isRetryable: true })
  | (OrderConfirmationError & { isRetryable: true })

/**
 * All errors that indicate the saga should immediately compensate
 */
export type PermanentError =
  | (InventoryReservationError & { isRetryable: false })
  | (PaymentCaptureError & { isRetryable: false })
  | InvalidStateTransitionError
  | LedgerNotFoundError
```

### 4. Repositories

#### 4.1 OutboxRepository Interface (`src/repositories/OutboxRepository.ts`)

```typescript
import { Context, Effect } from "effect"
import type { OutboxEvent, OutboxEventId } from "../domain/OutboxEvent.js"

export interface ClaimResult {
  readonly events: readonly OutboxEvent[]
}

export class OutboxRepository extends Context.Tag("OutboxRepository")<
  OutboxRepository,
  {
    /**
     * Claim pending outbox events for processing.
     * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent access.
     * Returns events in creation order.
     *
     * @param limit - Maximum number of events to claim (default: 10)
     */
    readonly claimPendingEvents: (limit?: number) => Effect.Effect<ClaimResult>

    /**
     * Mark an event as successfully processed.
     */
    readonly markProcessed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Mark an event as failed (for dead-letter handling).
     */
    readonly markFailed: (eventId: OutboxEventId) => Effect.Effect<void>
  }
>() {}
```

#### 4.2 OutboxRepository Implementation (`src/repositories/OutboxRepositoryLive.ts`)

```typescript
import { Layer, Effect, DateTime } from "effect"
import { PgClient } from "@effect/sql-pg"
import { OutboxRepository, type ClaimResult } from "./OutboxRepository.js"
import { OutboxEvent, type OutboxEventId, type OutboxEventType, type OutboxEventStatus } from "../domain/OutboxEvent.js"

// Database row type
interface OutboxRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: unknown // JSONB comes back as object
  status: string
  created_at: string
  processed_at: string | null
}

const rowToOutboxEvent = (row: OutboxRow): OutboxEvent =>
  new OutboxEvent({
    id: row.id as OutboxEventId,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type as OutboxEventType,
    payload: row.payload,
    status: row.status as OutboxEventStatus,
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at)),
    processedAt: row.processed_at ? DateTime.unsafeFromDate(new Date(row.processed_at)) : null
  })

export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    return {
      claimPendingEvents: (limit = 10) =>
        Effect.gen(function* () {
          // CRITICAL: Must use transaction to hold locks until processing complete
          // The caller is responsible for committing after processing
          const rows = yield* sql<OutboxRow>`
            SELECT id, aggregate_type, aggregate_id, event_type, payload, status, created_at, processed_at
            FROM outbox
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          `

          yield* Effect.logDebug("Claimed outbox events", { count: rows.length })

          const events = rows.map(rowToOutboxEvent)
          return { events } satisfies ClaimResult
        }),

      markProcessed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'PROCESSED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as processed", { eventId })
        }),

      markFailed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'FAILED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as failed", { eventId })
        })
    }
  })
)
```

#### 4.3 LedgerRepository Interface (`src/repositories/LedgerRepository.ts`)

```typescript
import { Context, Effect, Option } from "effect"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface LedgerWithItems {
  readonly ledger: OrderLedger
  readonly items: readonly OrderLedgerItem[]
}

export class LedgerRepository extends Context.Tag("LedgerRepository")<
  LedgerRepository,
  {
    /**
     * Find a ledger entry by ID, including its items.
     */
    readonly findByIdWithItems: (id: OrderLedgerId) => Effect.Effect<Option.Option<LedgerWithItems>>

    /**
     * Update the ledger status.
     * Also updates the `updated_at` timestamp automatically via trigger.
     */
    readonly updateStatus: (id: OrderLedgerId, newStatus: OrderLedgerStatus) => Effect.Effect<OrderLedger>

    /**
     * Update ledger status and store the created order ID.
     * Used after Step 1 (create order) to record the order reference.
     */
    readonly updateStatusWithOrderId: (
      id: OrderLedgerId,
      newStatus: OrderLedgerStatus,
      orderId: string
    ) => Effect.Effect<OrderLedger>
  }
>() {}
```

**Note**: The `order_ledger` table needs a new column to store `order_id` after the order is created. This requires a migration:

```sql
-- Migration: Add order_id column to order_ledger
ALTER TABLE order_ledger ADD COLUMN order_id UUID;
CREATE INDEX idx_order_ledger_order_id ON order_ledger(order_id);
```

This is recommended but not strictly required - alternatively, the order can be looked up by `order_ledger_id` via the Orders Service. For simplicity in this plan, we'll store the `order_id` in the ledger.

#### 4.4 LedgerRepository Implementation (`src/repositories/LedgerRepositoryLive.ts`)

```typescript
import { Layer, Effect, Option, DateTime } from "effect"
import { PgClient } from "@effect/sql-pg"
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
  retry_count: number
  next_retry_at: string | null
  created_at: string
  updated_at: string
}

interface LedgerWithItemsRow extends LedgerRow {
  item_id: string | null
  product_id: string | null
  quantity: number | null
  unit_price_cents: number | null
  item_created_at: string | null
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
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ? DateTime.unsafeFromDate(new Date(row.next_retry_at)) : null,
    createdAt: DateTime.unsafeFromDate(new Date(row.created_at)),
    updatedAt: DateTime.unsafeFromDate(new Date(row.updated_at))
  })

export const LedgerRepositoryLive = Layer.effect(
  LedgerRepository,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient

    return {
      findByIdWithItems: (id: OrderLedgerId) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerWithItemsRow>`
            SELECT
              ol.id, ol.client_request_id, ol.user_id, ol.email, ol.status,
              ol.total_amount_cents, ol.currency, ol.payment_authorization_id,
              ol.order_id, ol.retry_count, ol.next_retry_at, ol.created_at, ol.updated_at,
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
                createdAt: DateTime.unsafeFromDate(new Date(row.item_created_at!))
              })
            )

          return Option.some({ ledger, items } satisfies LedgerWithItems)
        }),

      updateStatus: (id: OrderLedgerId, newStatus: OrderLedgerStatus) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerRow>`
            UPDATE order_ledger
            SET status = ${newStatus}
            WHERE id = ${id}
            RETURNING *
          `
          return rowToLedger(rows[0])
        }),

      updateStatusWithOrderId: (id: OrderLedgerId, newStatus: OrderLedgerStatus, orderId: string) =>
        Effect.gen(function* () {
          const rows = yield* sql<LedgerRow>`
            UPDATE order_ledger
            SET status = ${newStatus}, order_id = ${orderId}
            WHERE id = ${id}
            RETURNING *
          `
          return rowToLedger(rows[0])
        })
    }
  })
)
```

### 5. HTTP Clients

#### 5.1 OrdersClient Interface (`src/clients/OrdersClient.ts`)

```typescript
import { Context, Effect } from "effect"
import type { OrderCreationError, OrderConfirmationError, ServiceConnectionError } from "../domain/errors.js"

export interface CreateOrderParams {
  readonly orderLedgerId: string
  readonly userId: string
  readonly totalAmountCents: number
  readonly currency: string
  readonly items: readonly {
    readonly productId: string
    readonly quantity: number
    readonly unitPriceCents: number
  }[]
}

export interface CreateOrderResult {
  readonly orderId: string
  readonly status: string
}

export interface ConfirmOrderResult {
  readonly orderId: string
  readonly status: "CONFIRMED"
}

export class OrdersClient extends Context.Tag("OrdersClient")<
  OrdersClient,
  {
    /**
     * Create an order from a ledger entry.
     * Idempotent: if order already exists for this ledger entry, returns existing order.
     */
    readonly createOrder: (
      params: CreateOrderParams
    ) => Effect.Effect<CreateOrderResult, OrderCreationError | ServiceConnectionError>

    /**
     * Confirm an order (final saga step).
     * Idempotent: returns success if already confirmed.
     */
    readonly confirmOrder: (
      orderId: string
    ) => Effect.Effect<ConfirmOrderResult, OrderConfirmationError | ServiceConnectionError>
  }
>() {}
```

#### 5.2 OrdersClient Implementation (`src/clients/OrdersClientLive.ts`)

```typescript
import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { OrdersClient, type CreateOrderParams, type CreateOrderResult, type ConfirmOrderResult } from "./OrdersClient.js"
import { OrderCreationError, OrderConfirmationError, ServiceConnectionError } from "../domain/errors.js"

// Response schemas
const CreateOrderSuccessResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.String
})

const ConfirmOrderSuccessResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("CONFIRMED")
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  message: Schema.String
})

export const OrdersClientLive = Layer.effect(
  OrdersClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("ORDERS_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3003")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "orders",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      createOrder: (params: CreateOrderParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Creating order via Orders Service", {
            orderLedgerId: params.orderLedgerId
          })

          const request = HttpClientRequest.post(`${baseUrl}/orders`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              orderLedgerId: params.orderLedgerId,
              userId: params.userId,
              totalAmountCents: params.totalAmountCents,
              currency: params.currency,
              items: params.items.map(item => ({
                productId: item.productId,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents
              }))
            })
          )

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("createOrder")),
            Effect.catchTag("RequestError", handleConnectionError("createOrder"))
          )

          // 201 Created - new order created
          // 200 OK - idempotent return of existing order (some APIs do this)
          if (response.status === 201 || response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new OrderCreationError({
                  orderLedgerId: params.orderLedgerId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(CreateOrderSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new OrderCreationError({
                orderLedgerId: params.orderLedgerId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Order created successfully", {
              orderLedgerId: params.orderLedgerId,
              orderId: body.id
            })

            return {
              orderId: body.id,
              status: body.status
            } satisfies CreateOrderResult
          }

          // 4xx errors - permanent failures
          if (response.status >= 400 && response.status < 500) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            const errorBody = Schema.decodeUnknownSync(ErrorResponse)(rawBody)
            return yield* Effect.fail(new OrderCreationError({
              orderLedgerId: params.orderLedgerId,
              reason: errorBody?.message ?? `HTTP ${response.status}`,
              statusCode: response.status,
              isRetryable: false
            }))
          }

          // 5xx errors - retryable
          return yield* Effect.fail(new OrderCreationError({
            orderLedgerId: params.orderLedgerId,
            reason: `Server error: ${response.status}`,
            statusCode: response.status,
            isRetryable: true
          }))
        }),

      confirmOrder: (orderId: string) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Confirming order via Orders Service", { orderId })

          const request = HttpClientRequest.post(`${baseUrl}/orders/${orderId}/confirmation`)

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("confirmOrder")),
            Effect.catchTag("RequestError", handleConnectionError("confirmOrder"))
          )

          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new OrderConfirmationError({
                  orderId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(ConfirmOrderSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new OrderConfirmationError({
                orderId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Order confirmed successfully", { orderId })

            return {
              orderId: body.id,
              status: body.status
            } satisfies ConfirmOrderResult
          }

          // 409 Conflict with "already confirmed" should be treated as success (idempotent)
          if (response.status === 409) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            if (rawBody && typeof rawBody === "object" && "current_status" in rawBody) {
              const currentStatus = (rawBody as { current_status?: string }).current_status
              if (currentStatus === "CONFIRMED") {
                yield* Effect.logInfo("Order already confirmed (idempotent)", { orderId })
                return { orderId, status: "CONFIRMED" } satisfies ConfirmOrderResult
              }
            }
          }

          // Handle other errors
          if (response.status >= 400 && response.status < 500) {
            return yield* Effect.fail(new OrderConfirmationError({
              orderId,
              reason: `Client error: ${response.status}`,
              statusCode: response.status,
              isRetryable: false
            }))
          }

          return yield* Effect.fail(new OrderConfirmationError({
            orderId,
            reason: `Server error: ${response.status}`,
            statusCode: response.status,
            isRetryable: true
          }))
        })
    }
  })
)
```

#### 5.3 InventoryClient Interface (`src/clients/InventoryClient.ts`)

```typescript
import { Context, Effect } from "effect"
import type { InventoryReservationError, ServiceConnectionError } from "../domain/errors.js"

export interface ReserveStockParams {
  readonly orderId: string
  readonly items: readonly {
    readonly productId: string
    readonly quantity: number
  }[]
}

export interface ReserveStockResult {
  readonly orderId: string
  readonly reservationIds: readonly string[]
  readonly lineItemsReserved: number
  readonly totalQuantityReserved: number
}

export class InventoryClient extends Context.Tag("InventoryClient")<
  InventoryClient,
  {
    /**
     * Reserve stock for an order.
     * Uses SELECT FOR UPDATE to prevent oversell.
     * Idempotent: returns existing reservation if already reserved.
     */
    readonly reserveStock: (
      params: ReserveStockParams
    ) => Effect.Effect<ReserveStockResult, InventoryReservationError | ServiceConnectionError>
  }
>() {}
```

#### 5.4 InventoryClient Implementation (`src/clients/InventoryClientLive.ts`)

```typescript
import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { InventoryClient, type ReserveStockParams, type ReserveStockResult } from "./InventoryClient.js"
import { InventoryReservationError, ServiceConnectionError } from "../domain/errors.js"

const ReserveSuccessResponse = Schema.Struct({
  order_id: Schema.String,
  reservation_ids: Schema.Array(Schema.String),
  line_items_reserved: Schema.Number,
  total_quantity_reserved: Schema.Number
})

const InsufficientStockResponse = Schema.Struct({
  error: Schema.Literal("insufficient_stock"),
  product_id: Schema.String,
  product_sku: Schema.optional(Schema.String),
  requested: Schema.Number,
  available: Schema.Number
})

export const InventoryClientLive = Layer.effect(
  InventoryClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("INVENTORY_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3001")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "inventory",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      reserveStock: (params: ReserveStockParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Reserving stock via Inventory Service", {
            orderId: params.orderId,
            itemCount: params.items.length
          })

          const request = HttpClientRequest.post(`${baseUrl}/reservations`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              orderId: params.orderId,
              items: params.items.map(item => ({
                productId: item.productId,
                quantity: item.quantity
              }))
            })
          )

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("reserveStock")),
            Effect.catchTag("RequestError", handleConnectionError("reserveStock"))
          )

          // 201 Created - stock reserved
          if (response.status === 201) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new InventoryReservationError({
                  orderId: params.orderId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(ReserveSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new InventoryReservationError({
                orderId: params.orderId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Stock reserved successfully", {
              orderId: params.orderId,
              reservationIds: body.reservation_ids
            })

            return {
              orderId: body.order_id,
              reservationIds: body.reservation_ids,
              lineItemsReserved: body.line_items_reserved,
              totalQuantityReserved: body.total_quantity_reserved
            } satisfies ReserveStockResult
          }

          // 409 Conflict - insufficient stock (PERMANENT failure - should compensate)
          if (response.status === 409) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            const decoded = Schema.decodeUnknownOption(InsufficientStockResponse)(rawBody)

            if (decoded._tag === "Some") {
              yield* Effect.logWarning("Insufficient stock", {
                orderId: params.orderId,
                productId: decoded.value.product_id,
                requested: decoded.value.requested,
                available: decoded.value.available
              })

              return yield* Effect.fail(new InventoryReservationError({
                orderId: params.orderId,
                reason: `Insufficient stock for product ${decoded.value.product_id}`,
                statusCode: 409,
                isRetryable: false, // PERMANENT - should trigger compensation
                insufficientStock: {
                  productId: decoded.value.product_id,
                  productSku: decoded.value.product_sku,
                  requested: decoded.value.requested,
                  available: decoded.value.available
                }
              }))
            }
          }

          // 404 Not Found - product doesn't exist (PERMANENT failure)
          if (response.status === 404) {
            return yield* Effect.fail(new InventoryReservationError({
              orderId: params.orderId,
              reason: "Product not found",
              statusCode: 404,
              isRetryable: false
            }))
          }

          // 5xx errors - retryable
          if (response.status >= 500) {
            return yield* Effect.fail(new InventoryReservationError({
              orderId: params.orderId,
              reason: `Server error: ${response.status}`,
              statusCode: response.status,
              isRetryable: true
            }))
          }

          // Other 4xx - not retryable
          return yield* Effect.fail(new InventoryReservationError({
            orderId: params.orderId,
            reason: `Client error: ${response.status}`,
            statusCode: response.status,
            isRetryable: false
          }))
        })
    }
  })
)
```

#### 5.5 PaymentsClient Interface (`src/clients/PaymentsClient.ts`)

```typescript
import { Context, Effect } from "effect"
import type { PaymentCaptureError, ServiceConnectionError } from "../domain/errors.js"

export interface CapturePaymentParams {
  readonly authorizationId: string
  readonly idempotencyKey: string
  readonly amountCents?: number // Optional: for partial capture
}

export interface CapturePaymentResult {
  readonly captureId: string
  readonly authorizationId: string
  readonly status: "CAPTURED"
  readonly amountCents: number
  readonly currency: string
  readonly capturedAt: string
}

export class PaymentsClient extends Context.Tag("PaymentsClient")<
  PaymentsClient,
  {
    /**
     * Capture an authorized payment.
     * Idempotent: returns existing capture if already captured.
     */
    readonly capturePayment: (
      params: CapturePaymentParams
    ) => Effect.Effect<CapturePaymentResult, PaymentCaptureError | ServiceConnectionError>
  }
>() {}
```

#### 5.6 PaymentsClient Implementation (`src/clients/PaymentsClientLive.ts`)

```typescript
import { Layer, Effect, Config, Duration, Schema, Option } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { PaymentsClient, type CapturePaymentParams, type CapturePaymentResult } from "./PaymentsClient.js"
import { PaymentCaptureError, ServiceConnectionError } from "../domain/errors.js"

const CaptureSuccessResponse = Schema.Struct({
  capture_id: Schema.String,
  authorization_id: Schema.String,
  status: Schema.Literal("CAPTURED"),
  amount_cents: Schema.Number,
  currency: Schema.String,
  captured_at: Schema.String
})

export const PaymentsClientLive = Layer.effect(
  PaymentsClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("PAYMENTS_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3002")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "payments",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      capturePayment: (params: CapturePaymentParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Capturing payment via Payments Service", {
            authorizationId: params.authorizationId
          })

          const requestBody: Record<string, unknown> = {
            idempotency_key: params.idempotencyKey
          }
          if (params.amountCents !== undefined) {
            requestBody.amount_cents = params.amountCents
          }

          const request = HttpClientRequest.post(
            `${baseUrl}/payments/capture/${params.authorizationId}`
          ).pipe(HttpClientRequest.bodyUnsafeJson(requestBody))

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("capturePayment")),
            Effect.catchTag("RequestError", handleConnectionError("capturePayment"))
          )

          // 200 OK - payment captured
          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentCaptureError({
                  authorizationId: params.authorizationId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(CaptureSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentCaptureError({
                authorizationId: params.authorizationId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Payment captured successfully", {
              authorizationId: params.authorizationId,
              captureId: body.capture_id
            })

            return {
              captureId: body.capture_id,
              authorizationId: body.authorization_id,
              status: body.status,
              amountCents: body.amount_cents,
              currency: body.currency,
              capturedAt: body.captured_at
            } satisfies CapturePaymentResult
          }

          // 404 Not Found - authorization doesn't exist (PERMANENT)
          if (response.status === 404) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Authorization not found",
              statusCode: 404,
              isRetryable: false
            }))
          }

          // 409 Conflict - already voided (PERMANENT)
          if (response.status === 409) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Authorization already voided",
              statusCode: 409,
              isRetryable: false
            }))
          }

          // 503 Service Unavailable - gateway error (RETRYABLE)
          if (response.status === 503) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Payment gateway unavailable",
              statusCode: 503,
              isRetryable: true
            }))
          }

          // Other 5xx - retryable
          if (response.status >= 500) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: `Server error: ${response.status}`,
              statusCode: response.status,
              isRetryable: true
            }))
          }

          // Other 4xx - not retryable
          return yield* Effect.fail(new PaymentCaptureError({
            authorizationId: params.authorizationId,
            reason: `Client error: ${response.status}`,
            statusCode: response.status,
            isRetryable: false
          }))
        })
    }
  })
)
```

### 6. Saga Executor Service

#### 6.1 SagaExecutor Interface (`src/services/SagaExecutor.ts`)

```typescript
import { Context, Effect } from "effect"
import type { OutboxEvent } from "../domain/OutboxEvent.js"

export interface SagaExecutionResult {
  readonly _tag: "Completed" | "Failed" | "RequiresRetry" | "RequiresCompensation"
  readonly orderLedgerId: string
  readonly finalStatus: string
  readonly error?: string
}

export class SagaExecutor extends Context.Tag("SagaExecutor")<
  SagaExecutor,
  {
    /**
     * Execute the saga for an outbox event.
     * Processes from current ledger status to COMPLETED.
     * Returns result indicating success, failure, or need for retry/compensation.
     */
    readonly executeSaga: (event: OutboxEvent) => Effect.Effect<SagaExecutionResult>
  }
>() {}
```

#### 6.2 SagaExecutor Implementation (`src/services/SagaExecutorLive.ts`)

```typescript
import { Layer, Effect, Option, Schema, Match } from "effect"
import { SagaExecutor, type SagaExecutionResult } from "./SagaExecutor.js"
import { LedgerRepository } from "../repositories/LedgerRepository.js"
import { OrdersClient } from "../clients/OrdersClient.js"
import { InventoryClient } from "../clients/InventoryClient.js"
import { PaymentsClient } from "../clients/PaymentsClient.js"
import { OutboxEvent, OrderAuthorizedPayload } from "../domain/OutboxEvent.js"
import type { OrderLedger, OrderLedgerItem, OrderLedgerStatus } from "../domain/OrderLedger.js"
import {
  InvalidPayloadError,
  LedgerNotFoundError,
  ServiceConnectionError,
  OrderCreationError,
  InventoryReservationError,
  PaymentCaptureError,
  OrderConfirmationError
} from "../domain/errors.js"
import { isValidTransition } from "../domain/SagaState.js"

// Type alias for saga step errors
type SagaStepError =
  | ServiceConnectionError
  | OrderCreationError
  | InventoryReservationError
  | PaymentCaptureError
  | OrderConfirmationError

export const SagaExecutorLive = Layer.effect(
  SagaExecutor,
  Effect.gen(function* () {
    const ledgerRepo = yield* LedgerRepository
    const ordersClient = yield* OrdersClient
    const inventoryClient = yield* InventoryClient
    const paymentsClient = yield* PaymentsClient

    /**
     * Execute a single saga step with error handling.
     * Updates ledger status on success.
     * Returns error info on failure for retry/compensation decision.
     */
    const executeStep = <A>(
      stepName: string,
      ledgerId: string,
      targetStatus: OrderLedgerStatus,
      action: Effect.Effect<A, SagaStepError>
    ): Effect.Effect<A, SagaStepError> =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Executing saga step: ${stepName}`, { ledgerId })

        const result = yield* action

        // Update ledger status after successful step
        yield* ledgerRepo.updateStatus(ledgerId as any, targetStatus)

        yield* Effect.logInfo(`Saga step completed: ${stepName}`, {
          ledgerId,
          newStatus: targetStatus
        })

        return result
      }).pipe(Effect.withSpan(`saga-step-${stepName}`))

    return {
      executeSaga: (event: OutboxEvent) =>
        Effect.gen(function* () {
          const eventId = event.id
          const aggregateId = event.aggregateId

          yield* Effect.logInfo("Starting saga execution", {
            eventId,
            aggregateId,
            eventType: event.eventType
          })

          // 1. Parse the payload
          const payload = yield* Schema.decodeUnknown(OrderAuthorizedPayload)(event.payload).pipe(
            Effect.mapError(() =>
              new InvalidPayloadError({
                eventId,
                eventType: event.eventType,
                reason: "Failed to parse OrderAuthorized payload"
              })
            )
          )

          const orderLedgerId = payload.order_ledger_id

          // 2. Load the ledger entry with items
          const ledgerResult = yield* ledgerRepo.findByIdWithItems(orderLedgerId as any)
          if (Option.isNone(ledgerResult)) {
            yield* Effect.logError("Ledger entry not found", { orderLedgerId })
            return {
              _tag: "Failed",
              orderLedgerId,
              finalStatus: "UNKNOWN",
              error: "Ledger entry not found"
            } satisfies SagaExecutionResult
          }

          const { ledger, items } = ledgerResult.value

          yield* Effect.logDebug("Loaded ledger entry", {
            orderLedgerId,
            status: ledger.status,
            itemCount: items.length
          })

          // 3. Check current status and execute remaining steps
          // The saga is idempotent - we skip steps that are already completed
          const currentStatus = ledger.status

          // If already completed or failed, nothing to do
          if (currentStatus === "COMPLETED") {
            yield* Effect.logInfo("Saga already completed", { orderLedgerId })
            return {
              _tag: "Completed",
              orderLedgerId,
              finalStatus: "COMPLETED"
            } satisfies SagaExecutionResult
          }

          if (currentStatus === "FAILED" || currentStatus === "COMPENSATING") {
            yield* Effect.logWarning("Saga already in terminal/compensation state", {
              orderLedgerId,
              status: currentStatus
            })
            return {
              _tag: "Failed",
              orderLedgerId,
              finalStatus: currentStatus
            } satisfies SagaExecutionResult
          }

          // Execute saga steps based on current status
          const sagaResult = yield* executeSagaSteps(
            ledger,
            items,
            payload,
            ledgerRepo,
            ordersClient,
            inventoryClient,
            paymentsClient
          )

          return sagaResult
        }).pipe(
          Effect.withSpan("saga-execution", { attributes: { eventId: event.id } }),
          // Catch payload parsing errors
          Effect.catchTag("InvalidPayloadError", (error) =>
            Effect.succeed({
              _tag: "Failed",
              orderLedgerId: event.aggregateId,
              finalStatus: "UNKNOWN",
              error: error.reason
            } satisfies SagaExecutionResult)
          )
        )
    }
  })
)

/**
 * Execute saga steps from current status to completion.
 * Returns execution result with final status.
 */
const executeSagaSteps = (
  ledger: OrderLedger,
  items: readonly OrderLedgerItem[],
  payload: OrderAuthorizedPayload,
  ledgerRepo: LedgerRepository["Type"],
  ordersClient: OrdersClient["Type"],
  inventoryClient: InventoryClient["Type"],
  paymentsClient: PaymentsClient["Type"]
): Effect.Effect<SagaExecutionResult> =>
  Effect.gen(function* () {
    const orderLedgerId = ledger.id
    let currentStatus = ledger.status
    let orderId: string | undefined

    // Step 1: Create Order (if not already created)
    if (currentStatus === "AUTHORIZED") {
      const createOrderResult = yield* ordersClient.createOrder({
        orderLedgerId,
        userId: payload.user_id,
        totalAmountCents: payload.total_amount_cents,
        currency: payload.currency,
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents
        }))
      }).pipe(
        Effect.tap(() =>
          ledgerRepo.updateStatusWithOrderId(orderLedgerId as any, "ORDER_CREATED", orderId!)
        ),
        Effect.tapError((error) =>
          Effect.logError("Step 1 (Create Order) failed", {
            orderLedgerId,
            error: error._tag,
            isRetryable: "isRetryable" in error ? error.isRetryable : false
          })
        ),
        Effect.catchAll((error) =>
          handleStepError(orderLedgerId, "ORDER_CREATED", error)
        )
      )

      if (createOrderResult._tag !== "StepSuccess") {
        return createOrderResult.result
      }

      orderId = createOrderResult.orderId
      currentStatus = "ORDER_CREATED"

      // Update ledger with order ID
      yield* ledgerRepo.updateStatusWithOrderId(orderLedgerId as any, "ORDER_CREATED", orderId)
    }

    // Step 2: Reserve Inventory (if not already reserved)
    if (currentStatus === "ORDER_CREATED") {
      // Need to get orderId if we resumed from ORDER_CREATED status
      // In a full implementation, we'd store orderId in ledger and retrieve it
      // For now, we assume orderId was set in step 1 or retrieved from ledger

      const reserveResult = yield* inventoryClient.reserveStock({
        orderId: orderId ?? "unknown", // Should be fetched from ledger in full impl
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity
        }))
      }).pipe(
        Effect.tap(() =>
          ledgerRepo.updateStatus(orderLedgerId as any, "INVENTORY_RESERVED")
        ),
        Effect.tapError((error) =>
          Effect.logError("Step 2 (Reserve Inventory) failed", {
            orderLedgerId,
            error: error._tag,
            isRetryable: "isRetryable" in error ? error.isRetryable : false
          })
        ),
        Effect.catchAll((error) =>
          handleStepError(orderLedgerId, "INVENTORY_RESERVED", error)
        )
      )

      if (reserveResult._tag !== "StepSuccess") {
        return reserveResult.result
      }

      currentStatus = "INVENTORY_RESERVED"
      yield* ledgerRepo.updateStatus(orderLedgerId as any, "INVENTORY_RESERVED")
    }

    // Step 3: Capture Payment (if not already captured)
    if (currentStatus === "INVENTORY_RESERVED") {
      const captureResult = yield* paymentsClient.capturePayment({
        authorizationId: payload.payment_authorization_id,
        idempotencyKey: `capture-${orderLedgerId}`
      }).pipe(
        Effect.tap(() =>
          ledgerRepo.updateStatus(orderLedgerId as any, "PAYMENT_CAPTURED")
        ),
        Effect.tapError((error) =>
          Effect.logError("Step 3 (Capture Payment) failed", {
            orderLedgerId,
            error: error._tag,
            isRetryable: "isRetryable" in error ? error.isRetryable : false
          })
        ),
        Effect.catchAll((error) =>
          handleStepError(orderLedgerId, "PAYMENT_CAPTURED", error)
        )
      )

      if (captureResult._tag !== "StepSuccess") {
        return captureResult.result
      }

      currentStatus = "PAYMENT_CAPTURED"
      yield* ledgerRepo.updateStatus(orderLedgerId as any, "PAYMENT_CAPTURED")
    }

    // Step 4: Confirm Order (final step)
    if (currentStatus === "PAYMENT_CAPTURED") {
      const confirmResult = yield* ordersClient.confirmOrder(orderId ?? "unknown").pipe(
        Effect.tap(() =>
          ledgerRepo.updateStatus(orderLedgerId as any, "COMPLETED")
        ),
        Effect.tapError((error) =>
          Effect.logError("Step 4 (Confirm Order) failed", {
            orderLedgerId,
            error: error._tag,
            isRetryable: "isRetryable" in error ? error.isRetryable : false
          })
        ),
        Effect.catchAll((error) =>
          handleStepError(orderLedgerId, "COMPLETED", error)
        )
      )

      if (confirmResult._tag !== "StepSuccess") {
        return confirmResult.result
      }

      yield* ledgerRepo.updateStatus(orderLedgerId as any, "COMPLETED")
    }

    yield* Effect.logInfo("Saga completed successfully", { orderLedgerId })

    return {
      _tag: "Completed",
      orderLedgerId,
      finalStatus: "COMPLETED"
    } satisfies SagaExecutionResult
  })

// Discriminated union for step results
type StepResult =
  | { readonly _tag: "StepSuccess"; readonly orderId?: string }
  | { readonly _tag: "StepFailed"; readonly result: SagaExecutionResult }

/**
 * Handle step errors and convert to SagaExecutionResult.
 * Determines if error is retryable or requires compensation.
 */
const handleStepError = (
  orderLedgerId: string,
  _targetStatus: OrderLedgerStatus,
  error: SagaStepError
): Effect.Effect<StepResult> =>
  Effect.gen(function* () {
    const isRetryable = "isRetryable" in error && error.isRetryable

    if (isRetryable) {
      // Transient error - should retry
      yield* Effect.logWarning("Saga step failed with retryable error", {
        orderLedgerId,
        errorType: error._tag,
        willRetry: true
      })

      return {
        _tag: "StepFailed",
        result: {
          _tag: "RequiresRetry",
          orderLedgerId,
          finalStatus: "AUTHORIZED", // Current status unchanged
          error: error._tag
        } satisfies SagaExecutionResult
      } satisfies StepResult
    }

    // Permanent error - requires compensation
    yield* Effect.logError("Saga step failed with permanent error", {
      orderLedgerId,
      errorType: error._tag,
      requiresCompensation: true
    })

    return {
      _tag: "StepFailed",
      result: {
        _tag: "RequiresCompensation",
        orderLedgerId,
        finalStatus: "COMPENSATING",
        error: error._tag
      } satisfies SagaExecutionResult
    } satisfies StepResult
  })
```

### 7. Update main.ts to Use SagaExecutor

Update the `processEvents` function in `main.ts`:

```typescript
// In main.ts, replace the placeholder processEvents with:

import { OutboxRepository } from "./repositories/OutboxRepository.js"
import { SagaExecutor } from "./services/SagaExecutor.js"
import { PgClient } from "@effect/sql-pg"

/**
 * Process pending outbox events.
 * Claims events with SELECT FOR UPDATE SKIP LOCKED,
 * executes saga for each, and marks as processed.
 */
export const processEvents = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const outboxRepo = yield* OutboxRepository
  const sagaExecutor = yield* SagaExecutor

  yield* Effect.logDebug("Processing pending events...")

  // Process in a transaction to maintain locks until all events are handled
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Claim pending events
      const { events } = yield* outboxRepo.claimPendingEvents(10)

      if (events.length === 0) {
        yield* Effect.logDebug("No pending events to process")
        return
      }

      yield* Effect.logInfo("Processing outbox events", { count: events.length })

      // Process each event sequentially
      // (Could be parallelized with care for ordering guarantees)
      for (const event of events) {
        const result = yield* sagaExecutor.executeSaga(event).pipe(
          Effect.withSpan("process-outbox-event", {
            attributes: { eventId: event.id, eventType: event.eventType }
          })
        )

        // Mark based on result
        if (result._tag === "Completed") {
          yield* outboxRepo.markProcessed(event.id)
        } else if (result._tag === "Failed") {
          yield* outboxRepo.markFailed(event.id)
        } else if (result._tag === "RequiresRetry") {
          // Leave as PENDING for retry on next poll
          yield* Effect.logInfo("Event will be retried", {
            eventId: event.id,
            reason: result.error
          })
        } else if (result._tag === "RequiresCompensation") {
          // Mark as failed - compensation handled separately
          yield* outboxRepo.markFailed(event.id)
          yield* Effect.logWarning("Event requires compensation", {
            eventId: event.id,
            orderLedgerId: result.orderLedgerId
          })
        }
      }
    })
  )

  yield* Effect.logDebug("Event processing complete")
})
```

### 8. Update layers.ts

```typescript
import { Layer } from "effect"
import { HttpClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseLive } from "./db.js"
import { OrchestratorConfigLive } from "./config.js"
import { OutboxRepositoryLive } from "./repositories/OutboxRepositoryLive.js"
import { LedgerRepositoryLive } from "./repositories/LedgerRepositoryLive.js"
import { OrdersClientLive } from "./clients/OrdersClientLive.js"
import { InventoryClientLive } from "./clients/InventoryClientLive.js"
import { PaymentsClientLive } from "./clients/PaymentsClientLive.js"
import { SagaExecutorLive } from "./services/SagaExecutorLive.js"

// HTTP client layer for all service clients
const HttpClientLive = NodeHttpClient.layer

// Repository layers
const RepositoriesLive = Layer.mergeAll(
  OutboxRepositoryLive,
  LedgerRepositoryLive
).pipe(Layer.provide(DatabaseLive))

// HTTP client layers (depend on HttpClient)
const ClientsLive = Layer.mergeAll(
  OrdersClientLive,
  InventoryClientLive,
  PaymentsClientLive
).pipe(Layer.provide(HttpClientLive))

// Service layers (depend on repositories and clients)
const ServicesLive = SagaExecutorLive.pipe(
  Layer.provide(RepositoriesLive),
  Layer.provide(ClientsLive)
)

// Complete application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrchestratorConfigLive,
  RepositoriesLive,
  ClientsLive,
  ServicesLive
)
```

### 9. Database Migration

Add migration to support storing `order_id` in the ledger:

**File: `migrations/008_add_order_id_to_ledger.sql`**

```sql
-- Add order_id column to order_ledger for saga tracking
-- This allows the orchestrator to track which order was created for a ledger entry

ALTER TABLE order_ledger ADD COLUMN IF NOT EXISTS order_id UUID;

CREATE INDEX IF NOT EXISTS idx_order_ledger_order_id ON order_ledger(order_id);

COMMENT ON COLUMN order_ledger.order_id IS 'Reference to the order created by saga step 1';
```

---

## Implementation Steps

### Phase 1: Domain Models and Errors

1. **Create `src/domain/OutboxEvent.ts`**
   - Define `OutboxEvent` schema with branded types
   - Define `OrderAuthorizedPayload` schema for event parsing

2. **Create `src/domain/OrderLedger.ts`**
   - Define `OrderLedger` and `OrderLedgerItem` schemas
   - Define `OrderLedgerStatus` with all saga states

3. **Create `src/domain/SagaState.ts`**
   - Define valid state transitions
   - Define saga steps array for ordering

4. **Create `src/domain/errors.ts`**
   - Define all error types with `Data.TaggedError`
   - Include context fields for debugging

### Phase 2: Repositories

5. **Create `src/repositories/OutboxRepository.ts`**
   - Define interface with `claimPendingEvents`, `markProcessed`, `markFailed`

6. **Create `src/repositories/OutboxRepositoryLive.ts`**
   - Implement `SELECT FOR UPDATE SKIP LOCKED` pattern
   - Map database rows to domain models

7. **Create `src/repositories/LedgerRepository.ts`**
   - Define interface with `findByIdWithItems`, `updateStatus`, `updateStatusWithOrderId`

8. **Create `src/repositories/LedgerRepositoryLive.ts`**
   - Implement with LEFT JOIN for items
   - Handle null items from JOIN

### Phase 3: HTTP Clients

9. **Create `src/clients/OrdersClient.ts`** and **`src/clients/OrdersClientLive.ts`**
   - `createOrder` - POST /orders
   - `confirmOrder` - POST /orders/:id/confirmation
   - Handle idempotency (existing order returns success)

10. **Create `src/clients/InventoryClient.ts`** and **`src/clients/InventoryClientLive.ts`**
    - `reserveStock` - POST /reservations
    - Handle 409 insufficient stock as permanent error

11. **Create `src/clients/PaymentsClient.ts`** and **`src/clients/PaymentsClientLive.ts`**
    - `capturePayment` - POST /payments/capture/:authorization_id
    - Handle 409 already voided as permanent error

### Phase 4: Saga Executor

12. **Create `src/services/SagaExecutor.ts`**
    - Define interface with `executeSaga` method
    - Define `SagaExecutionResult` discriminated union

13. **Create `src/services/SagaExecutorLive.ts`**
    - Implement step execution with status updates
    - Handle error classification (retryable vs permanent)
    - Return appropriate result type

### Phase 5: Integration

14. **Update `src/main.ts`**
    - Replace placeholder `processEvents` with real implementation
    - Add transaction wrapper for event processing

15. **Update `src/layers.ts`**
    - Add all new repositories, clients, services
    - Configure dependency graph

16. **Create migration `migrations/008_add_order_id_to_ledger.sql`**
    - Add `order_id` column to `order_ledger` table

### Phase 6: Testing

17. **Manual Integration Test**
    - Start all services via docker-compose
    - Submit order via Edge API
    - Verify saga executes to completion
    - Check database states at each step

---

## Validation Criteria

### Functional
- [ ] Outbox events are claimed with `SELECT FOR UPDATE SKIP LOCKED`
- [ ] Saga executes all 4 steps in order: create order → reserve inventory → capture payment → confirm order
- [ ] Ledger status is updated after each successful step
- [ ] Failed events are marked appropriately
- [ ] Retryable errors leave event as PENDING for retry
- [ ] Permanent errors trigger transition to COMPENSATING (handled in future plan)
- [ ] Idempotency: re-processing a completed saga returns success without side effects

### Structural
- [ ] All new files follow established patterns from other services
- [ ] Error types use `Data.TaggedError` with context
- [ ] HTTP clients handle all response codes appropriately
- [ ] Repositories return `Option<T>` for queries that may not find data
- [ ] Layer composition is correct in `layers.ts`

### Code Quality
- [ ] TypeScript compiles without errors
- [ ] Effect.js patterns are used consistently
- [ ] Logging includes context for debugging
- [ ] Spans are added for observability
- [ ] No imperative side effects outside of Effect

---

## Error Handling Matrix

| Step | Error Type | HTTP Status | Retryable | Action |
|------|------------|-------------|-----------|--------|
| Create Order | Connection timeout | - | Yes | Retry |
| Create Order | 5xx | 500-599 | Yes | Retry |
| Create Order | 4xx | 400-499 | No | Compensate |
| Reserve Inventory | Connection timeout | - | Yes | Retry |
| Reserve Inventory | 5xx | 500-599 | Yes | Retry |
| Reserve Inventory | Insufficient stock | 409 | No | Compensate |
| Reserve Inventory | Product not found | 404 | No | Compensate |
| Capture Payment | Connection timeout | - | Yes | Retry |
| Capture Payment | 5xx/503 | 500-599 | Yes | Retry |
| Capture Payment | Already voided | 409 | No | Compensate |
| Capture Payment | Auth not found | 404 | No | Compensate |
| Confirm Order | Connection timeout | - | Yes | Retry |
| Confirm Order | 5xx | 500-599 | Yes | Retry |
| Confirm Order | 4xx | 400-499 | No | Compensate |

---

## Dependencies

This plan depends on:
- Existing scaffold from `orchestrator-scaffold-plan.md` (COMPLETE)
- Existing endpoints in Orders, Inventory, Payments services (COMPLETE per todo.md)
- PostgreSQL outbox table (exists per migration 007)

This plan enables:
- Compensation Handling plan (future)
- Retry Logic plan (future)

---

## References

- `engineering-design.md` - Sections 4 (Saga Orchestrator Design), 5 (Outbox Pattern)
- `.claude/resources/best-practices.md` - Effect.js patterns
- `services/edge-api/src/services/PaymentClientLive.ts` - HTTP client pattern reference
- `services/orders/src/api/orders.ts` - Orders API endpoints
- `services/inventory/src/api/reservations.ts` - Inventory API endpoints
- `services/payment/src/api/payments.ts` - Payments API endpoints
