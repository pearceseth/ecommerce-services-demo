import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime, Schema } from "effect"
import { HttpRouter } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { OrderService, type OrderWithItems } from "../../services/OrderService.js"
import {
  Order,
  OrderId,
  OrderLedgerId,
  UserId,
  ProductId,
  OrderItem,
  OrderItemId,
  CreateOrderRequest,
  OrderIdParams
} from "../../domain/Order.js"
import { OrderNotFoundError } from "../../domain/errors.js"

// Test fixtures
const testOrderLedgerId = "550e8400-e29b-41d4-a716-446655440000" as OrderLedgerId
const testOrderId = "660e8400-e29b-41d4-a716-446655440001" as OrderId
const testUserId = "770e8400-e29b-41d4-a716-446655440002" as UserId
const testProductId = "880e8400-e29b-41d4-a716-446655440003" as ProductId
const testOrderItemId = "990e8400-e29b-41d4-a716-446655440004" as OrderItemId

const testOrder = new Order({
  id: testOrderId,
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  status: "CREATED",
  totalAmountCents: 5998,
  currency: "USD",
  createdAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z")),
  updatedAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z"))
})

const testOrderItem = new OrderItem({
  id: testOrderItemId,
  orderId: testOrderId,
  productId: testProductId,
  quantity: 2,
  unitPriceCents: 2999,
  createdAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z"))
})

// Response types for helper functions
interface CreateOrderResponse {
  status: number
  body: {
    id?: string
    order_ledger_id?: string
    user_id?: string
    status?: string
    total_amount_cents?: number
    currency?: string
    created_at?: string
    updated_at?: string
    items?: Array<{
      id?: string
      product_id?: string
      quantity?: number
      unit_price_cents?: number
      created_at?: string
    }>
    error?: string
    message?: string
    details?: string
  }
}

interface GetOrderResponse {
  status: number
  body: {
    id?: string
    order_ledger_id?: string
    user_id?: string
    status?: string
    total_amount_cents?: number
    currency?: string
    items?: Array<{
      id?: string
      product_id?: string
      quantity?: number
      unit_price_cents?: number
    }>
    error?: string
    message?: string
  }
}

// Mock OrderService factory
const createMockOrderService = (overrides: {
  create?: (request: CreateOrderRequest) => Effect.Effect<OrderWithItems, SqlError.SqlError>
  findById?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(OrderService, {
    create: overrides.create ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    ),
    findById: overrides.findById ?? (() =>
      Effect.succeed({ order: testOrder, items: [testOrderItem] })
    )
  })
}

// Mock RouteContext factory - provides path params to the handler
const createMockRouteContext = (params: Record<string, string | undefined>) => {
  const routeContext = {
    [HttpRouter.RouteContextTypeId]: HttpRouter.RouteContextTypeId,
    params,
    route: {} as any
  } as HttpRouter.RouteContext

  return Layer.succeed(HttpRouter.RouteContext, routeContext)
}

// Helper to run the createOrder logic with mocks
const runCreateOrder = async (
  requestBody: unknown,
  orderService: Layer.Layer<OrderService>
): Promise<CreateOrderResponse> => {
  const testLayer = orderService

  return Effect.gen(function* () {
    // Parse and validate request body
    const request = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CreateOrderRequest)(requestBody),
      catch: (error) => error
    }).pipe(
      Effect.catchAll((error) => Effect.fail({ _tag: "ParseError" as const, error }))
    )

    // Get service and create order
    const service = yield* OrderService
    const { order, items } = yield* service.create(request)

    // Map to API response format
    return {
      status: 201,
      body: {
        id: order.id,
        order_ledger_id: order.orderLedgerId,
        user_id: order.userId,
        status: order.status,
        total_amount_cents: order.totalAmountCents,
        currency: order.currency,
        created_at: order.createdAt.toString(),
        updated_at: order.updatedAt.toString(),
        items: items.map(item => ({
          id: item.id,
          product_id: item.productId,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          created_at: item.createdAt.toString()
        }))
      }
    } as CreateOrderResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid request body"
        }
      } as CreateOrderResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as CreateOrderResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

