import { Context, Effect } from "effect"
import type { Product, ProductId } from "../domain/Product.js"

export interface CreateProductRow {
  readonly name: string
  readonly sku: string
  readonly price: string
  readonly stockQuantity: number
}

export class ProductRepository extends Context.Tag("ProductRepository")<
  ProductRepository,
  {
    readonly insert: (row: CreateProductRow) => Effect.Effect<Product>
    readonly findById: (id: ProductId) => Effect.Effect<Product | null>
    readonly findBySku: (sku: string) => Effect.Effect<Product | null>
    readonly updateStock: (id: ProductId, quantity: number) => Effect.Effect<void>
  }
>() {}
