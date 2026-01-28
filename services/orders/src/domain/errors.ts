import { Data } from "effect"

/**
 * Order was not found in the database.
 * Context includes how the search was performed to aid debugging.
 */
export class OrderNotFoundError extends Data.TaggedError("OrderNotFoundError")<{
  readonly orderId: string
  readonly searchedBy: "id" | "orderLedgerId"
}> {}

/**
 * Order with the given order_ledger_id already exists.
 * This is used for idempotency - the existing order should be returned.
 */
export class OrderAlreadyExistsError extends Data.TaggedError("OrderAlreadyExistsError")<{
  readonly orderLedgerId: string
  readonly existingOrderId: string
}> {}

/**
 * Invalid order status transition was attempted.
 * Used when trying to transition to a status that's not allowed from current state.
 */
export class InvalidOrderStatusError extends Data.TaggedError("InvalidOrderStatusError")<{
  readonly orderId: string
  readonly currentStatus: string
  readonly attemptedStatus: string
}> {}
