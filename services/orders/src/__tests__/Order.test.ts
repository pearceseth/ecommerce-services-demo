import { describe, it, expect } from "vitest"
import { Schema, Either } from "effect"

// Tests written first (TDD) - implementation follows
// These tests verify the domain schemas validate correctly

describe("Order Domain Types", () => {
  describe("OrderId", () => {
    it("should accept valid UUIDs", async () => {
      // Import dynamically to test compilation
      const { OrderId } = await import("../domain/Order.js")
      const validUUID = "550e8400-e29b-41d4-a716-446655440000"
      const result = Schema.decodeEither(OrderId)(validUUID)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should reject invalid UUIDs", async () => {
      const { OrderId } = await import("../domain/Order.js")
      const invalidUUID = "not-a-uuid"
      const result = Schema.decodeEither(OrderId)(invalidUUID)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OrderLedgerId", () => {
    it("should accept valid UUIDs", async () => {
      const { OrderLedgerId } = await import("../domain/Order.js")
      const validUUID = "660e8400-e29b-41d4-a716-446655440001"
      const result = Schema.decodeEither(OrderLedgerId)(validUUID)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should reject invalid UUIDs", async () => {
      const { OrderLedgerId } = await import("../domain/Order.js")
      const invalidUUID = "invalid"
      const result = Schema.decodeEither(OrderLedgerId)(invalidUUID)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("OrderStatus", () => {
    it("should accept CREATED status", async () => {
      const { OrderStatus } = await import("../domain/Order.js")
      const result = Schema.decodeEither(OrderStatus)("CREATED")
      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept CONFIRMED status", async () => {
      const { OrderStatus } = await import("../domain/Order.js")
      const result = Schema.decodeEither(OrderStatus)("CONFIRMED")
      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept CANCELLED status", async () => {
      const { OrderStatus } = await import("../domain/Order.js")
      const result = Schema.decodeEither(OrderStatus)("CANCELLED")
      expect(Either.isRight(result)).toBe(true)
    })

    it("should reject invalid status", async () => {
      const { OrderStatus } = await import("../domain/Order.js")
      const result = Schema.decodeUnknownEither(OrderStatus)("INVALID")
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("CreateOrderRequest", () => {
    it("should accept valid request with all fields", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const validRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 5998,
        currency: "USD",
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 2,
            unitPriceCents: 2999
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(validRequest)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should default currency to USD when not provided", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const requestWithoutCurrency = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 5998,
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 2,
            unitPriceCents: 2999
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(requestWithoutCurrency)
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.currency).toBe("USD")
      }
    })

    it("should reject empty items array", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 0,
        items: []
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject negative totalAmountCents", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: -100,
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            unitPriceCents: 100
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject zero quantity in items", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 0,
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 0,
            unitPriceCents: 2999
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject negative quantity in items", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 0,
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: -1,
            unitPriceCents: 2999
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject negative unitPriceCents", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 0,
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            unitPriceCents: -100
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject invalid currency length", async () => {
      const { CreateOrderRequest } = await import("../domain/Order.js")
      const invalidRequest = {
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440001",
        totalAmountCents: 100,
        currency: "US", // Too short
        items: [
          {
            productId: "770e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            unitPriceCents: 100
          }
        ]
      }
      const result = Schema.decodeEither(CreateOrderRequest)(invalidRequest)
      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("CreateOrderItemRequest", () => {
    it("should accept valid item request", async () => {
      const { CreateOrderItemRequest } = await import("../domain/Order.js")
      const validItem = {
        productId: "770e8400-e29b-41d4-a716-446655440002",
        quantity: 2,
        unitPriceCents: 2999
      }
      const result = Schema.decodeEither(CreateOrderItemRequest)(validItem)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept zero unitPriceCents (free items)", async () => {
      const { CreateOrderItemRequest } = await import("../domain/Order.js")
      const freeItem = {
        productId: "770e8400-e29b-41d4-a716-446655440002",
        quantity: 1,
        unitPriceCents: 0
      }
      const result = Schema.decodeEither(CreateOrderItemRequest)(freeItem)
      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("OrderIdParams", () => {
    it("should accept valid order_id path parameter", async () => {
      const { OrderIdParams } = await import("../domain/Order.js")
      const validParams = {
        order_id: "550e8400-e29b-41d4-a716-446655440000"
      }
      const result = Schema.decodeEither(OrderIdParams)(validParams)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should reject invalid order_id format", async () => {
      const { OrderIdParams } = await import("../domain/Order.js")
      const invalidParams = {
        order_id: "not-a-uuid"
      }
      const result = Schema.decodeEither(OrderIdParams)(invalidParams)
      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
