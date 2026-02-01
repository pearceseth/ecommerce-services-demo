import { Schema } from "effect"

// Branded UUIDs for type safety
export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

// Order ledger status - matches database constraint
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

// Line item in the order request
export class OrderItemRequest extends Schema.Class<OrderItemRequest>("OrderItemRequest")({
  product_id: Schema.UUID,
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" }),
    Schema.lessThanOrEqualTo(100, { message: () => "Quantity cannot exceed 100 per item" })
  )
}) {}

// Payment information
export class PaymentInfo extends Schema.Class<PaymentInfo>("PaymentInfo")({
  method: Schema.Literal("card"),
  token: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Payment token is required" })
  )
}) {}

// Full order request - body of POST /orders
export class CreateOrderRequest extends Schema.Class<CreateOrderRequest>("CreateOrderRequest")({
  user_id: Schema.UUID,
  email: Schema.String.pipe(
    Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: () => "Invalid email format" }),
    Schema.maxLength(255)
  ),
  items: Schema.Array(OrderItemRequest).pipe(
    Schema.minItems(1, { message: () => "Order must contain at least one item" }),
    Schema.maxItems(50, { message: () => "Order cannot exceed 50 items" })
  ),
  payment: PaymentInfo
}) {}

// Order ledger item (line item stored in the ledger)
export class OrderLedgerItem extends Schema.Class<OrderLedgerItem>("OrderLedgerItem")({
  id: Schema.UUID,
  orderLedgerId: OrderLedgerId,
  productId: ProductId,
  quantity: Schema.Int,
  unitPriceCents: Schema.Int,
  createdAt: Schema.DateTimeUtc
}) {}

// Order ledger entry - the primary domain model
export class OrderLedger extends Schema.Class<OrderLedger>("OrderLedger")({
  id: OrderLedgerId,
  clientRequestId: Schema.String,
  userId: UserId,
  email: Schema.String,
  status: OrderLedgerStatus,
  totalAmountCents: Schema.Int,
  currency: Schema.String,
  paymentAuthorizationId: Schema.NullOr(Schema.String),
  retryCount: Schema.Int,
  nextRetryAt: Schema.NullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

// Success response (202 Accepted)
export class CreateOrderResponse extends Schema.Class<CreateOrderResponse>("CreateOrderResponse")({
  order_ledger_id: Schema.String,
  status: Schema.String,
  message: Schema.String
}) {}

// Idempotent duplicate response (409 Conflict)
export class DuplicateOrderResponse extends Schema.Class<DuplicateOrderResponse>("DuplicateOrderResponse")({
  error: Schema.Literal("duplicate_request"),
  order_ledger_id: Schema.String,
  status: Schema.String
}) {}
