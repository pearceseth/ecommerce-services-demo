import { Layer, Effect, Option, Match } from "effect"
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

          // Handle the three possible outcomes using exhaustive pattern matching
          const response = Match.value(result).pipe(
            Match.tag("ProductNotFound", () =>
              Effect.fail(new ProductNotFoundError({ productId, searchedBy: "id" }))
            ),
            Match.tag("AlreadyExists", ({ adjustment }) =>
              Effect.fail(new DuplicateAdjustmentError({
                idempotencyKey,
                existingAdjustment: {
                  adjustmentId: adjustment.id,
                  previousQuantity: adjustment.previousQuantity,
                  addedQuantity: adjustment.quantityChange,
                  newQuantity: adjustment.newQuantity
                }
              }))
            ),
            Match.tag("Created", ({ adjustment, sku }) =>
              Effect.succeed({
                productId: adjustment.productId,
                sku,
                previousQuantity: adjustment.previousQuantity,
                addedQuantity: adjustment.quantityChange,
                newQuantity: adjustment.newQuantity,
                adjustmentId: adjustment.id as AdjustmentId,
                createdAt: adjustment.createdAt
              } as AddStockResponse)
            ),
            Match.exhaustive
          )

          return yield* response
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
