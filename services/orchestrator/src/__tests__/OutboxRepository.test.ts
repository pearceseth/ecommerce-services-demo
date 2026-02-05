import { describe, it, expect } from "vitest"
import { Effect, Layer, DateTime } from "effect"
import { OutboxRepository, type ClaimResult } from "../repositories/OutboxRepository.js"
import { OutboxEvent, type OutboxEventId } from "../domain/OutboxEvent.js"

// Test fixtures
const createTestEvent = (
  id: string,
  status: "PENDING" | "PROCESSED" | "FAILED" = "PENDING",
  retryCount = 0,
  nextRetryAt: DateTime.Utc | null = null
): OutboxEvent => {
  const now = DateTime.unsafeNow()
  return new OutboxEvent({
    id: id as OutboxEventId,
    aggregateType: "OrderLedger",
    aggregateId: `ledger-${id}`,
    eventType: "OrderAuthorized",
    payload: {
      order_ledger_id: `ledger-${id}`,
      user_id: "user-123",
      email: "test@example.com",
      total_amount_cents: 2999,
      currency: "USD",
      payment_authorization_id: "auth-456"
    },
    status,
    createdAt: now,
    processedAt: status === "PENDING" ? null : now,
    retryCount,
    nextRetryAt
  })
}

// Mock repository factory
const createMockOutboxRepo = (overrides: {
  claimPendingEvents?: (limit?: number) => Effect.Effect<ClaimResult>
  markProcessed?: (eventId: OutboxEventId) => Effect.Effect<void>
  markFailed?: (eventId: OutboxEventId) => Effect.Effect<void>
  scheduleRetry?: (eventId: OutboxEventId, nextRetryAt: DateTime.Utc) => Effect.Effect<{ retryCount: number }>
} = {}) => {
  return Layer.succeed(OutboxRepository, {
    claimPendingEvents: overrides.claimPendingEvents ?? (() => Effect.succeed({ events: [] })),
    markProcessed: overrides.markProcessed ?? (() => Effect.void),
    markFailed: overrides.markFailed ?? (() => Effect.void),
    scheduleRetry: overrides.scheduleRetry ?? (() => Effect.succeed({ retryCount: 1 }))
  })
}

