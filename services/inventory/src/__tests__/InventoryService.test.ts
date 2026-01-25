import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime, Exit } from "effect"
import { InventoryService } from "../services/InventoryService.js"
import { InventoryServiceLive } from "../services/InventoryServiceLive.js"
import { StockAdjustmentRepository, AtomicAddStockResult } from "../repositories/StockAdjustmentRepository.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { ReservationRepository, AtomicReserveResult } from "../repositories/ReservationRepository.js"
import { Product, ProductId } from "../domain/Product.js"
import { InventoryAdjustment, AdjustmentId, AddStockRequest, AdjustmentReason } from "../domain/Adjustment.js"
import { ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"

// Test fixtures
const testProductId = "550e8400-e29b-41d4-a716-446655440000" as ProductId
const testAdjustmentId = "660e8400-e29b-41d4-a716-446655440001" as AdjustmentId
const testIdempotencyKey = "test-idempotency-key-001"

const testProduct = new Product({
  id: testProductId,
  name: "Test Widget",
  sku: "TEST-001",
  priceCents: 2999,
  stockQuantity: 50,
  createdAt: DateTime.unsafeNow(),
  updatedAt: DateTime.unsafeNow()
})

const testAdjustment = new InventoryAdjustment({
  id: testAdjustmentId,
  idempotencyKey: testIdempotencyKey,
  productId: testProductId,
  quantityChange: 100,
  previousQuantity: 50,
  newQuantity: 150,
  reason: "warehouse_receiving" as AdjustmentReason,
  referenceId: "PO-2024-001",
  notes: "Q1 restock",
  createdBy: null,
  createdAt: DateTime.unsafeNow()
})

const testAddStockRequest = new AddStockRequest({
  quantity: 100,
  reason: "warehouse_receiving" as AdjustmentReason,
  referenceId: Option.some("PO-2024-001"),
  notes: Option.some("Q1 restock")
})

// Mock StockAdjustmentRepository factory
const createMockStockAdjustmentRepo = (overrides: {
  addStockAtomic?: (params: any) => Effect.Effect<AtomicAddStockResult>
} = {}) => {
  return Layer.succeed(StockAdjustmentRepository, {
    addStockAtomic: overrides.addStockAtomic ?? (() =>
      Effect.succeed({
        _tag: "Created",
        adjustment: testAdjustment,
        sku: "TEST-001"
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
  findByOrderId?: (orderId: string) => Effect.Effect<readonly any[]>
  releaseByOrderId?: (orderId: string) => Effect.Effect<void>
} = {}) => {
  return Layer.succeed(ReservationRepository, {
    reserveStockAtomic: overrides.reserveStockAtomic ?? (() =>
      Effect.succeed({ _tag: "Reserved", reservations: [] } as const)),
    findByOrderId: overrides.findByOrderId ?? (() => Effect.succeed([])),
    releaseByOrderId: overrides.releaseByOrderId ?? (() => Effect.void)
  })
}

describe("InventoryService", () => {
  describe("addStock", () => {
    it("should add stock successfully with new idempotency key", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo({
        addStockAtomic: () =>
          Effect.succeed({
            _tag: "Created",
            adjustment: testAdjustment,
            sku: "TEST-001"
          } as const)
      })
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.addStock(testProductId, testIdempotencyKey, testAddStockRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result.productId).toBe(testProductId)
      expect(result.sku).toBe("TEST-001")
      expect(result.previousQuantity).toBe(50)
      expect(result.addedQuantity).toBe(100)
      expect(result.newQuantity).toBe(150)
      expect(result.adjustmentId).toBe(testAdjustmentId)
    })

    it("should fail with DuplicateAdjustmentError when idempotency key already used", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo({
        addStockAtomic: () =>
          Effect.succeed({
            _tag: "AlreadyExists",
            adjustment: testAdjustment
          } as const)
      })
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const exit = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.addStock(testProductId, testIdempotencyKey, testAddStockRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("DuplicateAdjustmentError")
          const dupError = error.error as DuplicateAdjustmentError
          expect(dupError.idempotencyKey).toBe(testIdempotencyKey)
          expect(dupError.existingAdjustment.adjustmentId).toBe(testAdjustmentId)
          expect(dupError.existingAdjustment.previousQuantity).toBe(50)
          expect(dupError.existingAdjustment.addedQuantity).toBe(100)
          expect(dupError.existingAdjustment.newQuantity).toBe(150)
        }
      }
    })

    it("should fail with ProductNotFoundError when product does not exist", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo({
        addStockAtomic: () =>
          Effect.succeed({
            _tag: "ProductNotFound"
          } as const)
      })
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const nonExistentProductId = "00000000-0000-0000-0000-000000000000" as ProductId

      const exit = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.addStock(nonExistentProductId, testIdempotencyKey, testAddStockRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ProductNotFoundError")
          const notFoundError = error.error as ProductNotFoundError
          expect(notFoundError.productId).toBe(nonExistentProductId)
          expect(notFoundError.searchedBy).toBe("id")
        }
      }
    })

    it("should pass correct parameters to repository", async () => {
      let capturedParams: any = null

      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo({
        addStockAtomic: (params) => {
          capturedParams = params
          return Effect.succeed({
            _tag: "Created",
            adjustment: testAdjustment,
            sku: "TEST-001"
          } as const)
        }
      })
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.addStock(testProductId, testIdempotencyKey, testAddStockRequest)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(capturedParams).not.toBeNull()
      expect(capturedParams.idempotencyKey).toBe(testIdempotencyKey)
      expect(capturedParams.productId).toBe(testProductId)
      expect(capturedParams.quantity).toBe(100)
      expect(capturedParams.reason).toBe("warehouse_receiving")
      expect(capturedParams.referenceId).toBe("PO-2024-001")
      expect(capturedParams.notes).toBe("Q1 restock")
      expect(capturedParams.createdBy).toBeNull()
    })

    it("should handle request with optional fields as none", async () => {
      let capturedParams: any = null

      const requestWithoutOptionals = new AddStockRequest({
        quantity: 50,
        reason: "manual_adjustment" as AdjustmentReason,
        referenceId: Option.none(),
        notes: Option.none()
      })

      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo({
        addStockAtomic: (params) => {
          capturedParams = params
          return Effect.succeed({
            _tag: "Created",
            adjustment: new InventoryAdjustment({
              ...testAdjustment,
              quantityChange: 50,
              previousQuantity: 50,
              newQuantity: 100,
              reason: "manual_adjustment" as AdjustmentReason,
              referenceId: null,
              notes: null
            }),
            sku: "TEST-001"
          } as const)
        }
      })
      const mockProductRepo = createMockProductRepo()
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.addStock(testProductId, "new-key", requestWithoutOptionals)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(capturedParams.referenceId).toBeNull()
      expect(capturedParams.notes).toBeNull()
      expect(result.addedQuantity).toBe(50)
    })
  })

  describe("getAvailability", () => {
    it("should return stock quantity when product exists", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo({
        findById: () => Effect.succeed(Option.some(testProduct))
      })
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const result = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.getAvailability(testProductId)
      }).pipe(Effect.provide(testLayer), Effect.runPromise)

      expect(result).toBe(50)
    })

    it("should fail with ProductNotFoundError when product does not exist", async () => {
      const mockStockAdjustmentRepo = createMockStockAdjustmentRepo()
      const mockProductRepo = createMockProductRepo({
        findById: () => Effect.succeed(Option.none())
      })
      const mockReservationRepo = createMockReservationRepo()

      const testLayer = InventoryServiceLive.pipe(
        Layer.provide(Layer.mergeAll(mockStockAdjustmentRepo, mockProductRepo, mockReservationRepo))
      )

      const exit = await Effect.gen(function* () {
        const service = yield* InventoryService
        return yield* service.getAvailability("nonexistent-id" as ProductId)
      }).pipe(Effect.provide(testLayer), Effect.runPromiseExit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = exit.cause
        expect(error._tag).toBe("Fail")
        if (error._tag === "Fail") {
          expect(error.error._tag).toBe("ProductNotFoundError")
        }
      }
    })
  })
})
