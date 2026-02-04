# Implementation Plan: Saga Compensation Handling

## Status: COMPLETE

---

## Overview

This plan covers the implementation of compensation handling for the saga orchestrator. When a saga step fails with a permanent error (or after exhausting retries), the orchestrator must execute compensating actions in reverse order to undo any partially completed work.

### Scope

From `todo.md` - Compensation Handling section:
- [x] Detect permanent failures and transition to COMPENSATING state (partially implemented - state transition exists but no compensation execution)
- [ ] Execute compensations in reverse order based on last successful step
- [ ] Void payment authorization via Payments Service
- [ ] Release inventory reservation via Inventory Service
- [ ] Cancel order via Orders Service
- [ ] Mark ledger as FAILED after compensation complete

### Recommendation: Single Feature Delivery

These tasks are tightly coupled and should be implemented together:
1. **State Detection** - Already partially exists in `handleStepError`
2. **Compensation Logic** - Requires all three compensation operations
3. **State Finalization** - Must complete after compensations

Breaking this into separate PRs would leave the system in an inconsistent state where it detects compensation needs but cannot execute them.

---

## Current State Analysis

### What Exists

**SagaExecutorLive.ts** (lines 15-56):
- `handleStepError` function that classifies errors as retryable vs permanent
- Returns `SagaRequiresCompensation` result with `finalStatus: "COMPENSATING"`
- Does NOT execute compensations - just signals they're needed

**main.ts** (lines 52-59):
- Handles `RequiresCompensation` result by marking outbox event as failed
- Logs warning but does NOT execute compensation

**Client Interfaces** - Only forward operations exist:
- `PaymentsClient`: `capturePayment` only (no `voidPayment`)
- `InventoryClient`: `reserveStock` only (no `releaseStock`)
- `OrdersClient`: `createOrder`, `confirmOrder` (no `cancelOrder`)

### Service Compensation Endpoints (Already Exist)

| Service | Endpoint | Purpose |
|---------|----------|---------|
| Payment | `POST /payments/void/:authorization_id` | Void authorization |
| Inventory | `DELETE /reservations/:order_id` | Release reservations |
| Orders | `POST /orders/:order_id/cancellation` | Cancel order |

---

## Implementation Details

### Part 1: Extend Client Interfaces

#### 1.1 PaymentsClient.ts

Add `voidPayment` method to the existing interface:

```typescript
export interface VoidPaymentParams {
  readonly authorizationId: string
  readonly idempotencyKey: string
  readonly reason?: string
}

export interface VoidPaymentResult {
  readonly voidId: string
  readonly authorizationId: string
  readonly status: "VOIDED"
  readonly voidedAt: string
}
```

Add to the `PaymentsClient` context tag interface:
```typescript
/**
 * Void an authorized payment (compensation).
 * Idempotent: returns success if already voided.
 */
readonly voidPayment: (
  params: VoidPaymentParams
) => Effect.Effect<VoidPaymentResult, PaymentVoidError | ServiceConnectionError>
```

#### 1.2 InventoryClient.ts

Add `releaseStock` method to the existing interface:

```typescript
export interface ReleaseStockParams {
  readonly orderId: string
}

export interface ReleaseStockResult {
  readonly orderId: string
  readonly releasedCount: number
  readonly totalQuantityRestored: number
}
```

Add to the `InventoryClient` context tag interface:
```typescript
/**
 * Release stock reservations for an order (compensation).
 * Idempotent: returns success if already released or no reservations exist.
 */
readonly releaseStock: (
  params: ReleaseStockParams
) => Effect.Effect<ReleaseStockResult, InventoryReleaseError | ServiceConnectionError>
```

#### 1.3 OrdersClient.ts

Add `cancelOrder` method to the existing interface:

```typescript
export interface CancelOrderResult {
  readonly orderId: string
  readonly status: "CANCELLED"
}
```

Add to the `OrdersClient` context tag interface:
```typescript
/**
 * Cancel an order (compensation).
 * Idempotent: returns success if already cancelled.
 */
readonly cancelOrder: (
  orderId: string
) => Effect.Effect<CancelOrderResult, OrderCancellationError | ServiceConnectionError>
```

