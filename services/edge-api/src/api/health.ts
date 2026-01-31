import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

// Exported for testing - the core health check logic
export const healthCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const startTime = Date.now()

  // Test database connection
  yield* sql`SELECT 1`

  const latencyMs = Date.now() - startTime

  return yield* HttpServerResponse.json({
    status: "healthy",
    service: "edge-api",
    database: "connected",
    latency_ms: latencyMs,
    timestamp: new Date().toISOString()
  })
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      {
        status: "unhealthy",
        service: "edge-api",
        database: "disconnected",
        error: String(error),
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    )
  )
)

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
