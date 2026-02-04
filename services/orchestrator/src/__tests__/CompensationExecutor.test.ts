import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { CompensationExecutor, type CompensationContext } from "../services/CompensationExecutor.js"
import { CompensationExecutorLive } from "../services/CompensationExecutorLive.js"
import { OrdersClient, type CancelOrderResult } from "../clients/OrdersClient.js"
import { InventoryClient, type ReleaseStockResult, type ReleaseStockParams } from "../clients/InventoryClient.js"
import { PaymentsClient, type VoidPaymentResult, type VoidPaymentParams } from "../clients/PaymentsClient.js"
import {
  OrderCancellationError,
  InventoryReleaseError,
  PaymentVoidError,
  ServiceConnectionError
} from "../domain/errors.js"

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const testVoidPaymentResult: VoidPaymentResult = {
  voidId: "void-123",
  authorizationId: "auth-456",
  status: "VOIDED",
  voidedAt: "2024-01-15T10:30:00Z"
}

const testReleaseStockResult: ReleaseStockResult = {
  orderId: "order-789",
  releasedCount: 2,
  totalQuantityRestored: 5
}

const testCancelOrderResult: CancelOrderResult = {
  orderId: "order-789",
  status: "CANCELLED"
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock Factories
// ═══════════════════════════════════════════════════════════════════════════

const createMockOrdersClient = (overrides: {
  cancelOrder?: (orderId: string) => Effect.Effect<CancelOrderResult, OrderCancellationError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(OrdersClient, {
    createOrder: () => Effect.succeed({ orderId: "order-789", status: "CREATED" }),
    confirmOrder: () => Effect.succeed({ orderId: "order-789", status: "CONFIRMED" }),
    cancelOrder: overrides.cancelOrder ?? (() => Effect.succeed(testCancelOrderResult))
  })
}

const createMockInventoryClient = (overrides: {
  releaseStock?: (params: ReleaseStockParams) => Effect.Effect<ReleaseStockResult, InventoryReleaseError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(InventoryClient, {
    reserveStock: () => Effect.succeed({ orderId: "order-789", reservationIds: ["res-1"], lineItemsReserved: 1, totalQuantityReserved: 2 }),
    releaseStock: overrides.releaseStock ?? (() => Effect.succeed(testReleaseStockResult))
  })
}

const createMockPaymentsClient = (overrides: {
  voidPayment?: (params: VoidPaymentParams) => Effect.Effect<VoidPaymentResult, PaymentVoidError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(PaymentsClient, {
    capturePayment: () => Effect.succeed({ captureId: "cap-123", authorizationId: "auth-456", status: "CAPTURED", amountCents: 5999, currency: "USD", capturedAt: "2024-01-15T10:30:00Z" }),
    voidPayment: overrides.voidPayment ?? (() => Effect.succeed(testVoidPaymentResult))
  })
}

const createTestLayer = (
  ordersClientOverrides: Parameters<typeof createMockOrdersClient>[0] = {},
  inventoryClientOverrides: Parameters<typeof createMockInventoryClient>[0] = {},
  paymentsClientOverrides: Parameters<typeof createMockPaymentsClient>[0] = {}
) => {
  return CompensationExecutorLive.pipe(
    Layer.provide(createMockOrdersClient(ordersClientOverrides)),
    Layer.provide(createMockInventoryClient(inventoryClientOverrides)),
    Layer.provide(createMockPaymentsClient(paymentsClientOverrides))
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("CompensationExecutor", () => {
  describe("executeCompensation - happy path", () => {
    it("should void payment and cancel order when last status is ORDER_CREATED", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "ORDER_CREATED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.orderLedgerId).toBe("ledger-123")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).toContain("cancel_order")
      expect(result.stepsExecuted).not.toContain("release_inventory")
    })

    it("should void payment, release inventory, and cancel order when last status is INVENTORY_RESERVED", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).toContain("release_inventory")
      expect(result.stepsExecuted).toContain("cancel_order")
    })

    it("should release inventory and cancel order (no void) when last status is PAYMENT_CAPTURED", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "PAYMENT_CAPTURED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).not.toContain("void_payment")
      expect(result.stepsExecuted).toContain("release_inventory")
      expect(result.stepsExecuted).toContain("cancel_order")
    })

    it("should only void payment when last status is AUTHORIZED (no order created)", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: null,
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "AUTHORIZED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).not.toContain("release_inventory")
      expect(result.stepsExecuted).not.toContain("cancel_order")
    })
  })

  describe("executeCompensation - idempotency", () => {
    it("should succeed when called twice (all operations idempotent)", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer()

      // First call
      const result1 = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      // Second call (idempotent)
      const result2 = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result1._tag).toBe("CompensationCompleted")
      expect(result2._tag).toBe("CompensationCompleted")
    })
  })

  describe("executeCompensation - partial failures", () => {
    it("should continue with other steps when void payment fails", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer(
        {},
        {},
        {
          voidPayment: () => Effect.fail(new PaymentVoidError({
            authorizationId: "auth-456",
            reason: "Gateway unavailable",
            statusCode: 503,
            isRetryable: true
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationFailed")
      // Even though void failed, other steps should have executed
      expect(result.stepsExecuted).toContain("release_inventory")
      expect(result.stepsExecuted).toContain("cancel_order")
      expect(result.stepsExecuted).not.toContain("void_payment")
      if (result._tag === "CompensationFailed") {
        expect(result.error).toContain("void_payment")
      }
    })

    it("should continue with other steps when release inventory fails", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer(
        {},
        {
          releaseStock: () => Effect.fail(new InventoryReleaseError({
            orderId: "order-789",
            reason: "Server error",
            statusCode: 500,
            isRetryable: true
          }))
        },
        {}
      )

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationFailed")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).toContain("cancel_order")
      expect(result.stepsExecuted).not.toContain("release_inventory")
    })

    it("should continue with other steps when cancel order fails", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer(
        {
          cancelOrder: () => Effect.fail(new OrderCancellationError({
            orderId: "order-789",
            reason: "Invalid status transition",
            statusCode: 409,
            isRetryable: false
          }))
        },
        {},
        {}
      )

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationFailed")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).toContain("release_inventory")
      expect(result.stepsExecuted).not.toContain("cancel_order")
    })

    it("should collect all errors when all steps fail", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "INVENTORY_RESERVED"
      }

      const testLayer = createTestLayer(
        {
          cancelOrder: () => Effect.fail(new OrderCancellationError({
            orderId: "order-789",
            reason: "Order not found",
            statusCode: 404,
            isRetryable: false
          }))
        },
        {
          releaseStock: () => Effect.fail(new InventoryReleaseError({
            orderId: "order-789",
            reason: "Server error",
            statusCode: 500,
            isRetryable: true
          }))
        },
        {
          voidPayment: () => Effect.fail(new PaymentVoidError({
            authorizationId: "auth-456",
            reason: "Already captured",
            statusCode: 409,
            isRetryable: false
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationFailed")
      expect(result.stepsExecuted).toHaveLength(0)
      if (result._tag === "CompensationFailed") {
        expect(result.error).toContain("void_payment")
        expect(result.error).toContain("release_inventory")
        expect(result.error).toContain("cancel_order")
      }
    })
  })

  describe("executeCompensation - edge cases", () => {
    it("should handle null orderId gracefully (no order cancel attempt)", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: null,
        paymentAuthorizationId: "auth-456",
        lastSuccessfulStatus: "ORDER_CREATED" // This shouldn't happen in practice, but handle gracefully
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).toContain("void_payment")
      expect(result.stepsExecuted).not.toContain("cancel_order")
    })

    it("should handle null paymentAuthorizationId gracefully (no void attempt)", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: "order-789",
        paymentAuthorizationId: null,
        lastSuccessfulStatus: "ORDER_CREATED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).not.toContain("void_payment")
      expect(result.stepsExecuted).toContain("cancel_order")
    })

    it("should do nothing for AUTHORIZED status with null paymentAuthorizationId", async () => {
      const context: CompensationContext = {
        orderLedgerId: "ledger-123",
        orderId: null,
        paymentAuthorizationId: null,
        lastSuccessfulStatus: "AUTHORIZED"
      }

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* CompensationExecutor
        return yield* executor.executeCompensation(context)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("CompensationCompleted")
      expect(result.stepsExecuted).toHaveLength(0)
    })
  })

  describe("CompensationExecutor interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(CompensationExecutor.key).toBe("CompensationExecutor")
    })
  })
})
