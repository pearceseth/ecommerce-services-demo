# Implementation Plan: Saga Retry Logic with Exponential Backoff

## Status: COMPLETE

## Overview

Implement retry logic for the Saga Orchestrator that handles transient failures with exponential backoff delays. When a saga step fails with a retryable error, the system should:
1. Increment the `retry_count` on the **outbox event**
2. Calculate the next retry time using exponential backoff
3. Leave the outbox event in PENDING state for re-processing
4. After 5 failed attempts, transition to compensation

**Key Design Decision**: Retry coordination lives in the outbox table, not the ledger. This maintains cleaner separation of concerns:
- **Ledger** = Business state (order lifecycle, immutable record)
- **Outbox** = Processing coordination (work queue with retry scheduling)

---

## Requirements from Engineering Design

From `engineering-design.md` Section 4.5 (Retry Policy):

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 second |
| 3 | 4 seconds |
| 4 | 16 seconds |
| 5 | 64 seconds |
| 6+ | Mark as FAILED, begin compensation |

**Formula**: `delay = 4^(attempt - 2)` seconds (min 1s, max 5 attempts)

From Section 4.3 (Step Execution Logic):
```
On failure:
   a. If transient: increment retry_count, set next_retry_at
   b. If permanent or max retries exceeded: transition to COMPENSATING
```

---

## Architecture: Outbox-Based Retry Coordination

### Why Outbox Instead of Ledger?

The outbox table is fundamentally a **work queue**. Retry scheduling is a queue concern:
- "When should this work item be processed next?"
- "How many times have we tried?"

The ledger is a **business record**:
- "What state is this order in?"
- "What was the payment authorization ID?"

Mixing retry metadata into the ledger violates separation of concerns and makes the ledger mutable for operational reasons rather than business reasons.

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           OUTBOX TABLE                               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ id | status  | retry_count | next_retry_at | aggregate_id  │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 1  | PENDING |     0       |     NULL      | ledger-123    │ ←── New event    │
│  │ 1  | PENDING |     1       | +1 second     | ledger-123    │ ←── After 1st fail│
│  │ 1  | PENDING |     2       | +4 seconds    | ledger-123    │ ←── After 2nd fail│
│  │ 1  | FAILED  |     5       |     -         | ledger-123    │ ←── Max exceeded  │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          LEDGER TABLE                                │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ id         | status           | (business fields...)        │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ ledger-123 | AUTHORIZED       │ ← Initial state             │    │
│  │ ledger-123 | ORDER_CREATED    │ ← After step 1 succeeds     │    │
│  │ ledger-123 | COMPENSATING     │ ← After max retries         │    │
│  │ ledger-123 | FAILED           │ ← After compensation done   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                    (Only status changes - business state)            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Modify Outbox Table Schema - Add Retry Columns

**File**: `migrations/007_create_outbox.sql` (modify existing)

Update the existing outbox table creation to include retry columns:

```sql
-- Outbox: Transactional outbox for reliable event publishing
-- Events are written atomically with business operations
-- The orchestrator processes these events via LISTEN/NOTIFY + polling
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    -- Retry tracking columns
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMP WITH TIME ZONE
);

-- Index for efficient pending event queries (used by orchestrator)
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(created_at) WHERE status = 'PENDING';

-- Index for retry scheduling queries
CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(next_retry_at) WHERE status = 'PENDING';
```

### Step 1b: Modify Order Ledger Table Schema - Remove Retry Columns

**File**: `migrations/005_create_order_ledger.sql` (modify existing)

Remove the now-unused retry tracking columns from the ledger table:

```sql
-- Order Ledger: Authoritative record of all order requests
-- Owned by Edge API - this is the durable record created before any processing
CREATE TABLE IF NOT EXISTS order_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_request_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AWAITING_AUTHORIZATION',
    total_amount_cents INT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_authorization_id VARCHAR(255),
    -- REMOVED: retry_count INT NOT NULL DEFAULT 0,
    -- REMOVED: next_retry_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for orchestrator queries by status
CREATE INDEX IF NOT EXISTS idx_order_ledger_status ON order_ledger(status);

-- REMOVED: idx_order_ledger_next_retry index (retry tracking moved to outbox)

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_order_ledger_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_ledger_updated_at_trigger ON order_ledger;
CREATE TRIGGER order_ledger_updated_at_trigger
    BEFORE UPDATE ON order_ledger
    FOR EACH ROW
    EXECUTE FUNCTION update_order_ledger_updated_at();
```

**Note**: Since this is a demo project, we modify the original migrations instead of creating ALTER TABLE migrations. For a production system with live data, migrations would be required.

### Step 2: Update OutboxEvent Domain Model

**File**: `services/orchestrator/src/domain/OutboxEvent.ts`

Add retry fields to the OutboxEvent schema class:

```typescript
import { Schema } from "effect"

export const OutboxEventId = Schema.String.pipe(Schema.brand("OutboxEventId"))
export type OutboxEventId = typeof OutboxEventId.Type

export const OutboxEventType = Schema.Literal("OrderAuthorized")
export type OutboxEventType = typeof OutboxEventType.Type

export const OutboxEventStatus = Schema.Literal("PENDING", "PROCESSED", "FAILED")
export type OutboxEventStatus = typeof OutboxEventStatus.Type

export class OutboxEvent extends Schema.Class<OutboxEvent>("OutboxEvent")({
  id: OutboxEventId,
  aggregateType: Schema.String,
  aggregateId: Schema.String,
  eventType: OutboxEventType,
  payload: Schema.Unknown,
  status: OutboxEventStatus,
  createdAt: Schema.DateTimeUtc,
  processedAt: Schema.NullOr(Schema.DateTimeUtc),
  // New fields for retry coordination:
  retryCount: Schema.Number,
  nextRetryAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}

// Payload schema for OrderAuthorized events (unchanged)
export const OrderAuthorizedPayload = Schema.Struct({
  order_ledger_id: Schema.String,
  user_id: Schema.String,
  email: Schema.String,
  total_amount_cents: Schema.Number,
  currency: Schema.String,
  payment_authorization_id: Schema.String
})
export type OrderAuthorizedPayload = typeof OrderAuthorizedPayload.Type
```

