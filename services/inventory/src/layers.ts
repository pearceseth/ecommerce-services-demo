import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { ProductRepositoryLive } from "./repositories/ProductRepositoryLive.js"
import { StockAdjustmentRepositoryLive } from "./repositories/StockAdjustmentRepositoryLive.js"
import { ProductServiceLive } from "./services/ProductServiceLive.js"
import { InventoryServiceLive } from "./services/InventoryServiceLive.js"

// Repository layer depends on database
const RepositoryLive = Layer.mergeAll(
  ProductRepositoryLive,
  StockAdjustmentRepositoryLive
).pipe(Layer.provide(DatabaseLive))

// Service layer depends on repositories
const ServiceLive = Layer.mergeAll(
  ProductServiceLive,
  InventoryServiceLive
).pipe(Layer.provide(RepositoryLive))

// Export composed application layer
export const AppLive = Layer.mergeAll(DatabaseLive, ServiceLive)
