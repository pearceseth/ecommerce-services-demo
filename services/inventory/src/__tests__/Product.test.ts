import { describe, it, expect } from "vitest"
import { Schema, Either } from "effect"
import { CreateProductRequest } from "../domain/Product.js"

describe("CreateProductRequest", () => {
  const decode = Schema.decodeUnknownEither(CreateProductRequest)

  describe("valid requests", () => {
    it("should accept a valid request with all fields", () => {
      const input = {
        name: "Widget Pro",
        sku: "WIDGET-PRO-001",
        priceCents: 2999,
        initialStock: 100
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.name).toBe("Widget Pro")
        expect(result.right.sku).toBe("WIDGET-PRO-001")
        expect(result.right.priceCents).toBe(2999)
        expect(result.right.initialStock).toBe(100)
      }
    })

    it("should default initialStock to 0 when not provided", () => {
      const input = {
        name: "Widget Pro",
        sku: "WIDGET-PRO-001",
        priceCents: 2999
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right.initialStock).toBe(0)
      }
    })

    it("should accept SKU with hyphens and underscores", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET_PRO-001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept SKU with numbers", () => {
      const input = {
        name: "Widget",
        sku: "W123",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("name validation", () => {
    it("should reject empty name", () => {
      const input = {
        name: "",
        sku: "WIDGET-001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject name exceeding 255 characters", () => {
      const input = {
        name: "a".repeat(256),
        sku: "WIDGET-001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should accept name at exactly 255 characters", () => {
      const input = {
        name: "a".repeat(255),
        sku: "WIDGET-001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("sku validation", () => {
    it("should reject empty SKU", () => {
      const input = {
        name: "Widget",
        sku: "",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject SKU exceeding 100 characters", () => {
      const input = {
        name: "Widget",
        sku: "A".repeat(101),
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject SKU with invalid characters (spaces)", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET 001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject SKU with invalid characters (special chars)", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET@001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("priceCents validation", () => {
    it("should reject zero price", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 0
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject negative price", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: -100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should accept positive integer price", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 1
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })

    it("should reject non-integer price", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 29.99
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })
  })

  describe("initialStock validation", () => {
    it("should reject negative initial stock", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 100,
        initialStock: -1
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should accept zero initial stock", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 100,
        initialStock: 0
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept positive initial stock", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001",
        priceCents: 100,
        initialStock: 1000
      }

      const result = decode(input)

      expect(Either.isRight(result)).toBe(true)
    })
  })

  describe("missing required fields", () => {
    it("should reject missing name", () => {
      const input = {
        sku: "WIDGET-001",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject missing sku", () => {
      const input = {
        name: "Widget",
        priceCents: 100
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject missing priceCents", () => {
      const input = {
        name: "Widget",
        sku: "WIDGET-001"
      }

      const result = decode(input)

      expect(Either.isLeft(result)).toBe(true)
    })
  })
})
