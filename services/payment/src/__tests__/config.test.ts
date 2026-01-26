import { describe, it, expect } from "vitest"
import { Effect, Layer, ConfigProvider } from "effect"
import { PaymentConfig, PaymentConfigLive } from "../config.js"

describe("PaymentConfig", () => {
  it("should use default values when no environment variables set", async () => {
    const result = await Effect.gen(function* () {
      const config = yield* PaymentConfig
      return config
    }).pipe(
      Effect.provide(PaymentConfigLive),
      Effect.runPromise
    )

    expect(result.port).toBe(3002)
    expect(result.mockLatencyMs).toBe(100)
    expect(result.mockFailureRate).toBe(0.0)
  })

  it("should read PORT from environment", async () => {
    const configProvider = ConfigProvider.fromMap(new Map([
      ["PORT", "4000"]
    ]))

    const TestLayer = Layer.mergeAll(
      PaymentConfigLive.pipe(
        Layer.provideMerge(Layer.setConfigProvider(configProvider))
      )
    )

    const result = await Effect.gen(function* () {
      const config = yield* PaymentConfig
      return config
    }).pipe(
      Effect.provide(TestLayer),
      Effect.runPromise
    )

    expect(result.port).toBe(4000)
  })

  it("should read MOCK_LATENCY_MS from environment", async () => {
    const configProvider = ConfigProvider.fromMap(new Map([
      ["MOCK_LATENCY_MS", "500"]
    ]))

    const TestLayer = Layer.mergeAll(
      PaymentConfigLive.pipe(
        Layer.provideMerge(Layer.setConfigProvider(configProvider))
      )
    )

    const result = await Effect.gen(function* () {
      const config = yield* PaymentConfig
      return config
    }).pipe(
      Effect.provide(TestLayer),
      Effect.runPromise
    )

    expect(result.mockLatencyMs).toBe(500)
  })

  it("should read MOCK_FAILURE_RATE from environment", async () => {
    const configProvider = ConfigProvider.fromMap(new Map([
      ["MOCK_FAILURE_RATE", "0.1"]
    ]))

    const TestLayer = Layer.mergeAll(
      PaymentConfigLive.pipe(
        Layer.provideMerge(Layer.setConfigProvider(configProvider))
      )
    )

    const result = await Effect.gen(function* () {
      const config = yield* PaymentConfig
      return config
    }).pipe(
      Effect.provide(TestLayer),
      Effect.runPromise
    )

    expect(result.mockFailureRate).toBe(0.1)
  })

  it("should handle all config values together", async () => {
    const configProvider = ConfigProvider.fromMap(new Map([
      ["PORT", "5000"],
      ["MOCK_LATENCY_MS", "200"],
      ["MOCK_FAILURE_RATE", "0.05"]
    ]))

    const TestLayer = Layer.mergeAll(
      PaymentConfigLive.pipe(
        Layer.provideMerge(Layer.setConfigProvider(configProvider))
      )
    )

    const result = await Effect.gen(function* () {
      const config = yield* PaymentConfig
      return config
    }).pipe(
      Effect.provide(TestLayer),
      Effect.runPromise
    )

    expect(result.port).toBe(5000)
    expect(result.mockLatencyMs).toBe(200)
    expect(result.mockFailureRate).toBe(0.05)
  })
})
