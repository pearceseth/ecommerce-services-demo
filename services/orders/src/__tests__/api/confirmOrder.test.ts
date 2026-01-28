import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime } from "effect"
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
  OrderIdParams
} from "../../domain/Order.js"
import { OrderNotFoundError, InvalidOrderStatusError } from "../../domain/errors.js"

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

const cancelledOrder = new Order({
  id: testOrderId,
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  status: "CANCELLED",
  totalAmountCents: 5998,
  currency: "USD",
  createdAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z")),
  updatedAt: DateTime.unsafeMake(new Date("2024-01-15T10:31:00Z"))
})

const confirmedOrder = new Order({
  id: testOrderId,
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  status: "CONFIRMED",
  totalAmountCents: 5998,
  currency: "USD",
  createdAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z")),
  updatedAt: DateTime.unsafeMake(new Date("2024-01-15T10:31:00Z"))
})

const testOrderItem = new OrderItem({
  id: testOrderItemId,
  orderId: testOrderId,
  productId: testProductId,
  quantity: 2,
  unitPriceCents: 2999,
  createdAt: DateTime.unsafeMake(new Date("2024-01-15T10:30:00Z"))
})

// Response type
interface ConfirmOrderResponse {
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
    current_status?: string
    attempted_status?: string
  }
}

// Map domain order + items to snake_case API response
const toOrderResponse = (order: Order, items: readonly OrderItem[]) => ({
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
})

// Mock OrderService factory
const createMockOrderService = (overrides: {
  confirm?: (id: OrderId) => Effect.Effect<OrderWithItems, OrderNotFoundError | InvalidOrderStatusError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(OrderService, {
    create: () => Effect.succeed({ order: testOrder, items: [testOrderItem] }),
    findById: () => Effect.succeed({ order: testOrder, items: [testOrderItem] }),
    cancel: () => Effect.succeed({ order: cancelledOrder, items: [testOrderItem] }),
    confirm: overrides.confirm ?? (() =>
      Effect.succeed({ order: confirmedOrder, items: [testOrderItem] })
    )
  })
}

// Mock RouteContext factory
const createMockRouteContext = (params: Record<string, string | undefined>) => {
  const routeContext = {
    [HttpRouter.RouteContextTypeId]: HttpRouter.RouteContextTypeId,
    params,
    route: {} as any
  } as HttpRouter.RouteContext

  return Layer.succeed(HttpRouter.RouteContext, routeContext)
}

// Helper to run confirmOrder logic with mocks
const runConfirmOrder = async (
  orderIdParam: string | undefined,
  orderService: Layer.Layer<OrderService>
): Promise<ConfirmOrderResponse> => {
  const routeContextLayer = createMockRouteContext({ order_id: orderIdParam })
  const testLayer = Layer.mergeAll(routeContextLayer, orderService)

  return Effect.gen(function* () {
    const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)
    const service = yield* OrderService
    const { order, items } = yield* service.confirm(orderId)

    return {
      status: 200,
      body: toOrderResponse(order, items)
    } as ConfirmOrderResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: { error: "validation_error", message: "Invalid order_id format. Must be a valid UUID." }
      } as ConfirmOrderResponse)
    ),
    Effect.catchTag("OrderNotFoundError", (error) =>
      Effect.succeed({
        status: 404,
        body: { error: "not_found", message: `Order with ID ${error.orderId} not found` }
      } as ConfirmOrderResponse)
    ),
    Effect.catchTag("InvalidOrderStatusError", (error) =>
      Effect.succeed({
        status: 409,
        body: {
          error: "invalid_status_transition",
          message: `Cannot confirm order in ${error.currentStatus} status`,
          current_status: error.currentStatus,
          attempted_status: error.attemptedStatus
        }
      } as ConfirmOrderResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: { error: "internal_error", message: "An unexpected error occurred" }
      } as ConfirmOrderResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("PUT /orders/:order_id/confirm", () => {
  describe("successful confirmation", () => {
    it("should return 200 with confirmed order", async () => {
      const mockService = createMockOrderService()

      const result = await runConfirmOrder(testOrderId, mockService)

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("CONFIRMED")
      expect(result.body.items).toHaveLength(1)
    })

    it("should return 200 on idempotent retry (already confirmed)", async () => {
      const mockService = createMockOrderService({
        confirm: () => Effect.succeed({ order: confirmedOrder, items: [testOrderItem] })
      })

      const result = await runConfirmOrder(testOrderId, mockService)

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("CONFIRMED")
    })
  })

  describe("validation errors", () => {
    it("should return 400 for invalid order_id format", async () => {
      const mockService = createMockOrderService()

      const result = await runConfirmOrder("not-a-uuid", mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for undefined order_id", async () => {
      const mockService = createMockOrderService()

      const result = await runConfirmOrder(undefined, mockService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })
  })

  describe("not found", () => {
    it("should return 404 when order does not exist", async () => {
      const nonExistentId = "550e8400-e29b-41d4-a716-446655440099"
      const mockService = createMockOrderService({
        confirm: () => Effect.fail(new OrderNotFoundError({
          orderId: nonExistentId,
          searchedBy: "id"
        }))
      })

      const result = await runConfirmOrder(nonExistentId, mockService)

      expect(result.status).toBe(404)
      expect(result.body.error).toBe("not_found")
    })
  })

  describe("invalid status transition", () => {
    it("should return 409 when order is already cancelled", async () => {
      const mockService = createMockOrderService({
        confirm: () => Effect.fail(new InvalidOrderStatusError({
          orderId: testOrderId,
          currentStatus: "CANCELLED",
          attemptedStatus: "CONFIRMED"
        }))
      })

      const result = await runConfirmOrder(testOrderId, mockService)

      expect(result.status).toBe(409)
      expect(result.body.error).toBe("invalid_status_transition")
      expect(result.body.current_status).toBe("CANCELLED")
      expect(result.body.attempted_status).toBe("CONFIRMED")
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response", async () => {
      const mockService = createMockOrderService()

      const result = await runConfirmOrder(testOrderId, mockService)

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

      const result = await runConfirmOrder(testOrderId, mockService)

      expect(result.body.id).toBeDefined()
      expect(result.body.order_ledger_id).toBe(testOrderLedgerId)
      expect(result.body.user_id).toBe(testUserId)
      expect(result.body.status).toBe("CONFIRMED")
      expect(result.body.total_amount_cents).toBe(5998)
      expect(result.body.currency).toBe("USD")
      expect(result.body.created_at).toBeDefined()
      expect(result.body.updated_at).toBeDefined()
      expect(result.body.items).toHaveLength(1)
    })
  })

  describe("error handling", () => {
    it("should return 500 for SQL errors", async () => {
      const mockService = createMockOrderService({
        confirm: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })

      const result = await runConfirmOrder(testOrderId, mockService)

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
    })
  })
})