### Step 3: Add Configuration for Retry Parameters

**File**: `services/orchestrator/src/config.ts`

Add retry configuration parameters to `OrchestratorConfig`:

```typescript
import { Config, Context, Effect, Layer } from "effect"

export class OrchestratorConfig extends Context.Tag("OrchestratorConfig")<
  OrchestratorConfig,
  {
    readonly pollIntervalMs: number
    readonly ordersServiceUrl: string
    readonly inventoryServiceUrl: string
    readonly paymentsServiceUrl: string
    // New retry configuration:
    readonly maxRetryAttempts: number
    readonly retryBaseDelayMs: number
    readonly retryBackoffMultiplier: number
  }
>() {}

export const OrchestratorConfigLive = Layer.effect(
  OrchestratorConfig,
  Effect.gen(function* () {
    return {
      pollIntervalMs: yield* Config.number("POLL_INTERVAL_MS").pipe(
        Config.withDefault(5000)
      ),
      ordersServiceUrl: yield* Config.string("ORDERS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3003")
      ),
      inventoryServiceUrl: yield* Config.string("INVENTORY_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3001")
      ),
      paymentsServiceUrl: yield* Config.string("PAYMENTS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      ),
      // Retry defaults matching engineering-design.md Section 4.5
      maxRetryAttempts: yield* Config.number("MAX_RETRY_ATTEMPTS").pipe(
        Config.withDefault(5)
      ),
      retryBaseDelayMs: yield* Config.number("RETRY_BASE_DELAY_MS").pipe(
        Config.withDefault(1000)
      ),
      retryBackoffMultiplier: yield* Config.number("RETRY_BACKOFF_MULTIPLIER").pipe(
        Config.withDefault(4)
      )
    }
  })
)
```

### Step 4: Create Retry Delay Calculator Utility

**File**: `services/orchestrator/src/domain/RetryPolicy.ts` (new file)

Create a pure function module for retry delay calculation:

```typescript
import { DateTime, Duration } from "effect"

/**
 * Configuration for retry behavior.
 */
export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly backoffMultiplier: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  backoffMultiplier: 4
}

/**
 * Calculate the delay for a given retry attempt.
 *
 * Formula: delay = baseDelay * multiplier^(attempt - 2)
 *
 * | Attempt | Calculation      | Delay  |
 * |---------|------------------|--------|
 * | 1       | (immediate)      | 0ms    |
 * | 2       | 1000 * 4^0       | 1000ms |
 * | 3       | 1000 * 4^1       | 4000ms |
 * | 4       | 1000 * 4^2       | 16000ms|
 * | 5       | 1000 * 4^3       | 64000ms|
 *
 * @param attemptNumber - The next attempt number (1-indexed)
 * @param policy - The retry policy configuration
 * @returns Duration representing the delay before the next retry
 */
export const calculateRetryDelay = (
  attemptNumber: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Duration.Duration => {
  if (attemptNumber <= 1) {
    return Duration.zero
  }

  const exponent = attemptNumber - 2
  const delayMs = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, exponent)
  return Duration.millis(delayMs)
}

/**
 * Calculate the absolute timestamp for the next retry.
 *
 * @param attemptNumber - The next attempt number (1-indexed)
 * @param policy - The retry policy configuration
 * @param fromTime - Optional base time (defaults to now)
 * @returns DateTime.Utc representing when the retry should occur
 */
export const calculateNextRetryAt = (
  attemptNumber: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  fromTime?: DateTime.Utc
): DateTime.Utc => {
  const baseTime = fromTime ?? DateTime.unsafeNow()
  const delay = calculateRetryDelay(attemptNumber, policy)
  return DateTime.add(baseTime, delay)
}

/**
 * Check if max retries have been exceeded.
 *
 * @param currentRetryCount - The current retry_count value (0 = never failed)
 * @param maxAttempts - Maximum allowed attempts (default: 5)
 * @returns true if no more retries should be attempted
 */
export const isMaxRetriesExceeded = (
  currentRetryCount: number,
  maxAttempts: number = DEFAULT_RETRY_POLICY.maxAttempts
): boolean => {
  // retry_count of 5 means we've failed 5 times
  // maxAttempts of 5 means attempts 1-5 are allowed
  // So if retry_count >= maxAttempts, we're done
  return currentRetryCount >= maxAttempts
}
```

### Step 5: Extend OutboxRepository Interface

**File**: `services/orchestrator/src/repositories/OutboxRepository.ts`

Add new methods for retry tracking:

```typescript
import { Context, Effect } from "effect"
import type { DateTime } from "effect"
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
     * Only returns events where next_retry_at is NULL or in the past.
     *
     * @param limit - Maximum number of events to claim (default: 10)
     */
    readonly claimPendingEvents: (limit?: number) => Effect.Effect<ClaimResult>

    /**
     * Mark an event as successfully processed.
     */
    readonly markProcessed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Mark an event as failed (terminal state after compensation).
     */
    readonly markFailed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Schedule a retry for an event.
     * Increments retry_count and sets next_retry_at.
     * Event remains in PENDING status.
     *
     * @param eventId - The event to schedule for retry
     * @param nextRetryAt - When to retry next
     * @returns Updated retry count
     */
    readonly scheduleRetry: (
      eventId: OutboxEventId,
      nextRetryAt: DateTime.Utc
    ) => Effect.Effect<{ retryCount: number }>
  }
>() {}
```

### Step 6: Implement OutboxRepository Methods

**File**: `services/orchestrator/src/repositories/OutboxRepositoryLive.ts`

Update the implementation:

