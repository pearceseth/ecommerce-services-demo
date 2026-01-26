import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { PaymentRoutes } from "./api/payments.js"
import { AppLive } from "./layers.js"
import { TelemetryLive } from "./telemetry.js"
import { PaymentConfig } from "./config.js"

const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get("/", Effect.succeed(HttpServerResponse.text("Payments Service")))
)

const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/", PaymentRoutes)
)

// Create server with dynamic port from config
const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* PaymentConfig

    return router.pipe(
      HttpServer.serve(),
      HttpServer.withLogAddress,
      Layer.provide(
        NodeHttpServer.layer(createServer, { port: config.port })
      )
    )
  })
)

const MainLive = HttpLive.pipe(
  Layer.provide(AppLive),
  Layer.provide(TelemetryLive)
)

Layer.launch(MainLive).pipe(NodeRuntime.runMain)
