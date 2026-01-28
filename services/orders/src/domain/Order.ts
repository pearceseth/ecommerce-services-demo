import { Schema } from "effect"

// Branded types for type safety
export const OrderId = Schema.UUID.pipe(Schema.brand("OrderId"))
export type OrderId = typeof OrderId.Type

export const OrderLedgerId = Schema.UUID.pipe(Schema.brand("OrderLedgerId"))
export type OrderLedgerId = typeof OrderLedgerId.Type

export const UserId = Schema.UUID.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export const OrderItemId = Schema.UUID.pipe(Schema.brand("OrderItemId"))
export type OrderItemId = typeof OrderItemId.Type

// Order status enum - use Schema.Literal for exhaustive matching
export const OrderStatus = Schema.Literal("CREATED", "CONFIRMED", "CANCELLED")
export type OrderStatus = typeof OrderStatus.Type

// Domain models
export class OrderItem extends Schema.Class<OrderItem>("OrderItem")({
  id: OrderItemId,
  orderId: OrderId,
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive()),
  unitPriceCents: Schema.Int.pipe(Schema.nonNegative()),
  createdAt: Schema.DateTimeUtc
}) {}

export class Order extends Schema.Class<Order>("Order")({
  id: OrderId,
  orderLedgerId: OrderLedgerId,
  userId: UserId,
  status: OrderStatus,
  totalAmountCents: Schema.Int.pipe(Schema.nonNegative()),
  currency: Schema.String.pipe(Schema.minLength(3), Schema.maxLength(3)),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

// Request schemas for API input
export class CreateOrderItemRequest extends Schema.Class<CreateOrderItemRequest>("CreateOrderItemRequest")({
  productId: ProductId,
  quantity: Schema.Int.pipe(
    Schema.positive({ message: () => "Quantity must be positive" })
  ),
  unitPriceCents: Schema.Int.pipe(
    Schema.nonNegative({ message: () => "Unit price cannot be negative" })
  )
}) {}

export class CreateOrderRequest extends Schema.Class<CreateOrderRequest>("CreateOrderRequest")({
  orderLedgerId: OrderLedgerId,
  userId: UserId,
  totalAmountCents: Schema.Int.pipe(
    Schema.nonNegative({ message: () => "Total amount cannot be negative" })
  ),
  currency: Schema.optionalWith(
    Schema.String.pipe(Schema.minLength(3), Schema.maxLength(3)),
    { default: () => "USD" }
  ),
  items: Schema.Array(CreateOrderItemRequest).pipe(
    Schema.minItems(1, { message: () => "Order must have at least one item" })
  )
}) {}

// Path parameter schema for routes
export const OrderIdParams = Schema.Struct({
  order_id: OrderId
})
