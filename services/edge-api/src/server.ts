import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"

const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(HttpServerResponse.text("Hello from Edge API"))
  ),
  HttpRouter.get(
    "/health",
    HttpServerResponse.json({ status: "healthy" })
  )
)

const HttpLive = router.pipe(
  HttpServer.serve(),
  HttpServer.withLogAddress,
  Layer.provide(
    NodeHttpServer.layer(createServer, {
      port: Number(process.env.PORT) || 3000
    })
  )
)

Layer.launch(HttpLive).pipe(NodeRuntime.runMain)
