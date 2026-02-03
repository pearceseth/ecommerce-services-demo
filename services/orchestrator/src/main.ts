import { Effect, Schedule, Duration, Queue, Data } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { OrchestratorConfig } from "./config.js"

/**
 * Process pending outbox events.
 * For scaffold, this is a placeholder that logs.
 * Future: Implement actual event claiming and saga execution.
 */
export const processEvents = Effect.gen(function* () {
  yield* Effect.logDebug("Processing pending events...")
  // Placeholder for future implementation:
  // 1. SELECT FROM outbox WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
  // 2. For each event, execute saga step
  // 3. UPDATE outbox SET status = 'PROCESSED', processed_at = NOW()
  yield* Effect.logDebug("Event processing complete")
})

/**
 * Polling fallback - runs every POLL_INTERVAL_MS
 * Catches any events that NOTIFY might have missed
 */
export const createPollingLoop = Effect.gen(function* () {
  const config = yield* OrchestratorConfig

  yield* Effect.logInfo("Starting polling loop", { intervalMs: config.pollIntervalMs })

  yield* processEvents.pipe(
    Effect.repeat(
      Schedule.spaced(Duration.millis(config.pollIntervalMs))
    )
  )
})

/**
 * Database connection configuration from environment.
 */
const getDbConfig = () => ({
  host: process.env.DATABASE_HOST ?? "localhost",
  port: parseInt(process.env.DATABASE_PORT ?? "5432"),
  database: process.env.DATABASE_NAME ?? "ecommerce",
  user: process.env.DATABASE_USER ?? "ecommerce",
  password: process.env.DATABASE_PASSWORD ?? "ecommerce"
})

/**
 * Create a dedicated PostgreSQL connection for LISTEN/NOTIFY.
 * Returns a queue that receives notifications and a cleanup function.
 */
export const createListenConnection = Effect.gen(function* () {
  const notificationQueue = yield* Queue.unbounded<string>()
  const dbConfig = getDbConfig()

  yield* Effect.logInfo("Creating LISTEN connection", {
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database
  })

  const client = new pg.Client(dbConfig)

  yield* Effect.tryPromise({
    try: () => client.connect(),
    catch: (error) => new ListenConnectionError({ cause: error })
  })

  yield* Effect.logInfo("LISTEN connection established")

  client.on("notification", (msg) => {
    if (msg.channel === "order_events") {
      Effect.runFork(
        Effect.gen(function* () {
          yield* Effect.logDebug("Received notification", { channel: msg.channel, payload: msg.payload })
          yield* Queue.offer(notificationQueue, msg.channel)
        })
      )
    }
  })

  client.on("error", (error) => {
    Effect.runFork(
      Effect.logError("LISTEN connection error", { error })
    )
  })

  yield* Effect.tryPromise({
    try: () => client.query("LISTEN order_events"),
    catch: (error) => new ListenConnectionError({ cause: error })
  })

  yield* Effect.logInfo("Subscribed to order_events channel")

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.logInfo("Closing LISTEN connection")
      yield* Effect.promise(() => client.end().catch(() => {}))
    })
  )

  return notificationQueue
})

/**
 * Process notifications from the queue.
 * Triggers event processing whenever a notification is received.
 */
export const notificationLoop = (queue: Queue.Queue<string>) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Starting notification loop")

    yield* Effect.forever(
      Effect.gen(function* () {
        const channel = yield* Queue.take(queue)
        yield* Effect.logDebug("Processing notification", { channel })
        yield* processEvents
      })
    )
  })

/**
 * Main orchestrator program.
 * Runs LISTEN subscription and polling loop concurrently.
 * Never terminates under normal operation.
 */
export const main = Effect.gen(function* () {
  yield* Effect.logInfo("Orchestrator starting...")

  const sql = yield* PgClient.PgClient
  const result = yield* sql`SELECT 1 as health_check`
  yield* Effect.logInfo("Database connection verified", { check: result[0] })

  const notificationQueue = yield* createListenConnection

  yield* Effect.all([
    notificationLoop(notificationQueue),
    createPollingLoop
  ], { concurrency: "unbounded" })
}).pipe(
  Effect.withSpan("orchestrator-main"),
  Effect.scoped,
  Effect.catchAllCause((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError("Orchestrator fatal error", { cause })
      return yield* Effect.failCause(cause)
    })
  )
)

/**
 * Error for LISTEN connection failures.
 */
class ListenConnectionError extends Data.TaggedError("ListenConnectionError")<{
  readonly cause: unknown
}> {}
