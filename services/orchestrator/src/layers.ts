import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrchestratorConfigLive } from "./config.js"

export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrchestratorConfigLive
)
