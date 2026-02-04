import { Context, Effect } from "effect"
import type { OutboxEvent } from "../domain/OutboxEvent.js"

export interface SagaCompleted {
  readonly _tag: "Completed"
  readonly orderLedgerId: string
  readonly finalStatus: "COMPLETED"
}

export interface SagaFailed {
  readonly _tag: "Failed"
  readonly orderLedgerId: string
  readonly finalStatus: string
  readonly error: string
}

export interface SagaRequiresRetry {
  readonly _tag: "RequiresRetry"
  readonly orderLedgerId: string
  readonly finalStatus: string
  readonly error: string
}

export interface SagaCompensated {
  readonly _tag: "Compensated"
  readonly orderLedgerId: string
  readonly finalStatus: "FAILED"
  readonly compensationSteps: readonly string[]
}

export type SagaExecutionResult =
  | SagaCompleted
  | SagaFailed
  | SagaRequiresRetry
  | SagaCompensated

export class SagaExecutor extends Context.Tag("SagaExecutor")<
  SagaExecutor,
  {
    /**
     * Execute the saga for an outbox event.
     * Processes from current ledger status to COMPLETED.
     * Returns result indicating success, failure, or need for retry/compensation.
     */
    readonly executeSaga: (event: OutboxEvent) => Effect.Effect<SagaExecutionResult>
  }
>() {}
