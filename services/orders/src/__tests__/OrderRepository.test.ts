import { describe, it, expect } from "vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "@effect/sql"
import { OrderRepository } from "../repositories/OrderRepository.js"
import { OrderRepositoryLive } from "../repositories/OrderRepositoryLive.js"
import {
  OrderId,
  OrderLedgerId,
  UserId,
  ProductId,
  CreateOrderRequest,
  CreateOrderItemRequest
} from "../domain/Order.js"

// Mock SQL client factory that tracks query execution
const createMockSqlClient = (
  queryHandler: (strings: TemplateStringsArray, ...values: any[]) => any[]
) => {
  const mockSql = Object.assign(
    (strings: TemplateStringsArray, ...values: any[]) => {
      return Effect.succeed(queryHandler(strings, values))
    },
    {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
    }
  )

  return Layer.succeed(SqlClient.SqlClient, mockSql as any)
}

// Test fixtures
const testOrderLedgerId = "550e8400-e29b-41d4-a716-446655440000" as OrderLedgerId
const testOrderId = "660e8400-e29b-41d4-a716-446655440001" as OrderId
const testUserId = "770e8400-e29b-41d4-a716-446655440002" as UserId
const testProductId = "880e8400-e29b-41d4-a716-446655440003" as ProductId

const mockOrderRow = {
  id: testOrderId,
  order_ledger_id: testOrderLedgerId,
  user_id: testUserId,
  status: "CREATED",
  total_amount_cents: 5998,
  currency: "USD",
  created_at: new Date("2024-01-15T10:30:00Z"),
  updated_at: new Date("2024-01-15T10:30:00Z")
}

const mockOrderItemRow = {
  id: "990e8400-e29b-41d4-a716-446655440004",
  order_id: testOrderId,
  product_id: testProductId,
  quantity: 2,
  unit_price_cents: 2999,
  created_at: new Date("2024-01-15T10:30:00Z")
}

const createOrderRequest = new CreateOrderRequest({
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

describe("OrderRepository", () => {
  describe("findById", () => {
    it("should return Option.none when order not found", async () => {
      const mockSqlClient = createMockSqlClient(() => [])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.findById("nonexistent-id" as OrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return Option.some with mapped order when found", async () => {
      const mockSqlClient = createMockSqlClient(() => [mockOrderRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.findById(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.id).toBe(testOrderId)
        expect(result.value.orderLedgerId).toBe(testOrderLedgerId)
        expect(result.value.userId).toBe(testUserId)
        expect(result.value.status).toBe("CREATED")
        expect(result.value.totalAmountCents).toBe(5998)
        expect(result.value.currency).toBe("USD")
      }
    })
  })

  describe("findByLedgerId", () => {
    it("should return Option.none when order not found", async () => {
      const mockSqlClient = createMockSqlClient(() => [])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.findByLedgerId("nonexistent-id" as OrderLedgerId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return Option.some with mapped order when found", async () => {
      const mockSqlClient = createMockSqlClient(() => [mockOrderRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.findByLedgerId(testOrderLedgerId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.orderLedgerId).toBe(testOrderLedgerId)
      }
    })
  })

  describe("getItems", () => {
    it("should return empty array when no items exist", async () => {
      const mockSqlClient = createMockSqlClient(() => [])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.getItems(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result).toEqual([])
    })

    it("should return mapped order items when found", async () => {
      const mockSqlClient = createMockSqlClient(() => [mockOrderItemRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.getItems(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.length).toBe(1)
      expect(result[0].orderId).toBe(testOrderId)
      expect(result[0].productId).toBe(testProductId)
      expect(result[0].quantity).toBe(2)
      expect(result[0].unitPriceCents).toBe(2999)
    })
  })

  describe("createWithItems", () => {
    it("should return Created tag when order is new", async () => {
      let queryCount = 0
      const mockSqlClient = createMockSqlClient((strings) => {
        queryCount++
        const query = strings.join("?")
        // First query: check for existing order
        if (query.includes("SELECT * FROM orders") && query.includes("order_ledger_id")) {
          return []
        }
        // Second query: insert order
        if (query.includes("INSERT INTO orders")) {
          return [mockOrderRow]
        }
        // Third query: insert order items
        if (query.includes("INSERT INTO order_items")) {
          return [mockOrderItemRow]
        }
        return []
      })
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.createWithItems(createOrderRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("Created")
      expect(result.order.id).toBe(testOrderId)
      expect(result.items.length).toBe(1)
    })

    it("should return AlreadyExists tag when order exists (idempotency)", async () => {
      const mockSqlClient = createMockSqlClient((strings) => {
        const query = strings.join("?")
        // First query: check for existing order - FOUND
        if (query.includes("SELECT * FROM orders") && query.includes("order_ledger_id")) {
          return [mockOrderRow]
        }
        // Query for items of existing order
        if (query.includes("SELECT * FROM order_items")) {
          return [mockOrderItemRow]
        }
        return []
      })
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.createWithItems(createOrderRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result._tag).toBe("AlreadyExists")
      expect(result.order.id).toBe(testOrderId)
      expect(result.items.length).toBe(1)
    })
  })

  describe("updateStatus", () => {
    it("should return Option.none when order not found", async () => {
      const mockSqlClient = createMockSqlClient(() => [])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.updateStatus("nonexistent-id" as OrderId, "CONFIRMED")
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return updated order when status change succeeds", async () => {
      const updatedRow = { ...mockOrderRow, status: "CONFIRMED" }
      const mockSqlClient = createMockSqlClient(() => [updatedRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.updateStatus(testOrderId, "CONFIRMED")
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("CONFIRMED")
      }
    })
  })

  describe("row mapping", () => {
    it("should correctly map snake_case DB columns to camelCase domain", async () => {
      const mockSqlClient = createMockSqlClient(() => [mockOrderRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.findById(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        // Verify all mappings
        expect(result.value.id).toBe(mockOrderRow.id)
        expect(result.value.orderLedgerId).toBe(mockOrderRow.order_ledger_id)
        expect(result.value.userId).toBe(mockOrderRow.user_id)
        expect(result.value.totalAmountCents).toBe(mockOrderRow.total_amount_cents)
      }
    })

    it("should correctly map order item columns", async () => {
      const mockSqlClient = createMockSqlClient(() => [mockOrderItemRow])
      const testLayer = OrderRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* OrderRepository
        return yield* repo.getItems(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.length).toBe(1)
      expect(result[0].id).toBe(mockOrderItemRow.id)
      expect(result[0].orderId).toBe(mockOrderItemRow.order_id)
      expect(result[0].productId).toBe(mockOrderItemRow.product_id)
      expect(result[0].unitPriceCents).toBe(mockOrderItemRow.unit_price_cents)
    })
  })
})
