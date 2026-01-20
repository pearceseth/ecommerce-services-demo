import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { ProductRoutes } from "./api/products.js"
import { AppLive } from "./layers.js"
import { TelemetryLive } from "./telemetry.js"

const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(HttpServerResponse.text("Hello from Inventory Service"))
  )
)

const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/inventory", ProductRoutes)
)

const HttpLive = router.pipe(
  HttpServer.serve(),
  HttpServer.withLogAddress,
  Layer.provide(
    NodeHttpServer.layer(createServer, {
      port: Number(process.env.PORT) || 3001
    })
  ),
  Layer.provide(AppLive),
  Layer.provide(TelemetryLive)
)

Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
