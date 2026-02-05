import { Context, Effect } from "effect"
import type { DateTime } from "effect"
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
     * Only returns events where next_retry_at is NULL or in the past.
     *
     * @param limit - Maximum number of events to claim (default: 10)
     */
    readonly claimPendingEvents: (limit?: number) => Effect.Effect<ClaimResult>

    /**
     * Mark an event as successfully processed.
     */
    readonly markProcessed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Mark an event as failed (terminal state after compensation).
     */
    readonly markFailed: (eventId: OutboxEventId) => Effect.Effect<void>

    /**
     * Schedule a retry for an event.
     * Increments retry_count and sets next_retry_at.
     * Event remains in PENDING status.
     *
     * @param eventId - The event to schedule for retry
     * @param nextRetryAt - When to retry next
     * @returns Updated retry count
     */
    readonly scheduleRetry: (
      eventId: OutboxEventId,
      nextRetryAt: DateTime.Utc
    ) => Effect.Effect<{ retryCount: number }>
  }
>() {}
