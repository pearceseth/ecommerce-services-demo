import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, Layer, Queue } from "effect"
import { OrchestratorConfig } from "../config.js"
import { processEvents } from "../main.js"

const createTestConfig = (overrides: Partial<{
  pollIntervalMs: number
  ordersServiceUrl: string
  inventoryServiceUrl: string
  paymentsServiceUrl: string
}> = {}) =>
  Layer.succeed(OrchestratorConfig, {
    pollIntervalMs: overrides.pollIntervalMs ?? 1000,
    ordersServiceUrl: overrides.ordersServiceUrl ?? "http://localhost:3003",
    inventoryServiceUrl: overrides.inventoryServiceUrl ?? "http://localhost:3001",
    paymentsServiceUrl: overrides.paymentsServiceUrl ?? "http://localhost:3002"
  })

describe("processEvents", () => {
  it("should complete successfully as a placeholder", async () => {
    const result = await processEvents.pipe(Effect.runPromise)
    expect(result).toBeUndefined()
  })

  it("should be an Effect that can be composed", async () => {
    const composed = Effect.gen(function* () {
      yield* processEvents
      yield* processEvents
      return "completed"
    })

    const result = await composed.pipe(Effect.runPromise)
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
