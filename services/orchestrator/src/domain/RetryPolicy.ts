import { DateTime, Duration } from "effect"

/**
 * Configuration for retry behavior.
 */
export interface RetryPolicy {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly backoffMultiplier: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  backoffMultiplier: 4
}

/**
 * Calculate the delay for a given retry attempt.
 *
 * Formula: delay = baseDelay * multiplier^(attempt - 2)
 *
 * | Attempt | Calculation      | Delay  |
 * |---------|------------------|--------|
 * | 1       | (immediate)      | 0ms    |
 * | 2       | 1000 * 4^0       | 1000ms |
 * | 3       | 1000 * 4^1       | 4000ms |
 * | 4       | 1000 * 4^2       | 16000ms|
 * | 5       | 1000 * 4^3       | 64000ms|
 *
 * @param attemptNumber - The next attempt number (1-indexed)
 * @param policy - The retry policy configuration
 * @returns Duration representing the delay before the next retry
 */
export const calculateRetryDelay = (
  attemptNumber: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Duration.Duration => {
  if (attemptNumber <= 1) {
    return Duration.zero
  }

  const exponent = attemptNumber - 2
  const delayMs = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, exponent)
  return Duration.millis(delayMs)
}

/**
 * Calculate the absolute timestamp for the next retry.
 *
 * @param attemptNumber - The next attempt number (1-indexed)
 * @param policy - The retry policy configuration
 * @param fromTime - Optional base time (defaults to now)
 * @returns DateTime.Utc representing when the retry should occur
 */
export const calculateNextRetryAt = (
  attemptNumber: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  fromTime?: DateTime.Utc
): DateTime.Utc => {
  const baseTime = fromTime ?? DateTime.unsafeNow()
  const delay = calculateRetryDelay(attemptNumber, policy)
  return DateTime.addDuration(baseTime, delay)
}

/**
 * Check if max retries have been exceeded.
 *
 * @param currentRetryCount - The current retry_count value (0 = never failed)
 * @param maxAttempts - Maximum allowed attempts (default: 5)
 * @returns true if no more retries should be attempted
 */
export const isMaxRetriesExceeded = (
  currentRetryCount: number,
  maxAttempts: number = DEFAULT_RETRY_POLICY.maxAttempts
): boolean => {
  // retry_count of 5 means we've failed 5 times
  // maxAttempts of 5 means attempts 1-5 are allowed
  // So if retry_count >= maxAttempts, we're done
  return currentRetryCount >= maxAttempts
}
