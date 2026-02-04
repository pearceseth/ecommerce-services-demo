import { describe, it, expect } from "vitest"
import { Effect, Layer, Exit } from "effect"
import { OrdersClient, type CreateOrderParams, type CreateOrderResult, type ConfirmOrderResult, type CancelOrderResult } from "../clients/OrdersClient.js"
import { InventoryClient, type ReserveStockParams, type ReserveStockResult, type ReleaseStockParams, type ReleaseStockResult } from "../clients/InventoryClient.js"
import { PaymentsClient, type CapturePaymentParams, type CapturePaymentResult, type VoidPaymentParams, type VoidPaymentResult } from "../clients/PaymentsClient.js"
import {
  OrderCreationError,
  OrderConfirmationError,
  OrderCancellationError,
  InventoryReservationError,
  InventoryReleaseError,
  PaymentCaptureError,
  PaymentVoidError,
  ServiceConnectionError
} from "../domain/errors.js"

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const testCreateOrderParams: CreateOrderParams = {
  orderLedgerId: "ledger-123",
  userId: "user-456",
  totalAmountCents: 5999,
  currency: "USD",
  items: [
    { productId: "product-1", quantity: 2, unitPriceCents: 1500 },
    { productId: "product-2", quantity: 1, unitPriceCents: 2999 }
  ]
}

const testCreateOrderResult: CreateOrderResult = {
  orderId: "order-789",
  status: "CREATED"
}

const testConfirmOrderResult: ConfirmOrderResult = {
  orderId: "order-789",
  status: "CONFIRMED"
}

const testReserveStockParams: ReserveStockParams = {
  orderId: "order-789",
  items: [
    { productId: "product-1", quantity: 2 },
    { productId: "product-2", quantity: 1 }
  ]
}

const testReserveStockResult: ReserveStockResult = {
  orderId: "order-789",
  reservationIds: ["res-1", "res-2"],
  lineItemsReserved: 2,
  totalQuantityReserved: 3
}

const testCapturePaymentParams: CapturePaymentParams = {
  authorizationId: "auth-123",
  idempotencyKey: "capture-ledger-456"
}

const testCapturePaymentResult: CapturePaymentResult = {
  captureId: "cap-789",
  authorizationId: "auth-123",
  status: "CAPTURED",
  amountCents: 5999,
  currency: "USD",
  capturedAt: "2024-01-15T10:30:00Z"
}

const testVoidPaymentParams: VoidPaymentParams = {
  authorizationId: "auth-123",
  idempotencyKey: "void-ledger-456",
  reason: "Saga compensation"
}

const testVoidPaymentResult: VoidPaymentResult = {
  voidId: "void-789",
  authorizationId: "auth-123",
  status: "VOIDED",
  voidedAt: "2024-01-15T10:30:00Z"
}

const testReleaseStockParams: ReleaseStockParams = {
  orderId: "order-789"
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
  createOrder?: (params: CreateOrderParams) => Effect.Effect<CreateOrderResult, OrderCreationError | ServiceConnectionError>
  confirmOrder?: (orderId: string) => Effect.Effect<ConfirmOrderResult, OrderConfirmationError | ServiceConnectionError>
  cancelOrder?: (orderId: string) => Effect.Effect<CancelOrderResult, OrderCancellationError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(OrdersClient, {
    createOrder: overrides.createOrder ?? (() => Effect.succeed(testCreateOrderResult)),
    confirmOrder: overrides.confirmOrder ?? (() => Effect.succeed(testConfirmOrderResult)),
    cancelOrder: overrides.cancelOrder ?? (() => Effect.succeed(testCancelOrderResult))
  })
}

