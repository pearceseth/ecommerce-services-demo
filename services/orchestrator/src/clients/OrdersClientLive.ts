import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { OrdersClient, type CreateOrderParams, type CreateOrderResult, type ConfirmOrderResult } from "./OrdersClient.js"
import { OrderCreationError, OrderConfirmationError, ServiceConnectionError } from "../domain/errors.js"

const CreateOrderSuccessResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.String
})

const ConfirmOrderSuccessResponse = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("CONFIRMED")
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  message: Schema.String
})

export const OrdersClientLive = Layer.effect(
  OrdersClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("ORDERS_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3003")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "orders",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      createOrder: (params: CreateOrderParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Creating order via Orders Service", {
            orderLedgerId: params.orderLedgerId
          })

          const request = HttpClientRequest.post(`${baseUrl}/orders`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              orderLedgerId: params.orderLedgerId,
              userId: params.userId,
              totalAmountCents: params.totalAmountCents,
              currency: params.currency,
              items: params.items.map(item => ({
                productId: item.productId,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents
              }))
            })
          )

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("createOrder")),
            Effect.catchTag("RequestError", handleConnectionError("createOrder")),
            Effect.catchTag("ResponseError", handleConnectionError("createOrder"))
          )

          if (response.status === 201 || response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new OrderCreationError({
                  orderLedgerId: params.orderLedgerId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(CreateOrderSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new OrderCreationError({
                orderLedgerId: params.orderLedgerId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Order created successfully", {
              orderLedgerId: params.orderLedgerId,
              orderId: body.id
            })

            return {
              orderId: body.id,
              status: body.status
            } satisfies CreateOrderResult
          }

          if (response.status >= 400 && response.status < 500) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            const errorBody = Schema.decodeUnknownOption(ErrorResponse)(rawBody)
            const message = errorBody._tag === "Some" ? errorBody.value.message : `HTTP ${response.status}`
            return yield* Effect.fail(new OrderCreationError({
              orderLedgerId: params.orderLedgerId,
              reason: message,
              statusCode: response.status,
              isRetryable: false
            }))
          }

          return yield* Effect.fail(new OrderCreationError({
            orderLedgerId: params.orderLedgerId,
            reason: `Server error: ${response.status}`,
            statusCode: response.status,
            isRetryable: true
          }))
        }),

      confirmOrder: (orderId: string) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Confirming order via Orders Service", { orderId })

          const request = HttpClientRequest.post(`${baseUrl}/orders/${orderId}/confirmation`)

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("confirmOrder")),
            Effect.catchTag("RequestError", handleConnectionError("confirmOrder")),
            Effect.catchTag("ResponseError", handleConnectionError("confirmOrder"))
          )

          if (response.status === 200) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new OrderConfirmationError({
                  orderId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(ConfirmOrderSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new OrderConfirmationError({
                orderId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Order confirmed successfully", { orderId })

            return {
              orderId: body.id,
              status: body.status
            } satisfies ConfirmOrderResult
          }

          if (response.status === 409) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            if (rawBody && typeof rawBody === "object" && "current_status" in rawBody) {
              const currentStatus = (rawBody as { current_status?: string }).current_status
              if (currentStatus === "CONFIRMED") {
                yield* Effect.logInfo("Order already confirmed (idempotent)", { orderId })
                return { orderId, status: "CONFIRMED" } satisfies ConfirmOrderResult
              }
            }
          }

          if (response.status >= 400 && response.status < 500) {
            return yield* Effect.fail(new OrderConfirmationError({
              orderId,
              reason: `Client error: ${response.status}`,
              statusCode: response.status,
              isRetryable: false
            }))
          }

          return yield* Effect.fail(new OrderConfirmationError({
            orderId,
            reason: `Server error: ${response.status}`,
            statusCode: response.status,
            isRetryable: true
          }))
        })
    }
  })
)
