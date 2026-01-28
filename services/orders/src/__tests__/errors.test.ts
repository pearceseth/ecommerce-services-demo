import { describe, it, expect } from "vitest"

describe("Order Domain Errors", () => {
  describe("OrderNotFoundError", () => {
    it("should have correct _tag", async () => {
      const { OrderNotFoundError } = await import("../domain/errors.js")
      const error = new OrderNotFoundError({
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        searchedBy: "id"
      })
      expect(error._tag).toBe("OrderNotFoundError")
    })

    it("should capture orderId context", async () => {
      const { OrderNotFoundError } = await import("../domain/errors.js")
      const error = new OrderNotFoundError({
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        searchedBy: "id"
      })
      expect(error.orderId).toBe("550e8400-e29b-41d4-a716-446655440000")
    })

    it("should capture searchedBy context for id lookups", async () => {
      const { OrderNotFoundError } = await import("../domain/errors.js")
      const error = new OrderNotFoundError({
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        searchedBy: "id"
      })
      expect(error.searchedBy).toBe("id")
    })

    it("should capture searchedBy context for ledgerId lookups", async () => {
      const { OrderNotFoundError } = await import("../domain/errors.js")
      const error = new OrderNotFoundError({
        orderId: "660e8400-e29b-41d4-a716-446655440001",
        searchedBy: "orderLedgerId"
      })
      expect(error.searchedBy).toBe("orderLedgerId")
    })
  })

  describe("OrderAlreadyExistsError", () => {
    it("should have correct _tag", async () => {
      const { OrderAlreadyExistsError } = await import("../domain/errors.js")
      const error = new OrderAlreadyExistsError({
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        existingOrderId: "660e8400-e29b-41d4-a716-446655440001"
      })
      expect(error._tag).toBe("OrderAlreadyExistsError")
    })

    it("should capture orderLedgerId context", async () => {
      const { OrderAlreadyExistsError } = await import("../domain/errors.js")
      const error = new OrderAlreadyExistsError({
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        existingOrderId: "660e8400-e29b-41d4-a716-446655440001"
      })
      expect(error.orderLedgerId).toBe("550e8400-e29b-41d4-a716-446655440000")
    })

    it("should capture existingOrderId for idempotency handling", async () => {
      const { OrderAlreadyExistsError } = await import("../domain/errors.js")
      const error = new OrderAlreadyExistsError({
        orderLedgerId: "550e8400-e29b-41d4-a716-446655440000",
        existingOrderId: "660e8400-e29b-41d4-a716-446655440001"
      })
      expect(error.existingOrderId).toBe("660e8400-e29b-41d4-a716-446655440001")
    })
  })

  describe("InvalidOrderStatusError", () => {
    it("should have correct _tag", async () => {
      const { InvalidOrderStatusError } = await import("../domain/errors.js")
      const error = new InvalidOrderStatusError({
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        currentStatus: "CONFIRMED",
        attemptedStatus: "CREATED"
      })
      expect(error._tag).toBe("InvalidOrderStatusError")
    })

    it("should capture status transition context", async () => {
      const { InvalidOrderStatusError } = await import("../domain/errors.js")
      const error = new InvalidOrderStatusError({
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        currentStatus: "CONFIRMED",
        attemptedStatus: "CREATED"
      })
      expect(error.orderId).toBe("550e8400-e29b-41d4-a716-446655440000")
      expect(error.currentStatus).toBe("CONFIRMED")
      expect(error.attemptedStatus).toBe("CREATED")
    })
  })
})
