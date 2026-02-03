import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime } from "effect"
import { SagaExecutor } from "../services/SagaExecutor.js"
import { SagaExecutorLive } from "../services/SagaExecutorLive.js"
import { LedgerRepository, type LedgerWithItems } from "../repositories/LedgerRepository.js"
import { OrdersClient, type CreateOrderParams, type CreateOrderResult, type ConfirmOrderResult } from "../clients/OrdersClient.js"
import { InventoryClient, type ReserveStockParams, type ReserveStockResult } from "../clients/InventoryClient.js"
import { PaymentsClient, type CapturePaymentParams, type CapturePaymentResult } from "../clients/PaymentsClient.js"
import { OutboxEvent, type OutboxEventId } from "../domain/OutboxEvent.js"
import { OrderLedger, OrderLedgerItem, type OrderLedgerId, type OrderLedgerStatus, type UserId, type ProductId } from "../domain/OrderLedger.js"
import {
  OrderCreationError,
  InventoryReservationError,
  PaymentCaptureError,
  ServiceConnectionError
} from "../domain/errors.js"

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const createTestOutboxEvent = (ledgerId: string): OutboxEvent => {
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
    processedAt: null
  })
}

const createTestLedger = (
  id: string,
  status: OrderLedgerStatus = "AUTHORIZED",
  orderId: string | null = null
): OrderLedger => {
  const now = DateTime.unsafeNow()
  return new OrderLedger({
    id: id as OrderLedgerId,
    clientRequestId: `client-req-${id}`,
    userId: "user-123" as UserId,
    email: "test@example.com",
    status,
    totalAmountCents: 5999,
    currency: "USD",
    paymentAuthorizationId: "auth-456",
    orderId,
    retryCount: 0,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now
  })
}

