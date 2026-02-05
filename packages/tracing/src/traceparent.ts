/**
 * W3C Trace Context traceparent header parsing and formatting
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 * Example: 00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01
 */

export interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: number
}

// W3C traceparent regex: version-traceid-parentid-traceflags
// version: 2 hex digits (currently "00")
// traceId: 32 hex digits (16 bytes)
// spanId: 16 hex digits (8 bytes)
// traceFlags: 2 hex digits (1 byte)
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i

/**
 * Parse a W3C traceparent header string into a TraceContext object
 * Returns undefined if the header is invalid or missing
 */
export const parseTraceparent = (header: string | undefined): TraceContext | undefined => {
  if (!header) {
    return undefined
  }

  const match = TRACEPARENT_REGEX.exec(header)
  if (!match) {
    return undefined
  }

  const [, version, traceId, spanId, flags] = match

  // Reject unknown versions (only 00 is currently supported)
  if (version !== "00") {
    return undefined
  }

  // Reject invalid trace-id (all zeros is invalid)
  if (traceId === "00000000000000000000000000000000") {
    return undefined
  }

  // Reject invalid span-id (all zeros is invalid)
  if (spanId === "0000000000000000") {
    return undefined
  }

  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: parseInt(flags, 16)
  }
}

/**
 * Format a TraceContext object into a W3C traceparent header string
 */
export const formatTraceparent = (ctx: TraceContext): string => {
  const flags = ctx.traceFlags.toString(16).padStart(2, "0")
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`
}

/**
 * Check if the sampled flag is set in trace flags
 */
export const isSampled = (traceFlags: number): boolean => {
  return (traceFlags & 0x01) === 0x01
}
