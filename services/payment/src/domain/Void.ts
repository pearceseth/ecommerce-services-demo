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
  voided_at: Schema.String // ISO timestamp
}) {}