const createTestItem = (id: string, ledgerId: string): OrderLedgerItem => {
  const now = DateTime.unsafeNow()
  return new OrderLedgerItem({
    id,
    orderLedgerId: ledgerId as OrderLedgerId,
    productId: `product-${id}` as ProductId,
    quantity: 2,
    unitPriceCents: 1500,
    createdAt: now
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock Factories
// ═══════════════════════════════════════════════════════════════════════════

const createMockLedgerRepo = (overrides: {
  findByIdWithItems?: (id: OrderLedgerId) => Effect.Effect<Option.Option<LedgerWithItems>>
  updateStatus?: (id: OrderLedgerId, newStatus: OrderLedgerStatus) => Effect.Effect<OrderLedger>
  updateStatusWithOrderId?: (id: OrderLedgerId, newStatus: OrderLedgerStatus, orderId: string) => Effect.Effect<OrderLedger>
} = {}) => {
  return Layer.succeed(LedgerRepository, {
    findByIdWithItems: overrides.findByIdWithItems ?? (() => Effect.succeed(Option.none())),
    updateStatus: overrides.updateStatus ?? ((id, status) => Effect.succeed(createTestLedger(id, status))),
    updateStatusWithOrderId: overrides.updateStatusWithOrderId ?? ((id, status, orderId) => Effect.succeed(createTestLedger(id, status, orderId)))
  })
}

const createMockOrdersClient = (overrides: {
  createOrder?: (params: CreateOrderParams) => Effect.Effect<CreateOrderResult, OrderCreationError | ServiceConnectionError>
  confirmOrder?: (orderId: string) => Effect.Effect<ConfirmOrderResult, any>
} = {}) => {
  return Layer.succeed(OrdersClient, {
    createOrder: overrides.createOrder ?? (() => Effect.succeed({ orderId: "order-789", status: "CREATED" })),
    confirmOrder: overrides.confirmOrder ?? (() => Effect.succeed({ orderId: "order-789", status: "CONFIRMED" }))
  })
}

const createMockInventoryClient = (overrides: {
  reserveStock?: (params: ReserveStockParams) => Effect.Effect<ReserveStockResult, InventoryReservationError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(InventoryClient, {
    reserveStock: overrides.reserveStock ?? (() => Effect.succeed({
      orderId: "order-789",
      reservationIds: ["res-1"],
      lineItemsReserved: 1,
      totalQuantityReserved: 2
    }))
  })
}

const createMockPaymentsClient = (overrides: {
  capturePayment?: (params: CapturePaymentParams) => Effect.Effect<CapturePaymentResult, PaymentCaptureError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(PaymentsClient, {
    capturePayment: overrides.capturePayment ?? (() => Effect.succeed({
      captureId: "cap-123",
      authorizationId: "auth-456",
      status: "CAPTURED",
      amountCents: 5999,
      currency: "USD",
      capturedAt: "2024-01-15T10:30:00Z"
    }))
  })
}

const createTestLayer = (
  ledgerRepoOverrides: Parameters<typeof createMockLedgerRepo>[0] = {},
  ordersClientOverrides: Parameters<typeof createMockOrdersClient>[0] = {},
  inventoryClientOverrides: Parameters<typeof createMockInventoryClient>[0] = {},
  paymentsClientOverrides: Parameters<typeof createMockPaymentsClient>[0] = {}
) => {
  return SagaExecutorLive.pipe(
    Layer.provide(createMockLedgerRepo(ledgerRepoOverrides)),
    Layer.provide(createMockOrdersClient(ordersClientOverrides)),
    Layer.provide(createMockInventoryClient(inventoryClientOverrides)),
    Layer.provide(createMockPaymentsClient(paymentsClientOverrides))
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("SagaExecutor", () => {
  describe("executeSaga - happy path", () => {
    it("should execute all 4 saga steps successfully from AUTHORIZED status", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "AUTHORIZED")
      const items = [createTestItem("item-1", ledgerId)]
      const statusUpdates: { id: string; status: OrderLedgerStatus }[] = []

      const testLayer = createTestLayer(
        {
          findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })),
          updateStatus: (id, status) => {
            statusUpdates.push({ id, status })
            return Effect.succeed(createTestLedger(id, status))
          },
          updateStatusWithOrderId: (id, status, orderId) => {
            statusUpdates.push({ id, status })
            return Effect.succeed(createTestLedger(id, status, orderId))
          }
        },
        { createOrder: () => Effect.succeed({ orderId: "order-789", status: "CREATED" }) },
        { reserveStock: () => Effect.succeed({ orderId: "order-789", reservationIds: ["res-1"], lineItemsReserved: 1, totalQuantityReserved: 2 }) },
        { capturePayment: () => Effect.succeed({ captureId: "cap-123", authorizationId: "auth-456", status: "CAPTURED", amountCents: 5999, currency: "USD", capturedAt: "2024-01-15T10:30:00Z" }) }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Completed")
      expect(result.orderLedgerId).toBe(ledgerId)
      expect(result.finalStatus).toBe("COMPLETED")

      // Verify all status transitions happened
      expect(statusUpdates.map(u => u.status)).toContain("ORDER_CREATED")
      expect(statusUpdates.map(u => u.status)).toContain("INVENTORY_RESERVED")
      expect(statusUpdates.map(u => u.status)).toContain("PAYMENT_CAPTURED")
      expect(statusUpdates.map(u => u.status)).toContain("COMPLETED")
    })

    it("should be idempotent for already completed saga", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "COMPLETED", "order-789")

      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] }))
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Completed")
      expect(result.finalStatus).toBe("COMPLETED")
    })

    it("should resume from ORDER_CREATED status", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "ORDER_CREATED", "order-789")
      const items = [createTestItem("item-1", ledgerId)]
      const statusUpdates: OrderLedgerStatus[] = []

      const testLayer = createTestLayer(
        {
          findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })),
          updateStatus: (id, status) => {
            statusUpdates.push(status)
            return Effect.succeed(createTestLedger(id, status))
          }
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Completed")
      // Should not include ORDER_CREATED since we started from there
      expect(statusUpdates).toContain("INVENTORY_RESERVED")
      expect(statusUpdates).toContain("PAYMENT_CAPTURED")
      expect(statusUpdates).toContain("COMPLETED")
    })

    it("should resume from INVENTORY_RESERVED status", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "INVENTORY_RESERVED", "order-789")
      const statusUpdates: OrderLedgerStatus[] = []

      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] })),
        updateStatus: (id, status) => {
          statusUpdates.push(status)
          return Effect.succeed(createTestLedger(id, status))
        }
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Completed")
      expect(statusUpdates).toContain("PAYMENT_CAPTURED")
      expect(statusUpdates).toContain("COMPLETED")
      expect(statusUpdates).not.toContain("ORDER_CREATED")
      expect(statusUpdates).not.toContain("INVENTORY_RESERVED")
    })

    it("should resume from PAYMENT_CAPTURED status", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "PAYMENT_CAPTURED", "order-789")
      const statusUpdates: OrderLedgerStatus[] = []

      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] })),
        updateStatus: (id, status) => {
          statusUpdates.push(status)
          return Effect.succeed(createTestLedger(id, status))
        }
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Completed")
      expect(statusUpdates).toEqual(["COMPLETED"])
    })
  })

  describe("executeSaga - error handling", () => {
    it("should return Failed when ledger not found", async () => {
      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.none())
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent("nonexistent"))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Failed")
      if (result._tag === "Failed") {
        expect(result.error).toContain("not found")
      }
    })

    it("should return Failed when saga is in FAILED state", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "FAILED")

      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] }))
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Failed")
      expect(result.finalStatus).toBe("FAILED")
    })

    it("should return Failed when saga is in COMPENSATING state", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "COMPENSATING")

      const testLayer = createTestLayer({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] }))
      })

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Failed")
      expect(result.finalStatus).toBe("COMPENSATING")
    })

    it("should return Failed for invalid payload", async () => {
      const event = new OutboxEvent({
        id: "event-123" as OutboxEventId,
        aggregateType: "OrderLedger",
        aggregateId: "ledger-123",
        eventType: "OrderAuthorized",
        payload: { invalid: "payload" }, // Missing required fields
        status: "PENDING",
        createdAt: DateTime.unsafeNow(),
        processedAt: null
      })

      const testLayer = createTestLayer()

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(event)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Failed")
      if (result._tag === "Failed") {
        expect(result.error).toBeDefined()
      }
    })
  })

  describe("executeSaga - retryable errors", () => {
    it("should return RequiresRetry for retryable OrderCreationError", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "AUTHORIZED")
      const items = [createTestItem("item-1", ledgerId)]

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })) },
        {
          createOrder: () => Effect.fail(new OrderCreationError({
            orderLedgerId: ledgerId,
            reason: "Server error",
            statusCode: 500,
            isRetryable: true
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresRetry")
      if (result._tag === "RequiresRetry") {
        expect(result.error).toBe("OrderCreationError")
      }
    })

    it("should return RequiresRetry for ServiceConnectionError", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "ORDER_CREATED", "order-789")
      const items = [createTestItem("item-1", ledgerId)]

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })) },
        {},
        {
          reserveStock: () => Effect.fail(new ServiceConnectionError({
            service: "inventory",
            operation: "reserveStock",
            reason: "Connection timeout",
            isRetryable: true
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresRetry")
      if (result._tag === "RequiresRetry") {
        expect(result.error).toBe("ServiceConnectionError")
      }
    })

    it("should return RequiresRetry for retryable PaymentCaptureError (503)", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "INVENTORY_RESERVED", "order-789")

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] })) },
        {},
        {},
        {
          capturePayment: () => Effect.fail(new PaymentCaptureError({
            authorizationId: "auth-456",
            reason: "Gateway unavailable",
            statusCode: 503,
            isRetryable: true
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresRetry")
      if (result._tag === "RequiresRetry") {
        expect(result.error).toBe("PaymentCaptureError")
      }
    })
  })

  describe("executeSaga - permanent errors requiring compensation", () => {
    it("should return RequiresCompensation for non-retryable OrderCreationError", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "AUTHORIZED")
      const items = [createTestItem("item-1", ledgerId)]

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })) },
        {
          createOrder: () => Effect.fail(new OrderCreationError({
            orderLedgerId: ledgerId,
            reason: "Validation failed",
            statusCode: 400,
            isRetryable: false
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresCompensation")
      if (result._tag === "RequiresCompensation") {
        expect(result.error).toBe("OrderCreationError")
      }
    })

    it("should return RequiresCompensation for insufficient stock", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "ORDER_CREATED", "order-789")
      const items = [createTestItem("item-1", ledgerId)]

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items })) },
        {},
        {
          reserveStock: () => Effect.fail(new InventoryReservationError({
            orderId: "order-789",
            reason: "Insufficient stock",
            statusCode: 409,
            isRetryable: false,
            insufficientStock: {
              productId: "product-1",
              requested: 10,
              available: 5
            }
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresCompensation")
      if (result._tag === "RequiresCompensation") {
        expect(result.error).toBe("InventoryReservationError")
      }
    })

    it("should return RequiresCompensation for voided authorization", async () => {
      const ledgerId = "ledger-123"
      const ledger = createTestLedger(ledgerId, "INVENTORY_RESERVED", "order-789")

      const testLayer = createTestLayer(
        { findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] })) },
        {},
        {},
        {
          capturePayment: () => Effect.fail(new PaymentCaptureError({
            authorizationId: "auth-456",
            reason: "Authorization already voided",
            statusCode: 409,
            isRetryable: false
          }))
        }
      )

      const result = await Effect.gen(function* () {
        const executor = yield* SagaExecutor
        return yield* executor.executeSaga(createTestOutboxEvent(ledgerId))
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("RequiresCompensation")
      if (result._tag === "RequiresCompensation") {
        expect(result.error).toBe("PaymentCaptureError")
      }
    })
  })

  describe("SagaExecutor interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(SagaExecutor.key).toBe("SagaExecutor")
    })
  })
})
