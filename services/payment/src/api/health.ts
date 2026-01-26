import { HttpRouter, HttpServerResponse } from "@effect/platform"

const healthCheck = HttpServerResponse.json({
  status: "healthy",
  service: "payments",
  timestamp: new Date().toISOString()
})

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
