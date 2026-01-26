# Implementation Plan: Payments Service (Mock) - Complete Setup

## Status: COMPLETE

---

## Overview

This plan covers the complete setup of the Payments Service, a **stateless mock service** for simulating payment gateway operations. The service provides configurable latency and failure rates for testing saga flows in the e-commerce system.

### Endpoints to Implement
1. `POST /payments/authorize` - Authorize payment, return authorization_id
2. `POST /payments/capture/{authorization_id}` - Capture authorized payment
3. `POST /payments/void/{authorization_id}` - Void authorization (compensation)

### Key Characteristics
- **Stateless**: No database required - uses in-memory state simulation
- **Configurable**: Latency and failure rates controlled via environment variables
- **Idempotent**: All operations are idempotent via idempotency keys
- **Mock Gateway**: Simulates real payment gateway responses and behaviors

---

## Task 1: Create Service Scaffold and Folder Structure

### 1.1 Create Directory Structure

```
services/payment/src/
├── index.ts              # Entry point
├── server.ts             # HTTP server setup
├── config.ts             # Environment configuration
├── layers.ts             # Layer composition
├── telemetry.ts          # OpenTelemetry setup
├── api/                  # HTTP endpoints
│   ├── health.ts         # Health check
│   └── payments.ts       # Payment endpoints
├── domain/               # Domain models
│   ├── Authorization.ts  # Authorization model
│   ├── Capture.ts        # Capture model
│   └── errors.ts         # Tagged errors
└── services/             # Business logic
    ├── PaymentGatewayService.ts      # Interface
    └── PaymentGatewayServiceLive.ts  # Mock implementation
```

**Note**: No `repositories/` folder needed - this is a stateless mock service.

### 1.2 Create `src/index.ts`

```typescript
import "./server.js"
```

Simple entry point that imports and runs the server.

### 1.3 Create `src/config.ts`

Define configuration schema using Effect's Config module:

```typescript
import { Config, Effect, Layer } from "effect"

export class PaymentConfig extends Context.Tag("PaymentConfig")<
  PaymentConfig,
  {
    readonly port: number
    readonly mockLatencyMs: number
    readonly mockFailureRate: number  // 0.0 to 1.0
  }
>() {}

export const PaymentConfigLive = Layer.effect(
  PaymentConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3002)),
      mockLatencyMs: yield* Config.number("MOCK_LATENCY_MS").pipe(Config.withDefault(100)),
      mockFailureRate: yield* Config.number("MOCK_FAILURE_RATE").pipe(Config.withDefault(0.0))
    }
  })
)
```

**Key Points:**
- Default port is 3002 (different from inventory on 3001 and edge-api on 3000)
- `MOCK_LATENCY_MS` adds artificial delay to simulate network latency
- `MOCK_FAILURE_RATE` is a decimal (0.0 = never fail, 1.0 = always fail, 0.05 = 5% failure)

---

## Task 2: Define Domain Models

### 2.1 Create `src/domain/Authorization.ts`

```typescript
import { Schema } from "effect"

// Branded types for type safety
export const AuthorizationId = Schema.String.pipe(
  Schema.pattern(/^auth_[a-zA-Z0-9]{24}$/),
  Schema.brand("AuthorizationId")
)
export type AuthorizationId = typeof AuthorizationId.Type

// Authorization request schema
export class AuthorizePaymentRequest extends Schema.Class<AuthorizePaymentRequest>("AuthorizePaymentRequest")({
  user_id: Schema.UUID,
  amount_cents: Schema.Int.pipe(
    Schema.positive({ message: () => "Amount must be positive" })
  ),
  currency: Schema.Literal("USD", "EUR", "GBP").pipe(
    Schema.propertySignature,
    Schema.withConstructorDefault(() => "USD" as const)
  ),
  payment_token: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Payment token is required" })
  ),
  idempotency_key: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Idempotency key is required" })
  )
}) {}

// Authorization response
export class AuthorizationResponse extends Schema.Class<AuthorizationResponse>("AuthorizationResponse")({
  authorization_id: AuthorizationId,
  status: Schema.Literal("AUTHORIZED", "DECLINED"),
  amount_cents: Schema.Int,
  currency: Schema.String,
  created_at: Schema.String  // ISO timestamp
}) {}

// Internal authorization state (for idempotency tracking)
export interface AuthorizationState {
  readonly authorizationId: string
  readonly userId: string
  readonly amountCents: number
  readonly currency: string
  readonly status: "AUTHORIZED" | "CAPTURED" | "VOIDED"
  readonly idempotencyKey: string
  readonly createdAt: Date
}
```

