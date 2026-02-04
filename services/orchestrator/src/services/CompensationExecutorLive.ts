import { Layer, Effect } from "effect"
import { CompensationExecutor, type CompensationContext, type CompensationResult } from "./CompensationExecutor.js"
import { OrdersClient } from "../clients/OrdersClient.js"
import { InventoryClient } from "../clients/InventoryClient.js"
import { PaymentsClient } from "../clients/PaymentsClient.js"

export const CompensationExecutorLive = Layer.effect(
  CompensationExecutor,
  Effect.gen(function* () {
    const ordersClient = yield* OrdersClient
    const inventoryClient = yield* InventoryClient
    const paymentsClient = yield* PaymentsClient

    const executeCompensation = (ctx: CompensationContext): Effect.Effect<CompensationResult> =>
      Effect.gen(function* () {
        const stepsExecuted: string[] = []
        const errors: string[] = []
        const { lastSuccessfulStatus, orderLedgerId, orderId, paymentAuthorizationId } = ctx

        yield* Effect.logInfo("Starting compensation", {
          orderLedgerId,
          lastSuccessfulStatus,
          orderId,
          paymentAuthorizationId
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
          yield* Effect.logInfo("Compensation: Voiding payment", { authorizationId: paymentAuthorizationId })
          yield* paymentsClient.voidPayment({
            authorizationId: paymentAuthorizationId!,
            idempotencyKey: `void-${orderLedgerId}`,
            reason: "Saga compensation"
          }).pipe(
            Effect.tap(() => {
              stepsExecuted.push("void_payment")
              return Effect.logInfo("Compensation: Payment voided successfully", { authorizationId: paymentAuthorizationId })
            }),
            Effect.catchAll((error) => {
              errors.push(`void_payment: ${error._tag}`)
              return Effect.logError("Compensation: Failed to void payment", { error: error._tag, authorizationId: paymentAuthorizationId })
            })
          )
        }

        // Step 2: Release inventory reservation (if applicable)
        if (requiresInventoryRelease && orderId) {
          yield* Effect.logInfo("Compensation: Releasing inventory", { orderId })
          yield* inventoryClient.releaseStock({ orderId }).pipe(
            Effect.tap(() => {
              stepsExecuted.push("release_inventory")
              return Effect.logInfo("Compensation: Inventory released successfully", { orderId })
            }),
            Effect.catchAll((error) => {
              errors.push(`release_inventory: ${error._tag}`)
              return Effect.logError("Compensation: Failed to release inventory", { error: error._tag, orderId })
            })
          )
        }

        // Step 3: Cancel order (if applicable)
        if (requiresOrderCancel && orderId) {
          yield* Effect.logInfo("Compensation: Cancelling order", { orderId })
          yield* ordersClient.cancelOrder(orderId).pipe(
            Effect.tap(() => {
              stepsExecuted.push("cancel_order")
              return Effect.logInfo("Compensation: Order cancelled successfully", { orderId })
            }),
            Effect.catchAll((error) => {
              errors.push(`cancel_order: ${error._tag}`)
              return Effect.logError("Compensation: Failed to cancel order", { error: error._tag, orderId })
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
