import { Layer, Effect, Config, Duration, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { InventoryClient, type ReserveStockParams, type ReserveStockResult } from "./InventoryClient.js"
import { InventoryReservationError, ServiceConnectionError } from "../domain/errors.js"

const ReserveSuccessResponse = Schema.Struct({
  order_id: Schema.String,
  reservation_ids: Schema.Array(Schema.String),
  line_items_reserved: Schema.Number,
  total_quantity_reserved: Schema.Number
})

const InsufficientStockResponse = Schema.Struct({
  error: Schema.Literal("insufficient_stock"),
  product_id: Schema.String,
  product_sku: Schema.optional(Schema.String),
  requested: Schema.Number,
  available: Schema.Number
})

export const InventoryClientLive = Layer.effect(
  InventoryClient,
  Effect.gen(function* () {
    const baseUrl = yield* Config.string("INVENTORY_SERVICE_URL").pipe(
      Config.withDefault("http://localhost:3001")
    )
    const client = yield* HttpClient.HttpClient

    const handleConnectionError = (operation: string) => (error: unknown) =>
      Effect.fail(new ServiceConnectionError({
        service: "inventory",
        operation,
        reason: error instanceof Error ? error.message : String(error),
        isRetryable: true
      }))

    return {
      reserveStock: (params: ReserveStockParams) =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Reserving stock via Inventory Service", {
            orderId: params.orderId,
            itemCount: params.items.length
          })

          const request = HttpClientRequest.post(`${baseUrl}/reservations`).pipe(
            HttpClientRequest.bodyUnsafeJson({
              orderId: params.orderId,
              items: params.items.map(item => ({
                productId: item.productId,
                quantity: item.quantity
              }))
            })
          )

          const response = yield* client.execute(request).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchTag("TimeoutException", handleConnectionError("reserveStock")),
            Effect.catchTag("RequestError", handleConnectionError("reserveStock")),
            Effect.catchTag("ResponseError", handleConnectionError("reserveStock"))
          )

          if (response.status === 201) {
            const rawBody = yield* response.json.pipe(
              Effect.catchAll(() =>
                Effect.fail(new InventoryReservationError({
                  orderId: params.orderId,
                  reason: "Failed to parse response JSON",
                  isRetryable: false
                }))
              )
            )
            const body = yield* Schema.decodeUnknown(ReserveSuccessResponse)(rawBody).pipe(
              Effect.mapError(() => new InventoryReservationError({
                orderId: params.orderId,
                reason: "Invalid response format",
                isRetryable: false
              }))
            )

            yield* Effect.logInfo("Stock reserved successfully", {
              orderId: params.orderId,
              reservationIds: body.reservation_ids
            })

            return {
              orderId: body.order_id,
              reservationIds: body.reservation_ids,
              lineItemsReserved: body.line_items_reserved,
              totalQuantityReserved: body.total_quantity_reserved
            } satisfies ReserveStockResult
          }

          if (response.status === 409) {
            const rawBody = yield* response.json.pipe(Effect.catchAll(() => Effect.succeed({})))
            const decoded = Schema.decodeUnknownOption(InsufficientStockResponse)(rawBody)

            if (decoded._tag === "Some") {
              yield* Effect.logWarning("Insufficient stock", {
                orderId: params.orderId,
                productId: decoded.value.product_id,
                requested: decoded.value.requested,
                available: decoded.value.available
              })

              return yield* Effect.fail(new InventoryReservationError({
                orderId: params.orderId,
                reason: `Insufficient stock for product ${decoded.value.product_id}`,
                statusCode: 409,
                isRetryable: false,
                insufficientStock: {
                  productId: decoded.value.product_id,
                  productSku: decoded.value.product_sku,
                  requested: decoded.value.requested,
                  available: decoded.value.available
                }
              }))
            }
          }

          if (response.status === 404) {
            return yield* Effect.fail(new InventoryReservationError({
              orderId: params.orderId,
              reason: "Product not found",
              statusCode: 404,
              isRetryable: false
            }))
          }

          if (response.status >= 500) {
            return yield* Effect.fail(new InventoryReservationError({
              orderId: params.orderId,
              reason: `Server error: ${response.status}`,
              statusCode: response.status,
              isRetryable: true
            }))
          }

          return yield* Effect.fail(new InventoryReservationError({
            orderId: params.orderId,
            reason: `Client error: ${response.status}`,
            statusCode: response.status,
            isRetryable: false
          }))
        })
    }
  })
)
