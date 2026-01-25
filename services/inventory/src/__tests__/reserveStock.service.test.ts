import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime, Exit } from "effect"
import { InventoryService, ReserveStockRequest } from "../services/InventoryService.js"
import { InventoryServiceLive } from "../services/InventoryServiceLive.js"
import { StockAdjustmentRepository, AtomicAddStockResult } from "../repositories/StockAdjustmentRepository.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { ReservationRepository, AtomicReserveResult } from "../repositories/ReservationRepository.js"
import { Product, ProductId } from "../domain/Product.js"
import { InventoryReservation, ReservationId } from "../domain/Reservation.js"
import { ProductNotFoundError, InsufficientStockError } from "../domain/errors.js"

// Test fixtures
const testProductId1 = "550e8400-e29b-41d4-a716-446655440000" as ProductId
const testProductId2 = "550e8400-e29b-41d4-a716-446655440001" as ProductId
const testOrderId = "660e8400-e29b-41d4-a716-446655440000"
const testReservationId1 = "770e8400-e29b-41d4-a716-446655440000" as ReservationId
const testReservationId2 = "770e8400-e29b-41d4-a716-446655440001" as ReservationId

const testProduct = new Product({
  id: testProductId1,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 50,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testReservation1 = new InventoryReservation({
  id: testReservationId1,
  orderId: testOrderId,
  productId: testProductId1,
  quantity: 2,
  status: "RESERVED",
  createdAt: DateTime.unsafeNow(),
  releasedAt: null
})

const testReservation2 = new InventoryReservation({
  id: testReservationId2,
  orderId: testOrderId,
  productId: testProductId2,
  quantity: 1,
  status: "RESERVED",
  createdAt: DateTime.unsafeNow(),
  releasedAt: null
})

// Mock StockAdjustmentRepository factory
const createMockStockAdjustmentRepo = (overrides: {
  addStockAtomic?: (params: any) => Effect.Effect<AtomicAddStockResult>
} = {}) => {
  return Layer.succeed(StockAdjustmentRepository, {
    addStockAtomic: overrides.addStockAtomic ?? (() =>
      Effect.succeed({
        _tag: "ProductNotFound"
      } as const))
  })
}

// Mock ProductRepository factory
const createMockProductRepo = (overrides: {
  findById?: (id: ProductId) => Effect.Effect<Option.Option<Product>>
  findBySku?: (sku: string) => Effect.Effect<Option.Option<Product>>
  insert?: (row: any) => Effect.Effect<Product>
  updateStock?: (id: ProductId, quantity: number) => Effect.Effect<void>
} = {}) => {
  return Layer.succeed(ProductRepository, {
    findById: overrides.findById ?? (() => Effect.succeed(Option.some(testProduct))),
    findBySku: overrides.findBySku ?? (() => Effect.succeed(Option.none())),
    insert: overrides.insert ?? (() => Effect.succeed(testProduct)),
    updateStock: overrides.updateStock ?? (() => Effect.void)
  })
}

// Mock ReservationRepository factory
const createMockReservationRepo = (overrides: {
  reserveStockAtomic?: (orderId: string, items: readonly any[]) => Effect.Effect<AtomicReserveResult>
  findByOrderId?: (orderId: string) => Effect.Effect<ReadonlyArray<InventoryReservation>>
  releaseByOrderId?: (orderId: string) => Effect.Effect<void>
} = {}) => {
  return Layer.succeed(ReservationRepository, {
    reserveStockAtomic: overrides.reserveStockAtomic ?? (() =>
      Effect.succeed({
        _tag: "Reserved",
        reservations: [testReservation1]
      } as const)),
    findByOrderId: overrides.findByOrderId ?? (() => Effect.succeed([])),
    releaseByOrderId: overrides.releaseByOrderId ?? (() => Effect.void)
  })
}

describe("InventoryService", () => {
  describe("reserveStock", () => {
    it("should successfully reserve stock for single item", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: () =>
          Effect.succeed({
            _tag: "Reserved",
            reservations: [testReservation1]
          } as const)
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 2 }]
      }

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result).toHaveLength(1)
      expect(result[0]).toBe(testReservationId1)
    })

    it("should successfully reserve stock for multiple items", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: () =>
          Effect.succeed({
            _tag: "Reserved",
            reservations: [testReservation1, testReservation2]
          } as const)
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [
          { productId: testProductId1, quantity: 2 },
          { productId: testProductId2, quantity: 1 }
        ]
      }

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result).toHaveLength(2)
      expect(result).toContain(testReservationId1)
      expect(result).toContain(testReservationId2)
    })

    it("should fail with ProductNotFoundError when product does not exist", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: () =>
          Effect.succeed({
            _tag: "ProductNotFound",
            productId: testProductId1
          } as const)
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 2 }]
      }

      const exit = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ProductNotFoundError")
          const notFoundError = error.error as ProductNotFoundError
          expect(notFoundError.productId).toBe(testProductId1)
          expect(notFoundError.searchedBy).toBe("id")
        }
      }
    })

    it("should fail with InsufficientStockError when stock is insufficient", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: () =>
          Effect.succeed({
            _tag: "InsufficientStock",
            productId: testProductId1,
            productSku: "TEST-001",
            requested: 100,
            available: 50
          } as const)
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 100 }]
      }

      const exit = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("InsufficientStockError")
          const insufficientError = error.error as InsufficientStockError
          expect(insufficientError.productId).toBe(testProductId1)
          expect(insufficientError.productSku).toBe("TEST-001")
          expect(insufficientError.requested).toBe(100)
          expect(insufficientError.available).toBe(50)
        }
      }
    })

    it("should return existing reservations on idempotent retry", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: () =>
          Effect.succeed({
            _tag: "AlreadyReserved",
            reservations: [testReservation1, testReservation2]
          } as const)
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [
          { productId: testProductId1, quantity: 2 },
          { productId: testProductId2, quantity: 1 }
        ]
      }

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result).toHaveLength(2)
      expect(result).toContain(testReservationId1)
      expect(result).toContain(testReservationId2)
    })

    it("should pass correct parameters to repository", async () => {
      let capturedOrderId: string | null = null
      let capturedItems: any[] | null = null

      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        reserveStockAtomic: (orderId, items) => {
          capturedOrderId = orderId
          capturedItems = items as any[]
          return Effect.succeed({
            _tag: "Reserved",
            reservations: [testReservation1]
          } as const)
        }
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const request: ReserveStockRequest = {
        orderId: testOrderId,
        items: [{ productId: testProductId1, quantity: 5 }]
      }

      await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.reserveStock(request)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(capturedOrderId).toBe(testOrderId)
      expect(capturedItems).not.toBeNull()
      expect(capturedItems).toHaveLength(1)
      expect(capturedItems![0].productId).toBe(testProductId1)
      expect(capturedItems![0].quantity).toBe(5)
    })
  })

  describe("releaseStock", () => {
    it("should call repository to release stock", async () => {
      let capturedOrderId: string | null = null

      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo({
        releaseByOrderId: (orderId) => {
          capturedOrderId = orderId
          return Effect.void
        }
      })

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.releaseStock(testOrderId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(capturedOrderId).toBe(testOrderId)
    })
  })
})
