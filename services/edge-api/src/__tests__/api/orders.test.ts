import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { HttpServerResponse, HttpServerRequest } from "@effect/platform"
import { createOrder } from "../../api/orders.js"
import { OrderService, type CreateOrderResult } from "../../services/OrderService.js"
import { DuplicateRequestError, PaymentDeclinedError, PaymentGatewayError } from "../../domain/errors.js"

// Type for response body
interface OrderResponse {
  order_ledger_id?: string
  status?: string
  message?: string
  error?: string
  details?: string
  decline_code?: string
  is_retryable?: boolean
}

interface MockRequestOptions {
  headers?: Record<string, string>
  body?: unknown
}

// Valid order request body
const validRequestBody = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  email: "customer@example.com",
  items: [
    {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 2
    }
  ],
  payment: {
    method: "card",
    token: "tok_test_123"
  }
}

// Create mock OrderService layer
const createMockOrderService = (config: {
  shouldSucceed: boolean
  result?: CreateOrderResult
  error?: DuplicateRequestError | PaymentDeclinedError | PaymentGatewayError
}) => {
  return Layer.succeed(OrderService, {
    createOrder: () => {
      if (config.shouldSucceed && config.result) {
        return Effect.succeed(config.result)
      }
      if (config.error) {
        return Effect.fail(config.error)
      }
      return Effect.fail(new PaymentGatewayError({
        reason: "Unexpected mock error",
        isRetryable: false
      }))
    }
  })
}

// Create mock HttpServerRequest layer
const createMockRequest = (options: MockRequestOptions) => {
  const mockRequest = {
    headers: options.headers ?? {},
    json: Effect.succeed(options.body ?? {}),
    text: Effect.succeed(JSON.stringify(options.body ?? {})),
    urlParamsBody: Effect.succeed(new URLSearchParams())
  }

  return Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    mockRequest as unknown as HttpServerRequest.HttpServerRequest
  )
}

// Execute the createOrder effect and extract response data
const executeCreateOrder = async (
  orderServiceLayer: Layer.Layer<OrderService>,
  requestLayer: Layer.Layer<HttpServerRequest.HttpServerRequest>
): Promise<{ status: number; body: OrderResponse }> => {
  const program = Effect.gen(function* () {
    const response = yield* createOrder
    const status = response.status
    const webResponse = HttpServerResponse.toWeb(response)
    const body = yield* Effect.promise(() => webResponse.json() as Promise<OrderResponse>)
    return { status, body }
  })

  return program.pipe(
    Effect.provide(orderServiceLayer),
    Effect.provide(requestLayer),
    Effect.runPromise
  )
}

describe("POST /orders", () => {
  describe("successful order creation", () => {
    it("should return 202 with order_ledger_id when order is created successfully", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          status: "AUTHORIZED"
        }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(202)
      expect(result.body.order_ledger_id).toBe("550e8400-e29b-41d4-a716-446655440099")
      expect(result.body.status).toBe("AUTHORIZED")
      expect(result.body.message).toBe("Order received, processing")
    })
  })

  describe("missing Idempotency-Key header", () => {
    it("should return 400 when Idempotency-Key header is missing", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: {},
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("missing_idempotency_key")
      expect(result.body.message).toBe("Idempotency-Key header is required")
    })
  })

  describe("request validation errors", () => {
    it("should return 400 for invalid email format", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: {
          ...validRequestBody,
          email: "not-an-email"
        }
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for empty items array", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: {
          ...validRequestBody,
          items: []
        }
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for invalid product_id UUID", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: {
          ...validRequestBody,
          items: [{ product_id: "not-a-uuid", quantity: 1 }]
        }
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for negative quantity", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: {
          ...validRequestBody,
          items: [{ product_id: "550e8400-e29b-41d4-a716-446655440001", quantity: -1 }]
        }
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for empty payment token", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: { orderLedgerId: "test", status: "AUTHORIZED" }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: {
          ...validRequestBody,
          payment: { method: "card", token: "" }
        }
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })
  })

  describe("duplicate request handling", () => {
    it("should return 409 for duplicate request with existing order details", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: false,
        error: new DuplicateRequestError({
          clientRequestId: "unique-request-id-123",
          existingOrderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          existingStatus: "AUTHORIZED"
        })
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(409)
      expect(result.body.error).toBe("duplicate_request")
      expect(result.body.order_ledger_id).toBe("550e8400-e29b-41d4-a716-446655440099")
      expect(result.body.status).toBe("AUTHORIZED")
    })
  })

  describe("payment declined handling", () => {
    it("should return 402 when payment is declined", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: false,
        error: new PaymentDeclinedError({
          userId: "550e8400-e29b-41d4-a716-446655440000",
          amountCents: 2000,
          declineCode: "insufficient_funds",
          reason: "Card has insufficient funds",
          isRetryable: false
        })
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(402)
      expect(result.body.error).toBe("payment_declined")
      expect(result.body.decline_code).toBe("insufficient_funds")
      expect(result.body.message).toBe("Card has insufficient funds")
      expect(result.body.is_retryable).toBe(false)
    })

    it("should indicate retryable status for retryable declines", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: false,
        error: new PaymentDeclinedError({
          userId: "550e8400-e29b-41d4-a716-446655440000",
          amountCents: 2000,
          declineCode: "temporary_error",
          reason: "Please try again",
          isRetryable: true
        })
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(402)
      expect(result.body.is_retryable).toBe(true)
    })
  })

  describe("payment gateway errors", () => {
    it("should return 503 when payment gateway is unavailable", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: false,
        error: new PaymentGatewayError({
          reason: "Connection timeout",
          isRetryable: true
        })
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(503)
      expect(result.body.error).toBe("gateway_error")
      expect(result.body.message).toBe("Payment service temporarily unavailable")
      expect(result.body.is_retryable).toBe(true)
    })

    it("should indicate non-retryable for permanent gateway errors", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: false,
        error: new PaymentGatewayError({
          reason: "Invalid API key",
          isRetryable: false
        })
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.status).toBe(503)
      expect(result.body.is_retryable).toBe(false)
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response body", async () => {
      const orderServiceLayer = createMockOrderService({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          status: "AUTHORIZED"
        }
      })

      const requestLayer = createMockRequest({
        headers: { "idempotency-key": "unique-request-id-123" },
        body: validRequestBody
      })

      const result = await executeCreateOrder(orderServiceLayer, requestLayer)

      expect(result.body).toHaveProperty("order_ledger_id")
      expect(result.body).not.toHaveProperty("orderLedgerId")
    })
  })
})