```typescript
import { Layer, Effect, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { OutboxRepository, type ClaimResult } from "./OutboxRepository.js"
import { OutboxEvent, type OutboxEventId, type OutboxEventType, type OutboxEventStatus } from "../domain/OutboxEvent.js"

interface OutboxRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: unknown
  status: string
  created_at: Date
  processed_at: Date | null
  retry_count: number
  next_retry_at: Date | null
}

const rowToOutboxEvent = (row: OutboxRow): OutboxEvent =>
  new OutboxEvent({
    id: row.id as OutboxEventId,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type as OutboxEventType,
    payload: row.payload,
    status: row.status as OutboxEventStatus,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    processedAt: row.processed_at ? DateTime.unsafeFromDate(row.processed_at) : null,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at ? DateTime.unsafeFromDate(row.next_retry_at) : null
  })

export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      claimPendingEvents: (limit = 10) =>
        Effect.gen(function* () {
          const rows = yield* sql<OutboxRow>`
            SELECT
              id, aggregate_type, aggregate_id, event_type,
              payload, status, created_at, processed_at,
              retry_count, next_retry_at
            FROM outbox
            WHERE status = 'PENDING'
              AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            ORDER BY
              next_retry_at NULLS FIRST,
              created_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          `

          yield* Effect.logDebug("Claimed outbox events", { count: rows.length })

          const events = rows.map(rowToOutboxEvent)
          return { events } satisfies ClaimResult
        }).pipe(Effect.orDie),

      markProcessed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'PROCESSED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as processed", { eventId })
        }).pipe(Effect.orDie),

      markFailed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'FAILED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as failed", { eventId })
        }).pipe(Effect.orDie),

      scheduleRetry: (eventId: OutboxEventId, nextRetryAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const nextRetryDate = DateTime.toDate(nextRetryAt)

          const rows = yield* sql<{ retry_count: number }>`
            UPDATE outbox
            SET
              retry_count = retry_count + 1,
              next_retry_at = ${nextRetryDate}
            WHERE id = ${eventId}
            RETURNING retry_count
          `

          const newRetryCount = rows[0].retry_count

          yield* Effect.logDebug("Scheduled outbox event for retry", {
            eventId,
            retryCount: newRetryCount,
            nextRetryAt: nextRetryDate.toISOString()
          })

          return { retryCount: newRetryCount }
        }).pipe(Effect.orDie)
    }
  })
)
```

**Key changes to `claimPendingEvents`:**
- Added `AND (next_retry_at IS NULL OR next_retry_at <= NOW())` filter
- Added `ORDER BY next_retry_at NULLS FIRST` to prioritize new events
- Now returns retry metadata with events

### Step 7: Update SagaExecutor Interface

**File**: `services/orchestrator/src/services/SagaExecutor.ts`

Update the `SagaRequiresRetry` result type to include retry metadata:

```typescript
import { Context, Effect, DateTime } from "effect"
import type { OutboxEvent } from "../domain/OutboxEvent.js"

export interface SagaCompleted {
  readonly _tag: "Completed"
  readonly orderLedgerId: string
  readonly finalStatus: "COMPLETED"
}

export interface SagaFailed {
  readonly _tag: "Failed"
  readonly orderLedgerId: string
  readonly finalStatus: string
  readonly error: string
}

export interface SagaRequiresRetry {
  readonly _tag: "RequiresRetry"
  readonly orderLedgerId: string
  readonly finalStatus: string
  readonly error: string
  // New fields:
  readonly retryCount: number
  readonly nextRetryAt: DateTime.Utc
  readonly isLastAttempt: boolean
}

export interface SagaCompensated {
  readonly _tag: "Compensated"
  readonly orderLedgerId: string
  readonly finalStatus: "FAILED"
  readonly compensationSteps: readonly string[]
}

export type SagaExecutionResult =
  | SagaCompleted
  | SagaFailed
  | SagaRequiresRetry
  | SagaCompensated

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

### Step 8: Update SagaExecutorLive Error Handling

**File**: `services/orchestrator/src/services/SagaExecutorLive.ts`

Modify the `handleStepError` function to coordinate retries through the outbox:

```typescript
import { Layer, Effect, Option, Schema, DateTime } from "effect"
import { SagaExecutor, type SagaExecutionResult, type SagaCompleted, type SagaFailed, type SagaRequiresRetry, type SagaCompensated } from "./SagaExecutor.js"
import { CompensationExecutor } from "./CompensationExecutor.js"
import { LedgerRepository } from "../repositories/LedgerRepository.js"
import { OutboxRepository } from "../repositories/OutboxRepository.js"
import { OrdersClient } from "../clients/OrdersClient.js"
import { InventoryClient } from "../clients/InventoryClient.js"
import { PaymentsClient } from "../clients/PaymentsClient.js"
import { OrchestratorConfig } from "../config.js"
import { OutboxEvent, OrderAuthorizedPayload, type OutboxEventId } from "../domain/OutboxEvent.js"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"
import { InvalidPayloadError, type SagaStepError } from "../domain/errors.js"
import {
  calculateNextRetryAt,
  isMaxRetriesExceeded,
  type RetryPolicy
} from "../domain/RetryPolicy.js"

type StepResult =
  | { readonly _tag: "StepSuccess"; readonly orderId?: string }
  | { readonly _tag: "StepFailed"; readonly result: SagaExecutionResult }

interface HandleStepErrorParams {
  readonly eventId: OutboxEventId
  readonly orderLedgerId: string
  readonly currentStatus: OrderLedgerStatus
  readonly orderId: string | null
  readonly paymentAuthorizationId: string | null
  readonly error: SagaStepError
  readonly currentRetryCount: number
  readonly retryPolicy: RetryPolicy
}