**Design Decisions:**
- Authorization IDs follow pattern `auth_XXXX` to be easily identifiable
- Currency is an enum to prevent invalid values
- `payment_token` simulates tokenized card data from a frontend
- Amounts stored in cents (consistent with rest of system)

### 2.2 Create `src/domain/Capture.ts`

```typescript
import { Schema } from "effect"

export const CaptureId = Schema.String.pipe(
  Schema.pattern(/^cap_[a-zA-Z0-9]{24}$/),
  Schema.brand("CaptureId")
)
export type CaptureId = typeof CaptureId.Type

// Path parameter schema for authorization_id
export const AuthorizationIdParams = Schema.Struct({
  authorization_id: Schema.String.pipe(
    Schema.pattern(/^auth_[a-zA-Z0-9]{24}$/, {
      message: () => "Invalid authorization ID format"
    })
  )
})

// Capture request (body is optional, mostly uses path param)
export class CapturePaymentRequest extends Schema.Class<CapturePaymentRequest>("CapturePaymentRequest")({
  idempotency_key: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Idempotency key is required" })
  ),
  // Optional: capture a different amount than authorized (partial capture)
  amount_cents: Schema.optionalWith(
    Schema.Int.pipe(Schema.positive()),
    { as: "Option" }
  )
}) {}

// Capture response
export class CaptureResponse extends Schema.Class<CaptureResponse>("CaptureResponse")({
  capture_id: CaptureId,
  authorization_id: Schema.String,
  status: Schema.Literal("CAPTURED", "FAILED"),
  amount_cents: Schema.Int,
  currency: Schema.String,
  captured_at: Schema.String  // ISO timestamp
}) {}
```

### 2.3 Create `src/domain/Void.ts`

```typescript
import { Schema } from "effect"

// Void request
export class VoidPaymentRequest extends Schema.Class<VoidPaymentRequest>("VoidPaymentRequest")({
  idempotency_key: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Idempotency key is required" })
  ),
  reason: Schema.optionalWith(
    Schema.String.pipe(Schema.maxLength(255)),
    { as: "Option" }
  )
}) {}

// Void response
export class VoidResponse extends Schema.Class<VoidResponse>("VoidResponse")({
  authorization_id: Schema.String,
  status: Schema.Literal("VOIDED"),
  voided_at: Schema.String  // ISO timestamp
}) {}
```

### 2.4 Create `src/domain/errors.ts`

```typescript
import { Data } from "effect"

/**
 * Payment authorization was declined by the gateway.
 * This is a PERMANENT failure - should not retry.
 */
export class PaymentDeclinedError extends Data.TaggedError("PaymentDeclinedError")<{
  readonly reason: string
  readonly declineCode: string  // e.g., "insufficient_funds", "card_expired"
  readonly isRetryable: false   // Always false - payment declined
}> {
  constructor(props: Omit<PaymentDeclinedError, "_tag" | "isRetryable">) {
    super({ ...props, isRetryable: false })
  }
}

/**
 * Payment gateway connection or timeout error.
 * This is a TRANSIENT failure - should retry with backoff.
 */
export class GatewayConnectionError extends Data.TaggedError("GatewayConnectionError")<{
  readonly reason: string
  readonly isRetryable: true  // Always true - network issue
}> {
  constructor(reason: string) {
    super({ reason, isRetryable: true })
  }
}

/**
 * Authorization not found for capture/void.
 * Could be invalid ID or already expired/voided.
 */
export class AuthorizationNotFoundError extends Data.TaggedError("AuthorizationNotFoundError")<{
  readonly authorizationId: string
  readonly reason: string
}> {}

/**
 * Authorization already captured - cannot capture again.
 * Return existing capture for idempotency.
 */
export class AlreadyCapturedError extends Data.TaggedError("AlreadyCapturedError")<{
  readonly authorizationId: string
  readonly captureId: string
  readonly capturedAt: string
}> {}

/**
 * Authorization already voided - cannot void again or capture.
 */
export class AlreadyVoidedError extends Data.TaggedError("AlreadyVoidedError")<{
  readonly authorizationId: string
  readonly voidedAt: string
}> {}

/**
 * Duplicate idempotency key with different parameters.
 * This indicates a client bug - same key used for different requests.
 */
export class IdempotencyKeyConflictError extends Data.TaggedError("IdempotencyKeyConflictError")<{
  readonly idempotencyKey: string
  readonly message: string
}> {}
```

