import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { PaymentClient, type AuthorizePaymentParams, type AuthorizePaymentResult } from "./PaymentClient.js"
import { PaymentDeclinedError, PaymentGatewayError } from "../domain/errors.js"

// Schema for successful authorization response
const AuthorizeSuccessResponse = Schema.Struct({
  authorization_id: Schema.String,
  status: Schema.Literal("AUTHORIZED"),
  amount_cents: Schema.Number,
  currency: Schema.String,
  created_at: Schema.String
})

// Schema for declined payment response
const DeclinedResponse = Schema.Struct({
  error: Schema.String,
  decline_code: Schema.String,
  message: Schema.String,
  is_retryable: Schema.Boolean
})

// Schema for gateway error response
const GatewayErrorResponse = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
  is_retryable: Schema.Boolean
})

export const PaymentClientLive = Layer.effect(
  PaymentClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("PAYMENT_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3002")
    )
    const client = yield* HttpClient.HttpClient

    return {
      authorize: (params: AuthorizePaymentParams): Effect.Effect<AuthorizePaymentResult, PaymentDeclinedError | PaymentGatewayError> =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(`${baseUrl}/payments/authorize`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              user_id: params.userId,
              amount_cents: params.amountCents,
              currency: params.currency,
              payment_token: params.paymentToken,
              idempotency_key: params.idempotencyKey
            })
          )

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", () =>
              Effect.fail(new PaymentGatewayError({
                reason: "Request timed out",
                isRetryable: true
              }))
            ),
            Effect.catchTag("ResponseError", () =>
              Effect.fail(new PaymentGatewayError({
                reason: "HTTP response error",
                isRetryable: true
              }))
            ),
            Effect.catchTag("RequestError", () =>
              Effect.fail(new PaymentGatewayError({
                reason: "Connection error",
                isRetryable: true
              }))
            )
          )

          // Check response status
          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentGatewayError({
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(AuthorizeSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentGatewayError({
                reason: "Invalid response format from payment service",
                isRetryable: false
              }))
            )
            return {
              authorizationId: body.authorization_id,
              status: body.status,
              amountCents: body.amount_cents,
              currency: body.currency,
              createdAt: body.created_at
            } satisfies AuthorizePaymentResult
          }

          if (response.status === 402) {
            // Payment declined
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentGatewayError({
                  reason: "Failed to parse declined response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(DeclinedResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentGatewayError({
                reason: "Invalid declined response format",
                isRetryable: false
              }))
            )
            return yield* Effect.fail(new PaymentDeclinedError({
              userId: params.userId,
              amountCents: params.amountCents,
              declineCode: body.decline_code,
              reason: body.message,
              isRetryable: body.is_retryable
            }))
          }

          if (response.status === 503) {
            // Gateway unavailable
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentGatewayError({
                  reason: "Failed to parse gateway error response JSON",
                  isRetryable: true
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(GatewayErrorResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentGatewayError({
                reason: "Invalid gateway error response format",
                isRetryable: true
              }))
            )
            return yield* Effect.fail(new PaymentGatewayError({
              reason: body.message,
              isRetryable: body.is_retryable
            }))
          }

          // Unexpected status
          return yield* Effect.fail(new PaymentGatewayError({
            reason: `Unexpected response status: ${response.status}`,
            isRetryable: false
          }))
        })
    }
  })
)
