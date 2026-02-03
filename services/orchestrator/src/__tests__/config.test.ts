import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, ConfigProvider, Layer } from "effect"
import { OrchestratorConfig, OrchestratorConfigLive } from "../config.js"

describe("OrchestratorConfig", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("pollIntervalMs configuration", () => {
    it("should use default pollIntervalMs of 5000 when POLL_INTERVAL_MS is not set", async () => {
      delete process.env.POLL_INTERVAL_MS

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.pollIntervalMs
      }).pipe(
        Effect.provide(OrchestratorConfigLive),
        Effect.runPromise
      )

      expect(result).toBe(5000)
    })

    it("should use POLL_INTERVAL_MS from environment when set", async () => {
      const customInterval = 10000
      const configProvider = ConfigProvider.fromMap(
        new Map([["POLL_INTERVAL_MS", String(customInterval)]])
      )

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.pollIntervalMs
      }).pipe(
        Effect.provide(
          OrchestratorConfigLive.pipe(
            Layer.provide(Layer.setConfigProvider(configProvider))
          )
        ),
        Effect.runPromise
      )

      expect(result).toBe(customInterval)
    })
  })

  describe("service URLs configuration", () => {
    it("should use default ordersServiceUrl when ORDERS_SERVICE_URL is not set", async () => {
      delete process.env.ORDERS_SERVICE_URL

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.ordersServiceUrl
      }).pipe(
        Effect.provide(OrchestratorConfigLive),
        Effect.runPromise
      )

      expect(result).toBe("http://localhost:3003")
    })

    it("should use ORDERS_SERVICE_URL from environment when set", async () => {
      const customUrl = "http://orders:8080"
      const configProvider = ConfigProvider.fromMap(
        new Map([["ORDERS_SERVICE_URL", customUrl]])
      )

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.ordersServiceUrl
      }).pipe(
        Effect.provide(
          OrchestratorConfigLive.pipe(
            Layer.provide(Layer.setConfigProvider(configProvider))
          )
        ),
        Effect.runPromise
      )

      expect(result).toBe(customUrl)
    })

    it("should use default inventoryServiceUrl when INVENTORY_SERVICE_URL is not set", async () => {
      delete process.env.INVENTORY_SERVICE_URL

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.inventoryServiceUrl
      }).pipe(
        Effect.provide(OrchestratorConfigLive),
        Effect.runPromise
      )

      expect(result).toBe("http://localhost:3001")
    })

    it("should use INVENTORY_SERVICE_URL from environment when set", async () => {
      const customUrl = "http://inventory:8080"
      const configProvider = ConfigProvider.fromMap(
        new Map([["INVENTORY_SERVICE_URL", customUrl]])
      )

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.inventoryServiceUrl
      }).pipe(
        Effect.provide(
          OrchestratorConfigLive.pipe(
            Layer.provide(Layer.setConfigProvider(configProvider))
          )
        ),
        Effect.runPromise
      )

      expect(result).toBe(customUrl)
    })

    it("should use default paymentsServiceUrl when PAYMENTS_SERVICE_URL is not set", async () => {
      delete process.env.PAYMENTS_SERVICE_URL

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.paymentsServiceUrl
      }).pipe(
        Effect.provide(OrchestratorConfigLive),
        Effect.runPromise
      )

      expect(result).toBe("http://localhost:3002")
    })

    it("should use PAYMENTS_SERVICE_URL from environment when set", async () => {
      const customUrl = "http://payments:8080"
      const configProvider = ConfigProvider.fromMap(
        new Map([["PAYMENTS_SERVICE_URL", customUrl]])
      )

      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config.paymentsServiceUrl
      }).pipe(
        Effect.provide(
          OrchestratorConfigLive.pipe(
            Layer.provide(Layer.setConfigProvider(configProvider))
          )
        ),
        Effect.runPromise
      )

      expect(result).toBe(customUrl)
    })
  })

  describe("OrchestratorConfig Context.Tag", () => {
    it("should have the correct tag name", () => {
      expect(OrchestratorConfig.key).toBe("OrchestratorConfig")
    })

    it("should provide a config object with all required properties", async () => {
      const result = await Effect.gen(function* () {
        const config = yield* OrchestratorConfig
        return config
      }).pipe(
        Effect.provide(OrchestratorConfigLive),
        Effect.runPromise
      )

      expect(result).toHaveProperty("pollIntervalMs")
      expect(result).toHaveProperty("ordersServiceUrl")
      expect(result).toHaveProperty("inventoryServiceUrl")
      expect(result).toHaveProperty("paymentsServiceUrl")
      expect(typeof result.pollIntervalMs).toBe("number")
      expect(typeof result.ordersServiceUrl).toBe("string")
      expect(typeof result.inventoryServiceUrl).toBe("string")
      expect(typeof result.paymentsServiceUrl).toBe("string")
    })
  })
})
