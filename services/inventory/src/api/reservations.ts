import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, ParseResult } from "effect"
import { ReserveStockHttpRequest, OrderIdParams } from "../domain/Reservation.js"
import { InventoryService } from "../services/InventoryService.js"
import type { ProductNotFoundError, InsufficientStockError } from "../domain/errors.js"


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
  Effect.withSpan("POST /reservations"),
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
  Effect.withSpan("DELETE /reservations/:order_id"),
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


export const ReservationRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/reservations", reserveStock),
  HttpRouter.del("/reservations/:order_id", releaseReservation)
)