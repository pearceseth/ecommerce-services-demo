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
  capture_id: Schema.String,
  authorization_id: Schema.String,
  status: Schema.Literal("CAPTURED", "FAILED"),
  amount_cents: Schema.Int,
  currency: Schema.String,
  captured_at: Schema.String // ISO timestamp
}) {}
