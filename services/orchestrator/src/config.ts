import { Config, Context, Effect, Layer } from "effect"

export class OrchestratorConfig extends Context.Tag("OrchestratorConfig")<
  OrchestratorConfig,
  {
    readonly pollIntervalMs: number
    readonly ordersServiceUrl: string
    readonly inventoryServiceUrl: string
    readonly paymentsServiceUrl: string
  }
>() {}

export const OrchestratorConfigLive = Layer.effect(
  OrchestratorConfig,
  Effect.gen(function* () {
    return {
      pollIntervalMs: yield* Config.number("POLL_INTERVAL_MS").pipe(
        Config.withDefault(5000)
      ),
      ordersServiceUrl: yield* Config.string("ORDERS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3003")
      ),
      inventoryServiceUrl: yield* Config.string("INVENTORY_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3001")
      ),
      paymentsServiceUrl: yield* Config.string("PAYMENTS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      )
    }
  })
)