### Part 2: Add New Error Types

#### 2.1 domain/errors.ts

Add compensation-specific error types:

```typescript
/**
 * Payment void failed
 */
export class PaymentVoidError extends Data.TaggedError("PaymentVoidError")<{
  readonly authorizationId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Inventory release failed
 */
export class InventoryReleaseError extends Data.TaggedError("InventoryReleaseError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Order cancellation failed
 */
export class OrderCancellationError extends Data.TaggedError("OrderCancellationError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}
```

Update `SagaStepError` union to include compensation errors:

```typescript
export type SagaCompensationError =
  | ServiceConnectionError
  | PaymentVoidError
  | InventoryReleaseError
  | OrderCancellationError
```

### Part 3: Implement Client Methods

#### 3.1 PaymentsClientLive.ts

Add `voidPayment` implementation following the pattern of `capturePayment`:

**Key Implementation Notes:**
- Endpoint: `POST /payments/void/:authorization_id`
- Request body: `{ idempotency_key: string, reason?: string }`
- Success response (200): Parse void result
- 404: Authorization not found - treat as success (idempotent - already cleaned up)
- 409 (AlreadyCaptured): Permanent failure - cannot void a captured payment
- 503: Gateway unavailable - retryable

**Response Schema:**
```typescript
const VoidSuccessResponse = Schema.Struct({
  void_id: Schema.String,
  authorization_id: Schema.String,
  status: Schema.Literal("VOIDED"),
  voided_at: Schema.String
})
```

**Idempotency Handling:**
The payment service returns 200 with the existing void record if already voided. The client should handle this gracefully as a success case.

#### 3.2 InventoryClientLive.ts

Add `releaseStock` implementation:

**Key Implementation Notes:**
- Endpoint: `DELETE /reservations/:order_id`
- No request body required
- Success response (200): Returns release statistics
- 404: No reservations found - treat as success (idempotent)
- 500: Server error - retryable

**Response Schema:**
```typescript
const ReleaseSuccessResponse = Schema.Struct({
  order_id: Schema.String,
  released_count: Schema.Number,
  total_quantity_restored: Schema.Number,
  message: Schema.String
})
```

**Idempotency Handling:**
The inventory service is already idempotent - calling release on already-released reservations returns 200 with `released_count: 0` and a message indicating they were already released.

#### 3.3 OrdersClientLive.ts

Add `cancelOrder` implementation:

**Key Implementation Notes:**
- Endpoint: `POST /orders/:order_id/cancellation`
- No request body required
- Success response (200): Returns cancelled order
- 404: Order not found - this is an error during compensation (should never happen if saga executed correctly)
- 409: Invalid status transition - check if `current_status === "CANCELLED"` → treat as success (idempotent)
- 500: Server error - retryable

**Response Schema:**
```typescript
const CancelOrderSuccessResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("CANCELLED")
})
```

**Idempotency Handling:**
On 409 response, parse the body to check if `current_status === "CANCELLED"`. If so, treat as success (already cancelled).

### Part 4: Implement Compensation Executor

#### 4.1 Create CompensationExecutor Service

Create new file: `services/orchestrator/src/services/CompensationExecutor.ts`

**Interface Definition:**
```typescript
import { Context, Effect } from "effect"
import type { OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface CompensationContext {
  readonly orderLedgerId: string
  readonly orderId: string | null
  readonly paymentAuthorizationId: string | null
  readonly lastSuccessfulStatus: OrderLedgerStatus
}

export interface CompensationResult {
  readonly _tag: "CompensationCompleted" | "CompensationFailed"
  readonly orderLedgerId: string
  readonly stepsExecuted: readonly string[]
  readonly error?: string
}

export class CompensationExecutor extends Context.Tag("CompensationExecutor")<
  CompensationExecutor,
  {
    /**
     * Execute compensating actions based on the last successful saga step.
     * Compensations run in reverse order: void payment → release inventory → cancel order
     * All operations are idempotent - safe to retry.
     */
    readonly executeCompensation: (
      context: CompensationContext
    ) => Effect.Effect<CompensationResult>
  }
>() {}
```

