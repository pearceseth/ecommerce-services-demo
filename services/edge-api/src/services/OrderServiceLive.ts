import { Layer, Effect, Option, DateTime } from "effect"
import { OrderService, type CreateOrderResult, type OrderStatusResult } from "./OrderService.js"
import { OrderLedgerRepository } from "../repositories/OrderLedgerRepository.js"
import { PaymentClient } from "./PaymentClient.js"
import type { CreateOrderRequest, OrderLedgerId } from "../domain/OrderLedger.js"
import { DuplicateRequestError, OrderLedgerNotFoundError } from "../domain/errors.js"

// Placeholder price per item in cents - will be replaced with actual inventory lookup
const PLACEHOLDER_PRICE_CENTS = 1000

export const OrderServiceLive = Layer.effect(
  OrderService,
  Effect.gen(function* () {
    const ledgerRepo = yield* OrderLedgerRepository
    const paymentClient = yield* PaymentClient

    return {
      createOrder: (idempotencyKey: string, request: CreateOrderRequest) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Processing order request", {
            idempotencyKey,
            userId: request.user_id,
            itemCount: request.items.length
          })

          // Step 1: Check for duplicate request (idempotency)
          const existingLedger = yield* ledgerRepo.findByClientRequestId(idempotencyKey)

          if (Option.isSome(existingLedger)) {
            const existing = existingLedger.value
            yield* Effect.logInfo("Duplicate request detected", {
              idempotencyKey,
              existingOrderLedgerId: existing.id,
              existingStatus: existing.status
            })
            return yield* Effect.fail(new DuplicateRequestError({
              clientRequestId: idempotencyKey,
              existingOrderLedgerId: existing.id,
              existingStatus: existing.status
            }))
          }

          // Step 2: Calculate total amount
          // TODO: In production, call Inventory Service to get actual prices
          const totalAmountCents = request.items.reduce(
            (total, item) => total + (item.quantity * PLACEHOLDER_PRICE_CENTS),
            0
          )

          // Step 3: Create ledger entry with AWAITING_AUTHORIZATION status
          const ledger = yield* ledgerRepo.create({
            clientRequestId: idempotencyKey,
            userId: request.user_id,
            email: request.email,
            totalAmountCents,
            currency: "USD"
          })

          yield* Effect.logInfo("Order ledger created", {
            orderLedgerId: ledger.id,
            status: ledger.status
          })

          // Step 4: Create ledger items
          const itemParams = request.items.map((item) => ({
            orderLedgerId: ledger.id,
            productId: item.product_id,
            quantity: item.quantity,
            unitPriceCents: PLACEHOLDER_PRICE_CENTS // TODO: Use actual price from inventory
          }))

          yield* ledgerRepo.createItems(itemParams)

          // Step 5: Authorize payment
          const authResult = yield* paymentClient.authorize({
            userId: request.user_id,
            amountCents: totalAmountCents,
            currency: "USD",
            paymentToken: request.payment.token,
            idempotencyKey
          }).pipe(
            Effect.catchTag("PaymentDeclinedError", (error) =>
              Effect.gen(function* () {
                // Mark ledger as failed before re-throwing
                yield* ledgerRepo.markAuthorizationFailed(ledger.id)
                yield* Effect.logWarning("Payment declined", {
                  orderLedgerId: ledger.id,
                  declineCode: error.declineCode,
                  reason: error.reason
                })
                return yield* Effect.fail(error)
              })
            )
          )

          yield* Effect.logInfo("Payment authorized", {
            orderLedgerId: ledger.id,
            authorizationId: authResult.authorizationId
          })

          // Step 6: Update ledger with authorization and write outbox event
          const updatedLedger = yield* ledgerRepo.updateWithAuthorizationAndOutbox({
            orderLedgerId: ledger.id,
            paymentAuthorizationId: authResult.authorizationId,
            newStatus: "AUTHORIZED"
          })

          yield* Effect.logInfo("Order authorized successfully", {
            orderLedgerId: updatedLedger.id,
            status: updatedLedger.status,
            paymentAuthorizationId: updatedLedger.paymentAuthorizationId
          })

          return {
            orderLedgerId: updatedLedger.id,
            status: updatedLedger.status
          } satisfies CreateOrderResult
        }),

      getOrderStatus: (orderLedgerId: string) =>
        Effect.gen(function* () {
          // Cast to branded type
          const ledgerId = orderLedgerId as OrderLedgerId

          // Fetch ledger with items
          const result = yield* ledgerRepo.findByIdWithItems(ledgerId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new OrderLedgerNotFoundError({ orderLedgerId })),
                onSome: Effect.succeed
              })
            )
          )

          // Map to response format
          return {
            orderLedgerId: result.ledger.id,
            clientRequestId: result.ledger.clientRequestId,
            status: result.ledger.status,
            userId: result.ledger.userId,
            email: result.ledger.email,
            totalAmountCents: result.ledger.totalAmountCents,
            currency: result.ledger.currency,
            paymentAuthorizationId: result.ledger.paymentAuthorizationId,
            createdAt: DateTime.toDateUtc(result.ledger.createdAt).toISOString(),
            updatedAt: DateTime.toDateUtc(result.ledger.updatedAt).toISOString(),
            items: result.items.map(item => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents
            }))
          } satisfies OrderStatusResult
        }).pipe(Effect.withSpan("OrderService.getOrderStatus"))
    }
  })
)
