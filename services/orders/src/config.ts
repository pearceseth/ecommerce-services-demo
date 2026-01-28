import { Config, Context, Effect, Layer } from "effect"

export class OrdersConfig extends Context.Tag("OrdersConfig")<
  OrdersConfig,
  {
    readonly port: number
  }
>() {}

export const OrdersConfigLive = Layer.effect(
  OrdersConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3003))
    }
  })
)
