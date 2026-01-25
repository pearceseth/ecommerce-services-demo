import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, DateTime, ParseResult } from "effect"
import { CreateProductRequest, ProductIdParams } from "../domain/Product.js"
import { AddStockRequest } from "../domain/Adjustment.js"
import { ReserveStockHttpRequest, OrderIdParams } from "../domain/Reservation.js"
import { ProductService } from "../services/ProductService.js"
import { InventoryService } from "../services/InventoryService.js"
import type { DuplicateSkuError, ProductNotFoundError, DuplicateAdjustmentError, InsufficientStockError } from "../domain/errors.js"

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

// GET /products/:product_id/availability - Get product availability
const getAvailability = Effect.gen(function* () {
  // Extract and validate product_id from path parameters using schema
  const { product_id: productId } = yield* HttpRouter.schemaPathParams(ProductIdParams)

  // Get product to retrieve SKU (via ProductService)
  const productService = yield* ProductService
  const product = yield* productService.findById(productId)

  // Get stock availability (via InventoryService)
  const inventoryService = yield* InventoryService
  const stockQuantity = yield* inventoryService.getAvailability(productId)

  yield* Effect.logInfo("Availability queried", {
    productId,
    sku: product.sku,
    stockQuantity
  })

  // Build and return response (snake_case for JSON)
  const response = {
    product_id: productId,
    sku: product.sku,
    stock_quantity: stockQuantity,
    available: stockQuantity > 0
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("GET /inventory/products/:product_id/availability"),
  Effect.flatten,
  Effect.catchTags({
    // Path parameter validation errors (400 Bad Request)
    ParseError: (_error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid product_id format. Must be a valid UUID."
        },
        { status: 400 }
      ),

    // Product not found (404)
    ProductNotFoundError: (error: ProductNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        },
        { status: 404 }
      ),

    // SQL errors (500)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in getAvailability", { error })
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

// POST /products/:product_id/stock - Add stock to a product
const addStock = Effect.gen(function* () {
  // Extract and validate product_id from path parameters using schema
  const { product_id: productId } = yield* HttpRouter.schemaPathParams(ProductIdParams)

  // Extract Idempotency-Key header
  const request = yield* HttpServerRequest.HttpServerRequest
  const idempotencyKey = request.headers["idempotency-key"]
  if (!idempotencyKey) {
    return yield* HttpServerResponse.json(
      {
        error: "missing_idempotency_key",
        message: "Idempotency-Key header is required"
      },
      { status: 400 }
    )
  }

  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(AddStockRequest)

  // Get the service and add stock
  const inventoryService = yield* InventoryService
  const result = yield* inventoryService.addStock(productId, idempotencyKey, body)

  yield* Effect.logInfo("Stock added", {
    productId: result.productId,
    sku: result.sku,
    addedQuantity: result.addedQuantity,
    newQuantity: result.newQuantity
  })

  // Map to response using snake_case for JSON
  const response = {
    product_id: result.productId,
    sku: result.sku,
    previous_quantity: result.previousQuantity,
    added_quantity: result.addedQuantity,
    new_quantity: result.newQuantity,
    adjustment_id: result.adjustmentId,
    created_at: DateTime.formatIso(result.createdAt)
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("POST /inventory/products/:product_id/stock"),
  Effect.flatten,
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

    // Product not found (404 Not Found)
    ProductNotFoundError: (error: ProductNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        },
        { status: 404 }
      ),

    // Duplicate idempotency key (409 Conflict - idempotent retry)
    // Return the ORIGINAL result for true idempotency
    DuplicateAdjustmentError: (error: DuplicateAdjustmentError) =>
      HttpServerResponse.json(
        {
          adjustment_id: error.existingAdjustment.adjustmentId,
          message: "This adjustment was already processed",
          previous_quantity: error.existingAdjustment.previousQuantity,
          added_quantity: error.existingAdjustment.addedQuantity,
          new_quantity: error.existingAdjustment.newQuantity
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
        yield* Effect.logError("Database error in addStock", { error })
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

// POST /reservations - Reserve stock for an order
const reserveStock = Effect.gen(function* () {
  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(ReserveStockHttpRequest)

  // Get service and execute reservation
  const inventoryService = yield* InventoryService
  const reservationIds = yield* inventoryService.reserveStock({
    orderId: body.orderId,
    items: body.items.map(item => ({
      productId: item.productId,
      quantity: item.quantity
    }))
  })

  const totalQuantity = body.items.reduce((sum, item) => sum + item.quantity, 0)

  yield* Effect.logInfo("Stock reserved", {
    orderId: body.orderId,
    lineItems: body.items.length,
    totalQuantity,
    reservationIds
  })

  // Return response (snake_case for JSON)
  const response = {
    order_id: body.orderId,
    reservation_ids: reservationIds,
    line_items_reserved: body.items.length,
    total_quantity_reserved: totalQuantity
  }

  return HttpServerResponse.json(response, { status: 201 })
}).pipe(
  Effect.withSpan("POST /inventory/reservations"),
  Effect.flatten,
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

    // Product not found (404 Not Found)
    ProductNotFoundError: (error: ProductNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        },
        { status: 404 }
      ),

    // Insufficient stock (409 Conflict)
    // Using 409 because the request conflicts with current resource state
    InsufficientStockError: (error: InsufficientStockError) =>
      HttpServerResponse.json(
        {
          error: "insufficient_stock",
          message: `Insufficient stock for product ${error.productSku}`,
          product_id: error.productId,
          product_sku: error.productSku,
          requested: error.requested,
          available: error.available
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
        yield* Effect.logError("Database error in reserveStock", { error })
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

// DELETE /reservations/:order_id - Release reservations for an order
const releaseReservation = Effect.gen(function* () {
  // Extract and validate order_id from path parameters
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  // Get service and execute release
  const inventoryService = yield* InventoryService
  const result = yield* inventoryService.releaseStock(orderId)

  // Log the operation
  if (result.releasedCount > 0) {
    yield* Effect.logInfo("Reservations released", {
      orderId,
      releasedCount: result.releasedCount,
      totalQuantityRestored: result.totalQuantityRestored
    })
  } else if (result.wasAlreadyReleased) {
    yield* Effect.logInfo("Reservations already released (idempotent)", { orderId })
  } else {
    yield* Effect.logInfo("No reservations found to release", { orderId })
  }

  // Return response (snake_case for JSON)
  const response = {
    order_id: orderId,
    released_count: result.releasedCount,
    total_quantity_restored: result.totalQuantityRestored,
    message: result.releasedCount > 0
      ? `Released ${result.releasedCount} reservation(s), restored ${result.totalQuantityRestored} units to stock`
      : result.wasAlreadyReleased
        ? "Reservations were already released"
        : "No reservations found for this order"
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("DELETE /inventory/reservations/:order_id"),
  Effect.flatten,
  Effect.catchTags({
    // Path parameter validation errors (400 Bad Request)
    ParseError: (_error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid order_id format. Must be a valid UUID."
        },
        { status: 400 }
      ),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in releaseReservation", { error })
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
  HttpRouter.post("/products", createProduct),
  HttpRouter.post("/products/:product_id/stock", addStock),
  HttpRouter.get("/products/:product_id/availability", getAvailability),
  HttpRouter.post("/reservations", reserveStock),
  HttpRouter.del("/reservations/:order_id", releaseReservation)
)
