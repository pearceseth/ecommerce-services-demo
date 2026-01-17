import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

const healthCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const startTime = Date.now()
  yield* sql`SELECT 1`
  const latencyMs = Date.now() - startTime

  return yield* HttpServerResponse.json({
    status: "healthy",
    database: "connected",
    latency_ms: latencyMs
  })
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      { status: "unhealthy", database: "disconnected", error: String(error) },
      { status: 503 }
    )
  )
)

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
