import { Schema } from "effect"

export const OrderLedgerId = Schema.String.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ProductId = Schema.String.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

// All possible ledger statuses (state machine)
export const OrderLedgerStatus = Schema.Literal(
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "AUTHORIZATION_FAILED",
  "ORDER_CREATED",
  "INVENTORY_RESERVED",
  "PAYMENT_CAPTURED",
  "COMPLETED",
  "COMPENSATING",
  "FAILED"
)
export type OrderLedgerStatus = typeof OrderLedgerStatus.Type

export class OrderLedger extends Schema.Class<OrderLedger>("OrderLedger")({
  id: OrderLedgerId,
  clientRequestId: Schema.String,
  userId: UserId,
  email: Schema.String,
  status: OrderLedgerStatus,
  totalAmountCents: Schema.Number,
  currency: Schema.String,
  paymentAuthorizationId: Schema.NullOr(Schema.String),
  orderId: Schema.NullOr(Schema.String),
  // Retry tracking fields moved to outbox table (see OutboxEvent.ts)
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

export class OrderLedgerItem extends Schema.Class<OrderLedgerItem>("OrderLedgerItem")({
  id: Schema.String,
  orderLedgerId: OrderLedgerId,
  productId: ProductId,
  quantity: Schema.Number.pipe(Schema.positive()),
  unitPriceCents: Schema.Number,
  createdAt: Schema.DateTimeUtc
}) {}