#### 4.2 Create CompensationExecutorLive

Create new file: `services/orchestrator/src/services/CompensationExecutorLive.ts`

**Implementation Strategy:**

The compensation logic must determine which steps to undo based on `lastSuccessfulStatus`:

| Last Status | Compensation Steps (in order) |
|-------------|------------------------------|
| `AUTHORIZED` | Void payment |
| `ORDER_CREATED` | Void payment → Cancel order |
| `INVENTORY_RESERVED` | Void payment → Release inventory → Cancel order |
| `PAYMENT_CAPTURED` | Release inventory → Cancel order (payment already captured - cannot void) |

**Key Design Decisions:**

1. **Best-Effort Compensation**: Each compensation step should be attempted even if previous ones fail. Log all failures but continue.

2. **Idempotent Operations**: All compensation operations are idempotent. Retrying compensation is safe.

3. **Payment Capture Edge Case**: If payment was already captured (`PAYMENT_CAPTURED` status), voiding is not possible. The business must handle refunds separately (out of scope for this implementation). Log a warning.

4. **Error Collection**: Collect errors from all compensation steps rather than failing fast. Return a result indicating partial success if some steps failed.

**Pseudo-code Structure:**
```typescript
export const CompensationExecutorLive = Layer.effect(
  CompensationExecutor,
  Effect.gen(function* () {
    const ordersClient = yield* OrdersClient
    const inventoryClient = yield* InventoryClient
    const paymentsClient = yield* PaymentsClient

    const executeCompensation = (ctx: CompensationContext) =>
      Effect.gen(function* () {
        const stepsExecuted: string[] = []
        const errors: string[] = []
        const { lastSuccessfulStatus, orderLedgerId, orderId, paymentAuthorizationId } = ctx

        yield* Effect.logInfo("Starting compensation", {
          orderLedgerId,
          lastSuccessfulStatus
        })

        // Determine required compensations based on last successful status
        const requiresPaymentVoid =
          lastSuccessfulStatus !== "PAYMENT_CAPTURED" &&
          paymentAuthorizationId !== null

        const requiresInventoryRelease =
          lastSuccessfulStatus === "INVENTORY_RESERVED" ||
          lastSuccessfulStatus === "PAYMENT_CAPTURED"

        const requiresOrderCancel =
          orderId !== null && (
            lastSuccessfulStatus === "ORDER_CREATED" ||
            lastSuccessfulStatus === "INVENTORY_RESERVED" ||
            lastSuccessfulStatus === "PAYMENT_CAPTURED"
          )

        // Step 1: Void payment authorization (if applicable and not already captured)
        if (requiresPaymentVoid) {
          yield* voidPaymentStep(paymentsClient, paymentAuthorizationId, orderLedgerId)
            .pipe(
              Effect.tap(() => stepsExecuted.push("void_payment")),
              Effect.catchAll((error) => {
                errors.push(`void_payment: ${error._tag}`)
                return Effect.logError("Failed to void payment", { error })
              })
            )
        }

        // Step 2: Release inventory reservation (if applicable)
        if (requiresInventoryRelease && orderId) {
          yield* releaseInventoryStep(inventoryClient, orderId, orderLedgerId)
            .pipe(
              Effect.tap(() => stepsExecuted.push("release_inventory")),
              Effect.catchAll((error) => {
                errors.push(`release_inventory: ${error._tag}`)
                return Effect.logError("Failed to release inventory", { error })
              })
            )
        }

        // Step 3: Cancel order (if applicable)
        if (requiresOrderCancel && orderId) {
          yield* cancelOrderStep(ordersClient, orderId, orderLedgerId)
            .pipe(
              Effect.tap(() => stepsExecuted.push("cancel_order")),
              Effect.catchAll((error) => {
                errors.push(`cancel_order: ${error._tag}`)
                return Effect.logError("Failed to cancel order", { error })
              })
            )
        }

        // If payment was already captured, log a warning about manual refund needed
        if (lastSuccessfulStatus === "PAYMENT_CAPTURED") {
          yield* Effect.logWarning(
            "Payment was already captured - manual refund may be required",
            { orderLedgerId, paymentAuthorizationId }
          )
        }

        if (errors.length > 0) {
          yield* Effect.logError("Compensation completed with errors", {
            orderLedgerId,
            stepsExecuted,
            errors
          })
          return {
            _tag: "CompensationFailed" as const,
            orderLedgerId,
            stepsExecuted,
            error: errors.join("; ")
          }
        }

        yield* Effect.logInfo("Compensation completed successfully", {
          orderLedgerId,
          stepsExecuted
        })
        return {
          _tag: "CompensationCompleted" as const,
          orderLedgerId,
          stepsExecuted
        }
      })

    return { executeCompensation }
  })
)
```

