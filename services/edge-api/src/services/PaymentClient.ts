import { Context, Effect } from "effect"
import type { PaymentDeclinedError, PaymentGatewayError } from "../domain/errors.js"

export interface AuthorizePaymentParams {
  readonly userId: string
  readonly amountCents: number
  readonly currency: string
  readonly paymentToken: string
  readonly idempotencyKey: string
}

export interface AuthorizePaymentResult {
  readonly authorizationId: string
  readonly status: "AUTHORIZED"
  readonly amountCents: number
  readonly currency: string
  readonly createdAt: string
}

export class PaymentClient extends Context.Tag("PaymentClient")<
  PaymentClient,
  {
    /**
     * Authorize a payment via the Payment Service.
     * Returns authorization_id on success.
     * Fails with PaymentDeclinedError if payment is declined.
     * Fails with PaymentGatewayError if the gateway is unavailable.
     */
    readonly authorize: (
      params: AuthorizePaymentParams
    ) => Effect.Effect<AuthorizePaymentResult, PaymentDeclinedError | PaymentGatewayError>
  }
>() {}
