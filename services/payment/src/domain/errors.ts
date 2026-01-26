import { Data } from "effect"

/**
 * Payment authorization was declined by the gateway.
 * This is a PERMANENT failure - should not retry.
 */
export class PaymentDeclinedError extends Data.TaggedError("PaymentDeclinedError")<{
  readonly reason: string
  readonly declineCode: string // e.g., "insufficient_funds", "card_expired"
  readonly isRetryable: false // Always false - payment declined
}> {}

/**
 * Payment gateway connection or timeout error.
 * This is a TRANSIENT failure - should retry with backoff.
 */
export class GatewayConnectionError extends Data.TaggedError("GatewayConnectionError")<{
  readonly reason: string
  readonly isRetryable: true // Always true - network issue
}> {}

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
