import { Config, Context, Effect, Layer } from "effect"

export class EdgeApiConfig extends Context.Tag("EdgeApiConfig")<
  EdgeApiConfig,
  {
    readonly port: number
  }
>() {}

export const EdgeApiConfigLive = Layer.effect(
  EdgeApiConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3000))
    }
  })
)
