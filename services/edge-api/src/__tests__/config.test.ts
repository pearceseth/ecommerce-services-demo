import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Effect, ConfigProvider, Layer } from "effect"
import { EdgeApiConfig, EdgeApiConfigLive } from "../config.js"

describe("EdgeApiConfig", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("port configuration", () => {
    it("should use default port 3000 when PORT is not set", async () => {
      delete process.env.PORT

      const result = await Effect.gen(function* () {
        const config = yield* EdgeApiConfig
        return config.port
      }).pipe(
        Effect.provide(EdgeApiConfigLive),
        Effect.runPromise
      )

      expect(result).toBe(3000)
    })

    it("should use PORT from environment when set", async () => {
      const customPort = 8080
      const configProvider = ConfigProvider.fromMap(
        new Map([["PORT", String(customPort)]])
      )

      const result = await Effect.gen(function* () {
        const config = yield* EdgeApiConfig
        return config.port
      }).pipe(
        Effect.provide(
          EdgeApiConfigLive.pipe(
            Layer.provide(Layer.setConfigProvider(configProvider))
          )
        ),
        Effect.runPromise
      )

      expect(result).toBe(customPort)
    })
  })

  describe("EdgeApiConfig Context.Tag", () => {
    it("should have the correct tag name", () => {
      expect(EdgeApiConfig.key).toBe("EdgeApiConfig")
    })

    it("should provide a config object with port property", async () => {
      const result = await Effect.gen(function* () {
        const config = yield* EdgeApiConfig
        return config
      }).pipe(
        Effect.provide(EdgeApiConfigLive),
        Effect.runPromise
      )

      expect(result).toHaveProperty("port")
      expect(typeof result.port).toBe("number")
    })
  })
})
