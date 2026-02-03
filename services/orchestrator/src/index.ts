import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { main } from "./main.js"
import { AppLive } from "./layers.js"
import { TelemetryLive } from "./telemetry.js"

const program = main.pipe(
  Effect.provide(AppLive),
  Effect.provide(TelemetryLive)
)

NodeRuntime.runMain(program)