const handleStepError = (
  params: HandleStepErrorParams
): Effect.Effect<StepResult, never, CompensationExecutor | LedgerRepository | OutboxRepository> =>
  Effect.gen(function* () {
    const {
      eventId,
      orderLedgerId,
      currentStatus,
      orderId,
      paymentAuthorizationId,
      error,
      currentRetryCount,
      retryPolicy
    } = params

    const isRetryable = "isRetryable" in error && error.isRetryable

    if (isRetryable && !isMaxRetriesExceeded(currentRetryCount, retryPolicy.maxAttempts)) {
      // Schedule retry via outbox
      const outboxRepo = yield* OutboxRepository
      const nextAttemptNumber = currentRetryCount + 1
      const nextRetryAt = calculateNextRetryAt(nextAttemptNumber + 1, retryPolicy)

      const { retryCount: newRetryCount } = yield* outboxRepo.scheduleRetry(eventId, nextRetryAt)

      yield* Effect.logWarning("Saga step failed - scheduled retry", {
        orderLedgerId,
        eventId,
        errorType: error._tag,
        errorReason: "reason" in error ? error.reason : "unknown",
        retryCount: newRetryCount,
        nextRetryAt: DateTime.formatIso(nextRetryAt),
        maxAttempts: retryPolicy.maxAttempts,
        attemptsRemaining: retryPolicy.maxAttempts - newRetryCount
      })

      return {
        _tag: "StepFailed",
        result: {
          _tag: "RequiresRetry",
          orderLedgerId,
          finalStatus: currentStatus,
          error: error._tag,
          retryCount: newRetryCount,
          nextRetryAt,
          isLastAttempt: newRetryCount >= retryPolicy.maxAttempts - 1
        } satisfies SagaRequiresRetry
      } satisfies StepResult
    }

    // Permanent failure OR max retries exceeded - execute compensation
    const failureReason = isRetryable ? "max_retries_exceeded" : "permanent_failure"

    yield* Effect.logError("Saga step failed - starting compensation", {
      orderLedgerId,
      eventId,
      errorType: error._tag,
      errorReason: "reason" in error ? error.reason : "unknown",
      failureReason,
      totalAttempts: currentRetryCount + 1,
      lastSuccessfulStatus: currentStatus
    })

    const ledgerRepo = yield* LedgerRepository
    const compensationExecutor = yield* CompensationExecutor

    // Transition ledger to COMPENSATING
    yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "COMPENSATING")

    // Execute compensation
    const compensationResult = yield* compensationExecutor.executeCompensation({
      orderLedgerId,
      orderId,
      paymentAuthorizationId,
      lastSuccessfulStatus: currentStatus
    })

    // Transition ledger to FAILED
    yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "FAILED")

    return {
      _tag: "StepFailed",
      result: {
        _tag: "Compensated",
        orderLedgerId,
        finalStatus: "FAILED",
        compensationSteps: compensationResult.stepsExecuted
      } satisfies SagaCompensated
    } satisfies StepResult
  })

