import { describe, it, expect } from "vitest"
import { Schema, Either } from "effect"
import { CreateOrderRequest, OrderItemRequest, PaymentInfo } from "../../domain/OrderLedger.js"

const validOrderRequest = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  email: "customer@example.com",
  items: [
    {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 2
    }
  ],
  payment: {
    method: "card" as const,
    token: "tok_test_123"
  }
}

describe("OrderItemRequest schema", () => {
  it("should accept valid item", () => {
    const item = {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 5
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject negative quantity", () => {
    const item = {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: -1
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should reject zero quantity", () => {
    const item = {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 0
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should reject quantity over 100", () => {
    const item = {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 101
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should accept quantity of exactly 100", () => {
    const item = {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 100
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject invalid product_id UUID", () => {
    const item = {
      product_id: "not-a-uuid",
      quantity: 1
    }

    const result = Schema.decodeUnknownEither(OrderItemRequest)(item)
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("PaymentInfo schema", () => {
  it("should accept valid payment info with card method", () => {
    const payment = {
      method: "card" as const,
      token: "tok_test_123"
    }

    const result = Schema.decodeUnknownEither(PaymentInfo)(payment)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject invalid payment method", () => {
    const payment = {
      method: "paypal",
      token: "tok_test_123"
    }

    const result = Schema.decodeUnknownEither(PaymentInfo)(payment)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should reject empty token", () => {
    const payment = {
      method: "card" as const,
      token: ""
    }

    const result = Schema.decodeUnknownEither(PaymentInfo)(payment)
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("CreateOrderRequest schema", () => {
  it("should accept valid order request", () => {
    const result = Schema.decodeUnknownEither(CreateOrderRequest)(validOrderRequest)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject invalid user_id UUID", () => {
    const request = {
      ...validOrderRequest,
      user_id: "not-a-uuid"
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should reject invalid email format", () => {
    const request = {
      ...validOrderRequest,
      email: "not-an-email"
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should accept email with subdomains", () => {
    const request = {
      ...validOrderRequest,
      email: "user@mail.example.com"
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject email over 255 characters", () => {
    const longEmail = "a".repeat(250) + "@b.com"
    const request = {
      ...validOrderRequest,
      email: longEmail
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should reject empty items array", () => {
    const request = {
      ...validOrderRequest,
      items: []
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should accept order with multiple items", () => {
    const request = {
      ...validOrderRequest,
      items: [
        { product_id: "550e8400-e29b-41d4-a716-446655440001", quantity: 1 },
        { product_id: "550e8400-e29b-41d4-a716-446655440002", quantity: 3 }
      ]
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isRight(result)).toBe(true)
  })

  it("should reject order with more than 50 items", () => {
    const items = Array.from({ length: 51 }, () => ({
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 1
    }))

    const request = {
      ...validOrderRequest,
      items
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isLeft(result)).toBe(true)
  })

  it("should accept order with exactly 50 items", () => {
    const items = Array.from({ length: 50 }, () => ({
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 1
    }))

    const request = {
      ...validOrderRequest,
      items
    }

    const result = Schema.decodeUnknownEither(CreateOrderRequest)(request)
    expect(Either.isRight(result)).toBe(true)
  })
})
