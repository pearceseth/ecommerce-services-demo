import { Layer, Effect, Option, Schema } from "effect"
import { SagaExecutor, type SagaExecutionResult, type SagaCompleted, type SagaFailed, type SagaRequiresRetry, type SagaRequiresCompensation } from "./SagaExecutor.js"
import { LedgerRepository } from "../repositories/LedgerRepository.js"
import { OrdersClient } from "../clients/OrdersClient.js"
import { InventoryClient } from "../clients/InventoryClient.js"
import { PaymentsClient } from "../clients/PaymentsClient.js"
import { OutboxEvent, OrderAuthorizedPayload } from "../domain/OutboxEvent.js"
import type { OrderLedger, OrderLedgerItem, OrderLedgerId, OrderLedgerStatus } from "../domain/OrderLedger.js"
import { InvalidPayloadError, type SagaStepError } from "../domain/errors.js"

type StepResult =
  | { readonly _tag: "StepSuccess"; readonly orderId?: string }
  | { readonly _tag: "StepFailed"; readonly result: SagaExecutionResult }

const handleStepError = (
  orderLedgerId: string, 
  currentStatus: OrderLedgerStatus,
  error: SagaStepError
): Effect.Effect<StepResult> =>
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
      } satisfies SagaRequiresCompensation
    } satisfies StepResult
  })

export const SagaExecutorLive = Layer.effect(
  SagaExecutor,
  Effect.gen(function* () {
    const ledgerRepo = yield* LedgerRepository
    const ordersClient = yield* OrdersClient
    const inventoryClient = yield* InventoryClient
    const paymentsClient = yield* PaymentsClient

    const executeSagaSteps = (
      ledger: OrderLedger,
      items: readonly OrderLedgerItem[],
      payload: OrderAuthorizedPayload
    ): Effect.Effect<SagaExecutionResult> =>
      Effect.gen(function* () {
        const orderLedgerId = ledger.id
        let currentStatus = ledger.status
        let orderId: string | null = ledger.orderId

        // Step 1: Create Order (if not already created)
        if (currentStatus === "AUTHORIZED") {
          yield* Effect.logInfo("Executing Step 1: Create Order", { orderLedgerId })

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
            Effect.catchAll((error) => handleStepError(orderLedgerId, error))
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
          yield* Effect.logInfo("Executing Step 2: Reserve Inventory", { orderLedgerId, orderId })

          const stepResult = yield* inventoryClient.reserveStock({
            orderId: orderId!,
            items: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity
            }))
          }).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError(orderLedgerId, currentStatus, error))
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
          yield* Effect.logInfo("Executing Step 3: Capture Payment", { orderLedgerId })

          const stepResult = yield* paymentsClient.capturePayment({
            authorizationId: payload.payment_authorization_id,
            idempotencyKey: `capture-${orderLedgerId}`
          }).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError(orderLedgerId, currentStatus, error))
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
          yield* Effect.logInfo("Executing Step 4: Confirm Order", { orderLedgerId, orderId })

          const stepResult = yield* ordersClient.confirmOrder(orderId!).pipe(
            Effect.map((): StepResult => ({ _tag: "StepSuccess" })),
            Effect.catchAll((error) => handleStepError(orderLedgerId, currentStatus, error))
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
      })

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
          const sagaResult = yield* executeSagaSteps(ledger, items, payload)

          return sagaResult
        }).pipe(
          Effect.withSpan("saga-execution", { attributes: { eventId: event.id } }),
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
