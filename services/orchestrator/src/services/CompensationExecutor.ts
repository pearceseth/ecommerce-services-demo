import { Context, Effect } from "effect"
import type { OrderLedgerStatus } from "../domain/OrderLedger.js"

export interface CompensationContext {
  readonly orderLedgerId: string
  readonly orderId: string | null
  readonly paymentAuthorizationId: string | null
  readonly lastSuccessfulStatus: OrderLedgerStatus
}

export interface CompensationCompleted {
  readonly _tag: "CompensationCompleted"
  readonly orderLedgerId: string
  readonly stepsExecuted: readonly string[]
}

export interface CompensationFailed {
  readonly _tag: "CompensationFailed"
  readonly orderLedgerId: string
  readonly stepsExecuted: readonly string[]
  readonly error: string
}

export type CompensationResult = CompensationCompleted | CompensationFailed

export class CompensationExecutor extends Context.Tag("CompensationExecutor")<
  CompensationExecutor,
  {
    /**
     * Execute compensating actions based on the last successful saga step.
     * Compensations run in reverse order: void payment → release inventory → cancel order
     * All operations are idempotent - safe to retry.
     */
    readonly executeCompensation: (
      context: CompensationContext
    ) => Effect.Effect<CompensationResult>
  }
>() {}