**Error Design Principles:**
- Each error has `isRetryable` where applicable
- Include identifiers for debugging (authorizationId, captureId)
- Provide meaningful decline codes matching real gateway patterns
- Separate "already done" errors for idempotent handling

---

## Task 3: Implement Payment Gateway Service (Mock)

### 3.1 Create `src/services/PaymentGatewayService.ts` (Interface)

```typescript
import { Context, Effect, Option } from "effect"
import {
  AuthorizePaymentRequest,
  AuthorizationResponse,
  AuthorizationState
} from "../domain/Authorization.js"
import { CapturePaymentRequest, CaptureResponse } from "../domain/Capture.js"
import { VoidPaymentRequest, VoidResponse } from "../domain/Void.js"
import {
  PaymentDeclinedError,
  GatewayConnectionError,
  AuthorizationNotFoundError,
  AlreadyCapturedError,
  AlreadyVoidedError
} from "../domain/errors.js"

export class PaymentGatewayService extends Context.Tag("PaymentGatewayService")<
  PaymentGatewayService,
  {
    /**
     * Authorize a payment amount. Holds funds but does not charge.
     * Idempotent: same idempotency_key returns same result.
     */
    readonly authorize: (
      request: AuthorizePaymentRequest
    ) => Effect.Effect<
      AuthorizationResponse,
      PaymentDeclinedError | GatewayConnectionError
    >

    /**
     * Capture an authorized payment. Actually charges the customer.
     * Idempotent: capturing already-captured auth returns existing capture.
     */
    readonly capture: (
      authorizationId: string,
      request: CapturePaymentRequest
    ) => Effect.Effect<
      CaptureResponse,
      AuthorizationNotFoundError | AlreadyVoidedError | GatewayConnectionError
    >

    /**
     * Void an authorization. Releases held funds without charging.
     * Idempotent: voiding already-voided auth succeeds.
     */
    readonly void_: (
      authorizationId: string,
      request: VoidPaymentRequest
    ) => Effect.Effect<
      VoidResponse,
      AuthorizationNotFoundError | AlreadyCapturedError | GatewayConnectionError
    >

    /**
     * Get authorization state (for testing/debugging).
     * Not part of typical payment API but useful for mock.
     */
    readonly getAuthorization: (
      authorizationId: string
    ) => Effect.Effect<Option.Option<AuthorizationState>, never>
  }
>() {}
```

**Note**: Method named `void_` because `void` is a reserved keyword in TypeScript.

### 3.2 Create `src/services/PaymentGatewayServiceLive.ts` (Mock Implementation)

