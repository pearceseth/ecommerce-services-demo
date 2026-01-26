import { Effect, Layer, Option, Ref, Duration } from "effect"
import { PaymentGatewayService } from "./PaymentGatewayService.js"
import { PaymentConfig } from "../config.js"
import type {
  AuthorizePaymentRequest,
  AuthorizationState
} from "../domain/Authorization.js"
import { AuthorizationResponse } from "../domain/Authorization.js"
import type { CapturePaymentRequest } from "../domain/Capture.js"
import { CaptureResponse } from "../domain/Capture.js"
import type { VoidPaymentRequest } from "../domain/Void.js"
import { VoidResponse } from "../domain/Void.js"
import {
  PaymentDeclinedError,
  GatewayConnectionError,
  AuthorizationNotFoundError,
  AlreadyCapturedError,
  AlreadyVoidedError
} from "../domain/errors.js"

// In-memory state for mock (reset on service restart)
interface MockState {
  // Map idempotency_key -> authorization_id for authorize requests
  authorizeIdempotencyMap: Map<string, string>
  // Map authorization_id -> state
  authorizations: Map<string, AuthorizationState>
  // Map idempotency_key -> capture_id for capture requests
  captureIdempotencyMap: Map<string, string>
  // Map capture_id -> { authorizationId, amountCents, capturedAt }
  captures: Map<string, { authorizationId: string; amountCents: number; capturedAt: Date }>
}

// Generate random IDs matching pattern
const generateAuthorizationId = (): string =>
  `auth_${Array.from({ length: 24 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
      Math.floor(Math.random() * 62)
    ]
  ).join("")}`

const generateCaptureId = (): string =>
  `cap_${Array.from({ length: 24 }, () =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
      Math.floor(Math.random() * 62)
    ]
  ).join("")}`

// Simulate gateway decline based on payment token patterns
const shouldDeclinePayment = (paymentToken: string): { decline: boolean; code: string; reason: string } => {
  // Magic tokens for testing different scenarios
  if (paymentToken.includes("decline_insufficient")) {
    return { decline: true, code: "insufficient_funds", reason: "Insufficient funds" }
  }
  if (paymentToken.includes("decline_expired")) {
    return { decline: true, code: "card_expired", reason: "Card has expired" }
  }
  if (paymentToken.includes("decline_stolen")) {
    return { decline: true, code: "card_declined", reason: "Card reported stolen" }
  }
  if (paymentToken.includes("decline_")) {
    return { decline: true, code: "generic_decline", reason: "Payment declined" }
  }
  return { decline: false, code: "", reason: "" }
}

