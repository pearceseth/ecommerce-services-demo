import { Layer, Effect, Option, Match } from "effect"
import { OrderService, type OrderWithItems } from "./OrderService.js"
import { OrderRepository } from "../repositories/OrderRepository.js"
import { OrderNotFoundError } from "../domain/errors.js"
import type { CreateOrderRequest, OrderId } from "../domain/Order.js"

export const OrderServiceLive = Layer.effect(
  OrderService,
  Effect.gen(function* () {
    const repo = yield* OrderRepository

    return {
      create: (request: CreateOrderRequest) =>
        Effect.gen(function* () {
          const result = yield* repo.createWithItems(request)

          // Both Created and AlreadyExists return the same shape
          // This is idempotent behavior - we don't distinguish at service level
          return Match.value(result).pipe(
            Match.tag("Created", ({ order, items }) => ({ order, items })),
            Match.tag("AlreadyExists", ({ order, items }) => ({ order, items })),
            Match.exhaustive
          )
        }),

      findById: (id: OrderId) =>
        Effect.gen(function* () {
          const orderOpt = yield* repo.findById(id)

          if (Option.isNone(orderOpt)) {
            return yield* Effect.fail(
              new OrderNotFoundError({ orderId: id, searchedBy: "id" })
            )
          }

          const order = orderOpt.value
          const items = yield* repo.getItems(order.id)

          return { order, items } as OrderWithItems
        })
    }
  })
)
