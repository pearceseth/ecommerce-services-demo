import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { EdgeApiConfigLive } from "./config.js"

// Export composed application layer
// Will be expanded with repository and service layers when endpoints are added
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  EdgeApiConfigLive
)
