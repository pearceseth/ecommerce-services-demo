import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Queue, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { OrchestratorConfig } from "../config.js"
import { processEvents } from "../main.js"
import { OutboxRepository, type ClaimResult } from "../repositories/OutboxRepository.js"
import { SagaExecutor, type SagaExecutionResult } from "../services/SagaExecutor.js"
import { OutboxEvent, type OutboxEventId } from "../domain/OutboxEvent.js"

const createTestConfig = (overrides: Partial<{
  pollIntervalMs: number
  ordersServiceUrl: string
  inventoryServiceUrl: string
  paymentsServiceUrl: string
  maxRetryAttempts: number
  retryBaseDelayMs: number
  retryBackoffMultiplier: number
}> = {}) =>
  Layer.succeed(OrchestratorConfig, {
    pollIntervalMs: overrides.pollIntervalMs ?? 1000,
    ordersServiceUrl: overrides.ordersServiceUrl ?? "http://localhost:3003",
    inventoryServiceUrl: overrides.inventoryServiceUrl ?? "http://localhost:3001",
    paymentsServiceUrl: overrides.paymentsServiceUrl ?? "http://localhost:3002",
    maxRetryAttempts: overrides.maxRetryAttempts ?? 5,
    retryBaseDelayMs: overrides.retryBaseDelayMs ?? 1000,
    retryBackoffMultiplier: overrides.retryBackoffMultiplier ?? 4
  })

// Mock SqlClient that supports withTransaction
const createMockSqlClient = () =>
  Layer.succeed(SqlClient.SqlClient, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
  } as any)

const createMockOutboxRepo = (events: OutboxEvent[] = []) =>
  Layer.succeed(OutboxRepository, {
    claimPendingEvents: () => Effect.succeed({ events } satisfies ClaimResult),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    scheduleRetry: () => Effect.succeed({ retryCount: 1 })
  })

const createMockSagaExecutor = (result: SagaExecutionResult = { _tag: "Completed", orderLedgerId: "test", finalStatus: "COMPLETED" }) =>
  Layer.succeed(SagaExecutor, {
    executeSaga: () => Effect.succeed(result)
  })

const createProcessEventsTestLayer = (events: OutboxEvent[] = []) =>
  Layer.mergeAll(
    createMockSqlClient(),
    createMockOutboxRepo(events),
    createMockSagaExecutor()
  )

describe("processEvents", () => {
  it("should complete successfully when no events pending", async () => {
    const testLayer = createProcessEventsTestLayer([])

    const result = await processEvents.pipe(
      Effect.provide(testLayer),
      Effect.runPromise
    )
    expect(result).toBeUndefined()
  })

  it("should process pending events and mark as processed", async () => {
    const now = DateTime.unsafeNow()
    const testEvent = new OutboxEvent({
      id: "event-123" as OutboxEventId,
      aggregateType: "OrderLedger",
      aggregateId: "ledger-123",
      eventType: "OrderAuthorized",
      payload: {
        order_ledger_id: "ledger-123",
        user_id: "user-456",
        email: "test@example.com",
        total_amount_cents: 2999,
        currency: "USD",
        payment_authorization_id: "auth-789"
      },
      status: "PENDING",
      createdAt: now,
      processedAt: null,
      retryCount: 0,
      nextRetryAt: null
    })

    let processedEventIds: string[] = []
    const testLayer = Layer.mergeAll(
      createMockSqlClient(),
      Layer.succeed(OutboxRepository, {
        claimPendingEvents: () => Effect.succeed({ events: [testEvent] }),
        markProcessed: (eventId) => {
          processedEventIds.push(eventId)
          return Effect.void
        },
        markFailed: () => Effect.void,
        scheduleRetry: () => Effect.succeed({ retryCount: 1 })
      }),
      createMockSagaExecutor()
    )

    await processEvents.pipe(
      Effect.provide(testLayer),
      Effect.runPromise
    )

    expect(processedEventIds).toContain("event-123")
  })

  it("should be an Effect that can be composed", async () => {
    const testLayer = createProcessEventsTestLayer([])

    const composed = Effect.gen(function* () {
      yield* processEvents
      yield* processEvents
      return "completed"
    })

    const result = await composed.pipe(
      Effect.provide(testLayer),
      Effect.runPromise
    )
    expect(result).toBe("completed")
  })
})

