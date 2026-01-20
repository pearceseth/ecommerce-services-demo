import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { ProductRepositoryLive } from "./repositories/ProductRepositoryLive.js"
import { ProductServiceLive } from "./services/ProductServiceLive.js"

// Repository layer depends on database
const RepositoryLive = ProductRepositoryLive.pipe(Layer.provide(DatabaseLive))

// Service layer depends on repository
const ServiceLive = ProductServiceLive.pipe(Layer.provide(RepositoryLive))

// Export composed application layer
export const AppLive = Layer.mergeAll(DatabaseLive, ServiceLive)
