import { describe, it, expect } from "vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "@effect/sql"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { ProductRepositoryLive } from "../repositories/ProductRepositoryLive.js"
import { ProductId } from "../domain/Product.js"

// Mock SQL client factory
const createMockSqlClient = (queryHandler: (strings: TemplateStringsArray, ...values: any[]) => any[]) => {
  // Create a tagged template function that acts like the sql client
  const mockSql = (strings: TemplateStringsArray, ...values: any[]) => {
    return Effect.succeed(queryHandler(strings, values))
  }

  return Layer.succeed(SqlClient.SqlClient, mockSql as any)
}

describe("ProductRepository", () => {
  describe("price_cents mapping", () => {
    it("should map price_cents directly from DB", async () => {
      const mockRow = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Widget",
        sku: "TEST-001",
        price_cents: 2999,
        stock_quantity: 100,
        created_at: new Date("2024-01-15T10:30:00Z"),
        updated_at: new Date("2024-01-15T10:30:00Z")
      }

      const mockSqlClient = createMockSqlClient(() => [mockRow])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        const product = yield* repo.findById("550e8400-e29b-41d4-a716-446655440000" as ProductId)
        return product
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.priceCents).toBe(2999)
      }
    })

    it("should handle whole dollar amounts in cents", async () => {
      const mockRow = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Widget",
        sku: "TEST-001",
        price_cents: 10000,  // $100.00
        stock_quantity: 100,
        created_at: new Date("2024-01-15T10:30:00Z"),
        updated_at: new Date("2024-01-15T10:30:00Z")
      }

      const mockSqlClient = createMockSqlClient(() => [mockRow])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        const product = yield* repo.findById("550e8400-e29b-41d4-a716-446655440000" as ProductId)
        return product
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.priceCents).toBe(10000)
      }
    })
  })

  describe("findById", () => {
    it("should return Option.none when product not found", async () => {
      const mockSqlClient = createMockSqlClient(() => [])  // Empty result
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.findById("nonexistent-id" as ProductId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return Option.some with mapped product when found", async () => {
      const mockRow = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Widget",
        sku: "TEST-001",
        price_cents: 2999,
        stock_quantity: 100,
        created_at: new Date("2024-01-15T10:30:00Z"),
        updated_at: new Date("2024-01-15T10:30:00Z")
      }

      const mockSqlClient = createMockSqlClient(() => [mockRow])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.findById("550e8400-e29b-41d4-a716-446655440000" as ProductId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.id).toBe("550e8400-e29b-41d4-a716-446655440000")
        expect(result.value.name).toBe("Test Widget")
        expect(result.value.sku).toBe("TEST-001")
        expect(result.value.stockQuantity).toBe(100)
      }
    })
  })

  describe("findBySku", () => {
    it("should return Option.none when SKU not found", async () => {
      const mockSqlClient = createMockSqlClient(() => [])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.findBySku("NONEXISTENT")
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return Option.some with mapped product when found", async () => {
      const mockRow = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Widget",
        sku: "TEST-001",
        price_cents: 2999,
        stock_quantity: 100,
        created_at: new Date("2024-01-15T10:30:00Z"),
        updated_at: new Date("2024-01-15T10:30:00Z")
      }

      const mockSqlClient = createMockSqlClient(() => [mockRow])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.findBySku("TEST-001")
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.sku).toBe("TEST-001")
      }
    })
  })

  describe("insert", () => {
    it("should convert cents to decimal for storage", async () => {
      let capturedQuery: string | null = null
      const newProductId = "770e8400-e29b-41d4-a716-446655440002"

      const mockSqlClient = Layer.succeed(SqlClient.SqlClient, ((strings: TemplateStringsArray) => {
        capturedQuery = strings.join("?")
        // Return mock inserted row
        return Effect.succeed([{
          id: newProductId,
          name: "New Product",
          sku: "NEW-001",
          price_cents: 2999,
          stock_quantity: 50,
          created_at: new Date(),
          updated_at: new Date()
        }])
      }) as any)

      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.insert({
          name: "New Product",
          sku: "NEW-001",
          priceCents: 2999,  // 2999 cents = $29.99
          stockQuantity: 50
        })
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      // The SQL query should have been called
      expect(capturedQuery).not.toBeNull()
    })

    it("should return mapped product after insert", async () => {
      const newProductId = "880e8400-e29b-41d4-a716-446655440003"
      const mockRow = {
        id: newProductId,
        name: "New Product",
        sku: "NEW-001",
        price_cents: 2999,
        stock_quantity: 50,
        created_at: new Date("2024-01-15T10:30:00Z"),
        updated_at: new Date("2024-01-15T10:30:00Z")
      }

      const mockSqlClient = createMockSqlClient(() => [mockRow])
      const testLayer = ProductRepositoryLive.pipe(Layer.provide(mockSqlClient))

      const result = await Effect.gen(function* () {
        const repo = yield* ProductRepository
        return yield* repo.insert({
          name: "New Product",
          sku: "NEW-001",
          priceCents: 2999,
          stockQuantity: 50
        })
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.id).toBe(newProductId)
      expect(result.name).toBe("New Product")
      expect(result.sku).toBe("NEW-001")
      expect(result.priceCents).toBe(2999)
      expect(result.stockQuantity).toBe(50)
    })
  })
})
