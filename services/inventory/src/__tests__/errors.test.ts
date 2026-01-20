import { describe, it, expect } from "vitest"
import {
  ProductNotFoundError,
  DuplicateSkuError,
  InsufficientStockError,
  DuplicateAdjustmentError
} from "../domain/errors.js"

describe("Error ADTs", () => {
  describe("ProductNotFoundError", () => {
    it("should have correct _tag", () => {
      const error = new ProductNotFoundError({
        productId: "abc-123",
        searchedBy: "id"
      })

      expect(error._tag).toBe("ProductNotFoundError")
    })

    it("should include productId context", () => {
      const error = new ProductNotFoundError({
        productId: "abc-123",
        searchedBy: "id"
      })

      expect(error.productId).toBe("abc-123")
    })

    it("should include searchedBy context for 'id' search", () => {
      const error = new ProductNotFoundError({
        productId: "abc-123",
        searchedBy: "id"
      })

      expect(error.searchedBy).toBe("id")
    })

    it("should include searchedBy context for 'sku' search", () => {
      const error = new ProductNotFoundError({
        productId: "WIDGET-001",
        searchedBy: "sku"
      })

      expect(error.searchedBy).toBe("sku")
    })
  })

  describe("DuplicateSkuError", () => {
    it("should have correct _tag", () => {
      const error = new DuplicateSkuError({
        sku: "WIDGET-001",
        existingProductId: "existing-uuid"
      })

      expect(error._tag).toBe("DuplicateSkuError")
    })

    it("should include sku context", () => {
      const error = new DuplicateSkuError({
        sku: "WIDGET-001",
        existingProductId: "existing-uuid"
      })

      expect(error.sku).toBe("WIDGET-001")
    })

    it("should include existingProductId for recovery", () => {
      const error = new DuplicateSkuError({
        sku: "WIDGET-001",
        existingProductId: "existing-uuid"
      })

      expect(error.existingProductId).toBe("existing-uuid")
    })
  })

  describe("InsufficientStockError", () => {
    it("should have correct _tag", () => {
      const error = new InsufficientStockError({
        productId: "product-uuid",
        productSku: "WIDGET-001",
        requested: 10,
        available: 5
      })

      expect(error._tag).toBe("InsufficientStockError")
    })

    it("should include all context fields", () => {
      const error = new InsufficientStockError({
        productId: "product-uuid",
        productSku: "WIDGET-001",
        requested: 10,
        available: 5
      })

      expect(error.productId).toBe("product-uuid")
      expect(error.productSku).toBe("WIDGET-001")
      expect(error.requested).toBe(10)
      expect(error.available).toBe(5)
    })

    it("should include human-readable SKU for error messaging", () => {
      const error = new InsufficientStockError({
        productId: "product-uuid",
        productSku: "WIDGET-PRO-001",
        requested: 100,
        available: 0
      })

      expect(error.productSku).toBe("WIDGET-PRO-001")
    })
  })

  describe("DuplicateAdjustmentError", () => {
    it("should have correct _tag", () => {
      const error = new DuplicateAdjustmentError({
        idempotencyKey: "adj-123",
        existingAdjustmentId: "existing-adj-uuid"
      })

      expect(error._tag).toBe("DuplicateAdjustmentError")
    })

    it("should include idempotencyKey context", () => {
      const error = new DuplicateAdjustmentError({
        idempotencyKey: "adj-123",
        existingAdjustmentId: "existing-adj-uuid"
      })

      expect(error.idempotencyKey).toBe("adj-123")
    })

    it("should include existingAdjustmentId for idempotent response", () => {
      const error = new DuplicateAdjustmentError({
        idempotencyKey: "adj-123",
        existingAdjustmentId: "existing-adj-uuid"
      })

      expect(error.existingAdjustmentId).toBe("existing-adj-uuid")
    })
  })
})