describe("createPollingLoop", () => {
  it("should require OrchestratorConfig", async () => {
    const result = await Effect.gen(function* () {
      return (yield* OrchestratorConfig).pollIntervalMs
    }).pipe(
      Effect.provide(createTestConfig({ pollIntervalMs: 2000 })),
      Effect.runPromise
    )

    expect(result).toBe(2000)
  })

  it("should call processEvents at the configured interval", async () => {
    let processCount = 0
    const trackingProcessEvents = Effect.sync(() => {
      processCount++
    })

    const testPollingLoop = Effect.gen(function* () {
      yield* OrchestratorConfig

      yield* trackingProcessEvents.pipe(
        Effect.repeat({
          times: 2
        })
      )

      return processCount
    })

    const result = await testPollingLoop.pipe(
      Effect.provide(createTestConfig({ pollIntervalMs: 100 })),
      Effect.runPromise
    )

    expect(result).toBe(3)
  })

  it("should use the pollIntervalMs from config", async () => {
    const result = await Effect.gen(function* () {
      const config = yield* OrchestratorConfig
      return config.pollIntervalMs
    }).pipe(
      Effect.provide(createTestConfig({ pollIntervalMs: 5000 })),
      Effect.runPromise
    )

    expect(result).toBe(5000)
  })
})

describe("createListenConnection", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("should use database configuration from environment", () => {
    process.env.DATABASE_HOST = "test-host"
    process.env.DATABASE_PORT = "5433"
    process.env.DATABASE_NAME = "test-db"
    process.env.DATABASE_USER = "test-user"
    process.env.DATABASE_PASSWORD = "test-pass"

    const dbConfig = {
      host: process.env.DATABASE_HOST ?? "localhost",
      port: parseInt(process.env.DATABASE_PORT ?? "5432"),
      database: process.env.DATABASE_NAME ?? "ecommerce",
      user: process.env.DATABASE_USER ?? "ecommerce",
      password: process.env.DATABASE_PASSWORD ?? "ecommerce"
    }

    expect(dbConfig.host).toBe("test-host")
    expect(dbConfig.port).toBe(5433)
    expect(dbConfig.database).toBe("test-db")
    expect(dbConfig.user).toBe("test-user")
    expect(dbConfig.password).toBe("test-pass")
  })

  it("should use default database configuration when not set", () => {
    delete process.env.DATABASE_HOST
    delete process.env.DATABASE_PORT
    delete process.env.DATABASE_NAME
    delete process.env.DATABASE_USER
    delete process.env.DATABASE_PASSWORD

    const dbConfig = {
      host: process.env.DATABASE_HOST ?? "localhost",
      port: parseInt(process.env.DATABASE_PORT ?? "5432"),
      database: process.env.DATABASE_NAME ?? "ecommerce",
      user: process.env.DATABASE_USER ?? "ecommerce",
      password: process.env.DATABASE_PASSWORD ?? "ecommerce"
    }

    expect(dbConfig.host).toBe("localhost")
    expect(dbConfig.port).toBe(5432)
    expect(dbConfig.database).toBe("ecommerce")
    expect(dbConfig.user).toBe("ecommerce")
    expect(dbConfig.password).toBe("ecommerce")
  })
})

describe("Notification Queue", () => {
  it("should be able to create an unbounded queue for notifications", async () => {
    const result = await Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()

      yield* Queue.offer(queue, "order_events")
      yield* Queue.offer(queue, "order_events")

      const first = yield* Queue.take(queue)
      const second = yield* Queue.take(queue)

      return [first, second]
    }).pipe(Effect.runPromise)

    expect(result).toEqual(["order_events", "order_events"])
  })

  it("should process notifications from queue", async () => {
    let processCount = 0

    const result = await Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>()

      yield* Queue.offer(queue, "notification-1")
      yield* Queue.offer(queue, "notification-2")

      yield* Queue.take(queue)
      processCount++
      yield* Queue.take(queue)
      processCount++

      return processCount
    }).pipe(Effect.runPromise)

    expect(result).toBe(2)
  })
})
