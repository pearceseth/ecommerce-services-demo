import { Data } from "effect"

// Payment authorization was declined
export class PaymentDeclinedError extends Data.TaggedError("PaymentDeclinedError")<{
  readonly userId: string
  readonly amountCents: number
  readonly declineCode: string
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// Payment gateway unavailable
export class PaymentGatewayError extends Data.TaggedError("PaymentGatewayError")<{
  readonly reason: string
  readonly isRetryable: boolean
}> {}

// Duplicate request (idempotency check)
export class DuplicateRequestError extends Data.TaggedError("DuplicateRequestError")<{
  readonly clientRequestId: string
  readonly existingOrderLedgerId: string
  readonly existingStatus: string
}> {}

// Product not found when looking up prices
export class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
}> {}

// Missing idempotency key header
export class MissingIdempotencyKeyError extends Data.TaggedError("MissingIdempotencyKeyError")<{
  readonly _void?: never
}> {}

// Database transaction failed
export class TransactionError extends Data.TaggedError("TransactionError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

// Order ledger entry not found
export class OrderLedgerNotFoundError extends Data.TaggedError("OrderLedgerNotFoundError")<{
  readonly orderLedgerId: string
}> {}
