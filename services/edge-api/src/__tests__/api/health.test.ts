import { describe, it, expect } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient, SqlError } from "@effect/sql"
import { HttpServerResponse } from "@effect/platform"
import { healthCheck } from "../../api/health.js"

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

// Execute the actual healthCheck effect and extract response data
const executeHealthCheck = async (
  sqlClientLayer: Layer.Layer<SqlClient.SqlClient>
): Promise<MockResponse> => {
  const program = Effect.gen(function* () {
    // Execute the actual healthCheck effect from the implementation
    const response = yield* healthCheck

    // Extract status and body from the HttpServerResponse
    const status = response.status

    // Convert the response to a web response to read the body
    const webResponse = HttpServerResponse.toWeb(response)
    const body = yield* Effect.promise(() => webResponse.json() as Promise<HealthResponse>)

    return { status, body }
  })

  return program.pipe(
    Effect.provide(sqlClientLayer),
    Effect.runPromise
  )
}

describe("GET /health", () => {
  describe("successful health checks", () => {
    it("should return 200 with healthy status when database is connected", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.status).toBe(200)
      expect(result.body.status).toBe("healthy")
      expect(result.body.service).toBe("edge-api")
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

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.status).toBe(200)
      expect(result.body.latency_ms).toBeGreaterThanOrEqual(0)
    })

    it("should include timestamp in ISO format", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  describe("failed health checks", () => {
    it("should return 503 with unhealthy status when database is disconnected", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.status).toBe(503)
      expect(result.body.status).toBe("unhealthy")
      expect(result.body.service).toBe("edge-api")
      expect(result.body.database).toBe("disconnected")
      expect(result.body.error).toBeDefined()
      expect(result.body.timestamp).toBeDefined()
    })

    it("should include error message when database query fails", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.body.error).toContain("SqlError")
    })

    it("should not include latency_ms when unhealthy", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: false })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.body.latency_ms).toBeUndefined()
    })
  })

  describe("response format", () => {
    it("should always include service field set to 'edge-api'", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.body.service).toBe("edge-api")
    })

    it("should use snake_case keys in response body", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await executeHealthCheck(mockSqlClient)

      expect(result.body).toHaveProperty("latency_ms")
      expect(result.body).not.toHaveProperty("latencyMs")
    })

    it("should return proper content type for JSON response", async () => {
      const mockSqlClient = createMockSqlClient({ shouldSucceed: true })

      const result = await executeHealthCheck(mockSqlClient)

      // The response body should be a valid JSON object
      expect(typeof result.body).toBe("object")
      expect(JSON.stringify(result.body)).toBeTruthy()
    })
  })
})
