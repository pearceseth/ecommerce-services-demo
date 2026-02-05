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
      const nextAttemptNumber = currentRetryCount + 2 // +1 for increment, +1 for next attempt
      const nextRetryAt = calculateNextRetryAt(nextAttemptNumber, retryPolicy)

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
