import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { OrderService } from "../services/OrderService.js"
import { CreateOrderRequest, OrderIdParams } from "../domain/Order.js"

// POST /orders - Create order from ledger entry
const createOrder = Effect.gen(function* () {
  const service = yield* OrderService
  const request = yield* HttpServerRequest.schemaBodyJson(CreateOrderRequest)

  const { order, items } = yield* service.create(request)

  // Map to API response format (snake_case for external API)
  const response = {
    id: order.id,
    order_ledger_id: order.orderLedgerId,
    user_id: order.userId,
    status: order.status,
    total_amount_cents: order.totalAmountCents,
    currency: order.currency,
    created_at: order.createdAt.toString(),
    updated_at: order.updatedAt.toString(),
    items: items.map(item => ({
      id: item.id,
      product_id: item.productId,
      quantity: item.quantity,
      unit_price_cents: item.unitPriceCents,
      created_at: item.createdAt.toString()
    }))
  }

  return yield* HttpServerResponse.json(response, { status: 201 })
}).pipe(
  Effect.catchTags({
    ParseError: (error) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid request body",
          details: error.message
        },
        { status: 400 }
      ),
    RequestError: () =>
      HttpServerResponse.json(
        { error: "request_error", message: "Failed to read request body" },
        { status: 400 }
      ),
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)

// GET /orders/:order_id - Get order by ID
const getOrderById = Effect.gen(function* () {
  const service = yield* OrderService
  const { order_id: orderId } = yield* HttpRouter.schemaPathParams(OrderIdParams)

  const { order, items } = yield* service.findById(orderId)

  // Map to API response format
  const response = {
    id: order.id,
    order_ledger_id: order.orderLedgerId,
    user_id: order.userId,
    status: order.status,
    total_amount_cents: order.totalAmountCents,
    currency: order.currency,
    created_at: order.createdAt.toString(),
    updated_at: order.updatedAt.toString(),
    items: items.map(item => ({
      id: item.id,
      product_id: item.productId,
      quantity: item.quantity,
      unit_price_cents: item.unitPriceCents,
      created_at: item.createdAt.toString()
    }))
  }

  return yield* HttpServerResponse.json(response)
}).pipe(
  Effect.catchTags({
    ParseError: () =>
      HttpServerResponse.json(
        { error: "validation_error", message: "Invalid order_id format. Must be a valid UUID." },
        { status: 400 }
      ),
    OrderNotFoundError: (error) =>
      HttpServerResponse.json(
        { error: "not_found", message: `Order with ID ${error.orderId} not found` },
        { status: 404 }
      ),
    SqlError: () =>
      HttpServerResponse.json(
        { error: "internal_error", message: "An unexpected error occurred" },
        { status: 500 }
      )
  })
)

export const OrderRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/orders", createOrder),
  HttpRouter.get("/orders/:order_id", getOrderById)
)
