import { describe, it, expect, beforeAll } from "vitest"
import { Effect, Layer, Option, DateTime, Schema } from "effect"
import { OrderServiceLive } from "../../services/OrderServiceLive.js"
import { OrderService } from "../../services/OrderService.js"
import { OrderLedgerRepository } from "../../repositories/OrderLedgerRepository.js"
import { PaymentClient, type AuthorizePaymentResult } from "../../services/PaymentClient.js"
import { CreateOrderRequest, OrderLedger, OrderLedgerItem, type OrderLedgerId, type UserId, type ProductId } from "../../domain/OrderLedger.js"
import { DuplicateRequestError, PaymentDeclinedError, PaymentGatewayError, OrderLedgerNotFoundError } from "../../domain/errors.js"

// Valid order request data
const validRequestData = {
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  email: "customer@example.com",
  items: [
    {
      product_id: "550e8400-e29b-41d4-a716-446655440001",
      quantity: 2
    }
  ],
  payment: {
    method: "card" as const,
    token: "tok_test_123"
  }
}

// Parse the request using Schema
const parseRequest = (data: unknown) =>
  Schema.decodeUnknownSync(CreateOrderRequest)(data)

let validRequest: CreateOrderRequest

beforeAll(() => {
  validRequest = parseRequest(validRequestData)
})

// Create mock OrderLedger for testing
const createMockOrderLedger = (overrides?: Partial<{
  id: string
  status: string
  paymentAuthorizationId: string | null
}>): OrderLedger => {
  const now = DateTime.unsafeNow()
  return new OrderLedger({
    id: (overrides?.id ?? "550e8400-e29b-41d4-a716-446655440099") as OrderLedgerId,
    clientRequestId: "unique-request-id-123",
    userId: "550e8400-e29b-41d4-a716-446655440000" as UserId,
    email: "customer@example.com",
    status: (overrides?.status ?? "AWAITING_AUTHORIZATION") as "AWAITING_AUTHORIZATION" | "AUTHORIZED" | "AUTHORIZATION_FAILED",
    totalAmountCents: 2000,
    currency: "USD",
    paymentAuthorizationId: overrides?.paymentAuthorizationId ?? null,
    createdAt: now,
    updatedAt: now
  })
}

// Create mock OrderLedgerItem for testing
const createMockOrderLedgerItem = (overrides?: Partial<{
  productId: string
  quantity: number
  unitPriceCents: number
}>): OrderLedgerItem => {
  const now = DateTime.unsafeNow()
  return new OrderLedgerItem({
    id: "550e8400-e29b-41d4-a716-446655440100",
    orderLedgerId: "550e8400-e29b-41d4-a716-446655440099" as OrderLedgerId,
    productId: (overrides?.productId ?? "550e8400-e29b-41d4-a716-446655440001") as ProductId,
    quantity: overrides?.quantity ?? 2,
    unitPriceCents: overrides?.unitPriceCents ?? 1000,
    createdAt: now
  })
}

// Create mock repository layer
const createMockRepository = (config: {
  findResult: Option.Option<OrderLedger>
  createResult?: OrderLedger
  updateResult?: OrderLedger
  shouldFailOnCreate?: boolean
  shouldFailOnUpdate?: boolean
  findByIdWithItemsResult?: Option.Option<{ ledger: OrderLedger; items: ReadonlyArray<OrderLedgerItem> }>
}) => {
  return Layer.succeed(OrderLedgerRepository, {
    findByClientRequestId: () => Effect.succeed(config.findResult),
    create: () => {
      if (config.shouldFailOnCreate) {
        return Effect.die(new Error("Create failed"))
      }
      return Effect.succeed(config.createResult ?? createMockOrderLedger())
    },
    createItems: () => Effect.succeed([]),
    updateWithAuthorizationAndOutbox: () => {
      if (config.shouldFailOnUpdate) {
        return Effect.die(new Error("Update failed"))
      }
      return Effect.succeed(config.updateResult ?? createMockOrderLedger({
        status: "AUTHORIZED",
        paymentAuthorizationId: "auth_123"
      }))
    },
    markAuthorizationFailed: () => Effect.succeed(createMockOrderLedger({
      status: "AUTHORIZATION_FAILED"
    })),
    findByIdWithItems: () => Effect.succeed(config.findByIdWithItemsResult ?? Option.none())
  })
}

