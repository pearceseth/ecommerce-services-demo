import { Layer, Effect, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { OutboxRepository, type ClaimResult } from "./OutboxRepository.js"
import { OutboxEvent, type OutboxEventId, type OutboxEventType, type OutboxEventStatus } from "../domain/OutboxEvent.js"

interface OutboxRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: unknown
  status: string
  created_at: Date
  processed_at: Date | null
}

const rowToOutboxEvent = (row: OutboxRow): OutboxEvent =>
  new OutboxEvent({
    id: row.id as OutboxEventId,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type as OutboxEventType,
    payload: row.payload,
    status: row.status as OutboxEventStatus,
    createdAt: DateTime.unsafeFromDate(row.created_at),
    processedAt: row.processed_at ? DateTime.unsafeFromDate(row.processed_at) : null
  })

export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      claimPendingEvents: (limit = 10) =>
        Effect.gen(function* () {
          const rows = yield* sql<OutboxRow>`
            SELECT id, aggregate_type, aggregate_id, event_type, payload, status, created_at, processed_at
            FROM outbox
            WHERE status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          `

          yield* Effect.logDebug("Claimed outbox events", { count: rows.length })

          const events = rows.map(rowToOutboxEvent)
          return { events } satisfies ClaimResult
        }).pipe(Effect.orDie),

      markProcessed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'PROCESSED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as processed", { eventId })
        }).pipe(Effect.orDie),

      markFailed: (eventId: OutboxEventId) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE outbox
            SET status = 'FAILED', processed_at = NOW()
            WHERE id = ${eventId}
          `
          yield* Effect.logDebug("Marked outbox event as failed", { eventId })
        }).pipe(Effect.orDie)
    }
  })
)