export const SagaExecutorLive = Layer.effect(
  SagaExecutor,
  Effect.gen(function* () {
    const ledgerRepo = yield* LedgerRepository
    const outboxRepo = yield* OutboxRepository
    const ordersClient = yield* OrdersClient
    const inventoryClient = yield* InventoryClient
    const paymentsClient = yield* PaymentsClient
    const compensationExecutor = yield* CompensationExecutor
    const config = yield* OrchestratorConfig

    // Build retry policy from config
    const retryPolicy: RetryPolicy = {
      maxAttempts: config.maxRetryAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      backoffMultiplier: config.retryBackoffMultiplier
    }

    const executeSagaSteps = (
      event: OutboxEvent,
      ledger: OrderLedger,
      items: readonly OrderLedgerItem[],
      payload: OrderAuthorizedPayload
    ): Effect.Effect<SagaExecutionResult> =>
      Effect.gen(function* () {
        const eventId = event.id
        const orderLedgerId = ledger.id
        const paymentAuthorizationId = payload.payment_authorization_id
        let currentStatus = ledger.status
        let orderId: string | null = ledger.orderId
        const currentRetryCount = event.retryCount  // Retry count from outbox, not ledger

        // Step 1: Create Order (if not already created)
        if (currentStatus === "AUTHORIZED") {
          yield* Effect.logInfo("Executing Step 1: Create Order", {
            orderLedgerId,
            attempt: currentRetryCount + 1
          })

          const stepResult = yield* ordersClient.createOrder({
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
            Effect.map((result): StepResult => ({
              _tag: "StepSuccess",
              orderId: result.orderId
            })),
            Effect.catchAll((error) => handleStepError({
              eventId,
              orderLedgerId,
              currentStatus,
              orderId,
              paymentAuthorizationId,
              error,
              currentRetryCount,
              retryPolicy
            }))
          )

          if (stepResult._tag === "StepFailed") {
            return stepResult.result
          }

          orderId = stepResult.orderId!
          yield* ledgerRepo.updateStatusWithOrderId(orderLedgerId as OrderLedgerId, "ORDER_CREATED", orderId)
          currentStatus = "ORDER_CREATED"
          yield* Effect.logInfo("Step 1 completed: Order created", { orderLedgerId, orderId })
        }

        // Step 2: Reserve Inventory (if not already reserved)
        if (currentStatus === "ORDER_CREATED") {
          yield* Effect.logInfo("Executing Step 2: Reserve Inventory", {
            orderLedgerId,
            orderId,
            attempt: currentRetryCount + 1
          })

          const stepResult = yield* inventoryClient.reserveStock({
            orderId: orderId!,
            items: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity
            }))
          }).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError({
              eventId,
              orderLedgerId,
              currentStatus,
              orderId,
              paymentAuthorizationId,
              error,
              currentRetryCount,
              retryPolicy
            }))
          )

          if (stepResult._tag === "StepFailed") {
            return stepResult.result
          }

          yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "INVENTORY_RESERVED")
          currentStatus = "INVENTORY_RESERVED"
          yield* Effect.logInfo("Step 2 completed: Inventory reserved", { orderLedgerId })
        }

        // Step 3: Capture Payment (if not already captured)
        if (currentStatus === "INVENTORY_RESERVED") {
          yield* Effect.logInfo("Executing Step 3: Capture Payment", {
            orderLedgerId,
            attempt: currentRetryCount + 1
          })

          const stepResult = yield* paymentsClient.capturePayment({
            authorizationId: paymentAuthorizationId,
            idempotencyKey: `capture-${orderLedgerId}`
          }).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError({
              eventId,
              orderLedgerId,
              currentStatus,
              orderId,
              paymentAuthorizationId,
              error,
              currentRetryCount,
              retryPolicy
            }))
          )

          if (stepResult._tag === "StepFailed") {
            return stepResult.result
          }

          yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "PAYMENT_CAPTURED")
          currentStatus = "PAYMENT_CAPTURED"
          yield* Effect.logInfo("Step 3 completed: Payment captured", { orderLedgerId })
        }

        // Step 4: Confirm Order (final step)
        if (currentStatus === "PAYMENT_CAPTURED") {
          yield* Effect.logInfo("Executing Step 4: Confirm Order", {
            orderLedgerId,
            orderId,
            attempt: currentRetryCount + 1
          })

          const stepResult = yield* ordersClient.confirmOrder(orderId!).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError({
              eventId,
              orderLedgerId,
              currentStatus,
              orderId,
              paymentAuthorizationId,
              error,
              currentRetryCount,
              retryPolicy
            }))
          )

          if (stepResult._tag === "StepFailed") {
            return stepResult.result
          }

          yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "COMPLETED")
          yield* Effect.logInfo("Step 4 completed: Order confirmed", { orderLedgerId })
        }

        yield* Effect.logInfo("Saga completed successfully", { orderLedgerId })

        return {
          _tag: "Completed",
          orderLedgerId,
          finalStatus: "COMPLETED"
        } satisfies SagaCompleted
      }).pipe(
        Effect.provideService(LedgerRepository, ledgerRepo),
        Effect.provideService(OutboxRepository, outboxRepo),
        Effect.provideService(CompensationExecutor, compensationExecutor)
      )

    return {
      executeSaga: (event: OutboxEvent) =>
        Effect.gen(function* () {
          const eventId = event.id
          const aggregateId = event.aggregateId

          yield* Effect.logInfo("Starting saga execution", {
            eventId,
            aggregateId,
            eventType: event.eventType,
            retryCount: event.retryCount,
            isRetry: event.retryCount > 0
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
          const ledgerResult = yield* ledgerRepo.findByIdWithItems(orderLedgerId as OrderLedgerId)
          if (Option.isNone(ledgerResult)) {
            yield* Effect.logError("Ledger entry not found", { orderLedgerId })
            return {
              _tag: "Failed",
              orderLedgerId,
              finalStatus: "UNKNOWN",
              error: "Ledger entry not found"
            } satisfies SagaFailed
          }

          const { ledger, items } = ledgerResult.value

          yield* Effect.logDebug("Loaded ledger entry", {
            orderLedgerId,
            status: ledger.status,
            itemCount: items.length
          })

          // 3. Check current status
          const currentStatus = ledger.status

          // If already completed, nothing to do
          if (currentStatus === "COMPLETED") {
            yield* Effect.logInfo("Saga already completed", { orderLedgerId })
            return {
              _tag: "Completed",
              orderLedgerId,
              finalStatus: "COMPLETED"
            } satisfies SagaCompleted
          }

          // If in terminal/compensation state, report failure
          if (currentStatus === "FAILED" || currentStatus === "COMPENSATING") {
            yield* Effect.logWarning("Saga already in terminal/compensation state", {
              orderLedgerId,
              status: currentStatus
            })
            return {
              _tag: "Failed",
              orderLedgerId,
              finalStatus: currentStatus,
              error: `Saga already in ${currentStatus} state`
            } satisfies SagaFailed
          }

          // 4. Execute saga steps based on current status
          const sagaResult = yield* executeSagaSteps(event, ledger, items, payload)

          return sagaResult
        }).pipe(
          Effect.withSpan("saga-execution", {
            attributes: {
              eventId: event.id,
              retryCount: event.retryCount
            }
          }),
          Effect.catchTag("InvalidPayloadError", (error) =>
            Effect.succeed({
              _tag: "Failed",
              orderLedgerId: event.aggregateId,
              finalStatus: "UNKNOWN",
              error: error.reason
            } satisfies SagaFailed)
          )
        )
    }
  })
)
```

**Key changes:**
- `handleStepError` now takes `eventId` and calls `outboxRepo.scheduleRetry`
- Retry count comes from `event.retryCount` (outbox) not `ledger.retryCount`
- Added `OutboxRepository` as a dependency
- Added `OrchestratorConfig` as a dependency for retry policy

### Step 9: Update Main Loop Result Handling

**File**: `services/orchestrator/src/main.ts`

Update the result handling to log retry scheduling info:

```typescript
import { Effect, Schedule, Duration, Queue, Data, Match, DateTime } from "effect"
// ... other imports

