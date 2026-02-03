import { Schema } from "effect"

// Branded types
export const OutboxEventId = Schema.String.pipe(Schema.brand("OutboxEventId"))
export type OutboxEventId = typeof OutboxEventId.Type

// Outbox event status
export const OutboxEventStatus = Schema.Literal("PENDING", "PROCESSED", "FAILED")
export type OutboxEventStatus = typeof OutboxEventStatus.Type

// Outbox event type
export const OutboxEventType = Schema.Literal("OrderAuthorized")
export type OutboxEventType = typeof OutboxEventType.Type

// Payload schema for OrderAuthorized events
export class OrderAuthorizedPayload extends Schema.Class<OrderAuthorizedPayload>("OrderAuthorizedPayload")({
  order_ledger_id: Schema.String,
  user_id: Schema.String,
  email: Schema.String,
  total_amount_cents: Schema.Number,
  currency: Schema.String,
  payment_authorization_id: Schema.String
}) {}

// Full outbox event
export class OutboxEvent extends Schema.Class<OutboxEvent>("OutboxEvent")({
  id: OutboxEventId,
  aggregateType: Schema.String,
  aggregateId: Schema.String,
  eventType: OutboxEventType,
  payload: Schema.Unknown,
  status: OutboxEventStatus,
  createdAt: Schema.DateTimeUtc,
  processedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}
