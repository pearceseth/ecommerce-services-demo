import { Layer } from "effect"
import { DatabaseLive } from "./db.js"

// Compose all application layers here
// As we implement services, we'll add their Live layers

export const AppLive = Layer.mergeAll(
  DatabaseLive
)
