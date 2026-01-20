import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime, Exit } from "effect"
import { ProductService } from "../services/ProductService.js"
import { ProductServiceLive } from "../services/ProductServiceLive.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { Product, ProductId, CreateProductRequest } from "../domain/Product.js"
import { DuplicateSkuError, ProductNotFoundError } from "../domain/errors.js"

// Test fixtures
const testProduct = new Product({
  id: "550e8400-e29b-41d4-a716-446655440000" as ProductId,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 100,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testCreateRequest = new CreateProductRequest({
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  initialStock: 100
})

// Mock repository factory
const createMockRepo = (overrides: {
  findBySku?: (sku: string) => Effect.Effect<Option.Option<Product>>
  findById?: (id: ProductId) => Effect.Effect<Option.Option<Product>>
  insert?: (row: any) => Effect.Effect<Product>
  updateStock?: (id: ProductId, quantity: number) => Effect.Effect<void>
} = {}) => {
  return Layer.succeed(ProductRepository, {
    findBySku: overrides.findBySku ?? (() => Effect.succeed(Option.none())),
    findById: overrides.findById ?? (() => Effect.succeed(Option.none())),
    insert: overrides.insert ?? (() => Effect.succeed(testProduct)),
    updateStock: overrides.updateStock ?? (() => Effect.void)
  })
}

describe("ProductService", () => {
  describe("create", () => {
    it("should create a product when SKU is unique", async () => {
      const mockRepo = createMockRepo({
        findBySku: () => Effect.succeed(Option.none()),
        insert: () => Effect.succeed(testProduct)
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.id).toBe(testProduct.id)
      expect(result.sku).toBe(testProduct.sku)
      expect(result.name).toBe(testProduct.name)
      expect(result.priceCents).toBe(testProduct.priceCents)
      expect(result.stockQuantity).toBe(testProduct.stockQuantity)
    })

    it("should fail with DuplicateSkuError when SKU already exists", async () => {
      const existingProduct = new Product({
        ...testProduct,
        id: "660e8400-e29b-41d4-a716-446655440001" as ProductId
      })

      const mockRepo = createMockRepo({
        findBySku: () => Effect.succeed(Option.some(existingProduct))
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const exit = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        // Check if it's a fail cause with DuplicateSkuError
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("DuplicateSkuError")
          expect((error.error as DuplicateSkuError).sku).toBe("TEST-001")
          expect((error.error as DuplicateSkuError).existingProductId).toBe("660e8400-e29b-41d4-a716-446655440001")
        }
      }
    })

    it("should pass correct data to repository insert", async () => {
      let insertedRow: any = null

      const mockRepo = createMockRepo({
        findBySku: () => Effect.succeed(Option.none()),
        insert: (row) => {
          insertedRow = row
          return Effect.succeed(testProduct)
        }
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.create(testCreateRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(insertedRow).not.toBeNull()
      expect(insertedRow.name).toBe("Test Widget")
      expect(insertedRow.sku).toBe("TEST-001")
      expect(insertedRow.priceCents).toBe(2999)
      expect(insertedRow.stockQuantity).toBe(100)
    })
  })

  describe("findById", () => {
    it("should return product when found", async () => {
      const mockRepo = createMockRepo({
        findById: () => Effect.succeed(Option.some(testProduct))
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.findById(testProduct.id)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.id).toBe(testProduct.id)
      expect(result.sku).toBe(testProduct.sku)
    })

    it("should fail with ProductNotFoundError when not found", async () => {
      const mockRepo = createMockRepo({
        findById: () => Effect.succeed(Option.none())
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const exit = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.findById("nonexistent-id" as ProductId)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ProductNotFoundError")
          expect((error.error as ProductNotFoundError).productId).toBe("nonexistent-id")
          expect((error.error as ProductNotFoundError).searchedBy).toBe("id")
        }
      }
    })
  })

  describe("findBySku", () => {
    it("should return product when found", async () => {
      const mockRepo = createMockRepo({
        findBySku: () => Effect.succeed(Option.some(testProduct))
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const result = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.findBySku("TEST-001")
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.id).toBe(testProduct.id)
      expect(result.sku).toBe("TEST-001")
    })

    it("should fail with ProductNotFoundError when not found", async () => {
      const mockRepo = createMockRepo({
        findBySku: () => Effect.succeed(Option.none())
      })

      const testLayer = ProductServiceLive.pipe(Layer.provide(mockRepo))

      const exit = await Effect.gen(function* () {
        const service = yield* ProductService
        return yield* service.findBySku("NONEXISTENT-SKU")
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ProductNotFoundError")
          expect((error.error as ProductNotFoundError).productId).toBe("NONEXISTENT-SKU")
          expect((error.error as ProductNotFoundError).searchedBy).toBe("sku")
        }
      }
    })
  })
})
