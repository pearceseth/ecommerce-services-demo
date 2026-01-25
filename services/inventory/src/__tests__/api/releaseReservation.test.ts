import { describe, it, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqlError } from "@effect/sql"
import { InventoryService } from "../../services/InventoryService.js"
import { ProductService } from "../../services/ProductService.js"
import { OrderIdParams } from "../../domain/Reservation.js"
import type { ReleaseReservationResult } from "../../repositories/ReservationRepository.js"

// Test fixtures
const testOrderId = "550e8400-e29b-41d4-a716-446655440000"

// Response type for our helper function
interface ReleaseResponse {
  status: number
  body: {
    order_id?: string
    released_count?: number
    total_quantity_restored?: number
    message?: string
    error?: string
  }
}

// Mock ProductService factory
const createMockProductService = () => {
  return Layer.succeed(ProductService, {
    create: () => Effect.succeed({} as any),
    findById: () => Effect.succeed({} as any),
    findBySku: () => Effect.succeed({} as any)
  })
}

// Mock InventoryService factory
const createMockInventoryService = (overrides: {
  releaseStock?: (orderId: string) => Effect.Effect<ReleaseReservationResult, SqlError.SqlError>
} = {}) => {
  return Layer.succeed(InventoryService, {
    addStock: () => Effect.succeed({} as any),
    getAvailability: () => Effect.succeed(100),
    reserveStock: () => Effect.succeed([]),
    releaseStock: overrides.releaseStock ?? (() => Effect.succeed({
      releasedCount: 0,
      totalQuantityRestored: 0,
      wasAlreadyReleased: false
    }))
  })
}

// Helper to run the release logic with mocks
const runReleaseReservation = async (
  orderId: string,
  inventoryService: Layer.Layer<InventoryService>
): Promise<ReleaseResponse> => {
  const productService = createMockProductService()
  const testLayer = Layer.mergeAll(productService, inventoryService)

  return Effect.gen(function* () {
    // Validate path parameter
    const params = yield* Schema.decodeUnknown(OrderIdParams)({ order_id: orderId })

    // Get service and execute release
    const svc = yield* InventoryService
    const result = yield* svc.releaseStock(params.order_id)

    const response = {
      order_id: params.order_id,
      released_count: result.releasedCount,
      total_quantity_restored: result.totalQuantityRestored,
      message: result.releasedCount > 0
        ? `Released ${result.releasedCount} reservation(s), restored ${result.totalQuantityRestored} units to stock`
        : result.wasAlreadyReleased
          ? "Reservations were already released"
          : "No reservations found for this order"
    }

    return { status: 200, body: response } as ReleaseResponse
  }).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.succeed({
        status: 400,
        body: {
          error: "validation_error",
          message: "Invalid order_id format. Must be a valid UUID."
        }
      } as ReleaseResponse)
    ),
    Effect.catchTag("SqlError", () =>
      Effect.succeed({
        status: 500,
        body: {
          error: "internal_error",
          message: "An unexpected error occurred"
        }
      } as ReleaseResponse)
    ),
    Effect.provide(testLayer),
    Effect.runPromise
  )
}

describe("DELETE /inventory/reservations/:order_id", () => {
  describe("successful requests", () => {
    it("should return 200 when reservations are released", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 2,
          totalQuantityRestored: 5,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.order_id).toBe(testOrderId)
      expect(result.body.released_count).toBe(2)
      expect(result.body.total_quantity_restored).toBe(5)
      expect(result.body.message).toContain("Released 2 reservation(s)")
    })

    it("should return 200 when no reservations exist (idempotent)", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.released_count).toBe(0)
      expect(result.body.total_quantity_restored).toBe(0)
      expect(result.body.message).toBe("No reservations found for this order")
    })

    it("should return 200 when reservations already released (idempotent)", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: true
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.released_count).toBe(0)
      expect(result.body.message).toBe("Reservations were already released")
    })

    it("should return correct message for single reservation release", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 1,
          totalQuantityRestored: 3,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.message).toBe("Released 1 reservation(s), restored 3 units to stock")
    })
  })

  describe("error handling", () => {
    it("should return 400 for invalid order_id format", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReleaseReservation("not-a-uuid", mockInventoryService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
      expect(result.body.message).toContain("Invalid order_id format")
    })

    it("should return 400 for empty order_id", async () => {
      const mockInventoryService = createMockInventoryService()

      const result = await runReleaseReservation("", mockInventoryService)

      expect(result.status).toBe(400)
      expect(result.body.error).toBe("validation_error")
    })

    it("should return 500 for SQL errors", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.fail(new SqlError.SqlError({
          cause: new Error("Connection failed"),
          message: "Database connection error"
        }))
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(500)
      expect(result.body.error).toBe("internal_error")
    })
  })

  describe("response format", () => {
    it("should use snake_case keys in response body", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 1,
          totalQuantityRestored: 3,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.body).toHaveProperty("order_id")
      expect(result.body).toHaveProperty("released_count")
      expect(result.body).toHaveProperty("total_quantity_restored")
      expect(result.body).not.toHaveProperty("orderId")
      expect(result.body).not.toHaveProperty("releasedCount")
    })

    it("should include all expected fields in successful response", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 2,
          totalQuantityRestored: 10,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.order_id).toBeDefined()
      expect(result.body.released_count).toBeDefined()
      expect(result.body.total_quantity_restored).toBeDefined()
      expect(result.body.message).toBeDefined()
    })
  })

  describe("OrderIdParams schema validation", () => {
    it("should accept valid UUID", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({
        order_id: testOrderId
      })
      expect(result._tag).toBe("Right")
    })

    it("should reject invalid UUID", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({
        order_id: "not-a-uuid"
      })
      expect(result._tag).toBe("Left")
    })

    it("should reject missing order_id", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({})
      expect(result._tag).toBe("Left")
    })

    it("should reject null order_id", () => {
      const result = Schema.decodeUnknownEither(OrderIdParams)({
        order_id: null
      })
      expect(result._tag).toBe("Left")
    })

    it("should accept different valid UUIDs", () => {
      const uuids = [
        "123e4567-e89b-12d3-a456-426614174000",
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "00000000-0000-0000-0000-000000000000"
      ]

      for (const uuid of uuids) {
        const result = Schema.decodeUnknownEither(OrderIdParams)({
          order_id: uuid
        })
        expect(result._tag).toBe("Right")
      }
    })
  })

  describe("idempotency behavior", () => {
    it("should return success for repeated calls on already released order", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: true
        })
      })

      // First call
      const result1 = await runReleaseReservation(testOrderId, mockInventoryService)
      // Second call (simulating idempotent retry)
      const result2 = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result1.status).toBe(200)
      expect(result2.status).toBe(200)
      expect(result1.body.message).toBe("Reservations were already released")
      expect(result2.body.message).toBe("Reservations were already released")
    })

    it("should return success for order that never had reservations", async () => {
      const mockInventoryService = createMockInventoryService({
        releaseStock: () => Effect.succeed({
          releasedCount: 0,
          totalQuantityRestored: 0,
          wasAlreadyReleased: false
        })
      })

      const result = await runReleaseReservation(testOrderId, mockInventoryService)

      expect(result.status).toBe(200)
      expect(result.body.released_count).toBe(0)
      expect(result.body.message).toBe("No reservations found for this order")
    })
  })
})
