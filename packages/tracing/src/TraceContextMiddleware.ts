/**
 * Trace Context Middleware
 *
 * Extracts W3C traceparent header from incoming HTTP requests and establishes
 * the parent span context for distributed tracing continuity.
 */

import { HttpServerRequest } from "@effect/platform"
import { Effect, Tracer } from "effect"
import { parseTraceparent } from "./traceparent.js"

/**
 * Wraps a handler effect to extract and propagate trace context from incoming requests.
 *
 * If a valid traceparent header is present, creates an external span that links
 * the incoming request to the distributed trace. Otherwise, the handler runs
 * without external parent context (a new trace will be started).
 *
 * @example
 * ```ts
 * const myHandler = withTraceContext(
 *   Effect.gen(function* () {
 *     // Handler code here - will be traced under incoming context
 *   })
 * ).pipe(Effect.withSpan("POST /my-endpoint"))
 * ```
 */
export const withTraceContext = <A, E, R>(
  handler: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const traceparent = request.headers["traceparent"]
    const parsed = parseTraceparent(traceparent)

    if (parsed) {
      // Create an external span that represents the parent from the upstream service
      const externalSpan = Tracer.externalSpan({
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        sampled: (parsed.traceFlags & 0x01) === 0x01
      })

      // Run the handler with this external span as the parent
      return yield* Effect.provideService(handler, Tracer.ParentSpan, externalSpan)
    }

    // No valid trace context - run handler normally (new trace will be created)
    return yield* handler
  })
