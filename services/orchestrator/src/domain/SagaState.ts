import type { OrderLedgerStatus } from "./OrderLedger.js"

/**
 * Valid state transitions for the saga.
 * Used to validate transitions before updating ledger status.
 */
export const VALID_TRANSITIONS: Record<OrderLedgerStatus, readonly OrderLedgerStatus[]> = {
  AWAITING_AUTHORIZATION: ["AUTHORIZED", "AUTHORIZATION_FAILED"],
  AUTHORIZED: ["ORDER_CREATED", "COMPENSATING"],
  AUTHORIZATION_FAILED: [], // Terminal state
  ORDER_CREATED: ["INVENTORY_RESERVED", "COMPENSATING"],
  INVENTORY_RESERVED: ["PAYMENT_CAPTURED", "COMPENSATING"],
  PAYMENT_CAPTURED: ["COMPLETED", "COMPENSATING"],
  COMPLETED: [], // Terminal state
  COMPENSATING: ["FAILED"],
  FAILED: [] // Terminal state
}

/**
 * Check if a state transition is valid.
 */
export const isValidTransition = (
  from: OrderLedgerStatus,
  to: OrderLedgerStatus
): boolean => VALID_TRANSITIONS[from].includes(to)

/**
 * Steps in order of execution.
 * Used to determine which compensations to run on failure.
 */
export const SAGA_STEPS = [
  "ORDER_CREATED",
  "INVENTORY_RESERVED",
  "PAYMENT_CAPTURED",
  "COMPLETED"
] as const

export type SagaStep = typeof SAGA_STEPS[number]

/**
 * Get the index of a saga step (for compensation ordering).
 */
export const getSagaStepIndex = (status: OrderLedgerStatus): number =>
  SAGA_STEPS.indexOf(status as SagaStep)