**Helper Functions:**
```typescript
// Each step is a separate function for clarity and testability

const voidPaymentStep = (
  client: PaymentsClient.Service,
  authorizationId: string,
  orderLedgerId: string
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Compensation: Voiding payment", { authorizationId })
    yield* client.voidPayment({
      authorizationId,
      idempotencyKey: `void-${orderLedgerId}`,
      reason: "Saga compensation"
    })
  })

const releaseInventoryStep = (
  client: InventoryClient.Service,
  orderId: string,
  orderLedgerId: string
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Compensation: Releasing inventory", { orderId })
    yield* client.releaseStock({ orderId })
  })

const cancelOrderStep = (
  client: OrdersClient.Service,
  orderId: string,
  orderLedgerId: string
) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Compensation: Cancelling order", { orderId })
    yield* client.cancelOrder(orderId)
  })
```

### Part 5: Integrate with SagaExecutor

#### 5.1 Update SagaExecutor Interface

Modify `SagaExecutor.ts` to reflect that compensation may now be executed:

```typescript
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
  | SagaCompensated  // Replaces SagaRequiresCompensation
```

**Note:** Remove `SagaRequiresCompensation` - compensation now executes inline rather than being deferred.

#### 5.2 Update SagaExecutorLive.ts

Modify the saga executor to execute compensation when a permanent failure occurs:

**Changes to `handleStepError`:**

Instead of returning `RequiresCompensation`, the function should call the `CompensationExecutor` and then update the ledger status to `FAILED`.

```typescript
const handleStepError = (
  orderLedgerId: string,
  currentStatus: OrderLedgerStatus,
  orderId: string | null,
  paymentAuthorizationId: string | null,
  error: SagaStepError
): Effect.Effect<StepResult, never, CompensationExecutor | LedgerRepository> =>
  Effect.gen(function* () {
    const isRetryable = "isRetryable" in error && error.isRetryable

    if (isRetryable) {
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
          finalStatus: currentStatus,
          error: error._tag
        } satisfies SagaRequiresRetry
      } satisfies StepResult
    }

    // Permanent failure - execute compensation
    yield* Effect.logError("Saga step failed with permanent error - starting compensation", {
      orderLedgerId,
      errorType: error._tag,
      lastSuccessfulStatus: currentStatus
    })

    const ledgerRepo = yield* LedgerRepository
    const compensationExecutor = yield* CompensationExecutor

    // Transition to COMPENSATING
    yield* ledgerRepo.updateStatus(orderLedgerId as OrderLedgerId, "COMPENSATING")

    // Execute compensation
    const compensationResult = yield* compensationExecutor.executeCompensation({
      orderLedgerId,
      orderId,
      paymentAuthorizationId,
      lastSuccessfulStatus: currentStatus
    })

    // Transition to FAILED
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
```

**Changes to `executeSagaSteps`:**

Pass `orderId` and `paymentAuthorizationId` to `handleStepError` so compensation has the context it needs:

```typescript
const stepResult = yield* ordersClient.createOrder({...}).pipe(
  Effect.map((result): StepResult => ({
    _tag: "StepSuccess",
    orderId: result.orderId
  })),
  Effect.catchAll((error) =>
    handleStepError(
      orderLedgerId,
      currentStatus,
      orderId,  // null at this point
      payload.payment_authorization_id,  // always available
      error
    )
  )
)
```

