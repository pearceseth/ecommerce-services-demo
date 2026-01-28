import { Layer, Effect, Option, Match } from "effect"
import { OrderService, type OrderWithItems } from "./OrderService.js"
import { OrderRepository } from "../repositories/OrderRepository.js"
import { OrderNotFoundError, InvalidOrderStatusError } from "../domain/errors.js"
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
          const order = yield* repo.findById(id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(
                  new OrderNotFoundError({ orderId: id, searchedBy: "id" })
                ),
                onSome: Effect.succeed
              })
            )
          )

          const items = yield* repo.getItems(order.id)

          return { order, items } as OrderWithItems
        }),

      cancel: (id: OrderId) =>
        Effect.gen(function* () {
          const orderOpt = yield* repo.findById(id)

          if (Option.isNone(orderOpt)) {
            return yield* Effect.fail(
              new OrderNotFoundError({ orderId: id, searchedBy: "id" })
            )
          }

          const order = orderOpt.value

          // Idempotency: already cancelled → return as-is
          if (order.status === "CANCELLED") {
            const items = yield* repo.getItems(order.id)
            return { order, items } as OrderWithItems
          }

          // Only CREATED orders can be cancelled
          if (order.status !== "CREATED") {
            return yield* Effect.fail(
              new InvalidOrderStatusError({
                orderId: id,
                currentStatus: order.status,
                attemptedStatus: "CANCELLED"
              })
            )
          }

          const updated = yield* repo.updateStatus(id, "CANCELLED").pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(
                  new OrderNotFoundError({ orderId: id, searchedBy: "id" })
                ),
                onSome: Effect.succeed
              })
            )
          )

          const items = yield* repo.getItems(id)
          return { order: updated, items } as OrderWithItems
        }),

      confirm: (id: OrderId) =>
        Effect.gen(function* () {
          const orderOpt = yield* repo.findById(id)

          if (Option.isNone(orderOpt)) {
            return yield* Effect.fail(
              new OrderNotFoundError({ orderId: id, searchedBy: "id" })
            )
          }

          const order = orderOpt.value

          // Idempotency: already confirmed → return as-is
          if (order.status === "CONFIRMED") {
            const items = yield* repo.getItems(order.id)
            return { order, items } as OrderWithItems
          }

          // Only CREATED orders can be confirmed
          if (order.status !== "CREATED") {
            return yield* Effect.fail(
              new InvalidOrderStatusError({
                orderId: id,
                currentStatus: order.status,
                attemptedStatus: "CONFIRMED"
              })
            )
          }

          const updated = yield* repo.updateStatus(id, "CONFIRMED").pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(
                  new OrderNotFoundError({ orderId: id, searchedBy: "id" })
                ),
                onSome: Effect.succeed
              })
            )
          )

          const items = yield* repo.getItems(id)
          return { order: updated, items } as OrderWithItems
        })
    }
  })
)
