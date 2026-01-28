import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrdersConfigLive } from "./config.js"

// For scaffold, we only have Database and Config
// Repositories and Services will be added in subsequent tasks
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrdersConfigLive
)
