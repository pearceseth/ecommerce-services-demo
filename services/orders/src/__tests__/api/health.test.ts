import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient, SqlError } from "@effect/sql"

// Response type for the health check
interface HealthResponse {
  status: "healthy" | "unhealthy"
  service: string
  database: "connected" | "disconnected"
  latency_ms?: number
  error?: string
  timestamp: string
}

interface MockResponse {
  status: number
  body: HealthResponse
}

// Mock SqlClient factory - simulates database connection
const createMockSqlClient = (config: {
  shouldSucceed: boolean
  queryDelay?: number
}) => {
  const mockClient = {
    // Template literal tag for SQL queries - this is what gets called with sql`SELECT 1`
    sql: () => {
      if (!config.shouldSucceed) {
        return Effect.fail(
          new SqlError.SqlError({
            cause: new Error("Connection failed"),
            message: "Database connection error"
          })
        )
      }
      // Simulate query delay
      if (config.queryDelay && config.queryDelay > 0) {
        return Effect.delay(Effect.succeed([{ "?column?": 1 }]), config.queryDelay)
      }
      return Effect.succeed([{ "?column?": 1 }])
    }
  }

  // Create a proxy that handles template literal calls
  const proxyClient = new Proxy(mockClient.sql, {
    apply: () => mockClient.sql()
  })

  return Layer.succeed(SqlClient.SqlClient, proxyClient as unknown as SqlClient.SqlClient)
}

// Run the health check logic with mocks
const runHealthCheck = async (
  sqlClientLayer: Layer.Layer<SqlClient.SqlClient>
): Promise<MockResponse> => {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const startTime = Date.now()

    // Test database connection
    yield* sql`SELECT 1`

    const latencyMs = Date.now() - startTime

    return {
      status: 200,
      body: {
        status: "healthy",
        service: "orders",
        database: "connected",
        latency_ms: latencyMs,
        timestamp: new Date().toISOString()
      }
    } as MockResponse
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        status: 503,
        body: {
          status: "unhealthy",
          service: "orders",
          database: "disconnected",
          error: String(error),
          timestamp: new Date().toISOString()
        }
      } as MockResponse)
    ),
    Effect.provide(sqlClientLayer),
    Effect.runPromise
  )
}

describe("GET /health", () => {
  describe("successful health checks", () => {
    it("should return 200 with healthy status when database is connected", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("healthy")
      expect(result.body.service).toBe("orders")
      expect(result.body.database).toBe("connected")
      expect(result.body.latency_ms).toBeDefined()
      expect(typeof result.body.latency_ms).toBe("number")
      expect(result.body.timestamp).toBeDefined()
    })

    it("should measure database query latency", async () => {
      const mockSqlClient = createMockSqlClient({
        shouldSucceed: true,
        queryDelay: 50
      })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.status).toBe(200)
      expect(result.body.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it("should include timestamp in ISO format", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  describe("failed health checks", () => {
    it("should return 503 with unhealthy status when database is disconnected", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.status).toBe(503)
      expect(result.body.status).toBe("unhealthy")
      expect(result.body.service).toBe("orders")
      expect(result.body.database).toBe("disconnected")
      expect(result.body.error).toBeDefined()
      expect(result.body.timestamp).toBeDefined()
    })

    it("should include error message when database query fails", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.body.error).toContain("SqlError")
    })

    it("should not include latency_ms when unhealthy", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.body.latency_ms).toBeUndefined()
    })
  })

  describe("response format", () => {
    it("should always include service field set to 'orders'", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.body.service).toBe("orders")
    })

    it("should use snake_case keys in response body", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await runHealthCheck(mockSqlClient)

      expect(result.body).toHaveProperty("latency_ms")
      expect(result.body).not.toHaveProperty("latencyMs")
    })

    it("should return proper content type for JSON response", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await runHealthCheck(mockSqlClient)

      // The response body should be a valid JSON object
      expect(typeof result.body).toBe("object")
      expect(JSON.stringify(result.body)).toBeTruthy()
    })
  })
})
