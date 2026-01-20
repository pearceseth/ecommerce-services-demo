import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, DateTime, ParseResult } from "effect"
import { CreateProductRequest } from "../domain/Product.js"
import { ProductService } from "../services/ProductService.js"
import type { DuplicateSkuError } from "../domain/errors.js"

const createProduct = Effect.gen(function* () {
  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(CreateProductRequest)

  // Get the service and create the product
  const productService = yield* ProductService
  const product = yield* productService.create(body)

  yield* Effect.logInfo("Product created", { productId: product.id, sku: product.sku })

  // Map domain model to response
  const response = {
    id: product.id,
    name: product.name,
    sku: product.sku,
    priceCents: product.priceCents,
    stockQuantity: product.stockQuantity,
    createdAt: DateTime.formatIso(product.createdAt)
  }

  return HttpServerResponse.json(response, { status: 201 })
}).pipe(
  Effect.withSpan("POST /inventory/products"),
  Effect.flatten,
  // Error handling - map domain errors to HTTP responses
  Effect.catchTags({
    // Schema validation errors (400 Bad Request)
    ParseError: (error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid request data",
          details: error.message
        },
        { status: 400 }
      ),

    // Duplicate SKU (409 Conflict)
    DuplicateSkuError: (error: DuplicateSkuError) =>
      HttpServerResponse.json(
        {
          error: "duplicate_sku",
          message: `Product with SKU '${error.sku}' already exists`,
          existingProductId: error.existingProductId
        },
        { status: 409 }
      ),

    // Request body parsing errors (400 Bad Request)
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        {
          error: "request_error",
          message: "Failed to parse request body"
        },
        { status: 400 }
      ),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in createProduct", { error })
        return HttpServerResponse.json(
          {
            error: "internal_error",
            message: "An unexpected error occurred"
          },
          { status: 500 }
        )
      }).pipe(Effect.flatten)
  })
)

export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct)
)
