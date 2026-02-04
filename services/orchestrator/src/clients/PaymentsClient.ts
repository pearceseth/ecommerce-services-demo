import { Context, Effect } from "effect"
import type { PaymentCaptureError, PaymentVoidError, ServiceConnectionError } from "../domain/errors.js"

export interface CapturePaymentParams {
  readonly authorizationId: string
  readonly idempotencyKey: string
  readonly amountCents?: number
}

export interface CapturePaymentResult {
  readonly captureId: string
  readonly authorizationId: string
  readonly status: "CAPTURED"
  readonly amountCents: number
  readonly currency: string
  readonly capturedAt: string
}

export interface VoidPaymentParams {
  readonly authorizationId: string
  readonly idempotencyKey: string
  readonly reason?: string
}

export interface VoidPaymentResult {
  readonly voidId: string
  readonly authorizationId: string
  readonly status: "VOIDED"
  readonly voidedAt: string
}

export class PaymentsClient extends Context.Tag("PaymentsClient")<
  PaymentsClient,
  {
    /**
     * Capture an authorized payment.
     * Idempotent: returns existing capture if already captured.
     */
    readonly capturePayment: (
      params: CapturePaymentParams
    ) => Effect.Effect<CapturePaymentResult, PaymentCaptureError | ServiceConnectionError>

    /**
     * Void an authorized payment (compensation).
     * Idempotent: returns success if already voided.
     */
    readonly voidPayment: (
      params: VoidPaymentParams
    ) => Effect.Effect<VoidPaymentResult, PaymentVoidError | ServiceConnectionError>
  }
>() {}
