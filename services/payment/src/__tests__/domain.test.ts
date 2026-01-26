import { describe, it, expect } from "vitest"
import { Schema, Effect, Exit, Option } from "effect"
import { AuthorizePaymentRequest, AuthorizationResponse, AuthorizationId } from "../domain/Authorization.js"
import { CapturePaymentRequest, CaptureResponse, AuthorizationIdParams, CaptureId } from "../domain/Capture.js"
import { VoidPaymentRequest, VoidResponse } from "../domain/Void.js"
import {
  PaymentDeclinedError,
  GatewayConnectionError,
  AuthorizationNotFoundError,
  AlreadyCapturedError,
  AlreadyVoidedError,
  IdempotencyKeyConflictError
} from "../domain/errors.js"

describe("Domain Models", () => {
  describe("AuthorizePaymentRequest", () => {
    it("should decode valid request", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const result = await Effect.runPromise(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 2999,
          currency: "USD",
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(result.user_id).toBe("550e8400-e29b-41d4-a716-446655440000")
      expect(result.amount_cents).toBe(2999)
      expect(result.currency).toBe("USD")
      expect(result.payment_token).toBe("tok_valid")
      expect(result.idempotency_key).toBe("idem-123")
    })

    it("should use default currency when not provided", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const result = await Effect.runPromise(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 1000,
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(result.currency).toBe("USD")
    })

    it("should reject invalid UUID", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "not-a-uuid",
          amount_cents: 1000,
          currency: "USD",
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })

    it("should reject non-positive amount", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 0,
          currency: "USD",
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })

    it("should reject negative amount", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: -100,
          currency: "USD",
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })

    it("should reject invalid currency", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 1000,
          currency: "INVALID",
          payment_token: "tok_valid",
          idempotency_key: "idem-123"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })

    it("should reject empty payment_token", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 1000,
          currency: "USD",
          payment_token: "",
          idempotency_key: "idem-123"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })

    it("should reject empty idempotency_key", async () => {
      const decode = Schema.decodeUnknown(AuthorizePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          user_id: "550e8400-e29b-41d4-a716-446655440000",
          amount_cents: 1000,
          currency: "USD",
          payment_token: "tok_valid",
          idempotency_key: ""
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("AuthorizationId", () => {
    it("should accept valid authorization ID", async () => {
      const decode = Schema.decodeUnknown(AuthorizationId)
      const result = await Effect.runPromise(
        decode("auth_ABCDEFghijklmnop12345678")
      )

      expect(result).toBe("auth_ABCDEFghijklmnop12345678")
    })

    it("should reject invalid authorization ID format", async () => {
      const decode = Schema.decodeUnknown(AuthorizationId)

      // Wrong prefix
      const exit1 = await Effect.runPromiseExit(decode("cap_ABCDEFghijklmnop12345678"))
      expect(Exit.isFailure(exit1)).toBe(true)

      // Wrong length
      const exit2 = await Effect.runPromiseExit(decode("auth_short"))
      expect(Exit.isFailure(exit2)).toBe(true)

      // Invalid characters
      const exit3 = await Effect.runPromiseExit(decode("auth_ABCDEFghijklmnop1234567!"))
      expect(Exit.isFailure(exit3)).toBe(true)
    })
  })

  describe("CapturePaymentRequest", () => {
    it("should decode valid request without amount", async () => {
      const decode = Schema.decodeUnknown(CapturePaymentRequest)
      const result = await Effect.runPromise(
        decode({
          idempotency_key: "idem-123"
        })
      )

      expect(result.idempotency_key).toBe("idem-123")
      expect(Option.isNone(result.amount_cents)).toBe(true)
    })

    it("should decode valid request with amount", async () => {
      const decode = Schema.decodeUnknown(CapturePaymentRequest)
      const result = await Effect.runPromise(
        decode({
          idempotency_key: "idem-123",
          amount_cents: 5000
        })
      )

      expect(result.idempotency_key).toBe("idem-123")
      expect(Option.isSome(result.amount_cents)).toBe(true)
      if (Option.isSome(result.amount_cents)) {
        expect(result.amount_cents.value).toBe(5000)
      }
    })

    it("should reject invalid amount (non-positive)", async () => {
      const decode = Schema.decodeUnknown(CapturePaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          idempotency_key: "idem-123",
          amount_cents: 0
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("AuthorizationIdParams", () => {
    it("should accept valid authorization_id", async () => {
      const decode = Schema.decodeUnknown(AuthorizationIdParams)
      const result = await Effect.runPromise(
        decode({
          authorization_id: "auth_ABCDEFghijklmnop12345678"
        })
      )

      expect(result.authorization_id).toBe("auth_ABCDEFghijklmnop12345678")
    })

    it("should reject invalid authorization_id", async () => {
      const decode = Schema.decodeUnknown(AuthorizationIdParams)
      const exit = await Effect.runPromiseExit(
        decode({
          authorization_id: "invalid-id"
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("CaptureId", () => {
    it("should accept valid capture ID", async () => {
      const decode = Schema.decodeUnknown(CaptureId)
      const result = await Effect.runPromise(
        decode("cap_ABCDEFghijklmnop12345678")
      )

      expect(result).toBe("cap_ABCDEFghijklmnop12345678")
    })

    it("should reject invalid capture ID", async () => {
      const decode = Schema.decodeUnknown(CaptureId)
      const exit = await Effect.runPromiseExit(decode("auth_ABCDEFghijklmnop12345678"))
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("VoidPaymentRequest", () => {
    it("should decode valid request without reason", async () => {
      const decode = Schema.decodeUnknown(VoidPaymentRequest)
      const result = await Effect.runPromise(
        decode({
          idempotency_key: "idem-123"
        })
      )

      expect(result.idempotency_key).toBe("idem-123")
      expect(Option.isNone(result.reason)).toBe(true)
    })

    it("should decode valid request with reason", async () => {
      const decode = Schema.decodeUnknown(VoidPaymentRequest)
      const result = await Effect.runPromise(
        decode({
          idempotency_key: "idem-123",
          reason: "Customer cancelled"
        })
      )

      expect(result.idempotency_key).toBe("idem-123")
      expect(Option.isSome(result.reason)).toBe(true)
      if (Option.isSome(result.reason)) {
        expect(result.reason.value).toBe("Customer cancelled")
      }
    })

    it("should reject reason exceeding max length", async () => {
      const decode = Schema.decodeUnknown(VoidPaymentRequest)
      const exit = await Effect.runPromiseExit(
        decode({
          idempotency_key: "idem-123",
          reason: "x".repeat(256)
        })
      )

      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  describe("AuthorizationResponse", () => {
    it("should decode valid response", async () => {
      const decode = Schema.decodeUnknown(AuthorizationResponse)
      const result = await Effect.runPromise(
        decode({
          authorization_id: "auth_ABCDEFghijklmnop12345678",
          status: "AUTHORIZED",
          amount_cents: 2999,
          currency: "USD",
          created_at: "2024-01-15T10:30:00.000Z"
        })
      )

      expect(result.status).toBe("AUTHORIZED")
    })

    it("should accept DECLINED status", async () => {
      const decode = Schema.decodeUnknown(AuthorizationResponse)
      const result = await Effect.runPromise(
        decode({
          authorization_id: "auth_ABCDEFghijklmnop12345678",
          status: "DECLINED",
          amount_cents: 2999,
          currency: "USD",
          created_at: "2024-01-15T10:30:00.000Z"
        })
      )

      expect(result.status).toBe("DECLINED")
    })
  })

  describe("CaptureResponse", () => {
    it("should decode valid response", async () => {
      const decode = Schema.decodeUnknown(CaptureResponse)
      const result = await Effect.runPromise(
        decode({
          capture_id: "cap_ABCDEFghijklmnop12345678",
          authorization_id: "auth_ABCDEFghijklmnop12345678",
          status: "CAPTURED",
          amount_cents: 2999,
          currency: "USD",
          captured_at: "2024-01-15T10:30:00.000Z"
        })
      )

      expect(result.status).toBe("CAPTURED")
    })
  })

  describe("VoidResponse", () => {
    it("should decode valid response", async () => {
      const decode = Schema.decodeUnknown(VoidResponse)
      const result = await Effect.runPromise(
        decode({
          authorization_id: "auth_ABCDEFghijklmnop12345678",
          status: "VOIDED",
          voided_at: "2024-01-15T10:30:00.000Z"
        })
      )

      expect(result.status).toBe("VOIDED")
    })
  })
})

describe("Error Types", () => {
  describe("PaymentDeclinedError", () => {
    it("should create error with correct properties", () => {
      const error = new PaymentDeclinedError({
        reason: "Insufficient funds",
        declineCode: "insufficient_funds",
        isRetryable: false
      })

      expect(error._tag).toBe("PaymentDeclinedError")
      expect(error.reason).toBe("Insufficient funds")
      expect(error.declineCode).toBe("insufficient_funds")
      expect(error.isRetryable).toBe(false)
    })
  })

  describe("GatewayConnectionError", () => {
    it("should create error with correct properties", () => {
      const error = new GatewayConnectionError({
        reason: "Connection timeout",
        isRetryable: true
      })

      expect(error._tag).toBe("GatewayConnectionError")
      expect(error.reason).toBe("Connection timeout")
      expect(error.isRetryable).toBe(true)
    })
  })

  describe("AuthorizationNotFoundError", () => {
    it("should create error with correct properties", () => {
      const error = new AuthorizationNotFoundError({
        authorizationId: "auth_12345",
        reason: "Authorization not found or expired"
      })

      expect(error._tag).toBe("AuthorizationNotFoundError")
      expect(error.authorizationId).toBe("auth_12345")
      expect(error.reason).toBe("Authorization not found or expired")
    })
  })

  describe("AlreadyCapturedError", () => {
    it("should create error with correct properties", () => {
      const error = new AlreadyCapturedError({
        authorizationId: "auth_12345",
        captureId: "cap_67890",
        capturedAt: "2024-01-15T10:30:00.000Z"
      })

      expect(error._tag).toBe("AlreadyCapturedError")
      expect(error.authorizationId).toBe("auth_12345")
      expect(error.captureId).toBe("cap_67890")
      expect(error.capturedAt).toBe("2024-01-15T10:30:00.000Z")
    })
  })

  describe("AlreadyVoidedError", () => {
    it("should create error with correct properties", () => {
      const error = new AlreadyVoidedError({
        authorizationId: "auth_12345",
        voidedAt: "2024-01-15T10:30:00.000Z"
      })

      expect(error._tag).toBe("AlreadyVoidedError")
      expect(error.authorizationId).toBe("auth_12345")
      expect(error.voidedAt).toBe("2024-01-15T10:30:00.000Z")
    })
  })

  describe("IdempotencyKeyConflictError", () => {
    it("should create error with correct properties", () => {
      const error = new IdempotencyKeyConflictError({
        idempotencyKey: "idem-123",
        message: "Idempotency key already used with different parameters"
      })

      expect(error._tag).toBe("IdempotencyKeyConflictError")
      expect(error.idempotencyKey).toBe("idem-123")
      expect(error.message).toBe("Idempotency key already used with different parameters")
    })
  })
})
