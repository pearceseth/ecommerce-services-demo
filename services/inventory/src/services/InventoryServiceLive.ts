import { Layer, Effect, Option } from "effect"
import { InventoryService } from "./InventoryService.js"
import { StockAdjustmentRepository } from "../repositories/StockAdjustmentRepository.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { ProductNotFoundError, DuplicateAdjustmentError } from "../domain/errors.js"
import type { ProductId } from "../domain/Product.js"
import type { AddStockRequest, AddStockResponse, AdjustmentId } from "../domain/Adjustment.js"

export const InventoryServiceLive = Layer.effect(
  InventoryService,
  Effect.gen(function* () {
    const stockAdjustmentRepo = yield* StockAdjustmentRepository
    const productRepo = yield* ProductRepository

    return {
      addStock: (productId: ProductId, idempotencyKey: string, request: AddStockRequest) =>
        Effect.gen(function* () {
          // Execute the atomic operation - this handles:
          // 1. Idempotency check
          // 2. Product existence check
          // 3. Stock update
          // 4. Adjustment record creation
          // All in a single SQL statement with no race condition window
          const result = yield* stockAdjustmentRepo.addStockAtomic({
            idempotencyKey,
            productId,
            quantity: request.quantity,
            reason: request.reason,
            referenceId: Option.getOrNull(request.referenceId),
            notes: Option.getOrNull(request.notes),
            createdBy: null // Could be populated from auth context in future
          })

          // Handle the three possible outcomes using pattern matching
          switch (result._tag) {
            case "ProductNotFound":
              return yield* Effect.fail(new ProductNotFoundError({
                productId,
                searchedBy: "id"
              }))

            case "AlreadyExists":
              // Return as error - the API handler converts to 409 with original result
              return yield* Effect.fail(new DuplicateAdjustmentError({
                idempotencyKey,
                existingAdjustment: {
                  adjustmentId: result.adjustment.id,
                  previousQuantity: result.adjustment.previousQuantity,
                  addedQuantity: result.adjustment.quantityChange,
                  newQuantity: result.adjustment.newQuantity
                }
              }))

            case "Created":
              // Success - build and return response
              return {
                productId: result.adjustment.productId,
                sku: result.sku,
                previousQuantity: result.adjustment.previousQuantity,
                addedQuantity: result.adjustment.quantityChange,
                newQuantity: result.adjustment.newQuantity,
                adjustmentId: result.adjustment.id as AdjustmentId,
                createdAt: result.adjustment.createdAt
              } as AddStockResponse
          }
        }),

      getAvailability: (productId: ProductId) =>
        Effect.gen(function* () {
          const product = yield* productRepo.findById(productId)
          return yield* Option.match(product, {
            onNone: () => Effect.fail(new ProductNotFoundError({ productId, searchedBy: "id" })),
            onSome: (p) => Effect.succeed(p.stockQuantity)
          })
        }),

      reserveStock: (_request) =>
        // Not implemented yet - placeholder for future saga orchestrator integration
        Effect.succeed([]),

      releaseStock: (_orderId) =>
        // Not implemented yet - placeholder for future saga orchestrator integration
        Effect.void
    }
  })
)