export const processEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const outboxRepo = yield* OutboxRepository
  const sagaExecutor = yield* SagaExecutor

  yield* Effect.logDebug("Processing pending events...")

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const { events } = yield* outboxRepo.claimPendingEvents(10)

      if (events.length === 0) {
        yield* Effect.logDebug("No pending events to process")
        return
      }

      yield* Effect.logInfo("Processing outbox events", {
        count: events.length,
        retryEvents: events.filter(e => e.retryCount > 0).length
      })

      for (const event of events) {
        const result = yield* sagaExecutor.executeSaga(event).pipe(
          Effect.withSpan("process-outbox-event", {
            attributes: {
              eventId: event.id,
              eventType: event.eventType,
              retryCount: event.retryCount
            }
          })
        )

        yield* Match.value(result).pipe(
          Match.tag("Completed", () =>
            Effect.gen(function* () {
              yield* outboxRepo.markProcessed(event.id)
              yield* Effect.logInfo("Saga completed successfully", {
                eventId: event.id,
                orderLedgerId: result.orderLedgerId
              })
            })
          ),
          Match.tag("Failed", ({ error }) =>
            Effect.gen(function* () {
              yield* outboxRepo.markFailed(event.id)
              yield* Effect.logError("Saga failed", {
                eventId: event.id,
                orderLedgerId: result.orderLedgerId,
                error
              })
            })
          ),
          Match.tag("RequiresRetry", ({ retryCount, nextRetryAt, isLastAttempt }) =>
            Effect.logInfo("Saga step failed - retry scheduled", {
              eventId: event.id,
              orderLedgerId: result.orderLedgerId,
              retryCount,
              nextRetryAt: DateTime.formatIso(nextRetryAt),
              isLastAttempt
            })
            // Note: outbox event stays PENDING with updated next_retry_at
            // It will be picked up on next poll after the delay
          ),
          Match.tag("Compensated", ({ compensationSteps }) =>
            Effect.gen(function* () {
              yield* outboxRepo.markFailed(event.id)
              yield* Effect.logInfo("Saga compensated", {
                eventId: event.id,
                orderLedgerId: result.orderLedgerId,
                compensationSteps
              })
            })
          ),
          Match.exhaustive
        )
      }
    })
  )

  yield* Effect.logDebug("Event processing complete")
})
```

### Step 10: Update Layer Dependencies

**File**: `services/orchestrator/src/layers.ts`

Ensure all new dependencies are wired:

```typescript
import { Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import { HttpClient } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"

import { OrchestratorConfigLive } from "./config.js"
import { LedgerRepositoryLive } from "./repositories/LedgerRepositoryLive.js"
import { OutboxRepositoryLive } from "./repositories/OutboxRepositoryLive.js"
import { OrdersClientLive } from "./clients/OrdersClientLive.js"
import { InventoryClientLive } from "./clients/InventoryClientLive.js"
import { PaymentsClientLive } from "./clients/PaymentsClientLive.js"
import { CompensationExecutorLive } from "./services/CompensationExecutorLive.js"
import { SagaExecutorLive } from "./services/SagaExecutorLive.js"

// Database layer
export const DatabaseLive = PgClient.layer({
  host: process.env.DATABASE_HOST ?? "localhost",
  port: parseInt(process.env.DATABASE_PORT ?? "5432"),
  database: process.env.DATABASE_NAME ?? "ecommerce",
  username: process.env.DATABASE_USER ?? "ecommerce",
  password: process.env.DATABASE_PASSWORD ?? "ecommerce"
})

// HTTP client layer
export const HttpClientLive = NodeHttpClient.layer

// Repository layers
export const RepositoriesLive = Layer.mergeAll(
  LedgerRepositoryLive,
  OutboxRepositoryLive
)

// Service client layers
export const ClientsLive = Layer.mergeAll(
  OrdersClientLive,
  InventoryClientLive,
  PaymentsClientLive
).pipe(
  Layer.provide(HttpClientLive)
)

// Compensation executor (depends on clients)
export const CompensationLive = CompensationExecutorLive.pipe(
  Layer.provide(ClientsLive),
  Layer.provide(RepositoriesLive)
)

// Saga executor (depends on everything)
export const SagaExecutorLayer = SagaExecutorLive.pipe(
  Layer.provide(RepositoriesLive),
  Layer.provide(ClientsLive),
  Layer.provide(CompensationLive),
  Layer.provide(OrchestratorConfigLive)  // Add config for retry policy
)

// Full application layer
export const AppLive = Layer.mergeAll(
  SagaExecutorLayer,
  RepositoriesLive,
  OrchestratorConfigLive
).pipe(
  Layer.provide(DatabaseLive)
)
```

### Step 11: Update OrderLedger Domain Model - Remove Retry Fields

**File**: `services/orchestrator/src/domain/OrderLedger.ts`

Remove the retry fields from the OrderLedger schema class:

```typescript
import { Schema } from "effect"

export const OrderLedgerId = Schema.String.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ProductId = Schema.String.pipe(Schema.brand("ProductId"))
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
  totalAmountCents: Schema.Number,
  currency: Schema.String,
  paymentAuthorizationId: Schema.NullOr(Schema.String),
  orderId: Schema.NullOr(Schema.String),
  // REMOVED: retryCount: Schema.Number,
  // REMOVED: nextRetryAt: Schema.NullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

// OrderLedgerItem unchanged...
```

### Step 12: Update LedgerRepositoryLive - Remove Retry Field Mapping

**File**: `services/orchestrator/src/repositories/LedgerRepositoryLive.ts`

Update the row interface and mapping function:

```typescript
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
  // REMOVED: retry_count: number
  // REMOVED: next_retry_at: Date | null
  created_at: Date
  updated_at: Date
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
    orderId: row.order_id,
    // REMOVED: retryCount: row.retry_count,
    // REMOVED: nextRetryAt: row.next_retry_at ? DateTime.unsafeFromDate(row.next_retry_at) : null,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    updatedAt: DateTime.unsafeFromDate(row.updated_at)
  })
```

Also update the `findByIdWithItems` query to not select retry columns:

```typescript
findByIdWithItems: (id: OrderLedgerId) =>
  Effect.gen(function* () {
    const rows = yield* sql<LedgerWithItemsRow>`
      SELECT
        ol.id, ol.client_request_id, ol.user_id, ol.email, ol.status,
        ol.total_amount_cents, ol.currency, ol.payment_authorization_id,
        ol.order_id, ol.created_at, ol.updated_at,
        -- REMOVED: ol.retry_count, ol.next_retry_at,
        oli.id as item_id, oli.product_id, oli.quantity, oli.unit_price_cents,
        oli.created_at as item_created_at
      FROM order_ledger ol
      LEFT JOIN order_ledger_items oli ON oli.order_ledger_id = ol.id
      WHERE ol.id = ${id}
    `
    // ... rest unchanged
  })
```

---

## Testing Strategy

### Unit Tests

**File**: `services/orchestrator/src/__tests__/RetryPolicy.test.ts` (new file)

```typescript
import { describe, it, expect } from "vitest"
import { Duration, DateTime } from "effect"
import {
  calculateRetryDelay,
  calculateNextRetryAt,
  isMaxRetriesExceeded,
  DEFAULT_RETRY_POLICY
} from "../domain/RetryPolicy.js"

