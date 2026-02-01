import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, type ParseResult } from "effect"
import { CreateOrderRequest } from "../domain/OrderLedger.js"
import { OrderService } from "../services/OrderService.js"
import {
  MissingIdempotencyKeyError,
  type PaymentDeclinedError,
  type PaymentGatewayError,
  type DuplicateRequestError
} from "../domain/errors.js"

// POST /orders - Create a new order
export const createOrder = Effect.gen(function* () {
  // 1. Extract Idempotency-Key header
  const request = yield* HttpServerRequest.HttpServerRequest
  const idempotencyKey = request.headers["idempotency-key"]

  if (!idempotencyKey) {
    return yield* Effect.fail(new MissingIdempotencyKeyError({}))
  }

  // 2. Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(CreateOrderRequest)

  // 3. Execute order creation
  const orderService = yield* OrderService
  const result = yield* orderService.createOrder(idempotencyKey, body)

  yield* Effect.logInfo("Order created", {
    orderLedgerId: result.orderLedgerId,
    status: result.status
  })

  // 4. Return 202 Accepted
  return HttpServerResponse.json(
    {
      order_ledger_id: result.orderLedgerId,
      status: result.status,
      message: "Order received, processing"
    },
    { status: 202 }
  )
}).pipe(
  Effect.withSpan("POST /orders"),
  Effect.flatten,
  Effect.catchTags({
    // Missing idempotency key (400 Bad Request)
    MissingIdempotencyKeyError: () =>
      HttpServerResponse.json(
        {
          error: "missing_idempotency_key",
          message: "Idempotency-Key header is required"
        },
        { status: 400 }
      ),

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

    // Request body parsing errors (400 Bad Request)
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        {
          error: "request_error",
          message: "Failed to parse request body"
        },
        { status: 400 }
      ),

    // Duplicate request (409 Conflict - idempotent response)
    DuplicateRequestError: (error: DuplicateRequestError) =>
      HttpServerResponse.json(
        {
          error: "duplicate_request",
          order_ledger_id: error.existingOrderLedgerId,
          status: error.existingStatus
        },
        { status: 409 }
      ),

    // Payment declined (402 Payment Required)
    PaymentDeclinedError: (error: PaymentDeclinedError) =>
      HttpServerResponse.json(
        {
          error: "payment_declined",
          decline_code: error.declineCode,
          message: error.reason,
          is_retryable: error.isRetryable
        },
        { status: 402 }
      ),

    // Payment gateway unavailable (503 Service Unavailable)
    PaymentGatewayError: (error: PaymentGatewayError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Payment gateway error", { reason: error.reason })
        return HttpServerResponse.json(
          {
            error: "gateway_error",
            message: "Payment service temporarily unavailable",
            is_retryable: error.isRetryable
          },
          { status: 503 }
        )
      }).pipe(Effect.flatten),

    // SQL errors (500 Internal Server Error)
    SqlError: (error: SqlError.SqlError) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in createOrder", { error })
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

// Export routes
export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder)
)
