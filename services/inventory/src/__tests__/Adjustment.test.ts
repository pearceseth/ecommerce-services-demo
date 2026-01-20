import { describe, it, expect } from "vitest"
import { Schema, Option, Either } from "effect"
import { AddStockRequest, AdjustmentReason } from "../domain/Adjustment.js"

describe("Adjustment Domain Types", () => {
  describe("AdjustmentReason", () => {
    it("should accept valid reasons", () => {
      const validReasons: Array<typeof AdjustmentReason.Type> = [
        "warehouse_receiving",
        "manual_adjustment",
        "return_to_stock",
        "correction"
      ]

      for (const reason of validReasons) {
        const result = Schema.decodeUnknownEither(AdjustmentReason)(reason)
        expect(Either.isRight(result)).toBe(true)
      }
    })

    it("should reject invalid reasons", () => {
      const invalidReasons = ["invalid", "restock", "adjustment", ""]

      for (const reason of invalidReasons) {
        const result = Schema.decodeUnknownEither(AdjustmentReason)(reason)
        expect(Either.isLeft(result)).toBe(true)
      }
    })
  })

  describe("AddStockRequest", () => {
    it("should parse valid request with all fields", () => {
      const input = {
        quantity: 100,
        reason: "warehouse_receiving",
        referenceId: "PO-2024-001",
        notes: "Q1 restock shipment"
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isRight(result)).toBe(true)

      if (Either.isRight(result)) {
        expect(result.right.quantity).toBe(100)
        expect(result.right.reason).toBe("warehouse_receiving")
        expect(Option.isSome(result.right.referenceId)).toBe(true)
        expect(Option.getOrNull(result.right.referenceId)).toBe("PO-2024-001")
        expect(Option.isSome(result.right.notes)).toBe(true)
        expect(Option.getOrNull(result.right.notes)).toBe("Q1 restock shipment")
      }
    })

    it("should parse valid request with only required fields", () => {
      const input = {
        quantity: 50,
        reason: "manual_adjustment"
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isRight(result)).toBe(true)

      if (Either.isRight(result)) {
        expect(result.right.quantity).toBe(50)
        expect(result.right.reason).toBe("manual_adjustment")
        expect(Option.isNone(result.right.referenceId)).toBe(true)
        expect(Option.isNone(result.right.notes)).toBe(true)
      }
    })

    it("should reject non-positive quantity", () => {
      const invalidQuantities = [0, -1, -100]

      for (const quantity of invalidQuantities) {
        const input = {
          quantity,
          reason: "warehouse_receiving"
        }

        const result = Schema.decodeUnknownEither(AddStockRequest)(input)
        expect(Either.isLeft(result)).toBe(true)
      }
    })

    it("should reject missing quantity", () => {
      const input = {
        reason: "warehouse_receiving"
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject missing reason", () => {
      const input = {
        quantity: 100
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject invalid reason", () => {
      const input = {
        quantity: 100,
        reason: "invalid_reason"
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject referenceId exceeding max length", () => {
      const input = {
        quantity: 100,
        reason: "warehouse_receiving",
        referenceId: "x".repeat(256) // Exceeds 255 char limit
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should reject notes exceeding max length", () => {
      const input = {
        quantity: 100,
        reason: "warehouse_receiving",
        notes: "x".repeat(1001) // Exceeds 1000 char limit
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isLeft(result)).toBe(true)
    })

    it("should accept referenceId at max length", () => {
      const input = {
        quantity: 100,
        reason: "warehouse_receiving",
        referenceId: "x".repeat(255) // Exactly at limit
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should accept notes at max length", () => {
      const input = {
        quantity: 100,
        reason: "warehouse_receiving",
        notes: "x".repeat(1000) // Exactly at limit
      }

      const result = Schema.decodeUnknownEither(AddStockRequest)(input)
      expect(Either.isRight(result)).toBe(true)
    })

    it("should handle all valid reason types", () => {
      const reasons = [
        "warehouse_receiving",
        "manual_adjustment",
        "return_to_stock",
        "correction"
      ]

      for (const reason of reasons) {
        const input = {
          quantity: 10,
          reason
        }

        const result = Schema.decodeUnknownEither(AddStockRequest)(input)
        expect(Either.isRight(result)).toBe(true)
      }
    })
  })
})
