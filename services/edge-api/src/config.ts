import { Config, Context, Effect, Layer } from "effect"

export class EdgeApiConfig extends Context.Tag("EdgeApiConfig")<
  EdgeApiConfig,
  {
    readonly port: number
    readonly paymentServiceUrl: string
  }
>() {}

export const EdgeApiConfigLive = Layer.effect(
  EdgeApiConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3000)),
      paymentServiceUrl: yield* Config.string("PAYMENT_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      )
    }
  })
)