```typescript
import { Effect, Layer, Option, Ref } from "effect"
import { PaymentGatewayService } from "./PaymentGatewayService.js"
import { PaymentConfig } from "../config.js"
import {
  AuthorizePaymentRequest,
  AuthorizationResponse,
  AuthorizationState
} from "../domain/Authorization.js"
import { CapturePaymentRequest, CaptureResponse } from "../domain/Capture.js"
import { VoidPaymentRequest, VoidResponse } from "../domain/Void.js"
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
  // Map capture_id -> { authorizationId, capturedAt }
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
        yield* Effect.sleep(`${config.mockLatencyMs} millis`)
      }
    })

    // Helper: simulate random failures (gateway connection issues)
    const simulateRandomFailure = Effect.gen(function* () {
      if (config.mockFailureRate > 0 && Math.random() < config.mockFailureRate) {
        yield* Effect.fail(new GatewayConnectionError("Simulated gateway timeout"))
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
                authorization_id: existing.authorizationId as any,
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
            yield* new PaymentDeclinedError({
              reason: declineCheck.reason,
              declineCode: declineCheck.code
            })
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
            authorization_id: authorizationId as any,
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
                capture_id: existingCaptureId as any,
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
            yield* new AuthorizationNotFoundError({
              authorizationId,
              reason: "Authorization not found or expired"
            })
          }

          // Check status
          if (auth!.status === "VOIDED") {
            yield* new AlreadyVoidedError({
              authorizationId,
              voidedAt: new Date().toISOString()  // Approximate
            })
          }

          // If already captured, this is idempotent success
          if (auth!.status === "CAPTURED") {
            // Find existing capture for this auth
            for (const [capId, cap] of state.captures) {
              if (cap.authorizationId === authorizationId) {
                return new CaptureResponse({
                  capture_id: capId as any,
                  authorization_id: authorizationId,
                  status: "CAPTURED",
                  amount_cents: cap.amountCents,
                  currency: auth!.currency,
                  captured_at: cap.capturedAt.toISOString()
                })
              }
            }
          }

          // Perform capture
          const captureId = generateCaptureId()
          const captureAmount = Option.getOrElse(request.amount_cents, () => auth!.amountCents)
          const now = new Date()

          yield* Ref.update(stateRef, (s) => {
            const newAuths = new Map(s.authorizations)
            newAuths.set(authorizationId, { ...auth!, status: "CAPTURED" })

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
            capture_id: captureId as any,
            authorization_id: authorizationId,
            status: "CAPTURED",
            amount_cents: captureAmount,
            currency: auth!.currency,
            captured_at: now.toISOString()
          })
        }),

      void_: (authorizationId: string, request: VoidPaymentRequest) =>
        Effect.gen(function* () {
          yield* simulateLatency
          yield* simulateRandomFailure

          const state = yield* Ref.get(stateRef)

          // Find authorization
          const auth = state.authorizations.get(authorizationId)
          if (!auth) {
            yield* new AuthorizationNotFoundError({
              authorizationId,
              reason: "Authorization not found or expired"
            })
          }

          // Check status
          if (auth!.status === "CAPTURED") {
            // Find the capture
            for (const [capId, cap] of state.captures) {
              if (cap.authorizationId === authorizationId) {
                yield* new AlreadyCapturedError({
                  authorizationId,
                  captureId: capId,
                  capturedAt: cap.capturedAt.toISOString()
                })
              }
            }
            // Fallback if capture not found (shouldn't happen)
            yield* new AlreadyCapturedError({
              authorizationId,
              captureId: "unknown",
              capturedAt: new Date().toISOString()
            })
          }

          // If already voided, return success (idempotent)
          const now = new Date()
          if (auth!.status === "VOIDED") {
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
            newAuths.set(authorizationId, { ...auth!, status: "VOIDED" })
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
```

**Key Implementation Details:**

1. **In-Memory State with Ref**
   - Uses Effect's `Ref` for thread-safe mutable state
   - State resets on service restart (appropriate for mock)
   - Maps for O(1) idempotency lookups

2. **Idempotency Handling**
   - Separate idempotency maps for authorize and capture
   - Returns existing result for duplicate idempotency keys
   - True idempotency: same key = same result

3. **Magic Payment Tokens**
   - `decline_insufficient` → Insufficient funds
   - `decline_expired` → Card expired
   - `decline_stolen` → Card stolen
   - `decline_*` → Generic decline
   - Any other token → Success

4. **Configurable Behavior**
   - `MOCK_LATENCY_MS` → Artificial delay via `Effect.sleep`
   - `MOCK_FAILURE_RATE` → Random GatewayConnectionError

5. **Logging**
   - Log all successful operations
   - Log declines with warning level
   - Include relevant IDs for correlation

---

## Task 4: Implement HTTP Endpoints

### 4.1 Create `src/api/health.ts`

```typescript
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

const healthCheck = Effect.succeed(
  HttpServerResponse.json({
    status: "healthy",
    service: "payments",
    timestamp: new Date().toISOString()
  })
)

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
```

**Note**: No database health check needed - this is a stateless service.

### 4.2 Create `src/api/payments.ts`

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Option } from "effect"
import { PaymentGatewayService } from "../services/PaymentGatewayService.js"
import { AuthorizePaymentRequest } from "../domain/Authorization.js"
import { AuthorizationIdParams, CapturePaymentRequest } from "../domain/Capture.js"
import { VoidPaymentRequest } from "../domain/Void.js"

