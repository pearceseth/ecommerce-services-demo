import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { HttpServerResponse, HttpServerRequest, HttpRouter } from "@effect/platform"
import { createOrder, getOrderStatus } from "../../api/orders.js"
import { OrderService, type CreateOrderResult, type OrderStatusResult } from "../../services/OrderService.js"
import { DuplicateRequestError, PaymentDeclinedError, PaymentGatewayError, OrderLedgerNotFoundError } from "../../domain/errors.js"

// Type for POST response body
interface OrderResponse {
  order_ledger_id?: string
  status?: string
  message?: string
  error?: string
  details?: string
  decline_code?: string
  is_retryable?: boolean
}

// Type for GET response body
interface GetOrderStatusResponse {
  order_ledger_id?: string
  client_request_id?: string
  status?: string
  user_id?: string
  email?: string
  total_amount_cents?: number
  currency?: string
  payment_authorization_id?: string | null
  created_at?: string
  updated_at?: string
  items?: Array<{
    product_id: string
    quantity: number
    unit_price_cents: number
  }>
  error?: string
  message?: string
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

// Create mock OrderService layer for POST /orders
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
    },
    getOrderStatus: () => Effect.fail(new OrderLedgerNotFoundError({ orderLedgerId: "not-used" }))
  })
}

