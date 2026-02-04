import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { PaymentsClient, type CapturePaymentParams, type CapturePaymentResult, type VoidPaymentParams, type VoidPaymentResult } from "./PaymentsClient.js"
import { PaymentCaptureError, PaymentVoidError, ServiceConnectionError } from "../domain/errors.js"

const CaptureSuccessResponse = Schema.Struct({
  capture_id: Schema.String,
  authorization_id: Schema.String,
  status: Schema.Literal("CAPTURED"),
  amount_cents: Schema.Number,
  currency: Schema.String,
  captured_at: Schema.String
})

const VoidSuccessResponse = Schema.Struct({
  void_id: Schema.String,
  authorization_id: Schema.String,
  status: Schema.Literal("VOIDED"),
  voided_at: Schema.String
})

export const PaymentsClientLive = Layer.effect(
  PaymentsClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("PAYMENTS_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3002")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "payments",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      capturePayment: (params: CapturePaymentParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Capturing payment via Payments Service", {
            authorizationId: params.authorizationId
          })

          const requestBody: Record<string, unknown> = {
            idempotency_key: params.idempotencyKey
          }
          if (params.amountCents !== undefined) {
            requestBody.amount_cents = params.amountCents
          }

          const request = HttpClientRequest.post(
            `${baseUrl}/payments/capture/${params.authorizationId}`
          ).pipe(HttpClientRequest.bodyUnsafeJson(requestBody))

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("capturePayment")),
            Effect.catchTag("RequestError", handleConnectionError("capturePayment")),
            Effect.catchTag("ResponseError", handleConnectionError("capturePayment"))
          )

          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentCaptureError({
                  authorizationId: params.authorizationId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(CaptureSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentCaptureError({
                authorizationId: params.authorizationId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Payment captured successfully", {
              authorizationId: params.authorizationId,
              captureId: body.capture_id
            })

            return {
              captureId: body.capture_id,
              authorizationId: body.authorization_id,
              status: body.status,
              amountCents: body.amount_cents,
              currency: body.currency,
              capturedAt: body.captured_at
            } satisfies CapturePaymentResult
          }

          if (response.status === 404) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Authorization not found",
              statusCode: 404,
              isRetryable: false
            }))
          }

          if (response.status === 409) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Authorization already voided",
              statusCode: 409,
              isRetryable: false
            }))
          }

          if (response.status === 503) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: "Payment gateway unavailable",
              statusCode: 503,
              isRetryable: true
            }))
          }

          if (response.status >= 500) {
            return yield* Effect.fail(new PaymentCaptureError({
              authorizationId: params.authorizationId,
              reason: `Server error: ${response.status}`,
              statusCode: response.status,
              isRetryable: true
            }))
          }

          return yield* Effect.fail(new PaymentCaptureError({
            authorizationId: params.authorizationId,
            reason: `Client error: ${response.status}`,
            statusCode: response.status,
            isRetryable: false
          }))
        }),

      voidPayment: (params: VoidPaymentParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Voiding payment via Payments Service", {
            authorizationId: params.authorizationId
          })

          const requestBody: Record<string, unknown> = {
            idempotency_key: params.idempotencyKey
          }
          if (params.reason !== undefined) {
            requestBody.reason = params.reason
          }

          const request = HttpClientRequest.post(
            `${baseUrl}/payments/void/${params.authorizationId}`
          ).pipe(HttpClientRequest.bodyUnsafeJson(requestBody))

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("voidPayment")),
            Effect.catchTag("RequestError", handleConnectionError("voidPayment")),
            Effect.catchTag("ResponseError", handleConnectionError("voidPayment"))
          )

          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new PaymentVoidError({
                  authorizationId: params.authorizationId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(VoidSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new PaymentVoidError({
                authorizationId: params.authorizationId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Payment voided successfully", {
              authorizationId: params.authorizationId,
              voidId: body.void_id
            })

            return {
              voidId: body.void_id,
              authorizationId: body.authorization_id,
              status: body.status,
              voidedAt: body.voided_at
            } satisfies VoidPaymentResult
          }

          // 404: Authorization not found - treat as success (idempotent - already cleaned up)
          if (response.status === 404) {
            yield* Effect.logInfo("Payment authorization not found - treating as already voided", {
              authorizationId: params.authorizationId
            })
            return {
              voidId: `void-notfound-${params.authorizationId}`,
              authorizationId: params.authorizationId,
              status: "VOIDED",
              voidedAt: new Date().toISOString()
            } satisfies VoidPaymentResult
          }

          // 409: Already captured - cannot void
          if (response.status === 409) {
            return yield* Effect.fail(new PaymentVoidError({
              authorizationId: params.authorizationId,
              reason: "Authorization already captured - cannot void",
              statusCode: 409,
              isRetryable: false
            }))
          }

          if (response.status === 503) {
            return yield* Effect.fail(new PaymentVoidError({
              authorizationId: params.authorizationId,
              reason: "Payment gateway unavailable",
              statusCode: 503,
              isRetryable: true
            }))
          }

          if (response.status >= 500) {
            return yield* Effect.fail(new PaymentVoidError({
              authorizationId: params.authorizationId,
              reason: `Server error: ${response.status}`,
              statusCode: response.status,
              isRetryable: true
            }))
          }

          return yield* Effect.fail(new PaymentVoidError({
            authorizationId: params.authorizationId,
            reason: `Client error: ${response.status}`,
            statusCode: response.status,
            isRetryable: false
          }))
        })
    }
  })
)
