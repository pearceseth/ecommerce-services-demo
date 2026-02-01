import { Layer } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseLive } from "./db.js"
import { EdgeApiConfigLive } from "./config.js"
import { OrderLedgerRepositoryLive } from "./repositories/OrderLedgerRepositoryLive.js"
import { OrderServiceLive } from "./services/OrderServiceLive.js"
import { PaymentClientLive } from "./services/PaymentClientLive.js"

// HTTP client layer for making external requests
const HttpClientLive = NodeHttpClient.layer

// Repository layer depends on database
const RepositoryLive = OrderLedgerRepositoryLive.pipe(
  Layer.provide(DatabaseLive)
)

// Payment client depends on HTTP client
const PaymentClientLayer = PaymentClientLive.pipe(
  Layer.provide(HttpClientLive)
)

// Service layer depends on repositories and clients
const ServiceLive = OrderServiceLive.pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(PaymentClientLayer)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  EdgeApiConfigLive,
  ServiceLive
)
