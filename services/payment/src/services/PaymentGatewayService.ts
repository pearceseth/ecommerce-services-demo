import { Context, Effect, Option } from "effect"
import type {
  AuthorizePaymentRequest,
  AuthorizationResponse,
  AuthorizationState
} from "../domain/Authorization.js"
import type { CapturePaymentRequest, CaptureResponse } from "../domain/Capture.js"
import type { VoidPaymentRequest, VoidResponse } from "../domain/Void.js"
import type {
  PaymentDeclinedError,
  GatewayConnectionError,
  AuthorizationNotFoundError,
  AlreadyCapturedError,
  AlreadyVoidedError
} from "../domain/errors.js"

export class PaymentGatewayService extends Context.Tag("PaymentGatewayService")<
  PaymentGatewayService,
  {
    /**
     * Authorize a payment amount. Holds funds but does not charge.
     * Idempotent: same idempotency_key returns same result.
     */
    readonly authorize: (
      request: AuthorizePaymentRequest
    ) => Effect.Effect<
      AuthorizationResponse,
      PaymentDeclinedError | GatewayConnectionError
    >

    /**
     * Capture an authorized payment. Actually charges the customer.
     * Idempotent: capturing already-captured auth returns existing capture.
     */
    readonly capture: (
      authorizationId: string,
      request: CapturePaymentRequest
    ) => Effect.Effect<
      CaptureResponse,
      AuthorizationNotFoundError | AlreadyVoidedError | GatewayConnectionError
    >

    /**
     * Void an authorization. Releases held funds without charging.
     * Idempotent: voiding already-voided auth succeeds.
     */
    readonly voidAuthorization: (
      authorizationId: string,
      request: VoidPaymentRequest
    ) => Effect.Effect<
      VoidResponse,
      AuthorizationNotFoundError | AlreadyCapturedError | GatewayConnectionError
    >

    /**
     * Get authorization state (for testing/debugging).
     * Not part of typical payment API but useful for mock.
     */
    readonly getAuthorization: (
      authorizationId: string
    ) => Effect.Effect<Option.Option<AuthorizationState>, never>
  }
>() {}