describe("RetryPolicy", () => {
  describe("calculateRetryDelay", () => {
    it("should return zero delay for first attempt", () => {
      const delay = calculateRetryDelay(1)
      expect(Duration.toMillis(delay)).toBe(0)
    })

    it("should return 1 second for second attempt", () => {
      const delay = calculateRetryDelay(2)
      expect(Duration.toMillis(delay)).toBe(1000)
    })

    it("should return 4 seconds for third attempt", () => {
      const delay = calculateRetryDelay(3)
      expect(Duration.toMillis(delay)).toBe(4000)
    })

    it("should return 16 seconds for fourth attempt", () => {
      const delay = calculateRetryDelay(4)
      expect(Duration.toMillis(delay)).toBe(16000)
    })

    it("should return 64 seconds for fifth attempt", () => {
      const delay = calculateRetryDelay(5)
      expect(Duration.toMillis(delay)).toBe(64000)
    })

    it("should respect custom policy values", () => {
      const policy = { maxAttempts: 3, baseDelayMs: 500, backoffMultiplier: 2 }
      const delay = calculateRetryDelay(3, policy)
      expect(Duration.toMillis(delay)).toBe(1000) // 500 * 2^1
    })
  })

  describe("calculateNextRetryAt", () => {
    it("should add delay to current time", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const nextRetry = calculateNextRetryAt(2, DEFAULT_RETRY_POLICY, baseTime)
      const expected = DateTime.unsafeMake("2024-01-15T10:00:01Z") // +1 second
      expect(DateTime.equals(nextRetry, expected)).toBe(true)
    })
  })

  describe("isMaxRetriesExceeded", () => {
    it("should return false when retryCount is 0", () => {
      expect(isMaxRetriesExceeded(0, 5)).toBe(false)
    })

    it("should return false when retryCount is less than maxAttempts", () => {
      expect(isMaxRetriesExceeded(4, 5)).toBe(false)
    })

    it("should return true when retryCount equals maxAttempts", () => {
      expect(isMaxRetriesExceeded(5, 5)).toBe(true)
    })

    it("should return true when retryCount exceeds maxAttempts", () => {
      expect(isMaxRetriesExceeded(6, 5)).toBe(true)
    })
  })
})
```

### OutboxRepository Tests

**File**: `services/orchestrator/src/__tests__/OutboxRepository.test.ts`

Add tests for new `scheduleRetry` method:

```typescript
describe("OutboxRepository", () => {
  // ... existing tests ...

  describe("scheduleRetry", () => {
    it("should increment retry_count and set next_retry_at", async () => {
      // Setup: create test outbox event
      // Act: call scheduleRetry
      // Assert: retry_count is incremented, next_retry_at is set
    })

    it("should return the new retry count", async () => {
      // Setup: event with retry_count = 2
      // Act: call scheduleRetry
      // Assert: returns { retryCount: 3 }
    })
  })

  describe("claimPendingEvents with retry filtering", () => {
    it("should return events with null next_retry_at", async () => {
      // New events ready for first attempt
    })

    it("should return events where next_retry_at is in the past", async () => {
      // Retries that are due
    })

    it("should NOT return events where next_retry_at is in the future", async () => {
      // Retries not yet due
    })

    it("should prioritize new events (null next_retry_at) over retries", async () => {
      // ORDER BY next_retry_at NULLS FIRST
    })
  })
})
```

### SagaExecutor Retry Tests

**File**: `services/orchestrator/src/__tests__/SagaExecutor.test.ts`

Update mock factories and add tests:

```typescript
// Update createTestOutboxEvent to include retry fields
const createTestOutboxEvent = (
  ledgerId: string,
  retryCount = 0,
  nextRetryAt: DateTime.Utc | null = null
): OutboxEvent => {
  const now = DateTime.unsafeNow()
  return new OutboxEvent({
    id: `event-${ledgerId}` as OutboxEventId,
    aggregateType: "OrderLedger",
    aggregateId: ledgerId,
    eventType: "OrderAuthorized",
    payload: {
      order_ledger_id: ledgerId,
      user_id: "user-123",
      email: "test@example.com",
      total_amount_cents: 5999,
      currency: "USD",
      payment_authorization_id: "auth-456"
    },
    status: "PENDING",
    createdAt: now,
    processedAt: null,
    retryCount,
    nextRetryAt
  })
}

// Add mock for OutboxRepository
const createMockOutboxRepo = (overrides: {
  scheduleRetry?: (eventId: OutboxEventId, nextRetryAt: DateTime.Utc) => Effect.Effect<{ retryCount: number }>
} = {}) => {
  return Layer.succeed(OutboxRepository, {
    claimPendingEvents: () => Effect.succeed({ events: [] }),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    scheduleRetry: overrides.scheduleRetry ?? ((_, __) => Effect.succeed({ retryCount: 1 }))
  })
}

