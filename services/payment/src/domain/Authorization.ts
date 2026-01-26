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
  currency: Schema.optionalWith(
    Schema.Literal("USD", "EUR", "GBP"),
    { default: () => "USD" as const }
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
  authorization_id: Schema.String,
  status: Schema.Literal("AUTHORIZED", "DECLINED"),
  amount_cents: Schema.Int,
  currency: Schema.String,
  created_at: Schema.String // ISO timestamp
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