// POST /payments/authorize
const authorizePayment = Effect.gen(function* () {
  // 1. Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(AuthorizePaymentRequest)

  // 2. Get service
  const gateway = yield* PaymentGatewayService

  // 3. Execute authorization
  const result = yield* gateway.authorize(body)

  // 4. Return success response
  return HttpServerResponse.json(result, { status: 200 })
}).pipe(
  Effect.withSpan("POST /payments/authorize"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error) =>
      HttpServerResponse.json(
        { error: "validation_error", message: "Invalid request body", details: error.message },
        { status: 400 }
      ),
    PaymentDeclinedError: (error) =>
      HttpServerResponse.json(
        {
          error: "payment_declined",
          decline_code: error.declineCode,
          message: error.reason,
          is_retryable: error.isRetryable
        },
        { status: 402 }  // 402 Payment Required
      ),
    GatewayConnectionError: (error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error", { reason: error.reason })
        return HttpServerResponse.json(
          {
            error: "gateway_error",
            message: "Payment gateway temporarily unavailable",
            is_retryable: error.isRetryable
          },
          { status: 503 }  // 503 Service Unavailable
        )
      }).pipe(Effect.flatten)
  })
)

// POST /payments/capture/:authorization_id
const capturePayment = Effect.gen(function* () {
  // 1. Parse path params
  const params = yield* HttpRouter.schemaPathParams(AuthorizationIdParams)

  // 2. Parse body
  const body = yield* HttpServerRequest.schemaBodyJson(CapturePaymentRequest)

  // 3. Get service and execute
  const gateway = yield* PaymentGatewayService
  const result = yield* gateway.capture(params.authorization_id, body)

  return HttpServerResponse.json(result, { status: 200 })
}).pipe(
  Effect.withSpan("POST /payments/capture/:authorization_id"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error) =>
      HttpServerResponse.json(
        { error: "validation_error", message: error.message },
        { status: 400 }
      ),
    AuthorizationNotFoundError: (error) =>
      HttpServerResponse.json(
        {
          error: "authorization_not_found",
          authorization_id: error.authorizationId,
          message: error.reason
        },
        { status: 404 }
      ),
    AlreadyVoidedError: (error) =>
      HttpServerResponse.json(
        {
          error: "already_voided",
          authorization_id: error.authorizationId,
          voided_at: error.voidedAt,
          message: "Authorization has already been voided and cannot be captured"
        },
        { status: 409 }  // 409 Conflict
      ),
    GatewayConnectionError: (error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error during capture", { reason: error.reason })
        return HttpServerResponse.json(
          { error: "gateway_error", message: "Gateway unavailable", is_retryable: true },
          { status: 503 }
        )
      }).pipe(Effect.flatten)
  })
)

// POST /payments/void/:authorization_id
const voidPayment = Effect.gen(function* () {
  // 1. Parse path params
  const params = yield* HttpRouter.schemaPathParams(AuthorizationIdParams)

  // 2. Parse body
  const body = yield* HttpServerRequest.schemaBodyJson(VoidPaymentRequest)

  // 3. Get service and execute
  const gateway = yield* PaymentGatewayService
  const result = yield* gateway.void_(params.authorization_id, body)

  return HttpServerResponse.json(result, { status: 200 })
}).pipe(
  Effect.withSpan("POST /payments/void/:authorization_id"),
  Effect.flatten,
  Effect.catchTags({
    ParseError: (error) =>
      HttpServerResponse.json(
        { error: "validation_error", message: error.message },
        { status: 400 }
      ),
    AuthorizationNotFoundError: (error) =>
      HttpServerResponse.json(
        {
          error: "authorization_not_found",
          authorization_id: error.authorizationId,
          message: error.reason
        },
        { status: 404 }
      ),
    AlreadyCapturedError: (error) =>
      HttpServerResponse.json(
        {
          error: "already_captured",
          authorization_id: error.authorizationId,
          capture_id: error.captureId,
          captured_at: error.capturedAt,
          message: "Authorization has already been captured and cannot be voided"
        },
        { status: 409 }
      ),
    GatewayConnectionError: (error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Gateway connection error during void", { reason: error.reason })
        return HttpServerResponse.json(
          { error: "gateway_error", message: "Gateway unavailable", is_retryable: true },
          { status: 503 }
        )
      }).pipe(Effect.flatten)
  })
)

