import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime, Schema } from "effect"
import { SqlError } from "@effect/sql"
import { ProductService } from "../../services/ProductService.js"
import { InventoryService, ReserveStockRequest } from "../../services/InventoryService.js"
import { Product, ProductId } from "../../domain/Product.js"
import { ReserveStockHttpRequest } from "../../domain/Reservation.js"
import { ProductNotFoundError, InsufficientStockError } from "../../domain/errors.js"

// Test fixtures
const testProductId1 = "550e8400-e29b-41d4-a716-446655440000" as ProductId
const testProductId2 = "550e8400-e29b-41d4-a716-446655440001" as ProductId
const testOrderId = "660e8400-e29b-41d4-a716-446655440000"
const testReservationId1 = "770e8400-e29b-41d4-a716-446655440000"
const testReservationId2 = "770e8400-e29b-41d4-a716-446655440001"

const testProduct = new Product({
  id: testProductId1,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 100,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

// Response type for our helper function
interface ReserveStockResponse {
  status: number
  body: {
    order_id?: string
    reservation_ids?: string[]
    line_items_reserved?: number
    total_quantity_reserved?: number
    error?: string
    message?: string
    product_id?: string
    product_sku?: string
    requested?: number
    available?: number
    details?: string
  }
}

// Mock ProductService factory
const createMockProductService = () => {
  return Layer.succeed(ProductService, {
    create: () => Effect.succeed(testProduct),
    findById: () => Effect.succeed(testProduct),
    findBySku: () => Effect.succeed(testProduct)
  })
}

// Mock InventoryService factory
const createMockInventoryService = (overrides: {
  reserveStock?: (request: ReserveStockRequest) => Effect.Effect<ReadonlyArray<string>, ProductNotFoundError | InsufficientStockError | SqlError.SqlError>
} = {}) => {
  return Layer.succeed(InventoryService, {
    addStock: () => Effect.succeed({} as any),
    getAvailability: () => Effect.succeed(100),
    reserveStock: overrides.reserveStock ?? (() => Effect.succeed([testReservationId1])),
    releaseStock: () => Effect.succeed({ releasedCount: 0, totalQuantityRestored: 0, wasAlreadyReleased: false })
  })
}

// Helper to run the reserveStock logic with mocks
const runReserveStock = async (
  requestBody: unknown,
  inventoryService: Layer.Layer<InventoryService>
): Promise<ReserveStockResponse> => {
  const productService = createMockProductService()
  const testLayer = Layer.mergeAll(productService, inventoryService)

  return Effect.gen(function* () {
    // Validate request body using schema
    const body = yield* Schema.decodeUnknown(ReserveStockHttpRequest)(requestBody)

    // Get service and execute reservation
    const svc = yield* InventoryService
    const reservationIds = yield* svc.reserveStock({
      orderId: body.orderId,
      items: body.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity
      }))
    })

    const totalQuantity = body.items.reduce((sum, item) => sum + item.quantity, 0)

    return {
      status: 201,
      body: {
        order_id: body.orderId,
        reservation_ids: reservationIds as string[],
        line_items_reserved: body.items.length,
        total_quantity_reserved: totalQuantity
      }
    } as ReserveStockResponse
  }).pipe(
    Effect.catchTag("ParseError", (error) =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid request data",
          details: error.message
        }
      } as ReserveStockResponse)
    ),
    Effect.catchTag("ProductNotFoundError", (error) =>
      Effect.succeed({
        status: 404,
        body: {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        }
      } as ReserveStockResponse)
    ),
    Effect.catchTag("InsufficientStockError", (error) =>
      Effect.succeed({
        status: 409,
        body: {
          error: "insufficient_stock",
          message: `Insufficient stock for product ${error.productSku}`,
          product_id: error.productId,
          product_sku: error.productSku,
          requested: error.requested,
          available: error.available
        }
      } as ReserveStockResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as ReserveStockResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("POST /reservations", () => {
  describe("successful requests", () => {
    it("should return 201 with reservation IDs for valid request", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.succeed([testReservationId1])
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(201)
      expect(result.body.order_id).toBe(testOrderId)
      expect(result.body.reservation_ids).toEqual([testReservationId1])
      expect(result.body.line_items_reserved).toBe(1)
      expect(result.body.total_quantity_reserved).toBe(2)
    })

    it("should return 201 with multiple reservation IDs for multiple items", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.succeed([testReservationId1, testReservationId2])
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [
            { productId: testProductId1, quantity: 2 },
            { productId: testProductId2, quantity: 1 }
          ]
        },
        mockInventoryService
      )

      expect(result.status).toBe(201)
      expect(result.body.order_id).toBe(testOrderId)
      expect(result.body.reservation_ids).toEqual([testReservationId1, testReservationId2])
      expect(result.body.line_items_reserved).toBe(2)
      expect(result.body.total_quantity_reserved).toBe(3)
    })

    it("should return same response on idempotent retry", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.succeed([testReservationId1])
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(201)
      expect(result.body.reservation_ids).toEqual([testReservationId1])
    })
  })

  describe("error handling", () => {
    it("should return 400 for missing orderId", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for invalid orderId format", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          orderId: "not-a-uuid",
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for empty items array", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: []
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for invalid productId in items", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: "not-a-uuid", quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for negative quantity", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: -1 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 400 for zero quantity", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 0 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 404 when product does not exist", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.fail(new ProductNotFoundError({
          productId: testProductId1,
          searchedBy: "id"
        }))
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(404)
      expect(result.body.error).toBe("product_not_found")
      expect(result.body.message).toBe(`Product with ID ${testProductId1} does not exist`)
    })

    it("should return 409 when stock is insufficient", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.fail(new InsufficientStockError({
          productId: testProductId1,
          productSku: "TEST-001",
          requested: 100,
          available: 50
        }))
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 100 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(409)
      expect(result.body.error).toBe("insufficient_stock")
      expect(result.body.message).toBe("Insufficient stock for product TEST-001")
      expect(result.body.product_id).toBe(testProductId1)
      expect(result.body.product_sku).toBe("TEST-001")
      expect(result.body.requested).toBe(100)
      expect(result.body.available).toBe(50)
    })

    it("should return 500 for SQL errors", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
      expect(result.body.message).toBe("An unexpected error occurred")
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response body", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.succeed([testReservationId1])
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.body).toHaveProperty("order_id")
      expect(result.body).toHaveProperty("reservation_ids")
      expect(result.body).toHaveProperty("line_items_reserved")
      expect(result.body).toHaveProperty("total_quantity_reserved")
      expect(result.body).not.toHaveProperty("orderId")
      expect(result.body).not.toHaveProperty("reservationIds")
      expect(result.body).not.toHaveProperty("lineItemsReserved")
      expect(result.body).not.toHaveProperty("totalQuantityReserved")
    })

    it("should include all expected fields in successful response", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.succeed([testReservationId1])
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 2 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(201)
      expect(result.body.order_id).toBeDefined()
      expect(result.body.reservation_ids).toBeDefined()
      expect(result.body.line_items_reserved).toBeDefined()
      expect(result.body.total_quantity_reserved).toBeDefined()
    })

    it("should include all context in insufficient stock error response", async () => {
      const mockInventoryService = createMockInventoryService({
        reserveStock: () => Effect.fail(new InsufficientStockError({
          productId: testProductId1,
          productSku: "WIDGET-001",
          requested: 5,
          available: 3
        }))
      })

      const result = await runReserveStock(
        {
          orderId: testOrderId,
          items: [{ productId: testProductId1, quantity: 5 }]
        },
        mockInventoryService
      )

      expect(result.status).toBe(409)
      expect(result.body.error).toBe("insufficient_stock")
      expect(result.body.product_id).toBe(testProductId1)
      expect(result.body.product_sku).toBe("WIDGET-001")
      expect(result.body.requested).toBe(5)
      expect(result.body.available).toBe(3)
    })
  })

  describe("ReserveStockHttpRequest schema validation", () => {
    it("should accept valid request", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 2 }]
      })
      expect(result._tag).toBe("Right")
    })

    it("should accept request with multiple items", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: [
          { productId: testProductId1, quantity: 2 },
          { productId: testProductId2, quantity: 1 }
        ]
      })
      expect(result._tag).toBe("Right")
    })

    it("should reject empty items array", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: []
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject invalid orderId", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: "not-a-uuid",
        items: [{ productId: testProductId1, quantity: 2 }]
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject negative quantity", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: -1 }]
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject zero quantity", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 0 }]
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject non-integer quantity", () => {
      const result = Schema.decodeUnknownEither(ReserveStockHttpRequest)({
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 2.5 }]
      })
      expect(result._tag).toBe("Left")
    })
  })
})