### Part 6: Update Layers

#### 6.1 layers.ts

Add `CompensationExecutorLive` to the layer composition:

```typescript
import { CompensationExecutorLive } from "./services/CompensationExecutorLive.js"

export const ApplicationLive = Layer.mergeAll(
  // ... existing layers ...
  CompensationExecutorLive
)
```

Ensure dependencies are correctly wired:
- `CompensationExecutorLive` depends on: `OrdersClient`, `InventoryClient`, `PaymentsClient`
- `SagaExecutorLive` depends on: `LedgerRepository`, `OrdersClient`, `InventoryClient`, `PaymentsClient`, `CompensationExecutor`

### Part 7: Update Main Process Loop

#### 7.1 main.ts

Update the `processEvents` function to handle the new `Compensated` result type:

```typescript
yield* Match.value(result).pipe(
  Match.tag("Completed", () => outboxRepo.markProcessed(event.id)),
  Match.tag("Failed", () => outboxRepo.markFailed(event.id)),
  Match.tag("RequiresRetry", ({ error }) =>
    Effect.logInfo("Event will be retried", {
      eventId: event.id,
      reason: error
    })
  ),
  Match.tag("Compensated", ({ orderLedgerId, compensationSteps }) =>
    Effect.gen(function* () {
      yield* outboxRepo.markFailed(event.id)
      yield* Effect.logInfo("Saga compensated and marked as failed", {
        eventId: event.id,
        orderLedgerId,
        compensationSteps
      })
    })
  ),
  Match.exhaustive
)
```

---

## Testing Strategy

### Unit Tests

#### CompensationExecutor.test.ts

Create comprehensive tests for the compensation executor:

1. **Happy Path Tests:**
   - From `ORDER_CREATED`: Should void payment and cancel order
   - From `INVENTORY_RESERVED`: Should void payment, release inventory, and cancel order
   - From `PAYMENT_CAPTURED`: Should release inventory and cancel order (no void)

2. **Idempotency Tests:**
   - Calling compensation twice should succeed both times
   - Already-voided payment returns success
   - Already-released inventory returns success
   - Already-cancelled order returns success

3. **Partial Failure Tests:**
   - Payment void fails → other steps still execute
   - Inventory release fails → order cancel still executes
   - All steps fail → returns CompensationFailed with all errors

4. **Edge Cases:**
   - No orderId available (failure at ORDER_CREATED step before order created)
   - No paymentAuthorizationId (should never happen in practice)

#### Client Tests

For each new client method (`voidPayment`, `releaseStock`, `cancelOrder`):

1. Success response handling
2. Idempotent response handling (already voided/released/cancelled)
3. 404 handling (not found)
4. 409 handling (conflict states)
5. 5xx error handling (retryable)
6. Connection timeout handling

### Integration Tests

#### SagaExecutor.test.ts (Extend Existing)

Add integration tests that verify end-to-end compensation flow:

1. **Inventory Failure → Compensation:**
   - Create order succeeds
   - Reserve inventory fails (insufficient stock)
   - Compensation voids payment and cancels order
   - Ledger status is FAILED

2. **Payment Capture Failure → Compensation:**
   - Create order succeeds
   - Reserve inventory succeeds
   - Capture payment fails (card declined)
   - Compensation releases inventory and cancels order
   - Ledger status is FAILED

3. **Already Compensated:**
   - Run saga that fails
   - Verify compensation ran
   - Run saga again
   - Verify idempotent behavior

---

## File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `services/CompensationExecutor.ts` | Interface for compensation execution |
| `services/CompensationExecutorLive.ts` | Implementation of compensation logic |
| `__tests__/CompensationExecutor.test.ts` | Unit tests for compensation |

### Modified Files

