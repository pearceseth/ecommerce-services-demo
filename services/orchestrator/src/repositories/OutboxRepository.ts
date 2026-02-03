import { Context, Effect } from "effect"
import type { OutboxEvent, OutboxEventId } from "../domain/OutboxEvent.js"

export interface ClaimResult {
  readonly events: readonly OutboxEvent[]
}

export class OutboxRepository extends Context.Tag("OutboxRepository")<
  OutboxRepository,
  {
    /**
     * Claim pending outbox events for processing.
     * Uses SELECT FOR UPDATE SKIP LOCKED for safe concurrent access.
     * Returns events in creation order.
     *
     * @param limit - Maximum number of events to claim (default: 10)
     */
    readonly claimPendingEvents: (limit?: number) => Effect.Effect<ClaimResult>

    /**
     * Mark an event as successfully processed.
     */
    readonly markProcessed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Mark an event as failed (for dead-letter handling).
     */
    readonly markFailed: (eventId: OutboxEventId) => Effect.Effect<void>
  }
>() {}
