import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, Exit } from "effect"
import { PaymentGatewayService } from "../services/PaymentGatewayService.js"
import { PaymentGatewayServiceLive } from "../services/PaymentGatewayServiceLive.js"
import { PaymentConfig } from "../config.js"
import { AuthorizePaymentRequest } from "../domain/Authorization.js"
import { CapturePaymentRequest } from "../domain/Capture.js"
import { VoidPaymentRequest } from "../domain/Void.js"
import type {
  PaymentDeclinedError,
  AuthorizationNotFoundError,
  AlreadyVoidedError,
  AlreadyCapturedError
} from "../domain/errors.js"

// Test config with no latency and no random failures
const TestConfigLive = Layer.succeed(PaymentConfig, {
  port: 3099,
  mockLatencyMs: 0,
  mockFailureRate: 0
})

const TestServiceLive = PaymentGatewayServiceLive.pipe(
  Layer.provide(TestConfigLive)
)

const runTest = <A, E>(effect: Effect.Effect<A, E, PaymentGatewayService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TestServiceLive))
  )

describe("PaymentGatewayService", () => {
  describe("authorize", () => {
    it("should authorize a valid payment", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 2999,
              currency: "USD",
              payment_token: "tok_valid_card",
              idempotency_key: `test-auth-${Date.now()}`
            })
          )
        })
      )

      expect(result.status).toBe("AUTHORIZED")
      expect(result.amount_cents).toBe(2999)
      expect(result.currency).toBe("USD")
      expect(result.authorization_id).toMatch(/^auth_[a-zA-Z0-9]{24}$/)
      expect(result.created_at).toBeDefined()
    })

    it("should use default currency (USD) when not provided", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 5000,
              payment_token: "tok_valid_card",
              idempotency_key: `test-auth-default-currency-${Date.now()}`
            })
          )
        })
      )

      expect(result.currency).toBe("USD")
    })

    it("should return same result for duplicate idempotency key", async () => {
      const idempotencyKey = `test-idem-${Date.now()}`

      const [first, second] = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          const request = new AuthorizePaymentRequest({
            user_id: "550e8400-e29b-41d4-a716-446655440000",
            amount_cents: 5000,
            currency: "USD",
            payment_token: "tok_valid",
            idempotency_key: idempotencyKey
          })

          const first = yield* gateway.authorize(request)
          const second = yield* gateway.authorize(request)
          return [first, second]
        })
      )

      expect(first.authorization_id).toBe(second.authorization_id)
      expect(first.amount_cents).toBe(second.amount_cents)
      expect(first.created_at).toBe(second.created_at)
    })

    it("should decline payment with insufficient funds token", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 10000,
              currency: "USD",
              payment_token: "tok_decline_insufficient",
              idempotency_key: `test-decline-insufficient-${Date.now()}`
            })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentDeclinedError
        expect(error._tag).toBe("PaymentDeclinedError")
        expect(error.declineCode).toBe("insufficient_funds")
        expect(error.reason).toBe("Insufficient funds")
        expect(error.isRetryable).toBe(false)
      }
    })

    it("should decline payment with expired card token", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 10000,
              currency: "USD",
              payment_token: "tok_decline_expired",
              idempotency_key: `test-decline-expired-${Date.now()}`
            })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentDeclinedError
        expect(error._tag).toBe("PaymentDeclinedError")
        expect(error.declineCode).toBe("card_expired")
        expect(error.reason).toBe("Card has expired")
      }
    })

    it("should decline payment with stolen card token", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 10000,
              currency: "USD",
              payment_token: "tok_decline_stolen",
              idempotency_key: `test-decline-stolen-${Date.now()}`
            })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentDeclinedError
        expect(error._tag).toBe("PaymentDeclinedError")
        expect(error.declineCode).toBe("card_declined")
        expect(error.reason).toBe("Card reported stolen")
      }
    })

    it("should decline payment with generic decline token", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 10000,
              currency: "USD",
              payment_token: "tok_decline_generic",
              idempotency_key: `test-decline-generic-${Date.now()}`
            })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as PaymentDeclinedError
        expect(error._tag).toBe("PaymentDeclinedError")
        expect(error.declineCode).toBe("generic_decline")
      }
    })

    it("should support EUR and GBP currencies", async () => {
      const eurResult = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "EUR",
              payment_token: "tok_valid",
              idempotency_key: `test-eur-${Date.now()}`
            })
          )
        })
      )
      expect(eurResult.currency).toBe("EUR")

      const gbpResult = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "GBP",
              payment_token: "tok_valid",
              idempotency_key: `test-gbp-${Date.now()}`
            })
          )
        })
      )
      expect(gbpResult.currency).toBe("GBP")
    })
  })

  describe("capture", () => {
    it("should capture an authorized payment", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          // First authorize
          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1500,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-for-capture-${Date.now()}`
            })
          )

          // Then capture
          const capture = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({
              idempotency_key: `capture-${Date.now()}`,
              amount_cents: Option.none()
            })
          )

          return capture
        })
      )

      expect(result.status).toBe("CAPTURED")
      expect(result.amount_cents).toBe(1500)
      expect(result.capture_id).toMatch(/^cap_[a-zA-Z0-9]{24}$/)
      expect(result.captured_at).toBeDefined()
    })

    it("should capture with partial amount", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 5000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-partial-${Date.now()}`
            })
          )

          const capture = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({
              idempotency_key: `capture-partial-${Date.now()}`,
              amount_cents: Option.some(3000)
            })
          )

          return capture
        })
      )

      expect(result.status).toBe("CAPTURED")
      expect(result.amount_cents).toBe(3000)
    })

    it("should return existing capture for duplicate idempotency key", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 2000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-idem-cap-${Date.now()}`
            })
          )

          const idempotencyKey = `capture-idem-${Date.now()}`

          const capture1 = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: idempotencyKey, amount_cents: Option.none() })
          )

          const capture2 = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: idempotencyKey, amount_cents: Option.none() })
          )

          return { capture1, capture2 }
        })
      )

      expect(result.capture1.capture_id).toBe(result.capture2.capture_id)
      expect(result.capture1.captured_at).toBe(result.capture2.captured_at)
    })

    it("should return existing capture when auth already captured", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 2000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-double-cap-${Date.now()}`
            })
          )

          const capture1 = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: `cap1-${Date.now()}`, amount_cents: Option.none() })
          )

          // Capturing again with different idempotency key should return existing capture
          const capture2 = yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: `cap2-${Date.now()}`, amount_cents: Option.none() })
          )

          return { capture1, capture2 }
        })
      )

      expect(result.capture1.capture_id).toBe(result.capture2.capture_id)
    })

    it("should fail to capture non-existent authorization", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.capture(
            "auth_nonexistent123456789012",
            new CapturePaymentRequest({ idempotency_key: `test-cap-${Date.now()}`, amount_cents: Option.none() })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as AuthorizationNotFoundError
        expect(error._tag).toBe("AuthorizationNotFoundError")
        expect(error.authorizationId).toBe("auth_nonexistent123456789012")
      }
    })

    it("should fail to capture voided authorization", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 3000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-void-cap-${Date.now()}`
            })
          )

          // Void first
          yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void-${Date.now()}`, reason: Option.none() })
          )

          // Try to capture - should fail
          return yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: `cap-after-void-${Date.now()}`, amount_cents: Option.none() })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as AlreadyVoidedError
        expect(error._tag).toBe("AlreadyVoidedError")
      }
    })
  })

  describe("voidAuthorization", () => {
    it("should void an authorized payment", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          // First authorize
          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 2000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-for-void-${Date.now()}`
            })
          )

          // Then void
          const voidResult = yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({
              idempotency_key: `void-${Date.now()}`,
              reason: Option.some("Customer cancelled")
            })
          )

          return voidResult
        })
      )

      expect(result.status).toBe("VOIDED")
      expect(result.voided_at).toBeDefined()
    })

    it("should void without reason", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 2000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-no-reason-${Date.now()}`
            })
          )

          const voidResult = yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({
              idempotency_key: `void-no-reason-${Date.now()}`,
              reason: Option.none()
            })
          )

          return voidResult
        })
      )

      expect(result.status).toBe("VOIDED")
    })

    it("should fail to void already captured payment", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          // Authorize
          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 3000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-cap-void-${Date.now()}`
            })
          )

          // Capture
          yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: `cap-${Date.now()}`, amount_cents: Option.none() })
          )

          // Try to void - should fail
          return yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void-${Date.now()}`, reason: Option.none() })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as AlreadyCapturedError
        expect(error._tag).toBe("AlreadyCapturedError")
        expect(error.captureId).toBeDefined()
        expect(error.capturedAt).toBeDefined()
      }
    })

    it("should be idempotent - voiding twice succeeds", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-double-void-${Date.now()}`
            })
          )

          const void1 = yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void1-${Date.now()}`, reason: Option.none() })
          )

          const void2 = yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void2-${Date.now()}`, reason: Option.none() })
          )

          return { void1, void2 }
        })
      )

      expect(result.void1.status).toBe("VOIDED")
      expect(result.void2.status).toBe("VOIDED")
    })

    it("should fail to void non-existent authorization", async () => {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.voidAuthorization(
            "auth_nonexistent123456789012",
            new VoidPaymentRequest({ idempotency_key: `void-nonexistent-${Date.now()}`, reason: Option.none() })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error as AuthorizationNotFoundError
        expect(error._tag).toBe("AuthorizationNotFoundError")
      }
    })
  })

  describe("getAuthorization", () => {
    it("should return authorization state when it exists", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-get-${Date.now()}`
            })
          )

          const state = yield* gateway.getAuthorization(auth.authorization_id)
          return { auth, state }
        })
      )

      expect(Option.isSome(result.state)).toBe(true)
      if (Option.isSome(result.state)) {
        expect(result.state.value.authorizationId).toBe(result.auth.authorization_id)
        expect(result.state.value.status).toBe("AUTHORIZED")
        expect(result.state.value.amountCents).toBe(1000)
      }
    })

    it("should return none for non-existent authorization", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.getAuthorization("auth_nonexistent123456789012")
        })
      )

      expect(Option.isNone(result)).toBe(true)
    })

    it("should reflect state changes after capture", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-state-cap-${Date.now()}`
            })
          )

          yield* gateway.capture(
            auth.authorization_id,
            new CapturePaymentRequest({ idempotency_key: `cap-state-${Date.now()}`, amount_cents: Option.none() })
          )

          return yield* gateway.getAuthorization(auth.authorization_id)
        })
      )

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("CAPTURED")
      }
    })

    it("should reflect state changes after void", async () => {
      const result = await runTest(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService

          const auth = yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 1000,
              currency: "USD",
              payment_token: "tok_valid",
              idempotency_key: `auth-state-void-${Date.now()}`
            })
          )

          yield* gateway.voidAuthorization(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void-state-${Date.now()}`, reason: Option.none() })
          )

          return yield* gateway.getAuthorization(auth.authorization_id)
        })
      )

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.status).toBe("VOIDED")
      }
    })
  })
})

describe("PaymentGatewayService with failure rate", () => {
  it("should fail with GatewayConnectionError when failure rate is 100%", async () => {
    const FailingConfigLive = Layer.succeed(PaymentConfig, {
      port: 3099,
      mockLatencyMs: 0,
      mockFailureRate: 1.0 // Always fail
    })

    const FailingServiceLive = PaymentGatewayServiceLive.pipe(
      Layer.provide(FailingConfigLive)
    )

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const gateway = yield* PaymentGatewayService
        return yield* gateway.authorize(
          new AuthorizePaymentRequest({
            user_id: "550e8400-e29b-41d4-a716-446655440000",
            amount_cents: 1000,
            currency: "USD",
            payment_token: "tok_valid",
            idempotency_key: `test-failing-${Date.now()}`
          })
        )
      }).pipe(Effect.provide(FailingServiceLive))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("GatewayConnectionError")
    }
  })
})