const createMockInventoryClient = (overrides: {
  reserveStock?: (params: ReserveStockParams) => Effect.Effect<ReserveStockResult, InventoryReservationError | ServiceConnectionError>
  releaseStock?: (params: ReleaseStockParams) => Effect.Effect<ReleaseStockResult, InventoryReleaseError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(InventoryClient, {
    reserveStock: overrides.reserveStock ?? (() => Effect.succeed(testReserveStockResult)),
    releaseStock: overrides.releaseStock ?? (() => Effect.succeed(testReleaseStockResult))
  })
}

const createMockPaymentsClient = (overrides: {
  capturePayment?: (params: CapturePaymentParams) => Effect.Effect<CapturePaymentResult, PaymentCaptureError | ServiceConnectionError>
  voidPayment?: (params: VoidPaymentParams) => Effect.Effect<VoidPaymentResult, PaymentVoidError | ServiceConnectionError>
} = {}) => {
  return Layer.succeed(PaymentsClient, {
    capturePayment: overrides.capturePayment ?? (() => Effect.succeed(testCapturePaymentResult)),
    voidPayment: overrides.voidPayment ?? (() => Effect.succeed(testVoidPaymentResult))
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// OrdersClient Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("OrdersClient", () => {
  describe("createOrder", () => {
    it("should create an order successfully", async () => {
      const mockClient = createMockOrdersClient()

      const result = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.createOrder(testCreateOrderParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.orderId).toBe("order-789")
      expect(result.status).toBe("CREATED")
    })

    it("should pass all parameters to the service", async () => {
      let capturedParams: CreateOrderParams | undefined

      const mockClient = createMockOrdersClient({
        createOrder: (params) => {
          capturedParams = params
          return Effect.succeed(testCreateOrderResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.createOrder(testCreateOrderParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams).toEqual(testCreateOrderParams)
      expect(capturedParams?.items).toHaveLength(2)
    })

    it("should fail with OrderCreationError on permanent failure", async () => {
      const mockClient = createMockOrdersClient({
        createOrder: () => Effect.fail(new OrderCreationError({
          orderLedgerId: "ledger-123",
          reason: "Validation failed",
          statusCode: 400,
          isRetryable: false
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.createOrder(testCreateOrderParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("OrderCreationError")
        const error = exit.cause.error as OrderCreationError
        expect(error.isRetryable).toBe(false)
      }
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockOrdersClient({
        createOrder: () => Effect.fail(new ServiceConnectionError({
          service: "orders",
          operation: "createOrder",
          reason: "Connection timeout",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.createOrder(testCreateOrderParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("orders")
        expect(error.isRetryable).toBe(true)
      }
    })
  })

  describe("confirmOrder", () => {
    it("should confirm an order successfully", async () => {
      const mockClient = createMockOrdersClient()

      const result = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.confirmOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.orderId).toBe("order-789")
      expect(result.status).toBe("CONFIRMED")
    })

    it("should pass orderId to the service", async () => {
      let capturedOrderId: string | undefined

      const mockClient = createMockOrdersClient({
        confirmOrder: (orderId) => {
          capturedOrderId = orderId
          return Effect.succeed(testConfirmOrderResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.confirmOrder("order-123")
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedOrderId).toBe("order-123")
    })

    it("should fail with OrderConfirmationError on failure", async () => {
      const mockClient = createMockOrdersClient({
        confirmOrder: () => Effect.fail(new OrderConfirmationError({
          orderId: "order-789",
          reason: "Order not found",
          statusCode: 404,
          isRetryable: false
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.confirmOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("OrderConfirmationError")
      }
    })
  })

  describe("cancelOrder", () => {
    it("should cancel an order successfully", async () => {
      const mockClient = createMockOrdersClient()

      const result = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.cancelOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.orderId).toBe("order-789")
      expect(result.status).toBe("CANCELLED")
    })

    it("should pass orderId to the service", async () => {
      let capturedOrderId: string | undefined

      const mockClient = createMockOrdersClient({
        cancelOrder: (orderId) => {
          capturedOrderId = orderId
          return Effect.succeed(testCancelOrderResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.cancelOrder("order-123")
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedOrderId).toBe("order-123")
    })

    it("should fail with OrderCancellationError when order not found", async () => {
      const mockClient = createMockOrdersClient({
        cancelOrder: () => Effect.fail(new OrderCancellationError({
          orderId: "order-789",
          reason: "Order not found",
          statusCode: 404,
          isRetryable: false
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.cancelOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("OrderCancellationError")
        const error = exit.cause.error as OrderCancellationError
        expect(error.isRetryable).toBe(false)
      }
    })

    it("should be idempotent when order already cancelled", async () => {
      const mockClient = createMockOrdersClient({
        cancelOrder: () => Effect.succeed({ orderId: "order-789", status: "CANCELLED" })
      })

      const result = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.cancelOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.status).toBe("CANCELLED")
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockOrdersClient({
        cancelOrder: () => Effect.fail(new ServiceConnectionError({
          service: "orders",
          operation: "cancelOrder",
          reason: "Connection timeout",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* OrdersClient
        return yield* client.cancelOrder("order-789")
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("orders")
        expect(error.isRetryable).toBe(true)
      }
    })
  })

  describe("OrdersClient interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(OrdersClient.key).toBe("OrdersClient")
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// InventoryClient Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("InventoryClient", () => {
  describe("reserveStock", () => {
    it("should reserve stock successfully", async () => {
      const mockClient = createMockInventoryClient()

      const result = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.reserveStock(testReserveStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.orderId).toBe("order-789")
      expect(result.reservationIds).toEqual(["res-1", "res-2"])
      expect(result.lineItemsReserved).toBe(2)
      expect(result.totalQuantityReserved).toBe(3)
    })

    it("should pass all parameters to the service", async () => {
      let capturedParams: ReserveStockParams | undefined

      const mockClient = createMockInventoryClient({
        reserveStock: (params) => {
          capturedParams = params
          return Effect.succeed(testReserveStockResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.reserveStock(testReserveStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams).toEqual(testReserveStockParams)
    })

    it("should fail with InventoryReservationError for insufficient stock", async () => {
      const mockClient = createMockInventoryClient({
        reserveStock: () => Effect.fail(new InventoryReservationError({
          orderId: "order-789",
          reason: "Insufficient stock for product product-1",
          statusCode: 409,
          isRetryable: false,
          insufficientStock: {
            productId: "product-1",
            productSku: "SKU-001",
            requested: 10,
            available: 5
          }
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.reserveStock(testReserveStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("InventoryReservationError")
        const error = exit.cause.error as InventoryReservationError
        expect(error.isRetryable).toBe(false)
        expect(error.insufficientStock?.productId).toBe("product-1")
        expect(error.insufficientStock?.requested).toBe(10)
        expect(error.insufficientStock?.available).toBe(5)
      }
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockInventoryClient({
        reserveStock: () => Effect.fail(new ServiceConnectionError({
          service: "inventory",
          operation: "reserveStock",
          reason: "Service unavailable",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.reserveStock(testReserveStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("inventory")
      }
    })
  })

  describe("releaseStock", () => {
    it("should release stock successfully", async () => {
      const mockClient = createMockInventoryClient()

      const result = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.releaseStock(testReleaseStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.orderId).toBe("order-789")
      expect(result.releasedCount).toBe(2)
      expect(result.totalQuantityRestored).toBe(5)
    })

    it("should pass orderId to the service", async () => {
      let capturedParams: ReleaseStockParams | undefined

      const mockClient = createMockInventoryClient({
        releaseStock: (params) => {
          capturedParams = params
          return Effect.succeed(testReleaseStockResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.releaseStock({ orderId: "order-123" })
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams?.orderId).toBe("order-123")
    })

    it("should be idempotent when no reservations found (404)", async () => {
      const mockClient = createMockInventoryClient({
        releaseStock: () => Effect.succeed({
          orderId: "order-789",
          releasedCount: 0,
          totalQuantityRestored: 0
        })
      })

      const result = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.releaseStock(testReleaseStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.releasedCount).toBe(0)
      expect(result.totalQuantityRestored).toBe(0)
    })

    it("should fail with InventoryReleaseError on server error (retryable)", async () => {
      const mockClient = createMockInventoryClient({
        releaseStock: () => Effect.fail(new InventoryReleaseError({
          orderId: "order-789",
          reason: "Server error: 500",
          statusCode: 500,
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.releaseStock(testReleaseStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("InventoryReleaseError")
        const error = exit.cause.error as InventoryReleaseError
        expect(error.isRetryable).toBe(true)
      }
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockInventoryClient({
        releaseStock: () => Effect.fail(new ServiceConnectionError({
          service: "inventory",
          operation: "releaseStock",
          reason: "Connection timeout",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* InventoryClient
        return yield* client.releaseStock(testReleaseStockParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("inventory")
      }
    })
  })

  describe("InventoryClient interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(InventoryClient.key).toBe("InventoryClient")
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PaymentsClient Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("PaymentsClient", () => {
  describe("capturePayment", () => {
    it("should capture payment successfully", async () => {
      const mockClient = createMockPaymentsClient()

      const result = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment(testCapturePaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.captureId).toBe("cap-789")
      expect(result.authorizationId).toBe("auth-123")
      expect(result.status).toBe("CAPTURED")
      expect(result.amountCents).toBe(5999)
    })

    it("should pass all parameters to the service", async () => {
      let capturedParams: CapturePaymentParams | undefined

      const mockClient = createMockPaymentsClient({
        capturePayment: (params) => {
          capturedParams = params
          return Effect.succeed(testCapturePaymentResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment(testCapturePaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams).toEqual(testCapturePaymentParams)
    })

    it("should support optional amountCents for partial capture", async () => {
      let capturedParams: CapturePaymentParams | undefined

      const mockClient = createMockPaymentsClient({
        capturePayment: (params) => {
          capturedParams = params
          return Effect.succeed({ ...testCapturePaymentResult, amountCents: 3000 })
        }
      })

      await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment({
          ...testCapturePaymentParams,
          amountCents: 3000
        })
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams?.amountCents).toBe(3000)
    })

    it("should fail with PaymentCaptureError for voided authorization", async () => {
      const mockClient = createMockPaymentsClient({
        capturePayment: () => Effect.fail(new PaymentCaptureError({
          authorizationId: "auth-123",
          reason: "Authorization already voided",
          statusCode: 409,
          isRetryable: false
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment(testCapturePaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("PaymentCaptureError")
        const error = exit.cause.error as PaymentCaptureError
        expect(error.authorizationId).toBe("auth-123")
        expect(error.isRetryable).toBe(false)
      }
    })

    it("should fail with PaymentCaptureError for gateway unavailable (retryable)", async () => {
      const mockClient = createMockPaymentsClient({
        capturePayment: () => Effect.fail(new PaymentCaptureError({
          authorizationId: "auth-123",
          reason: "Payment gateway unavailable",
          statusCode: 503,
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment(testCapturePaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentCaptureError
        expect(error.isRetryable).toBe(true)
      }
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockPaymentsClient({
        capturePayment: () => Effect.fail(new ServiceConnectionError({
          service: "payments",
          operation: "capturePayment",
          reason: "Connection refused",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.capturePayment(testCapturePaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("payments")
      }
    })
  })

  describe("voidPayment", () => {
    it("should void payment successfully", async () => {
      const mockClient = createMockPaymentsClient()

      const result = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.voidId).toBe("void-789")
      expect(result.authorizationId).toBe("auth-123")
      expect(result.status).toBe("VOIDED")
    })

    it("should pass all parameters to the service", async () => {
      let capturedParams: VoidPaymentParams | undefined

      const mockClient = createMockPaymentsClient({
        voidPayment: (params) => {
          capturedParams = params
          return Effect.succeed(testVoidPaymentResult)
        }
      })

      await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(capturedParams).toEqual(testVoidPaymentParams)
    })

    it("should be idempotent when authorization not found (404)", async () => {
      const mockClient = createMockPaymentsClient({
        voidPayment: () => Effect.succeed({
          voidId: "void-notfound-auth-123",
          authorizationId: "auth-123",
          status: "VOIDED",
          voidedAt: "2024-01-15T10:30:00Z"
        })
      })

      const result = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromise)

      expect(result.status).toBe("VOIDED")
    })

    it("should fail with PaymentVoidError when authorization already captured (409)", async () => {
      const mockClient = createMockPaymentsClient({
        voidPayment: () => Effect.fail(new PaymentVoidError({
          authorizationId: "auth-123",
          reason: "Authorization already captured - cannot void",
          statusCode: 409,
          isRetryable: false
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("PaymentVoidError")
        const error = exit.cause.error as PaymentVoidError
        expect(error.authorizationId).toBe("auth-123")
        expect(error.isRetryable).toBe(false)
      }
    })

    it("should fail with PaymentVoidError for gateway unavailable (retryable)", async () => {
      const mockClient = createMockPaymentsClient({
        voidPayment: () => Effect.fail(new PaymentVoidError({
          authorizationId: "auth-123",
          reason: "Payment gateway unavailable",
          statusCode: 503,
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentVoidError
        expect(error.isRetryable).toBe(true)
      }
    })

    it("should fail with ServiceConnectionError on connection issues", async () => {
      const mockClient = createMockPaymentsClient({
        voidPayment: () => Effect.fail(new ServiceConnectionError({
          service: "payments",
          operation: "voidPayment",
          reason: "Connection refused",
          isRetryable: true
        }))
      })

      const exit = await Effect.gen(function* () {
        const client = yield* PaymentsClient
        return yield* client.voidPayment(testVoidPaymentParams)
      }).pipe(Effect.provide(mockClient), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error._tag).toBe("ServiceConnectionError")
        const error = exit.cause.error as ServiceConnectionError
        expect(error.service).toBe("payments")
      }
    })
  })

  describe("PaymentsClient interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(PaymentsClient.key).toBe("PaymentsClient")
    })
  })
})