| File | Changes |
|------|---------|
| `domain/errors.ts` | Add `PaymentVoidError`, `InventoryReleaseError`, `OrderCancellationError` |
| `clients/PaymentsClient.ts` | Add `voidPayment` interface |
| `clients/PaymentsClientLive.ts` | Add `voidPayment` implementation |
| `clients/InventoryClient.ts` | Add `releaseStock` interface |
| `clients/InventoryClientLive.ts` | Add `releaseStock` implementation |
| `clients/OrdersClient.ts` | Add `cancelOrder` interface |
| `clients/OrdersClientLive.ts` | Add `cancelOrder` implementation |
| `services/SagaExecutor.ts` | Replace `SagaRequiresCompensation` with `SagaCompensated` |
| `services/SagaExecutorLive.ts` | Integrate compensation execution |
| `main.ts` | Handle `Compensated` result type |
| `layers.ts` | Add `CompensationExecutorLive` to layer composition |
| `__tests__/clients.test.ts` | Add tests for new client methods |
| `__tests__/SagaExecutor.test.ts` | Add compensation integration tests |

---

## Implementation Order

For the implementing agent, follow this sequence:

1. **Error Types** (`domain/errors.ts`)
   - Add the three new error types first as they're dependencies

2. **Client Interfaces** (in parallel)
   - `PaymentsClient.ts` - add interface
   - `InventoryClient.ts` - add interface
   - `OrdersClient.ts` - add interface

3. **Client Implementations** (in parallel)
   - `PaymentsClientLive.ts` - add `voidPayment`
   - `InventoryClientLive.ts` - add `releaseStock`
   - `OrdersClientLive.ts` - add `cancelOrder`

4. **Compensation Executor**
   - Create `CompensationExecutor.ts` interface
   - Create `CompensationExecutorLive.ts` implementation

5. **Saga Executor Updates**
   - Update `SagaExecutor.ts` types
   - Update `SagaExecutorLive.ts` to use CompensationExecutor

6. **Layer Composition**
   - Update `layers.ts`

7. **Main Loop**
   - Update `main.ts` to handle new result type

8. **Tests** (in parallel with implementation)
   - Client tests
   - CompensationExecutor tests
   - Integration tests

---

## Validation Checklist

Before marking implementation complete:

- [ ] All new error types have proper `Data.TaggedError` structure with context fields
- [ ] All client methods follow existing patterns (timeout, error mapping, logging)
- [ ] All compensation operations are idempotent (handle already-done gracefully)
- [ ] CompensationExecutor handles partial failures (continues even if one step fails)
- [ ] Ledger transitions to COMPENSATING before compensation, FAILED after
- [ ] Logging includes orderLedgerId, orderId, compensation steps at INFO level
- [ ] TypeScript compiles without errors
- [ ] All existing tests pass
- [ ] New tests cover happy path, idempotency, and failure scenarios
- [ ] Manual test: trigger inventory failure and verify compensation runs

---

## Risks and Considerations

### Risk: Payment Already Captured

If failure occurs after payment capture (during order confirmation), the payment cannot be voided - only refunded. This implementation will:
- Log a warning that manual refund may be needed
- Continue with other compensation steps
- Mark the saga as FAILED

**Mitigation:** This is expected behavior per the design doc. A separate refund process would be needed for production.

### Risk: Compensation Step Failures

If a compensation step fails:
- The error is logged
- Other compensation steps still execute
- The saga is marked as FAILED
- The specific failure is recorded in the result

**Mitigation:** All compensation operations are idempotent, so re-triggering the saga (manually or via retry) would attempt compensation again safely.

### Risk: Race Conditions

Multiple orchestrator instances might process the same saga. The outbox `SELECT FOR UPDATE SKIP LOCKED` prevents this, and all operations are idempotent.

---

## Estimated Complexity

- **Lines of Code:** ~500-600 new/modified lines
- **Test Coverage:** ~300-400 lines of tests
- **Difficulty:** Medium - follows established patterns, but requires careful handling of partial failures

## Confidence Score for One-Pass Success

**75%** - The implementation follows well-established patterns in the codebase, and all downstream service endpoints already exist. Main risks are edge cases in error handling and ensuring the layer composition is correct.
