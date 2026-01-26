import { Config, Context, Effect, Layer } from "effect"

export class PaymentConfig extends Context.Tag("PaymentConfig")<
  PaymentConfig,
  {
    readonly port: number
    readonly mockLatencyMs: number
    readonly mockFailureRate: number // 0.0 to 1.0
  }
>() {}

export const PaymentConfigLive = Layer.effect(
  PaymentConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3002)),
      mockLatencyMs: yield* Config.number("MOCK_LATENCY_MS").pipe(Config.withDefault(100)),
      mockFailureRate: yield* Config.number("MOCK_FAILURE_RATE").pipe(Config.withDefault(0.0))
    }
  })
)