describe("executeSaga - retry logic", () => {
  it("should schedule retry via outbox for retryable error on first attempt", async () => {
    const ledgerId = "ledger-123"
    const event = createTestOutboxEvent(ledgerId, 0) // retryCount = 0
    let scheduledRetry: { eventId: string; nextRetryAt: DateTime.Utc } | null = null

    const testLayer = createTestLayer(
      { findByIdWithItems: () => Effect.succeed(Option.some({
          ledger: createTestLedger(ledgerId, "AUTHORIZED"),
          items: [createTestItem("item-1", ledgerId)]
        }))
      },
      { createOrder: () => Effect.fail(new OrderCreationError({
          orderLedgerId: ledgerId,
          reason: "Server error",
          statusCode: 500,
          isRetryable: true
        }))
      },
      {},
      {},
      {},
      { scheduleRetry: (eventId, nextRetryAt) => {
          scheduledRetry = { eventId, nextRetryAt }
          return Effect.succeed({ retryCount: 1 })
        }
      }
    )

    const result = await Effect.gen(function* () {
      const executor = yield* SagaExecutor
      return yield* executor.executeSaga(event)
    }).pipe(Effect.provide(testLayer), Effect.runPromise)

    expect(result._tag).toBe("RequiresRetry")
    expect(scheduledRetry).not.toBeNull()
    expect(scheduledRetry!.eventId).toBe(event.id)
  })

  it("should trigger compensation after max retries exceeded", async () => {
    const ledgerId = "ledger-123"
    const event = createTestOutboxEvent(ledgerId, 5) // Already at max (5 attempts)

    const testLayer = createTestLayer(
      { findByIdWithItems: () => Effect.succeed(Option.some({
          ledger: createTestLedger(ledgerId, "AUTHORIZED"),
          items: [createTestItem("item-1", ledgerId)]
        })),
        updateStatus: (id, status) => Effect.succeed(createTestLedger(id, status))
      },
      { createOrder: () => Effect.fail(new OrderCreationError({
          orderLedgerId: ledgerId,
          reason: "Server error",
          statusCode: 500,
          isRetryable: true // Still retryable, but max exceeded
        }))
      }
    )

    const result = await Effect.gen(function* () {
      const executor = yield* SagaExecutor
      return yield* executor.executeSaga(event)
    }).pipe(Effect.provide(testLayer), Effect.runPromise)

    expect(result._tag).toBe("Compensated")
  })

  it("should calculate correct exponential backoff delay", async () => {
    // Test that retry delays follow 1s, 4s, 16s, 64s pattern
    const ledgerId = "ledger-123"
    const delays: number[] = []

    for (let retryCount = 0; retryCount < 4; retryCount++) {
      const event = createTestOutboxEvent(ledgerId, retryCount)
      // ... capture nextRetryAt and verify delay
    }
  })
})
```

---

## Schema Changes

### 1. Modify Order Ledger Migration - Remove Retry Columns

**File**: `migrations/005_create_order_ledger.sql`

Remove from the CREATE TABLE statement:
- `retry_count INT NOT NULL DEFAULT 0`
- `next_retry_at TIMESTAMP WITH TIME ZONE`

Remove the index:
- `idx_order_ledger_next_retry`

### 2. Modify Outbox Migration - Add Retry Columns

**File**: `migrations/007_create_outbox.sql`

Add to the CREATE TABLE statement:
- `retry_count INT NOT NULL DEFAULT 0`
- `next_retry_at TIMESTAMP WITH TIME ZONE`

Add the index:
- `CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(next_retry_at) WHERE status = 'PENDING'`

### After Modifying Migrations

```bash
# Drop and recreate the database (demo only - destroys data)
docker-compose down -v
docker-compose up -d postgres
# Wait for postgres to be ready, then run migrations
```

---

## Validation Checklist

Before considering implementation complete:

- [ ] Schema modification adds retry_count and next_retry_at to outbox table
- [ ] OutboxEvent domain model includes new fields
- [ ] Config values loaded correctly with sensible defaults
- [ ] `calculateRetryDelay` produces correct delays (0, 1s, 4s, 16s, 64s)
- [ ] `isMaxRetriesExceeded` correctly identifies when to stop retrying
- [ ] `scheduleRetry` atomically updates both fields in outbox
- [ ] `claimPendingEvents` respects `next_retry_at` timestamp
- [ ] `claimPendingEvents` uses `FOR UPDATE SKIP LOCKED` correctly
- [ ] `handleStepError` schedules retry via outbox (not ledger)
- [ ] `handleStepError` triggers compensation when max retries exceeded
- [ ] Main loop logs retry scheduling appropriately
- [ ] Unit tests cover retry policy pure functions
- [ ] Integration tests verify outbox repository methods
- [ ] End-to-end test verifies full retry flow

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `migrations/005_create_order_ledger.sql` | Modify | Remove retry_count, next_retry_at columns and index |
| `migrations/007_create_outbox.sql` | Modify | Add retry_count, next_retry_at columns and index |
| `orchestrator/src/domain/OrderLedger.ts` | Modify | Remove retryCount, nextRetryAt fields |
| `orchestrator/src/domain/OutboxEvent.ts` | Modify | Add retryCount, nextRetryAt fields |
| `orchestrator/src/domain/RetryPolicy.ts` | Create | Pure retry calculation functions |
| `orchestrator/src/config.ts` | Modify | Add retry config fields |
| `orchestrator/src/repositories/LedgerRepositoryLive.ts` | Modify | Remove retry field mapping from queries |
| `orchestrator/src/repositories/OutboxRepository.ts` | Modify | Add scheduleRetry method |
| `orchestrator/src/repositories/OutboxRepositoryLive.ts` | Modify | Implement scheduleRetry, update claimPendingEvents |
| `orchestrator/src/services/SagaExecutor.ts` | Modify | Update SagaRequiresRetry type |
| `orchestrator/src/services/SagaExecutorLive.ts` | Modify | Integrate outbox-based retry logic |
| `orchestrator/src/main.ts` | Modify | Update result handling for retries |
| `orchestrator/src/layers.ts` | Modify | Wire up OrchestratorConfig |
| `orchestrator/src/__tests__/RetryPolicy.test.ts` | Create | Unit tests |
| `orchestrator/src/__tests__/OutboxRepository.test.ts` | Modify | Add retry method tests |
| `orchestrator/src/__tests__/SagaExecutor.test.ts` | Modify | Add retry test cases |

---

## Rollback Strategy

1. **If issues arise after deployment:**
   - Set `MAX_RETRY_ATTEMPTS=0` to disable retries (all retryable errors trigger immediate compensation)
   - Or revert code and redeploy

2. **Database rollback (demo project):**
   - Revert changes to `migrations/007_create_outbox.sql`
   - Recreate database: `docker-compose down -v && docker-compose up -d postgres`

3. **Data considerations:**
   - New columns have defaults (retry_count=0, next_retry_at=NULL)
   - Existing PENDING events will be processed normally on first attempt