// Combine all payment routes
export const PaymentRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/payments/authorize", authorizePayment),
  HttpRouter.post("/payments/capture/:authorization_id", capturePayment),
  HttpRouter.post("/payments/void/:authorization_id", voidPayment)
)
```

**HTTP Status Code Mapping:**

| Error Type | HTTP Status | Reason |
|------------|-------------|--------|
| ParseError (validation) | 400 Bad Request | Invalid input |
| PaymentDeclinedError | 402 Payment Required | Card declined |
| AuthorizationNotFoundError | 404 Not Found | Invalid ID |
| AlreadyVoidedError | 409 Conflict | State conflict |
| AlreadyCapturedError | 409 Conflict | State conflict |
| GatewayConnectionError | 503 Service Unavailable | Transient failure |

---

## Task 5: Wire Up Server and Layers

### 5.1 Create `src/layers.ts`

```typescript
import { Layer } from "effect"
import { PaymentConfigLive } from "./config.js"
import { PaymentGatewayServiceLive } from "./services/PaymentGatewayServiceLive.js"

// Service depends on config
const ServiceLive = PaymentGatewayServiceLive.pipe(
  Layer.provide(PaymentConfigLive)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(PaymentConfigLive, ServiceLive)
```

### 5.2 Create `src/telemetry.ts`

```typescript
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"

const serviceName = process.env.OTEL_SERVICE_NAME ?? "payments-service"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"

export const TelemetryLive = NodeSdk.layer(() => ({
  resource: { serviceName },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
  ),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
    exportIntervalMillis: 10000
  }),
  logRecordProcessor: new BatchLogRecordProcessor(
    new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` })
  )
}))
```

### 5.3 Create `src/server.ts`

```typescript
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { PaymentRoutes } from "./api/payments.js"
import { AppLive } from "./layers.js"
import { TelemetryLive } from "./telemetry.js"
import { PaymentConfig } from "./config.js"

const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get("/", Effect.succeed(HttpServerResponse.text("Payments Service")))
)

const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/", PaymentRoutes)
)

// Create server with dynamic port from config
const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* PaymentConfig

    return router.pipe(
      HttpServer.serve(),
      HttpServer.withLogAddress,
      Layer.provide(
        NodeHttpServer.layer(createServer, { port: config.port })
      )
    )
  })
)

const MainLive = HttpLive.pipe(
  Layer.provide(AppLive),
  Layer.provide(TelemetryLive)
)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
```

---

## Task 6: Write Tests

### 6.1 Create `src/__tests__/payments.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { Effect, Layer, Ref, Exit } from "effect"
import { PaymentGatewayService } from "../services/PaymentGatewayService.js"
import { PaymentGatewayServiceLive } from "../services/PaymentGatewayServiceLive.js"
import { PaymentConfig, PaymentConfigLive } from "../config.js"
import { AuthorizePaymentRequest } from "../domain/Authorization.js"
import { CapturePaymentRequest } from "../domain/Capture.js"
import { VoidPaymentRequest } from "../domain/Void.js"

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
              idempotency_key: "test-auth-1"
            })
          )
        })
      )

      expect(result.status).toBe("AUTHORIZED")
      expect(result.amount_cents).toBe(2999)
      expect(result.authorization_id).toMatch(/^auth_[a-zA-Z0-9]{24}$/)
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
    })

    it("should decline payment with insufficient funds token", async () => {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.authorize(
            new AuthorizePaymentRequest({
              user_id: "550e8400-e29b-41d4-a716-446655440000",
              amount_cents: 10000,
              currency: "USD",
              payment_token: "tok_decline_insufficient",
              idempotency_key: "test-decline-1"
            })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = result.cause
        // Check error is PaymentDeclinedError
        expect(error).toMatchObject({
          _tag: "PaymentDeclinedError",
          declineCode: "insufficient_funds"
        })
      }
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
              idempotency_key: `capture-${Date.now()}`
            })
          )

          return capture
        })
      )

      expect(result.status).toBe("CAPTURED")
      expect(result.amount_cents).toBe(1500)
      expect(result.capture_id).toMatch(/^cap_[a-zA-Z0-9]{24}$/)
    })

    it("should fail to capture non-existent authorization", async () => {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const gateway = yield* PaymentGatewayService
          return yield* gateway.capture(
            "auth_nonexistent123456789012",
            new CapturePaymentRequest({ idempotency_key: "test-cap-1" })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(result)).toBe(true)
    })
  })

  describe("void", () => {
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
          const voidResult = yield* gateway.void_(
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
    })

    it("should fail to void already captured payment", async () => {
      const result = await Effect.runPromiseExit(
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
            new CapturePaymentRequest({ idempotency_key: `cap-${Date.now()}` })
          )

          // Try to void - should fail
          return yield* gateway.void_(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void-${Date.now()}` })
          )
        }).pipe(Effect.provide(TestServiceLive))
      )

      expect(Exit.isFailure(result)).toBe(true)
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

          const void1 = yield* gateway.void_(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void1-${Date.now()}` })
          )

          const void2 = yield* gateway.void_(
            auth.authorization_id,
            new VoidPaymentRequest({ idempotency_key: `void2-${Date.now()}` })
          )

          return { void1, void2 }
        })
      )

      expect(result.void1.status).toBe("VOIDED")
      expect(result.void2.status).toBe("VOIDED")
    })
  })
})
```

### 6.2 Test Patterns to Include

1. **Happy Path Tests**
   - Authorize → success
   - Authorize → Capture → success
   - Authorize → Void → success

2. **Idempotency Tests**
   - Duplicate authorize returns same result
   - Duplicate capture returns same result
   - Void is idempotent (can void twice)

3. **Error Path Tests**
   - Decline with magic tokens
   - Capture non-existent auth
   - Void captured payment
   - Capture voided payment

4. **State Transition Tests**
   - AUTHORIZED → CAPTURED (valid)
   - AUTHORIZED → VOIDED (valid)
   - CAPTURED → VOIDED (invalid)
   - VOIDED → CAPTURED (invalid)

---

## Task 7: Update Docker Compose (if needed)

Verify `docker-compose.yml` in root has payments service configured:

```yaml
payments-service:
  build: ./services/payment
  environment:
    MOCK_LATENCY_MS: 100
    MOCK_FAILURE_RATE: 0.05
    PORT: 3002
    OTEL_SERVICE_NAME: payments-service
    OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
  ports:
    - "3002:3002"
  depends_on:
    observability:
      condition: service_started