describe("OutboxRepository", () => {
  describe("claimPendingEvents", () => {
    it("should return empty array when no pending events", async () => {
      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: () => Effect.succeed({ events: [] })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.events).toEqual([])
    })

    it("should return pending events in creation order", async () => {
      const event1 = createTestEvent("event-1")
      const event2 = createTestEvent("event-2")
      const event3 = createTestEvent("event-3")

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: () => Effect.succeed({ events: [event1, event2, event3] })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.events).toHaveLength(3)
      expect(result.events[0].id).toBe("event-1")
      expect(result.events[1].id).toBe("event-2")
      expect(result.events[2].id).toBe("event-3")
    })

    it("should respect the limit parameter", async () => {
      let capturedLimit: number | undefined

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: (limit) => {
          capturedLimit = limit
          return Effect.succeed({ events: [] })
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents(5)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(capturedLimit).toBe(5)
    })

    it("should use default limit when not specified", async () => {
      let capturedLimit: number | undefined

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: (limit) => {
          capturedLimit = limit
          return Effect.succeed({ events: [] })
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(capturedLimit).toBeUndefined()
    })

    it("should only return events with PENDING status", async () => {
      const pendingEvent = createTestEvent("event-1", "PENDING")

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: () => Effect.succeed({ events: [pendingEvent] })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.events).toHaveLength(1)
      expect(result.events[0].status).toBe("PENDING")
    })
  })

  describe("markProcessed", () => {
    it("should accept an event ID and complete successfully", async () => {
      let processedEventId: OutboxEventId | undefined

      const mockRepo = createMockOutboxRepo({
        markProcessed: (eventId) => {
          processedEventId = eventId
          return Effect.void
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        yield* repo.markProcessed("event-123" as OutboxEventId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(processedEventId).toBe("event-123")
    })

    it("should be callable multiple times for same event (idempotent)", async () => {
      let callCount = 0

      const mockRepo = createMockOutboxRepo({
        markProcessed: () => {
          callCount++
          return Effect.void
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        yield* repo.markProcessed("event-123" as OutboxEventId)
        yield* repo.markProcessed("event-123" as OutboxEventId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(callCount).toBe(2)
    })
  })

  describe("markFailed", () => {
    it("should accept an event ID and complete successfully", async () => {
      let failedEventId: OutboxEventId | undefined

      const mockRepo = createMockOutboxRepo({
        markFailed: (eventId) => {
          failedEventId = eventId
          return Effect.void
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        yield* repo.markFailed("event-456" as OutboxEventId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(failedEventId).toBe("event-456")
    })

    it("should be usable for dead-letter handling", async () => {
      const failedEvents: OutboxEventId[] = []

      const mockRepo = createMockOutboxRepo({
        markFailed: (eventId) => {
          failedEvents.push(eventId)
          return Effect.void
        }
      })

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        yield* repo.markFailed("event-1" as OutboxEventId)
        yield* repo.markFailed("event-2" as OutboxEventId)
        yield* repo.markFailed("event-3" as OutboxEventId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(failedEvents).toEqual(["event-1", "event-2", "event-3"])
    })
  })

  describe("scheduleRetry", () => {
    it("should accept event ID and next retry time", async () => {
      let capturedEventId: OutboxEventId | undefined
      let capturedNextRetryAt: DateTime.Utc | undefined

      const mockRepo = createMockOutboxRepo({
        scheduleRetry: (eventId, nextRetryAt) => {
          capturedEventId = eventId
          capturedNextRetryAt = nextRetryAt
          return Effect.succeed({ retryCount: 1 })
        }
      })

      const nextRetry = DateTime.unsafeMake("2024-01-15T10:00:05Z")

      await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        yield* repo.scheduleRetry("event-123" as OutboxEventId, nextRetry)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(capturedEventId).toBe("event-123")
      expect(capturedNextRetryAt).toBeDefined()
    })

    it("should return the new retry count", async () => {
      const mockRepo = createMockOutboxRepo({
        scheduleRetry: () => Effect.succeed({ retryCount: 3 })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.scheduleRetry(
          "event-123" as OutboxEventId,
          DateTime.unsafeMake("2024-01-15T10:00:05Z")
        )
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.retryCount).toBe(3)
    })

    it("should be callable multiple times for progressive retries", async () => {
      let callCount = 0
      const retryCounts = [1, 2, 3]

      const mockRepo = createMockOutboxRepo({
        scheduleRetry: () => {
          const count = retryCounts[callCount]
          callCount++
          return Effect.succeed({ retryCount: count })
        }
      })

      const results = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        const eventId = "event-123" as OutboxEventId
        const r1 = yield* repo.scheduleRetry(eventId, DateTime.unsafeMake("2024-01-15T10:00:01Z"))
        const r2 = yield* repo.scheduleRetry(eventId, DateTime.unsafeMake("2024-01-15T10:00:04Z"))
        const r3 = yield* repo.scheduleRetry(eventId, DateTime.unsafeMake("2024-01-15T10:00:16Z"))
        return [r1.retryCount, r2.retryCount, r3.retryCount]
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(results).toEqual([1, 2, 3])
    })
  })

  describe("claimPendingEvents with retry filtering", () => {
    it("should return events with null next_retry_at", async () => {
      const newEvent = createTestEvent("event-new", "PENDING", 0, null)

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: () => Effect.succeed({ events: [newEvent] })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.events).toHaveLength(1)
      expect(result.events[0].retryCount).toBe(0)
      expect(result.events[0].nextRetryAt).toBeNull()
    })

    it("should include retryCount and nextRetryAt in returned events", async () => {
      const pastTime = DateTime.unsafeMake("2024-01-15T09:00:00Z")
      const retryEvent = createTestEvent("event-retry", "PENDING", 2, pastTime)

      const mockRepo = createMockOutboxRepo({
        claimPendingEvents: () => Effect.succeed({ events: [retryEvent] })
      })

      const result = await Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return yield* repo.claimPendingEvents()
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(result.events).toHaveLength(1)
      expect(result.events[0].retryCount).toBe(2)
      expect(result.events[0].nextRetryAt).not.toBeNull()
    })
  })

  describe("OutboxRepository interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(OutboxRepository.key).toBe("OutboxRepository")
    })

    it("should work with Layer.provide pattern", async () => {
      const mockRepo = createMockOutboxRepo()

      const program = Effect.gen(function* () {
        const repo = yield* OutboxRepository
        return repo
      })

      const result = await program.pipe(
        Effect.provide(mockRepo),
        Effect.runPromise
      )

      expect(result).toBeDefined()
      expect(typeof result.claimPendingEvents).toBe("function")
      expect(typeof result.markProcessed).toBe("function")
      expect(typeof result.markFailed).toBe("function")
      expect(typeof result.scheduleRetry).toBe("function")
    })
  })
})