// Create mock payment client layer
const createMockPaymentClient = (config: {
  shouldSucceed: boolean
  result?: AuthorizePaymentResult
  error?: PaymentDeclinedError | PaymentGatewayError
}) => {
  return Layer.succeed(PaymentClient, {
    authorize: () => {
      if (config.shouldSucceed && config.result) {
        return Effect.succeed(config.result)
      }
      if (config.error) {
        return Effect.fail(config.error)
      }
      return Effect.fail(new PaymentGatewayError({
        reason: "Mock error",
        isRetryable: false
      }))
    }
  })
}

describe("OrderService", () => {
  describe("createOrder", () => {
    describe("happy path", () => {
      it("should create order and return authorized status when all steps succeed", async () => {
        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          createResult: createMockOrderLedger(),
          updateResult: createMockOrderLedger({
            id: "550e8400-e29b-41d4-a716-446655440099",
            status: "AUTHORIZED",
            paymentAuthorizationId: "auth_123"
          })
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.createOrder("unique-request-id-123", validRequest)
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.runPromise
        )

        expect(result.orderLedgerId).toBe("550e8400-e29b-41d4-a716-446655440099")
        expect(result.status).toBe("AUTHORIZED")
      })
    })

    describe("idempotency handling", () => {
      it("should fail with DuplicateRequestError when order already exists", async () => {
        const existingLedger = createMockOrderLedger({
          status: "AUTHORIZED",
          paymentAuthorizationId: "auth_existing"
        })

        const repositoryLayer = createMockRepository({
          findResult: Option.some(existingLedger)
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.createOrder("unique-request-id-123", validRequest)
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.either,
          Effect.runPromise
        )

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("DuplicateRequestError")
          const error = result.left as DuplicateRequestError
          expect(error.existingOrderLedgerId).toBe(existingLedger.id)
          expect(error.existingStatus).toBe("AUTHORIZED")
        }
      })
    })

    describe("payment declined", () => {
      it("should fail with PaymentDeclinedError and mark ledger as failed", async () => {
        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          createResult: createMockOrderLedger()
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: false,
          error: new PaymentDeclinedError({
            userId: "550e8400-e29b-41d4-a716-446655440000",
            amountCents: 2000,
            declineCode: "insufficient_funds",
            reason: "Card has insufficient funds",
            isRetryable: false
          })
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.createOrder("unique-request-id-123", validRequest)
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.either,
          Effect.runPromise
        )

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("PaymentDeclinedError")
          const error = result.left as PaymentDeclinedError
          expect(error.declineCode).toBe("insufficient_funds")
          expect(error.reason).toBe("Card has insufficient funds")
          expect(error.isRetryable).toBe(false)
        }
      })
    })

    describe("payment gateway errors", () => {
      it("should fail with PaymentGatewayError when payment service is unavailable", async () => {
        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          createResult: createMockOrderLedger()
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: false,
          error: new PaymentGatewayError({
            reason: "Connection timeout",
            isRetryable: true
          })
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.createOrder("unique-request-id-123", validRequest)
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.either,
          Effect.runPromise
        )

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("PaymentGatewayError")
          const error = result.left as PaymentGatewayError
          expect(error.reason).toBe("Connection timeout")
          expect(error.isRetryable).toBe(true)
        }
      })
    })

    describe("total amount calculation", () => {
      it("should calculate total based on item quantities", async () => {
        let capturedAmount = 0

        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          createResult: createMockOrderLedger(),
          updateResult: createMockOrderLedger({ status: "AUTHORIZED" })
        })

        // Custom payment client to capture the amount
        const paymentLayer = Layer.succeed(PaymentClient, {
          authorize: (params) => {
            capturedAmount = params.amountCents
            return Effect.succeed({
              authorizationId: "auth_123",
              status: "AUTHORIZED" as const,
              amountCents: params.amountCents,
              currency: params.currency,
              createdAt: new Date().toISOString()
            })
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const requestWithMultipleItems = parseRequest({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          email: "customer@example.com",
          items: [
            { product_id: "550e8400-e29b-41d4-a716-446655440001", quantity: 3 },
            { product_id: "550e8400-e29b-41d4-a716-446655440002", quantity: 2 }
          ],
          payment: { method: "card", token: "tok_test" }
        })

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.createOrder("unique-request-id-123", requestWithMultipleItems)
        })

        await program.pipe(
          Effect.provide(serviceLayer),
          Effect.runPromise
        )

        // 3 items + 2 items = 5 items * 1000 cents = 5000 cents
        expect(capturedAmount).toBe(5000)
      })
    })
  })

  describe("getOrderStatus", () => {
    describe("success cases", () => {
      it("should return order status and items when found", async () => {
        const mockLedger = createMockOrderLedger({
          id: "550e8400-e29b-41d4-a716-446655440099",
          status: "AUTHORIZED",
          paymentAuthorizationId: "auth_123"
        })

        const mockItems = [
          createMockOrderLedgerItem({
            productId: "550e8400-e29b-41d4-a716-446655440001",
            quantity: 2,
            unitPriceCents: 1000
          }),
          createMockOrderLedgerItem({
            productId: "550e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            unitPriceCents: 2500
          })
        ]

        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          findByIdWithItemsResult: Option.some({ ledger: mockLedger, items: mockItems })
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.getOrderStatus("550e8400-e29b-41d4-a716-446655440099")
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.runPromise
        )

        expect(result.orderLedgerId).toBe("550e8400-e29b-41d4-a716-446655440099")
        expect(result.status).toBe("AUTHORIZED")
        expect(result.email).toBe("customer@example.com")
        expect(result.paymentAuthorizationId).toBe("auth_123")
        expect(result.items).toHaveLength(2)
        expect(result.items[0].productId).toBe("550e8400-e29b-41d4-a716-446655440001")
        expect(result.items[0].quantity).toBe(2)
        expect(result.items[0].unitPriceCents).toBe(1000)
      })

      it("should return order with empty items array when ledger has no items", async () => {
        const mockLedger = createMockOrderLedger({
          id: "550e8400-e29b-41d4-a716-446655440099",
          status: "AWAITING_AUTHORIZATION"
        })

        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          findByIdWithItemsResult: Option.some({ ledger: mockLedger, items: [] })
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.getOrderStatus("550e8400-e29b-41d4-a716-446655440099")
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.runPromise
        )

        expect(result.orderLedgerId).toBe("550e8400-e29b-41d4-a716-446655440099")
        expect(result.status).toBe("AWAITING_AUTHORIZATION")
        expect(result.items).toHaveLength(0)
      })
    })

    describe("error cases", () => {
      it("should fail with OrderLedgerNotFoundError when order does not exist", async () => {
        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          findByIdWithItemsResult: Option.none()
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.getOrderStatus("00000000-0000-0000-0000-000000000000")
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.either,
          Effect.runPromise
        )

        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("OrderLedgerNotFoundError")
          const error = result.left as OrderLedgerNotFoundError
          expect(error.orderLedgerId).toBe("00000000-0000-0000-0000-000000000000")
        }
      })
    })

    describe("response format", () => {
      it("should return timestamps as ISO strings", async () => {
        const mockLedger = createMockOrderLedger({
          id: "550e8400-e29b-41d4-a716-446655440099",
          status: "AUTHORIZED"
        })

        const repositoryLayer = createMockRepository({
          findResult: Option.none(),
          findByIdWithItemsResult: Option.some({ ledger: mockLedger, items: [] })
        })

        const paymentLayer = createMockPaymentClient({
          shouldSucceed: true,
          result: {
            authorizationId: "auth_123",
            status: "AUTHORIZED",
            amountCents: 2000,
            currency: "USD",
            createdAt: new Date().toISOString()
          }
        })

        const serviceLayer = OrderServiceLive.pipe(
          Layer.provide(repositoryLayer),
          Layer.provide(paymentLayer)
        )

        const program = Effect.gen(function* () {
          const service = yield* OrderService
          return yield* service.getOrderStatus("550e8400-e29b-41d4-a716-446655440099")
        })

        const result = await program.pipe(
          Effect.provide(serviceLayer),
          Effect.runPromise
        )

        // Timestamps should be strings (ISO format)
        expect(typeof result.createdAt).toBe("string")
        expect(typeof result.updatedAt).toBe("string")
        // They should be parseable as dates
        expect(new Date(result.createdAt).toString()).not.toBe("Invalid Date")
        expect(new Date(result.updatedAt).toString()).not.toBe("Invalid Date")
      })
    })
  })
})
