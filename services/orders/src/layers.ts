import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrdersConfigLive } from "./config.js"
import { OrderRepositoryLive } from "./repositories/OrderRepositoryLive.js"
import { OrderServiceLive } from "./services/OrderServiceLive.js"

// Repository layer depends on database
const RepositoryLive = OrderRepositoryLive.pipe(
  Layer.provide(DatabaseLive)
)

// Service layer depends on repositories
const ServiceLive = OrderServiceLive.pipe(
  Layer.provide(RepositoryLive)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrdersConfigLive,
  ServiceLive
)