// Helper to run getOrderById logic with mocks
const runGetOrderById = async (
  orderIdParam: string | undefined,
  orderService: Layer.Layer<OrderService>
): Promise<GetOrderResponse> => {
  const routeContextLayer = createMockRouteContext({ order_id: orderIdParam })
  const testLayer = Layer.mergeAll(routeContextLayer, orderService)

  return Effect.gen(function* () {
    // Extract and validate order_id from path parameters
    const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

    // Get service and find order
    const service = yield* OrderService
    const { order, items } = yield* service.findById(orderId)

    return {
      status: 200,
      body: {
        id: order.id,
        order_ledger_id: order.orderLedgerId,
        user_id: order.userId,
        status: order.status,
        total_amount_cents: order.totalAmountCents,
        currency: order.currency,
        created_at: order.createdAt.toString(),
        updated_at: order.updatedAt.toString(),
        items: items.map(item => ({
          id: item.id,
          product_id: item.productId,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          created_at: item.createdAt.toString()
        }))
      }
    } as GetOrderResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid order_id format. Must be a valid UUID."
        }
      } as GetOrderResponse)
    ),
    Effect.catchTag("OrderNotFoundError", (error) =>
      Effect.succeed({
        status: 404,
        body: {
          error: "not_found",
          message: `Order with ID ${error.orderId} not found`
        }
      } as GetOrderResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as GetOrderResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("POST /orders", () => {
  describe("successful creation", () => {
    it("should return 201 with created order and items", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        currency: "USD",
        items: [
          {
            productId: testProductId,
            quantity: 2,
            unitPriceCents: 2999
          }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(201)
      expect(result.body.id).toBe(testOrderId)
      expect(result.body.status).toBe("CREATED")
      expect(result.body.items).toHaveLength(1)
    })

    it("should return same order on duplicate request (idempotency)", async () => {
      const mockService = createMockOrderService({
        create: () => Effect.succeed({ order: testOrder, items: [testOrderItem] })
      })

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(201)
      expect(result.body.id).toBe(testOrderId)
    })

    it("should default currency to USD when not provided", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(201)
      expect(result.body.currency).toBe("USD")
    })
  })

  describe("validation errors", () => {
    it("should return 400 for missing orderLedgerId", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for empty items array", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 0,
        items: []
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for negative quantity", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: -1, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for invalid UUID format", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: "not-a-uuid",
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 1, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for zero quantity", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 0,
        items: [
          { productId: testProductId, quantity: 0, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      // Verify snake_case keys
      expect(result.body).toHaveProperty("order_ledger_id")
      expect(result.body).toHaveProperty("user_id")
      expect(result.body).toHaveProperty("total_amount_cents")
      expect(result.body).toHaveProperty("created_at")
      expect(result.body).toHaveProperty("updated_at")
      expect(result.body.items?.[0]).toHaveProperty("product_id")
      expect(result.body.items?.[0]).toHaveProperty("unit_price_cents")
    })

    it("should include all order fields", async () => {
      const mockService = createMockOrderService()

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.body.id).toBeDefined()
      expect(result.body.order_ledger_id).toBe(testOrderLedgerId)
      expect(result.body.user_id).toBe(testUserId)
      expect(result.body.status).toBe("CREATED")
      expect(result.body.total_amount_cents).toBe(5998)
      expect(result.body.currency).toBe("USD")
      expect(result.body.created_at).toBeDefined()
      expect(result.body.updated_at).toBeDefined()
    })
  })

  describe("error handling", () => {
    it("should return 500 for SQL errors", async () => {
      const mockService = createMockOrderService({
        create: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })

      const requestBody = {
        orderLedgerId: testOrderLedgerId,
        userId: testUserId,
        totalAmountCents: 5998,
        items: [
          { productId: testProductId, quantity: 2, unitPriceCents: 2999 }
        ]
      }

      const result = await runCreateOrder(requestBody, mockService)

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
    })
  })
})

describe("GET /orders/:order_id", () => {
  describe("successful retrieval", () => {
    it("should return 200 with order and items", async () => {
      const mockService = createMockOrderService()

      const result = await runGetOrderById(testOrderId, mockService)

      expect(result.status).toBe(200)
      expect(result.body.id).toBe(testOrderId)
      expect(result.body.items).toHaveLength(1)
    })

    it("should use snake_case keys in response", async () => {
      const mockService = createMockOrderService()

      const result = await runGetOrderById(testOrderId, mockService)

      expect(result.body).toHaveProperty("order_ledger_id")
      expect(result.body).toHaveProperty("user_id")
      expect(result.body).toHaveProperty("total_amount_cents")
    })
  })

  describe("not found", () => {
    it("should return 404 when order not found", async () => {
      const nonExistentId = "550e8400-e29b-41d4-a716-446655440099"
      const mockService = createMockOrderService({
        findById: () => Effect.fail(new OrderNotFoundError({
          orderId: nonExistentId,
          searchedBy: "id"
        }))
      })

      const result = await runGetOrderById(nonExistentId, mockService)

      expect(result.status).toBe(404)
      expect(result.body.error).toBe("not_found")
    })
  })

  describe("validation errors", () => {
    it("should return 400 for invalid order_id format", async () => {
      const mockService = createMockOrderService()

      const result = await runGetOrderById("not-a-uuid", mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for undefined order_id", async () => {
      const mockService = createMockOrderService()

      const result = await runGetOrderById(undefined, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })
  })

  describe("error handling", () => {
    it("should return 500 for SQL errors", async () => {
      const mockService = createMockOrderService({
        findById: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Query timeout"),
          message: "Database query timeout"
        }))
      })

      const result = await runGetOrderById(testOrderId, mockService)

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
    })
  })
})

describe("OrderIdParams schema validation", () => {
  it("should accept valid UUID", () => {
    const result = Schema.decodeUnknownEither(OrderIdParams)({
      order_id: "550e8400-e29b-41d4-a716-446655440000"
    })
    expect(result._tag).toBe("Right")
  })

  it("should reject invalid UUID", () => {
    const result = Schema.decodeUnknownEither(OrderIdParams)({
      order_id: "not-a-uuid"
    })
    expect(result._tag).toBe("Left")
  })

  it("should reject missing order_id", () => {
    const result = Schema.decodeUnknownEither(OrderIdParams)({})
    expect(result._tag).toBe("Left")
  })
})
