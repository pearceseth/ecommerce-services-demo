import { describe, it, expect } from "vitest"
import { Duration, DateTime } from "effect"
import {
  calculateRetryDelay,
  calculateNextRetryAt,
  isMaxRetriesExceeded,
  DEFAULT_RETRY_POLICY
} from "../domain/RetryPolicy.js"

describe("RetryPolicy", () => {
  describe("calculateRetryDelay", () => {
    it("should return zero delay for first attempt", () => {
      const delay = calculateRetryDelay(1)
      expect(Duration.toMillis(delay)).toBe(0)
    })

    it("should return 1 second for second attempt", () => {
      const delay = calculateRetryDelay(2)
      expect(Duration.toMillis(delay)).toBe(1000)
    })

    it("should return 4 seconds for third attempt", () => {
      const delay = calculateRetryDelay(3)
      expect(Duration.toMillis(delay)).toBe(4000)
    })

    it("should return 16 seconds for fourth attempt", () => {
      const delay = calculateRetryDelay(4)
      expect(Duration.toMillis(delay)).toBe(16000)
    })

    it("should return 64 seconds for fifth attempt", () => {
      const delay = calculateRetryDelay(5)
      expect(Duration.toMillis(delay)).toBe(64000)
    })

    it("should return zero delay for attempt number less than 1", () => {
      const delay = calculateRetryDelay(0)
      expect(Duration.toMillis(delay)).toBe(0)
    })

    it("should respect custom policy values", () => {
      const policy = { maxAttempts: 3, baseDelayMs: 500, backoffMultiplier: 2 }
      // attempt 3: 500 * 2^(3-2) = 500 * 2^1 = 1000ms
      const delay = calculateRetryDelay(3, policy)
      expect(Duration.toMillis(delay)).toBe(1000)
    })

    it("should calculate correctly with different base delay", () => {
      const policy = { maxAttempts: 5, baseDelayMs: 2000, backoffMultiplier: 4 }
      // attempt 2: 2000 * 4^0 = 2000ms
      const delay = calculateRetryDelay(2, policy)
      expect(Duration.toMillis(delay)).toBe(2000)
    })

    it("should calculate correctly with different multiplier", () => {
      const policy = { maxAttempts: 5, baseDelayMs: 1000, backoffMultiplier: 3 }
      // attempt 3: 1000 * 3^1 = 3000ms
      const delay = calculateRetryDelay(3, policy)
      expect(Duration.toMillis(delay)).toBe(3000)
    })
  })

  describe("calculateNextRetryAt", () => {
    it("should add delay to current time", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      // attempt 2: delay = 1 second = 1000ms
      const nextRetry = calculateNextRetryAt(2, DEFAULT_RETRY_POLICY, baseTime)
      const delayMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(delayMs).toBe(1000)
    })

    it("should add 4 second delay for third attempt", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const nextRetry = calculateNextRetryAt(3, DEFAULT_RETRY_POLICY, baseTime)
      const delayMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(delayMs).toBe(4000)
    })

    it("should add 16 second delay for fourth attempt", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const nextRetry = calculateNextRetryAt(4, DEFAULT_RETRY_POLICY, baseTime)
      const delayMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(delayMs).toBe(16000)
    })

    it("should add 64 second delay for fifth attempt", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const nextRetry = calculateNextRetryAt(5, DEFAULT_RETRY_POLICY, baseTime)
      const delayMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(delayMs).toBe(64000)
    })

    it("should return baseTime unchanged for first attempt (immediate)", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const nextRetry = calculateNextRetryAt(1, DEFAULT_RETRY_POLICY, baseTime)
      const delayMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(delayMs).toBe(0)
    })

    it("should use custom policy for calculation", () => {
      const baseTime = DateTime.unsafeMake("2024-01-15T10:00:00Z")
      const policy = { maxAttempts: 3, baseDelayMs: 500, backoffMultiplier: 2 }
      // attempt 2: 500 * 2^0 = 500ms
      const nextRetry = calculateNextRetryAt(2, policy, baseTime)
      // Verify the difference is 500ms
      const diffMs = DateTime.toEpochMillis(nextRetry) - DateTime.toEpochMillis(baseTime)
      expect(diffMs).toBe(500)
    })
  })

  describe("isMaxRetriesExceeded", () => {
    it("should return false when retryCount is 0", () => {
      expect(isMaxRetriesExceeded(0, 5)).toBe(false)
    })

    it("should return false when retryCount is less than maxAttempts", () => {
      expect(isMaxRetriesExceeded(1, 5)).toBe(false)
      expect(isMaxRetriesExceeded(2, 5)).toBe(false)
      expect(isMaxRetriesExceeded(3, 5)).toBe(false)
      expect(isMaxRetriesExceeded(4, 5)).toBe(false)
    })

    it("should return true when retryCount equals maxAttempts", () => {
      expect(isMaxRetriesExceeded(5, 5)).toBe(true)
    })

    it("should return true when retryCount exceeds maxAttempts", () => {
      expect(isMaxRetriesExceeded(6, 5)).toBe(true)
      expect(isMaxRetriesExceeded(10, 5)).toBe(true)
    })

    it("should use default maxAttempts when not specified", () => {
      // DEFAULT_RETRY_POLICY.maxAttempts = 5
      expect(isMaxRetriesExceeded(4)).toBe(false)
      expect(isMaxRetriesExceeded(5)).toBe(true)
    })

    it("should work with custom maxAttempts of 3", () => {
      expect(isMaxRetriesExceeded(2, 3)).toBe(false)
      expect(isMaxRetriesExceeded(3, 3)).toBe(true)
    })

    it("should work with custom maxAttempts of 1", () => {
      expect(isMaxRetriesExceeded(0, 1)).toBe(false)
      expect(isMaxRetriesExceeded(1, 1)).toBe(true)
    })
  })

  describe("DEFAULT_RETRY_POLICY", () => {
    it("should have maxAttempts of 5", () => {
      expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(5)
    })

    it("should have baseDelayMs of 1000", () => {
      expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(1000)
    })

    it("should have backoffMultiplier of 4", () => {
      expect(DEFAULT_RETRY_POLICY.backoffMultiplier).toBe(4)
    })
  })

  describe("exponential backoff formula verification", () => {
    // Verify the full sequence matches engineering-design.md Section 4.5
    it("should produce delays matching the spec: 0, 1s, 4s, 16s, 64s", () => {
      const expectedDelays = [0, 1000, 4000, 16000, 64000]

      for (let attempt = 1; attempt <= 5; attempt++) {
        const delay = calculateRetryDelay(attempt)
        expect(Duration.toMillis(delay)).toBe(expectedDelays[attempt - 1])
      }
    })
  })
})
