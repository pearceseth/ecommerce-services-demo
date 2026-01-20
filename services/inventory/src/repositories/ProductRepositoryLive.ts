import { Layer, Effect, Option, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { ProductRepository, type CreateProductRow } from "./ProductRepository.js"
import { Product, ProductId } from "../domain/Product.js"

interface ProductRow {
  id: string
  name: string
  sku: string
  price_cents: number
  stock_quantity: number
  created_at: Date
  updated_at: Date
}

const mapRowToProduct = (row: ProductRow): Product =>
  new Product({
    id: row.id as ProductId,
    name: row.name,
    sku: row.sku,
    priceCents: row.price_cents,
    stockQuantity: row.stock_quantity,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    updatedAt: DateTime.unsafeFromDate(row.updated_at)
  })

export const ProductRepositoryLive = Layer.effect(
  ProductRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      insert: (row: CreateProductRow) =>
        Effect.gen(function* () {
          const result = yield* sql<ProductRow>`
            INSERT INTO products (name, sku, price_cents, stock_quantity)
            VALUES (${row.name}, ${row.sku}, ${row.priceCents}, ${row.stockQuantity})
            RETURNING *
          `
          return mapRowToProduct(result[0])
        }),

      findById: (id: ProductId) =>
        Effect.gen(function* () {
          const result = yield* sql<ProductRow>`
            SELECT * FROM products WHERE id = ${id}
          `
          return result.length > 0
            ? Option.some(mapRowToProduct(result[0]))
            : Option.none()
        }),

      findBySku: (sku: string) =>
        Effect.gen(function* () {
          const result = yield* sql<ProductRow>`
            SELECT * FROM products WHERE sku = ${sku}
          `
          return result.length > 0
            ? Option.some(mapRowToProduct(result[0]))
            : Option.none()
        }),

      updateStock: (id: ProductId, quantity: number) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE products
            SET stock_quantity = ${quantity}, updated_at = NOW()
            WHERE id = ${id}
          `
        })
    }
  })
)
