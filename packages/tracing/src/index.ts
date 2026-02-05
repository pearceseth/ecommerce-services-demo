/**
 * @ecommerce/tracing
 *
 * W3C Trace Context propagation utilities for distributed tracing across microservices.
 */

// Traceparent header parsing and formatting
export { parseTraceparent, formatTraceparent, isSampled, type TraceContext } from "./traceparent.js"

// HTTP client layer with automatic trace header injection
export { TracedHttpClientLive } from "./TracedHttpClient.js"

// Server middleware for extracting incoming trace context
export { withTraceContext } from "./TraceContextMiddleware.js"