// Create mock OrderService layer for GET /orders/:order_ledger_id
const createMockOrderServiceForGet = (config: {
  shouldSucceed: boolean
  result?: OrderStatusResult
  error?: OrderLedgerNotFoundError
}) => {
  return Layer.succeed(OrderService, {
    createOrder: () => Effect.fail(new PaymentGatewayError({ reason: "not-used", isRetryable: false })),
    getOrderStatus: () => {
      if (config.shouldSucceed && config.result) {
        return Effect.succeed(config.result)
      }
      if (config.error) {
        return Effect.fail(config.error)
      }
      return Effect.fail(new OrderLedgerNotFoundError({ orderLedgerId: "unknown" }))
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

// Create mock request with path params for GET /orders/:order_ledger_id
const createMockRequestWithPathParams = (pathParams: Record<string, string>) => {
  const mockRequest = {
    headers: {},
    json: Effect.succeed({}),
    text: Effect.succeed(""),
    urlParamsBody: Effect.succeed(new URLSearchParams())
  }

  return Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    mockRequest as unknown as HttpServerRequest.HttpServerRequest
  ).pipe(
    Layer.merge(Layer.succeed(HttpRouter.RouteContext, {
      params: pathParams,
      route: { path: "/orders/:order_ledger_id", method: "GET" }
    } as unknown as HttpRouter.RouteContext))
  )
}

// Execute the getOrderStatus effect and extract response data
const executeGetOrderStatus = async (
  orderServiceLayer: Layer.Layer<OrderService>,
  pathParams: Record<string, string>
): Promise<{ status: number; body: GetOrderStatusResponse }> => {
  const program = Effect.gen(function* () {
    const response = yield* getOrderStatus
    const status = response.status
    const webResponse = HttpServerResponse.toWeb(response)
    const body = yield* Effect.promise(() => webResponse.json() as Promise<GetOrderStatusResponse>)
    return { status, body }
  })

  const requestLayer = createMockRequestWithPathParams(pathParams)

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

describe("GET /orders/:order_ledger_id", () => {
  describe("success cases", () => {
    it("should return 200 with order status and items for existing AUTHORIZED order", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440001",
              quantity: 2,
              unitPriceCents: 1000
            }
          ]
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      expect(result.status).toBe(200)
      expect(result.body.order_ledger_id).toBe("550e8400-e29b-41d4-a716-446655440099")
      expect(result.body.status).toBe("AUTHORIZED")
      expect(result.body.email).toBe("customer@example.com")
      expect(result.body.total_amount_cents).toBe(2000)
      expect(result.body.currency).toBe("USD")
      expect(result.body.payment_authorization_id).toBe("auth_123")
      expect(result.body.items).toHaveLength(1)
      expect(result.body.items?.[0].product_id).toBe("550e8400-e29b-41d4-a716-446655440001")
      expect(result.body.items?.[0].quantity).toBe(2)
      expect(result.body.items?.[0].unit_price_cents).toBe(1000)
    })

    it("should return order with AWAITING_AUTHORIZATION status", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AWAITING_AUTHORIZATION",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: null,
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:00.000Z",
          items: []
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("AWAITING_AUTHORIZATION")
      expect(result.body.payment_authorization_id).toBeNull()
    })

    it("should return order with AUTHORIZATION_FAILED status", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZATION_FAILED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: null,
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440001",
              quantity: 2,
              unitPriceCents: 1000
            }
          ]
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("AUTHORIZATION_FAILED")
    })

    it("should return order with COMPLETED status", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "COMPLETED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:35:00.000Z",
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440001",
              quantity: 2,
              unitPriceCents: 1000
            }
          ]
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("COMPLETED")
    })
  })

  describe("error cases", () => {
    it("should return 404 for non-existent order_ledger_id", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: false,
        error: new OrderLedgerNotFoundError({
          orderLedgerId: "00000000-0000-0000-0000-000000000000"
        })
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "00000000-0000-0000-0000-000000000000"
      })

      expect(result.status).toBe(404)
      expect(result.body.error).toBe("not_found")
      expect(result.body.message).toContain("00000000-0000-0000-0000-000000000000")
    })

    it("should return 400 for invalid UUID format", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: []
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "not-a-uuid"
      })

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
      expect(result.body.message).toContain("UUID")
    })
  })

  describe("response format", () => {
    it("should use snake_case for all response fields", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: [
            {
              productId: "550e8400-e29b-41d4-a716-446655440001",
              quantity: 2,
              unitPriceCents: 1000
            }
          ]
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      // Verify snake_case keys
      expect(result.body).toHaveProperty("order_ledger_id")
      expect(result.body).toHaveProperty("client_request_id")
      expect(result.body).toHaveProperty("user_id")
      expect(result.body).toHaveProperty("total_amount_cents")
      expect(result.body).toHaveProperty("payment_authorization_id")
      expect(result.body).toHaveProperty("created_at")
      expect(result.body).toHaveProperty("updated_at")

      // Verify camelCase keys are NOT present
      expect(result.body).not.toHaveProperty("orderLedgerId")
      expect(result.body).not.toHaveProperty("clientRequestId")
      expect(result.body).not.toHaveProperty("userId")
      expect(result.body).not.toHaveProperty("totalAmountCents")
      expect(result.body).not.toHaveProperty("paymentAuthorizationId")
      expect(result.body).not.toHaveProperty("createdAt")
      expect(result.body).not.toHaveProperty("updatedAt")

      // Verify items use snake_case
      expect(result.body.items?.[0]).toHaveProperty("product_id")
      expect(result.body.items?.[0]).toHaveProperty("unit_price_cents")
      expect(result.body.items?.[0]).not.toHaveProperty("productId")
      expect(result.body.items?.[0]).not.toHaveProperty("unitPriceCents")
    })

    it("should include empty items array when order has no items", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 0,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: []
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      expect(result.status).toBe(200)
      expect(result.body.items).toEqual([])
    })

    it("should return timestamps in ISO format", async () => {
      const orderServiceLayer = createMockOrderServiceForGet({
        shouldSucceed: true,
        result: {
          orderLedgerId: "550e8400-e29b-41d4-a716-446655440099",
          clientRequestId: "unique-request-id-123",
          status: "AUTHORIZED",
          userId: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          totalAmountCents: 2000,
          currency: "USD",
          paymentAuthorizationId: "auth_123",
          createdAt: "2024-01-15T10:30:00.000Z",
          updatedAt: "2024-01-15T10:30:05.000Z",
          items: []
        }
      })

      const result = await executeGetOrderStatus(orderServiceLayer, {
        order_ledger_id: "550e8400-e29b-41d4-a716-446655440099"
      })

      // Verify timestamps are valid ISO format
      expect(result.body.created_at).toBe("2024-01-15T10:30:00.000Z")
      expect(result.body.updated_at).toBe("2024-01-15T10:30:05.000Z")
      expect(new Date(result.body.created_at!).toString()).not.toBe("Invalid Date")
      expect(new Date(result.body.updated_at!).toString()).not.toBe("Invalid Date")
    })
  })
})
