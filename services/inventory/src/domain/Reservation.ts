import { Schema } from "effect"
import { ProductId } from "./Product.js"

// Branded type for reservation IDs
export const ReservationId = Schema.UUID.pipe(Schema.brand("ReservationId"))
export type ReservationId = typeof ReservationId.Type

// Reservation status enum
export const ReservationStatus = Schema.Literal("RESERVED", "RELEASED")
export type ReservationStatus = typeof ReservationStatus.Type

// Domain model for a reservation
export class InventoryReservation extends Schema.Class<InventoryReservation>("InventoryReservation")({
  id: ReservationId,
  orderId: Schema.String,
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive()),
  status: ReservationStatus,
  createdAt: Schema.DateTimeUtc,
  releasedAt: Schema.NullOr(Schema.DateTimeUtc)
}) {}

// Request schema for a single item in the reserve request
export class ReserveItemRequest extends Schema.Class<ReserveItemRequest>("ReserveItemRequest")({
  productId: ProductId,
  quantity: Schema.Int.pipe(Schema.positive())
}) {}

// Full request schema for the HTTP endpoint
export class ReserveStockHttpRequest extends Schema.Class<ReserveStockHttpRequest>("ReserveStockHttpRequest")({
  orderId: Schema.UUID,
  items: Schema.Array(ReserveItemRequest).pipe(Schema.minItems(1))
}) {}

// Path parameter schema for DELETE /reservations/:order_id
export class OrderIdParams extends Schema.Class<OrderIdParams>("OrderIdParams")({
  order_id: Schema.UUID
}) {}
