import { Context, Effect, Option } from "effect"
import { SqlError } from "@effect/sql"
import type { Product, ProductId } from "../domain/Product.js"

export interface CreateProductRow {
  readonly name: string
  readonly sku: string
  readonly priceCents: number
  readonly stockQuantity: number
}

export class ProductRepository extends Context.Tag("ProductRepository")<
  ProductRepository,
  {
    readonly insert: (row: CreateProductRow) => Effect.Effect<Product, SqlError.SqlError>
    readonly findById: (id: ProductId) => Effect.Effect<Option.Option<Product>, SqlError.SqlError>
    readonly findBySku: (sku: string) => Effect.Effect<Option.Option<Product>, SqlError.SqlError>
    readonly updateStock: (id: ProductId, quantity: number) => Effect.Effect<void, SqlError.SqlError>
  }
>() {}
