import { Layer, Effect, Option, pipe } from "effect"
import { ProductService } from "./ProductService.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { DuplicateSkuError, ProductNotFoundError } from "../domain/errors.js"
import type { CreateProductRequest, ProductId } from "../domain/Product.js"

/** Converts an Option to an Effect, failing with the provided error if None */
const fromOption =
  <E>(onNone: () => E) =>
  <A>(option: Option.Option<A>): Effect.Effect<A, E> =>
    Option.isSome(option) ? Effect.succeed(option.value) : Effect.fail(onNone())

export const ProductServiceLive = Layer.effect(
  ProductService,
  Effect.gen(function* () {
    const repo = yield* ProductRepository

    return {
      create: (request: CreateProductRequest) =>
        repo.findBySku(request.sku).pipe(
          Effect.andThen(
            Option.match({
              onSome: (product) =>
                Effect.fail(
                  new DuplicateSkuError({ sku: request.sku, existingProductId: product.id })
                ),
              onNone: () =>
                repo.insert({
                  name: request.name,
                  sku: request.sku,
                  priceCents: request.priceCents,
                  stockQuantity: request.initialStock
                })
            })
          )
        ),

      findById: (id: ProductId) =>
        repo.findById(id).pipe(
          Effect.flatMap(fromOption(() => new ProductNotFoundError({ productId: id, searchedBy: "id" })))
        ),

      findBySku: (sku: string) =>
        repo.findBySku(sku).pipe(
          Effect.flatMap(fromOption(() => new ProductNotFoundError({ productId: sku, searchedBy: "sku" })))
        )
    }
  })
)