export const PaymentGatewayServiceLive = Layer.effect(
  PaymentGatewayService,
  Effect.gen(function* () {
    const config = yield* PaymentConfig

    // Initialize in-memory state using Effect Ref for thread-safety
    const stateRef = yield* Ref.make<MockState>({
      authorizeIdempotencyMap: new Map(),
      authorizations: new Map(),
      captureIdempotencyMap: new Map(),
      captures: new Map()
    })

    // Helper: simulate network latency
    const simulateLatency = Effect.gen(function* () {
      if (config.mockLatencyMs > 0) {
        yield* Effect.sleep(Duration.millis(config.mockLatencyMs))
      }
    })

    // Helper: simulate random failures (gateway connection issues)
    const simulateRandomFailure = Effect.gen(function* () {
      if (config.mockFailureRate > 0 && Math.random() < config.mockFailureRate) {
        yield* Effect.fail(new GatewayConnectionError({
          reason: "Simulated gateway timeout",
          isRetryable: true
        }))
      }
    })

    return {
      authorize: (request: AuthorizePaymentRequest) =>
        Effect.gen(function* () {
          yield* simulateLatency
          yield* simulateRandomFailure

          const state = yield* Ref.get(stateRef)

          // Check idempotency - return existing authorization if found
          const existingAuthId = state.authorizeIdempotencyMap.get(request.idempotency_key)
          if (existingAuthId) {
            const existing = state.authorizations.get(existingAuthId)
            if (existing) {
              yield* Effect.logInfo("Returning existing authorization (idempotent)", {
                idempotencyKey: request.idempotency_key,
                authorizationId: existingAuthId
              })
              return new AuthorizationResponse({
                authorization_id: existing.authorizationId,
                status: existing.status === "AUTHORIZED" ? "AUTHORIZED" : "DECLINED",
                amount_cents: existing.amountCents,
                currency: existing.currency,
                created_at: existing.createdAt.toISOString()
              })
            }
          }

          // Check for decline conditions
          const declineCheck = shouldDeclinePayment(request.payment_token)
          if (declineCheck.decline) {
            yield* Effect.logWarning("Payment declined", {
              userId: request.user_id,
              code: declineCheck.code
            })
            return yield* Effect.fail(new PaymentDeclinedError({
              reason: declineCheck.reason,
              declineCode: declineCheck.code,
              isRetryable: false
            }))
          }

          // Generate new authorization
          const authorizationId = generateAuthorizationId()
          const now = new Date()

          const authState: AuthorizationState = {
            authorizationId,
            userId: request.user_id,
            amountCents: request.amount_cents,
            currency: request.currency,
            status: "AUTHORIZED",
            idempotencyKey: request.idempotency_key,
            createdAt: now
          }

          // Update state atomically
          yield* Ref.update(stateRef, (s) => ({
            ...s,
            authorizeIdempotencyMap: new Map(s.authorizeIdempotencyMap).set(
              request.idempotency_key,
              authorizationId
            ),
            authorizations: new Map(s.authorizations).set(authorizationId, authState)
          }))

          yield* Effect.logInfo("Payment authorized", {
            authorizationId,
            userId: request.user_id,
            amountCents: request.amount_cents
          })

          return new AuthorizationResponse({
            authorization_id: authorizationId,
            status: "AUTHORIZED",
            amount_cents: request.amount_cents,
            currency: request.currency,
            created_at: now.toISOString()
          })
        }),

      capture: (authorizationId: string, request: CapturePaymentRequest) =>
        Effect.gen(function* () {
          yield* simulateLatency
          yield* simulateRandomFailure

          const state = yield* Ref.get(stateRef)

          // Check if already captured with this idempotency key
          const existingCaptureId = state.captureIdempotencyMap.get(request.idempotency_key)
          if (existingCaptureId) {
            const existingCapture = state.captures.get(existingCaptureId)
            if (existingCapture) {
              yield* Effect.logInfo("Returning existing capture (idempotent)", {
                idempotencyKey: request.idempotency_key,
                captureId: existingCaptureId
              })
              const auth = state.authorizations.get(existingCapture.authorizationId)
              return new CaptureResponse({
                capture_id: existingCaptureId,
                authorization_id: existingCapture.authorizationId,
                status: "CAPTURED",
                amount_cents: existingCapture.amountCents,
                currency: auth?.currency ?? "USD",
                captured_at: existingCapture.capturedAt.toISOString()
              })
            }
          }

          // Find authorization
          const auth = state.authorizations.get(authorizationId)
          if (!auth) {
            return yield* Effect.fail(new AuthorizationNotFoundError({
              authorizationId,
              reason: "Authorization not found or expired"
            }))
          }

          // Check status
          if (auth.status === "VOIDED") {
            return yield* Effect.fail(new AlreadyVoidedError({
              authorizationId,
              voidedAt: new Date().toISOString() // Approximate
            }))
          }

          // If already captured, this is idempotent success
          if (auth.status === "CAPTURED") {
            // Find existing capture for this auth
            for (const [capId, cap] of state.captures) {
              if (cap.authorizationId === authorizationId) {
                return new CaptureResponse({
                  capture_id: capId,
                  authorization_id: authorizationId,
                  status: "CAPTURED",
                  amount_cents: cap.amountCents,
                  currency: auth.currency,
                  captured_at: cap.capturedAt.toISOString()
                })
              }
            }
          }

          // Perform capture
          const captureId = generateCaptureId()
          const captureAmount = Option.getOrElse(request.amount_cents, () => auth.amountCents)
          const now = new Date()

          yield* Ref.update(stateRef, (s) => {
            const newAuths = new Map(s.authorizations)
            newAuths.set(authorizationId, { ...auth, status: "CAPTURED" })

            return {
              ...s,
              authorizations: newAuths,
              captureIdempotencyMap: new Map(s.captureIdempotencyMap).set(
                request.idempotency_key,
                captureId
              ),
              captures: new Map(s.captures).set(captureId, {
                authorizationId,
                amountCents: captureAmount,
                capturedAt: now
              })
            }
          })

          yield* Effect.logInfo("Payment captured", {
            captureId,
            authorizationId,
            amountCents: captureAmount
          })

          return new CaptureResponse({
            capture_id: captureId,
            authorization_id: authorizationId,
            status: "CAPTURED",
            amount_cents: captureAmount,
            currency: auth.currency,
            captured_at: now.toISOString()
          })
        }),

      voidAuthorization: (authorizationId: string, request: VoidPaymentRequest) =>
        Effect.gen(function* () {
          yield* simulateLatency
          yield* simulateRandomFailure

          const state = yield* Ref.get(stateRef)

          // Find authorization
          const auth = state.authorizations.get(authorizationId)
          if (!auth) {
            return yield* Effect.fail(new AuthorizationNotFoundError({
              authorizationId,
              reason: "Authorization not found or expired"
            }))
          }

          // Check status
          if (auth.status === "CAPTURED") {
            // Find the capture
            for (const [capId, cap] of state.captures) {
              if (cap.authorizationId === authorizationId) {
                return yield* Effect.fail(new AlreadyCapturedError({
                  authorizationId,
                  captureId: capId,
                  capturedAt: cap.capturedAt.toISOString()
                }))
              }
            }
            // Fallback if capture not found (shouldn't happen)
            return yield* Effect.fail(new AlreadyCapturedError({
              authorizationId,
              captureId: "unknown",
              capturedAt: new Date().toISOString()
            }))
          }

          // If already voided, return success (idempotent)
          const now = new Date()
          if (auth.status === "VOIDED") {
            yield* Effect.logInfo("Authorization already voided (idempotent)", { authorizationId })
            return new VoidResponse({
              authorization_id: authorizationId,
              status: "VOIDED",
              voided_at: now.toISOString()
            })
          }

          // Perform void
          yield* Ref.update(stateRef, (s) => {
            const newAuths = new Map(s.authorizations)
            newAuths.set(authorizationId, { ...auth, status: "VOIDED" })
            return { ...s, authorizations: newAuths }
          })

          yield* Effect.logInfo("Payment voided", {
            authorizationId,
            reason: Option.getOrElse(request.reason, () => "No reason provided")
          })

          return new VoidResponse({
            authorization_id: authorizationId,
            status: "VOIDED",
            voided_at: now.toISOString()
          })
        }),

      getAuthorization: (authorizationId: string) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef)
          const auth = state.authorizations.get(authorizationId)
          return auth ? Option.some(auth) : Option.none()
        })
    }
  })
)