```

---

## Summary of Files to Create

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point |
| `src/server.ts` | HTTP server setup |
| `src/config.ts` | Environment configuration |
| `src/layers.ts` | DI layer composition |
| `src/telemetry.ts` | OpenTelemetry setup |
| `src/api/health.ts` | Health endpoint |
| `src/api/payments.ts` | Payment endpoints |
| `src/domain/Authorization.ts` | Auth request/response schemas |
| `src/domain/Capture.ts` | Capture schemas |
| `src/domain/Void.ts` | Void schemas |
| `src/domain/errors.ts` | Tagged error types |
| `src/services/PaymentGatewayService.ts` | Service interface |
| `src/services/PaymentGatewayServiceLive.ts` | Mock implementation |
| `src/__tests__/payments.test.ts` | Unit tests |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | HTTP server port |
| `MOCK_LATENCY_MS` | 100 | Artificial delay in ms |
| `MOCK_FAILURE_RATE` | 0.0 | Random failure rate (0.0-1.0) |
| `OTEL_SERVICE_NAME` | payments-service | OpenTelemetry service name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | http://localhost:4318 | OTLP endpoint |

---

## Validation Checklist

After implementation, verify:

- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] `npm run test` all tests pass
- [ ] `npm run dev` starts server on port 3002
- [ ] `curl localhost:3002/health` returns healthy
- [ ] Authorize endpoint works with valid token
- [ ] Authorize endpoint declines with magic tokens
- [ ] Capture works after authorization
- [ ] Void works after authorization
- [ ] Idempotency works for all operations
- [ ] Error responses have correct HTTP status codes
- [ ] Logs appear with correct format
