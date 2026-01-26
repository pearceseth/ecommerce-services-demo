import { Layer } from "effect"
import { PaymentConfigLive } from "./config.js"
import { PaymentGatewayServiceLive } from "./services/PaymentGatewayServiceLive.js"

// Service depends on config
const ServiceLive = PaymentGatewayServiceLive.pipe(
  Layer.provide(PaymentConfigLive)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(PaymentConfigLive, ServiceLive)
