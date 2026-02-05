/**
 * Traced HTTP Client Layer
 *
 * Wraps the NodeHttpClient to automatically inject W3C traceparent headers
 * into outgoing HTTP requests based on the current Effect span context.
 */

import { HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpClient } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { formatTraceparent } from "./traceparent.js"

/**
 * Creates a traced HTTP client layer that injects traceparent headers
 * into all outgoing requests when a span is active.
 */
export const TracedHttpClientLive: Layer.Layer<HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient

    return HttpClient.mapRequestEffect(baseClient, (request) =>
      Effect.gen(function* () {
        const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)

        if (Option.isSome(maybeSpan)) {
          const span = maybeSpan.value
          const traceparent = formatTraceparent({
            traceId: span.traceId,
            spanId: span.spanId,
            traceFlags: span.sampled ? 1 : 0
          })
          return HttpClientRequest.setHeader(request, "traceparent", traceparent)
        }

        return request
      })
    )
  })
).pipe(Layer.provide(NodeHttpClient.layer))
