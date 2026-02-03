import { Data } from "effect"

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Client Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Order creation failed via Orders Service
 */
export class OrderCreationError extends Data.TaggedError("OrderCreationError")<{
  readonly orderLedgerId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Inventory reservation failed
 */
export class InventoryReservationError extends Data.TaggedError("InventoryReservationError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
  readonly insufficientStock?: {
    readonly productId: string
    readonly productSku?: string
    readonly requested: number
    readonly available: number
  }
}> {}

/**
 * Payment capture failed
 */
export class PaymentCaptureError extends Data.TaggedError("PaymentCaptureError")<{
  readonly authorizationId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Order confirmation failed
 */
export class OrderConfirmationError extends Data.TaggedError("OrderConfirmationError")<{
  readonly orderId: string
  readonly reason: string
  readonly statusCode?: number
  readonly isRetryable: boolean
}> {}

/**
 * Generic HTTP client error for connection issues
 */
export class ServiceConnectionError extends Data.TaggedError("ServiceConnectionError")<{
  readonly service: "orders" | "inventory" | "payments"
  readonly operation: string
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// ═══════════════════════════════════════════════════════════════════════════
// Saga Execution Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Invalid saga state transition attempted
 */
export class InvalidStateTransitionError extends Data.TaggedError("InvalidStateTransitionError")<{
  readonly orderLedgerId: string
  readonly fromStatus: string
  readonly toStatus: string
}> {}

/**
 * Order ledger not found
 */
export class LedgerNotFoundError extends Data.TaggedError("LedgerNotFoundError")<{
  readonly orderLedgerId: string
}> {}

/**
 * Outbox event payload parsing failed
 */
export class InvalidPayloadError extends Data.TaggedError("InvalidPayloadError")<{
  readonly eventId: string
  readonly eventType: string
  readonly reason: string
}> {}

// ═══════════════════════════════════════════════════════════════════════════
// Aggregate Error Types for Pattern Matching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All saga step errors that can occur during execution
 */
export type SagaStepError =
  | ServiceConnectionError
  | OrderCreationError
  | InventoryReservationError
  | PaymentCaptureError
  | OrderConfirmationError
