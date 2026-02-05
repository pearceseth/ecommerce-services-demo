import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { HttpServerError } from "@effect/platform"
import { Effect, type ParseResult } from "effect"
import { withTraceContext } from "@ecommerce/tracing"
import { PaymentGatewayService } from "../services/PaymentGatewayService.js"
import { AuthorizePaymentRequest } from "../domain/Authorization.js"
import { AuthorizationIdParams, CapturePaymentRequest } from "../domain/Capture.js"
import { VoidPaymentRequest } from "../domain/Void.js"
import type {
  PaymentDeclinedError,
  GatewayConnectionError,
  AuthorizationNotFoundError,
  AlreadyVoidedError,
  AlreadyCapturedError
} from "../domain/errors.js"

// POST /payments/authorize
const authorizePayment = withTraceContext(Effect.gen(function* () {
  // 1. Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(AuthorizePaymentRequest)

  // 2. Get service
  const gateway = yield* PaymentGatewayService

  // 3. Execute authorization
  const result = yield* gateway.authorize(body)

  // 4. Return success response
  return HttpServerResponse.json(result, { status: 200 })
})).pipe(
  Effect.withSpan("POST /payments/authorize"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        { error: "validation_error", message: "Invalid request body", details: error.message },
        { status: 400 }
      ),
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        { error: "request_error", message: "Failed to parse request body" },
        { status: 400 }
      ),
    PaymentDeclinedError: (error: PaymentDeclinedError) =>
      HttpServerResponse.json(
        {
          error: "payment_declined",
          decline_code: error.declineCode,
          message: error.reason,
          is_retryable: error.isRetryable
        },
        { status: 402 } // 402 Payment Required
      ),
    GatewayConnectionError: (error: GatewayConnectionError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error", { reason: error.reason })
        return HttpServerResponse.json(
          {
            error: "gateway_error",
            message: "Payment gateway temporarily unavailable",
            is_retryable: error.isRetryable
          },
          { status: 503 } // 503 Service Unavailable
        )
      }).pipe(Effect.flatten)
  })
)

// POST /payments/capture/:authorization_id
const capturePayment = withTraceContext(Effect.gen(function* () {
  // 1. Parse path params
  const params = yield* HttpRouter.schemaPathParams(AuthorizationIdParams)

  // 2. Parse body
  const body = yield* HttpServerRequest.schemaBodyJson(CapturePaymentRequest)

  // 3. Get service and execute
  const gateway = yield* PaymentGatewayService
  const result = yield* gateway.capture(params.authorization_id, body)

  return HttpServerResponse.json(result, { status: 200 })
})).pipe(
  Effect.withSpan("POST /payments/capture/:authorization_id"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        { error: "validation_error", message: error.message },
        { status: 400 }
      ),
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        { error: "request_error", message: "Failed to parse request body" },
        { status: 400 }
      ),
    AuthorizationNotFoundError: (error: AuthorizationNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "authorization_not_found",
          authorization_id: error.authorizationId,
          message: error.reason
        },
        { status: 404 }
      ),
    AlreadyVoidedError: (error: AlreadyVoidedError) =>
      HttpServerResponse.json(
        {
          error: "already_voided",
          authorization_id: error.authorizationId,
          voided_at: error.voidedAt,
          message: "Authorization has already been voided and cannot be captured"
        },
        { status: 409 } // 409 Conflict
      ),
    GatewayConnectionError: (error: GatewayConnectionError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error during capture", { reason: error.reason })
        return HttpServerResponse.json(
          { error: "gateway_error", message: "Gateway unavailable", is_retryable: true },
          { status: 503 }
        )
      }).pipe(Effect.flatten)
  })
)

// POST /payments/void/:authorization_id
const voidPayment = withTraceContext(Effect.gen(function* () {
  // 1. Parse path params
  const params = yield* HttpRouter.schemaPathParams(AuthorizationIdParams)

  // 2. Parse body
  const body = yield* HttpServerRequest.schemaBodyJson(VoidPaymentRequest)

  // 3. Get service and execute
  const gateway = yield* PaymentGatewayService
  const result = yield* gateway.voidAuthorization(params.authorization_id, body)

  return HttpServerResponse.json(result, { status: 200 })
})).pipe(
  Effect.withSpan("POST /payments/void/:authorization_id"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error: ParseResult.ParseError) =>
      HttpServerResponse.json(
        { error: "validation_error", message: error.message },
        { status: 400 }
      ),
    RequestError: (_error: HttpServerError.RequestError) =>
      HttpServerResponse.json(
        { error: "request_error", message: "Failed to parse request body" },
        { status: 400 }
      ),
    AuthorizationNotFoundError: (error: AuthorizationNotFoundError) =>
      HttpServerResponse.json(
        {
          error: "authorization_not_found",
          authorization_id: error.authorizationId,
          message: error.reason
        },
        { status: 404 }
      ),
    AlreadyCapturedError: (error: AlreadyCapturedError) =>
      HttpServerResponse.json(
        {
          error: "already_captured",
          authorization_id: error.authorizationId,
          capture_id: error.captureId,
          captured_at: error.capturedAt,
          message: "Authorization has already been captured and cannot be voided"
        },
        { status: 409 }
      ),
    GatewayConnectionError: (error: GatewayConnectionError) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error during void", { reason: error.reason })
        return HttpServerResponse.json(
          { error: "gateway_error", message: "Gateway unavailable", is_retryable: true },
          { status: 503 }
        )
      }).pipe(Effect.flatten)
  })
)

// Combine all payment routes
export const PaymentRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/payments/authorize", authorizePayment),
  HttpRouter.post("/payments/capture/:authorization_id", capturePayment),
  HttpRouter.post("/payments/void/:authorization_id", voidPayment)
)
