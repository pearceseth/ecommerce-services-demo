import { Context, Effect } from "effect"
import { SqlError } from "@effect/sql"
import type { CreateProductRequest, Product, ProductId } from "../domain/Product.js"
import type { DuplicateSkuError, ProductNotFoundError } from "../domain/errors.js"

export class ProductService extends Context.Tag("ProductService")<
  ProductService,
  {
    readonly create: (
      request: CreateProductRequest
    ) => Effect.Effect<Product, DuplicateSkuError | SqlError.SqlError>

    readonly findById: (
      id: ProductId
    ) => Effect.Effect<Product, ProductNotFoundError | SqlError.SqlError>

    readonly findBySku: (
      sku: string
    ) => Effect.Effect<Product, ProductNotFoundError | SqlError.SqlError>
  }
>() {}
