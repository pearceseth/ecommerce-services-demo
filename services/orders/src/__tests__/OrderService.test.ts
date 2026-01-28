import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime, Exit } from "effect"
import { OrderService } from "../services/OrderService.js"
import { OrderServiceLive } from "../services/OrderServiceLive.js"
import { OrderRepository, type CreateOrderResult } from "../repositories/OrderRepository.js"
import {
  Order,
  OrderId,
  OrderLedgerId,
  UserId,
  ProductId,
  OrderItem,
  OrderItemId,
  CreateOrderRequest,
  CreateOrderItemRequest
} from "../domain/Order.js"
import { OrderNotFoundError } from "../domain/errors.js"

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
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testOrderItem = new OrderItem({
  id: testOrderItemId,
  orderId: testOrderId,
  productId: testProductId,
  quantity: 2,
  unitPriceCents: 2999,
  createdAt: DateTime.unsafeNow()
})

const testCreateRequest = new CreateOrderRequest({
  orderLedgerId: testOrderLedgerId,
  userId: testUserId,
  totalAmountCents: 5998,
  currency: "USD",
  items: [
    new CreateOrderItemRequest({
      productId: testProductId,
      quantity: 2,
      unitPriceCents: 2999
    })
  ]
})

// Mock repository factory
const createMockRepo = (overrides: {
  createWithItems?: (request: CreateOrderRequest) => Effect.Effect<CreateOrderResult>
  findById?: (id: OrderId) => Effect.Effect<Option.Option<Order>>
  findByLedgerId?: (ledgerId: OrderLedgerId) => Effect.Effect<Option.Option<Order>>
  getItems?: (orderId: OrderId) => Effect.Effect<readonly OrderItem[]>
  updateStatus?: (orderId: OrderId, status: any) => Effect.Effect<Option.Option<Order>>
} = {}) => {
  return Layer.succeed(OrderRepository, {
    createWithItems: overrides.createWithItems ?? (() =>
      Effect.succeed({ _tag: "Created" as const, order: testOrder, items: [testOrderItem] })
    ),
    findById: overrides.findById ?? (() => Effect.succeed(Option.some(testOrder))),
    findByLedgerId: overrides.findByLedgerId ?? (() => Effect.succeed(Option.some(testOrder))),
    getItems: overrides.getItems ?? (() => Effect.succeed([testOrderItem])),
    updateStatus: overrides.updateStatus ?? (() => Effect.succeed(Option.some(testOrder)))
  })
}

describe("OrderService", () => {
  describe("create", () => {
    it("should return order with items when created successfully", async () => {
      const mockRepo = createMockRepo({
        createWithItems: () => Effect.succeed({
          _tag: "Created" as const,
          order: testOrder,
          items: [testOrderItem]
        })
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.order.id).toBe(testOrderId)
      expect(result.order.orderLedgerId).toBe(testOrderLedgerId)
      expect(result.order.status).toBe("CREATED")
      expect(result.items.length).toBe(1)
      expect(result.items[0].quantity).toBe(2)
    })

    it("should return existing order on duplicate request (idempotency)", async () => {
      const mockRepo = createMockRepo({
        createWithItems: () => Effect.succeed({
          _tag: "AlreadyExists" as const,
          order: testOrder,
          items: [testOrderItem]
        })
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      // Should return the existing order, not fail
      expect(result.order.id).toBe(testOrderId)
      expect(result.items.length).toBe(1)
    })

    it("should pass correct request data to repository", async () => {
      let capturedRequest: CreateOrderRequest | null = null

      const mockRepo = createMockRepo({
        createWithItems: (request) => {
          capturedRequest = request
          return Effect.succeed({
            _tag: "Created" as const,
            order: testOrder,
            items: [testOrderItem]
          })
        }
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(capturedRequest).not.toBeNull()
      expect(capturedRequest!.orderLedgerId).toBe(testOrderLedgerId)
      expect(capturedRequest!.userId).toBe(testUserId)
      expect(capturedRequest!.totalAmountCents).toBe(5998)
      expect(capturedRequest!.items.length).toBe(1)
    })
  })

  describe("findById", () => {
    it("should return order with items when found", async () => {
      const mockRepo = createMockRepo({
        findById: () => Effect.succeed(Option.some(testOrder)),
        getItems: () => Effect.succeed([testOrderItem])
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.findById(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.order.id).toBe(testOrderId)
      expect(result.items.length).toBe(1)
      expect(result.items[0].id).toBe(testOrderItemId)
    })

    it("should fail with OrderNotFoundError when order not found", async () => {
      const mockRepo = createMockRepo({
        findById: () => Effect.succeed(Option.none())
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      const exit = await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.findById("nonexistent-id" as OrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("OrderNotFoundError")
          expect((error.error as OrderNotFoundError).orderId).toBe("nonexistent-id")
          expect((error.error as OrderNotFoundError).searchedBy).toBe("id")
        }
      }
    })

    it("should fetch items for the found order", async () => {
      let itemsOrderId: OrderId | null = null

      const mockRepo = createMockRepo({
        findById: () => Effect.succeed(Option.some(testOrder)),
        getItems: (orderId) => {
          itemsOrderId = orderId
          return Effect.succeed([testOrderItem])
        }
      })

      const testLayer = OrderServiceLive.pipe(Layer.provide(mockRepo))

      await Effect.gen(function* () {
        const service = yield* OrderService
        return yield* service.findById(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(itemsOrderId).toBe(testOrderId)
    })
  })
})
