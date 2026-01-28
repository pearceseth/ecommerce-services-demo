import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { AppLive } from "./layers.js"
import { OrdersConfig } from "./config.js"
import { TelemetryLive } from "./telemetry.js"

// Root route - service identification
const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(
      HttpServerResponse.text("Orders Service - E-commerce Demo")
    )
  )
)

// Compose all routes
const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes)
)

// Create HTTP server with dynamic port from config
const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* OrdersConfig

    return router.pipe(
      HttpServer.serve(),
      HttpServer.withLogAddress,
      Layer.provide(
        NodeHttpServer.layer(createServer, { port: config.port })
      )
    )
  })
)

// Compose final application layer
const MainLive = HttpLive.pipe(
  Layer.provide(AppLive),
  Layer.provide(TelemetryLive)
)

// Launch the server
Layer.launch(MainLive).pipe(NodeRuntime.runMain)
