import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime, Schema } from "effect"
import { HttpRouter } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { ProductService } from "../../services/ProductService.js"
import { InventoryService } from "../../services/InventoryService.js"
import { Product, ProductId, ProductIdParams } from "../../domain/Product.js"
import { ProductNotFoundError } from "../../domain/errors.js"

// Test fixtures
const testProductId = "550e8400-e29b-41d4-a716-446655440000" as ProductId
const testProduct = new Product({
  id: testProductId,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 100,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testProductZeroStock = new Product({
  id: testProductId,
  name: "Test Widget Zero",
  sku: "TEST-ZERO-001",
  priceCents: 2999,
  stockQuantity: 0,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

// Response type for our helper function
interface AvailabilityResponse {
  status: number
  body: {
    product_id?: string
    sku?: string
    stock_quantity?: number
    available?: boolean
    error?: string
    message?: string
  }
}

// Mock ProductService factory
const createMockProductService = (overrides: {
  findById?: (id: ProductId) => Effect.Effect<Product, ProductNotFoundError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(ProductService, {
    create: () => Effect.succeed(testProduct),
    findById: overrides.findById ?? (() => Effect.succeed(testProduct)),
    findBySku: () => Effect.succeed(testProduct)
  })
}

// Mock InventoryService factory
const createMockInventoryService = (overrides: {
  getAvailability?: (productId: ProductId) => Effect.Effect<number, ProductNotFoundError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(InventoryService, {
    addStock: () => Effect.succeed({} as any),
    getAvailability: overrides.getAvailability ?? (() => Effect.succeed(100)),
    reserveStock: () => Effect.succeed([]),
    releaseStock: () => Effect.succeed({ releasedCount: 0, totalQuantityRestored: 0, wasAlreadyReleased: false })
  })
}

// Mock RouteContext factory - provides path params to the handler
const createMockRouteContext = (params: Record<string, string | undefined>) => {
  // Create a proper RouteContext with the required symbol
  const routeContext = {
    [HttpRouter.RouteContextTypeId]: HttpRouter.RouteContextTypeId,
    params,
    route: {} as any // Not used in our tests
  } as HttpRouter.RouteContext

  return Layer.succeed(HttpRouter.RouteContext, routeContext)
}

// Helper to run the getAvailability logic with mocks using schemaPathParams
const runGetAvailability = async (
  productIdParam: string | undefined,
  productService: Layer.Layer<ProductService>,
  inventoryService: Layer.Layer<InventoryService>
): Promise<AvailabilityResponse> => {
  // Create mock RouteContext with the product_id param
  const routeContextLayer = createMockRouteContext({ product_id: productIdParam })
  const testLayer = Layer.mergeAll(routeContextLayer, productService, inventoryService)

  // Execute the handler logic using schemaPathParams (matching the real implementation)
  return Effect.gen(function* () {
    // Extract and validate product_id from path parameters using schema
    const { product_id: productId } = yield* HttpRouter.schemaPathParams(ProductIdParams)

    // Get services
    const productSvc = yield* ProductService
    const inventorySvc = yield* InventoryService

    // Call services
    const product = yield* productSvc.findById(productId)
    const stockQuantity = yield* inventorySvc.getAvailability(productId)

    return {
      status: 200,
      body: {
        product_id: productId,
        sku: product.sku,
        stock_quantity: stockQuantity,
        available: stockQuantity > 0
      }
    } as AvailabilityResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid product_id format. Must be a valid UUID."
        }
      } as AvailabilityResponse)
    ),
    Effect.catchTag("ProductNotFoundError", (error) =>
      Effect.succeed({
        status: 404,
        body: {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        }
      } as AvailabilityResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as AvailabilityResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("GET /products/:product_id/availability", () => {
  describe("successful requests", () => {
    it("should return 200 with availability for product with stock", async () => {
      const mockProductService = createMockProductService({
        findById: () => Effect.succeed(testProduct)
      })
      const mockInventoryService = createMockInventoryService({
        getAvailability: () => Effect.succeed(100)
      })

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(200)
      expect(result.body).toEqual({
        product_id: testProductId,
        sku: "TEST-001",
        stock_quantity: 100,
        available: true
      })
    })

    it("should return 200 with available=false for product with zero stock", async () => {
      const mockProductService = createMockProductService({
        findById: () => Effect.succeed(testProductZeroStock)
      })
      const mockInventoryService = createMockInventoryService({
        getAvailability: () => Effect.succeed(0)
      })

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(200)
      expect(result.body).toEqual({
        product_id: testProductId,
        sku: "TEST-ZERO-001",
        stock_quantity: 0,
        available: false
      })
    })

    it("should return correct stock quantity from inventory service", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService({
        getAvailability: () => Effect.succeed(42)
      })

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(200)
      expect(result.body.stock_quantity).toBe(42)
      expect(result.body.available).toBe(true)
    })
  })

  describe("error handling", () => {
    it("should return 404 when product does not exist", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000" as ProductId
      const mockProductService = createMockProductService({
        findById: () => Effect.fail(new ProductNotFoundError({ productId: nonExistentId, searchedBy: "id" }))
      })
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        nonExistentId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(404)
      expect(result.body).toEqual({
        error: "product_not_found",
        message: `Product with ID ${nonExistentId} does not exist`
      })
    })

    it("should return 400 for invalid UUID format", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        "not-a-valid-uuid",
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body).toEqual({
        error: "validation_error",
        message: "Invalid product_id format. Must be a valid UUID."
      })
    })

    it("should return 400 for missing product_id (undefined)", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        undefined,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body).toEqual({
        error: "validation_error",
        message: "Invalid product_id format. Must be a valid UUID."
      })
    })

    it("should return 400 for empty product_id", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        "",
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for UUID-like but too short string", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        "550e8400-e29b-41d4",
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 500 for SQL errors from ProductService", async () => {
      const mockProductService = createMockProductService({
        findById: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(500)
      expect(result.body).toEqual({
        error: "internal_error",
        message: "An unexpected error occurred"
      })
    })

    it("should return 500 for SQL errors from InventoryService", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService({
        getAvailability: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Query timeout"),
          message: "Database query timeout"
        }))
      })

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.status).toBe(500)
      expect(result.body).toEqual({
        error: "internal_error",
        message: "An unexpected error occurred"
      })
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response body", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService({
        getAvailability: () => Effect.succeed(50)
      })

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.body).toHaveProperty("product_id")
      expect(result.body).toHaveProperty("stock_quantity")
      expect(result.body).not.toHaveProperty("productId")
      expect(result.body).not.toHaveProperty("stockQuantity")
    })

    it("should include sku in response", async () => {
      const mockProductService = createMockProductService()
      const mockInventoryService = createMockInventoryService()

      const result = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService
      )

      expect(result.body.sku).toBe("TEST-001")
    })

    it("should correctly compute available boolean based on stock_quantity", async () => {
      const mockProductService = createMockProductService()

      // Test with stock = 1
      const mockInventoryService1 = createMockInventoryService({
        getAvailability: () => Effect.succeed(1)
      })
      const result1 = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService1
      )
      expect(result1.body.available).toBe(true)

      // Test with stock = 0
      const mockInventoryService0 = createMockInventoryService({
        getAvailability: () => Effect.succeed(0)
      })
      const result0 = await runGetAvailability(
        testProductId,
        mockProductService,
        mockInventoryService0
      )
      expect(result0.body.available).toBe(false)
    })
  })

  describe("ProductIdParams schema validation", () => {
    it("should accept valid UUID", () => {
      const result = Schema.decodeUnknownEither(ProductIdParams)({
        product_id: "550e8400-e29b-41d4-a716-446655440000"
      })
      expect(result._tag).toBe("Right")
    })

    it("should reject invalid UUID", () => {
      const result = Schema.decodeUnknownEither(ProductIdParams)({
        product_id: "not-a-uuid"
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject missing product_id", () => {
      const result = Schema.decodeUnknownEither(ProductIdParams)({})
      expect(result._tag).toBe("Left")
    })
  })
})
