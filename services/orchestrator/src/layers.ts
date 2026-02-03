import { Layer } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseLive } from "./db.js"
import { OrchestratorConfigLive } from "./config.js"
import { OutboxRepositoryLive } from "./repositories/OutboxRepositoryLive.js"
import { LedgerRepositoryLive } from "./repositories/LedgerRepositoryLive.js"
import { OrdersClientLive } from "./clients/OrdersClientLive.js"
import { InventoryClientLive } from "./clients/InventoryClientLive.js"
import { PaymentsClientLive } from "./clients/PaymentsClientLive.js"
import { SagaExecutorLive } from "./services/SagaExecutorLive.js"

// HTTP client layer for all service clients
const HttpClientLive = NodeHttpClient.layer

// Repository layers (depend on Database)
const RepositoriesLive = Layer.mergeAll(
  OutboxRepositoryLive,
  LedgerRepositoryLive
).pipe(Layer.provide(DatabaseLive))

// HTTP client layers (depend on HttpClient)
const ClientsLive = Layer.mergeAll(
  OrdersClientLive,
  InventoryClientLive,
  PaymentsClientLive
).pipe(Layer.provide(HttpClientLive))

// Service layers (depend on repositories and clients)
const ServicesLive = SagaExecutorLive.pipe(
  Layer.provide(RepositoriesLive),
  Layer.provide(ClientsLive)
)

// Complete application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrchestratorConfigLive,
  RepositoriesLive,
  ClientsLive,
  ServicesLive
)
