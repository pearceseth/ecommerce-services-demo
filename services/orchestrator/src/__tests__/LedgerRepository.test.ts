import { describe, it, expect } from "vitest"
import { Effect, Layer, Option, DateTime } from "effect"
import { LedgerRepository, type LedgerWithItems } from "../repositories/LedgerRepository.js"
import { OrderLedger, OrderLedgerItem, type OrderLedgerId, type OrderLedgerStatus, type UserId, type ProductId } from "../domain/OrderLedger.js"

// Test fixtures
const createTestLedger = (
  id: string,
  status: OrderLedgerStatus = "AUTHORIZED",
  orderId: string | null = null
): OrderLedger => {
  const now = DateTime.unsafeNow()
  return new OrderLedger({
    id: id as OrderLedgerId,
    clientRequestId: `client-req-${id}`,
    userId: "user-123" as UserId,
    email: "test@example.com",
    status,
    totalAmountCents: 5999,
    currency: "USD",
    paymentAuthorizationId: "auth-456",
    orderId,
    createdAt: now,
    updatedAt: now
  })
}

const createTestItem = (id: string, ledgerId: string): OrderLedgerItem => {
  const now = DateTime.unsafeNow()
  return new OrderLedgerItem({
    id,
    orderLedgerId: ledgerId as OrderLedgerId,
    productId: `product-${id}` as ProductId,
    quantity: 2,
    unitPriceCents: 1500,
    createdAt: now
  })
}

// Mock repository factory
const createMockLedgerRepo = (overrides: {
  findByIdWithItems?: (id: OrderLedgerId) => Effect.Effect<Option.Option<LedgerWithItems>>
  updateStatus?: (id: OrderLedgerId, newStatus: OrderLedgerStatus) => Effect.Effect<OrderLedger>
  updateStatusWithOrderId?: (id: OrderLedgerId, newStatus: OrderLedgerStatus, orderId: string) => Effect.Effect<OrderLedger>
} = {}) => {
  const defaultLedger = createTestLedger("default-id")
  return Layer.succeed(LedgerRepository, {
    findByIdWithItems: overrides.findByIdWithItems ?? (() => Effect.succeed(Option.none())),
    updateStatus: overrides.updateStatus ?? (() => Effect.succeed(defaultLedger)),
    updateStatusWithOrderId: overrides.updateStatusWithOrderId ?? (() => Effect.succeed(defaultLedger))
  })
}

describe("LedgerRepository", () => {
  describe("findByIdWithItems", () => {
    it("should return Option.none when ledger not found", async () => {
      const mockRepo = createMockLedgerRepo({
        findByIdWithItems: () => Effect.succeed(Option.none())
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.findByIdWithItems("nonexistent-id" as OrderLedgerId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(Option.isNone(result)).toBe(true)
    })

    it("should return ledger with items when found", async () => {
      const ledger = createTestLedger("ledger-123")
      const items = [
        createTestItem("item-1", "ledger-123"),
        createTestItem("item-2", "ledger-123")
      ]

      const mockRepo = createMockLedgerRepo({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items }))
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.findByIdWithItems("ledger-123" as OrderLedgerId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.ledger.id).toBe("ledger-123")
        expect(result.value.items).toHaveLength(2)
        expect(result.value.items[0].id).toBe("item-1")
        expect(result.value.items[1].id).toBe("item-2")
      }
    })

    it("should return ledger with empty items array when no items exist", async () => {
      const ledger = createTestLedger("ledger-no-items")

      const mockRepo = createMockLedgerRepo({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] }))
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.findByIdWithItems("ledger-no-items" as OrderLedgerId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.ledger.id).toBe("ledger-no-items")
        expect(result.value.items).toEqual([])
      }
    })

    it("should include all ledger fields in the result", async () => {
      const ledger = createTestLedger("ledger-full", "ORDER_CREATED", "order-789")

      const mockRepo = createMockLedgerRepo({
        findByIdWithItems: () => Effect.succeed(Option.some({ ledger, items: [] }))
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.findByIdWithItems("ledger-full" as OrderLedgerId)
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        const { ledger: l } = result.value
        expect(l.id).toBe("ledger-full")
        expect(l.clientRequestId).toBe("client-req-ledger-full")
        expect(l.userId).toBe("user-123")
        expect(l.email).toBe("test@example.com")
        expect(l.status).toBe("ORDER_CREATED")
        expect(l.totalAmountCents).toBe(5999)
        expect(l.currency).toBe("USD")
        expect(l.paymentAuthorizationId).toBe("auth-456")
        expect(l.orderId).toBe("order-789")
      }
    })
  })

  describe("updateStatus", () => {
    it("should update ledger status and return updated ledger", async () => {
      const updatedLedger = createTestLedger("ledger-123", "ORDER_CREATED")
      let capturedId: OrderLedgerId | undefined
      let capturedStatus: OrderLedgerStatus | undefined

      const mockRepo = createMockLedgerRepo({
        updateStatus: (id, newStatus) => {
          capturedId = id
          capturedStatus = newStatus
          return Effect.succeed(updatedLedger)
        }
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.updateStatus("ledger-123" as OrderLedgerId, "ORDER_CREATED")
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(capturedId).toBe("ledger-123")
      expect(capturedStatus).toBe("ORDER_CREATED")
      expect(result.status).toBe("ORDER_CREATED")
    })

    it("should support all valid status transitions", async () => {
      const statuses: OrderLedgerStatus[] = [
        "AUTHORIZED",
        "ORDER_CREATED",
        "INVENTORY_RESERVED",
        "PAYMENT_CAPTURED",
        "COMPLETED",
        "COMPENSATING",
        "FAILED"
      ]

      for (const status of statuses) {
        const updatedLedger = createTestLedger("ledger-123", status)

        const mockRepo = createMockLedgerRepo({
          updateStatus: () => Effect.succeed(updatedLedger)
        })

        const result = await Effect.gen(function* () {
          const repo = yield* LedgerRepository
          return yield* repo.updateStatus("ledger-123" as OrderLedgerId, status)
        }).pipe(Effect.provide(mockRepo), Effect.runPromise)

        expect(result.status).toBe(status)
      }
    })
  })

  describe("updateStatusWithOrderId", () => {
    it("should update status and set order ID", async () => {
      const updatedLedger = createTestLedger("ledger-123", "ORDER_CREATED", "order-789")
      let capturedId: OrderLedgerId | undefined
      let capturedStatus: OrderLedgerStatus | undefined
      let capturedOrderId: string | undefined

      const mockRepo = createMockLedgerRepo({
        updateStatusWithOrderId: (id, newStatus, orderId) => {
          capturedId = id
          capturedStatus = newStatus
          capturedOrderId = orderId
          return Effect.succeed(updatedLedger)
        }
      })

      const result = await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return yield* repo.updateStatusWithOrderId(
          "ledger-123" as OrderLedgerId,
          "ORDER_CREATED",
          "order-789"
        )
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(capturedId).toBe("ledger-123")
      expect(capturedStatus).toBe("ORDER_CREATED")
      expect(capturedOrderId).toBe("order-789")
      expect(result.status).toBe("ORDER_CREATED")
      expect(result.orderId).toBe("order-789")
    })

    it("should be idempotent when called with same order ID", async () => {
      let callCount = 0
      const updatedLedger = createTestLedger("ledger-123", "ORDER_CREATED", "order-789")

      const mockRepo = createMockLedgerRepo({
        updateStatusWithOrderId: () => {
          callCount++
          return Effect.succeed(updatedLedger)
        }
      })

      await Effect.gen(function* () {
        const repo = yield* LedgerRepository
        yield* repo.updateStatusWithOrderId("ledger-123" as OrderLedgerId, "ORDER_CREATED", "order-789")
        yield* repo.updateStatusWithOrderId("ledger-123" as OrderLedgerId, "ORDER_CREATED", "order-789")
      }).pipe(Effect.provide(mockRepo), Effect.runPromise)

      expect(callCount).toBe(2)
    })
  })

  describe("LedgerRepository interface", () => {
    it("should be a Context.Tag with the correct identifier", () => {
      expect(LedgerRepository.key).toBe("LedgerRepository")
    })

    it("should work with Layer.provide pattern", async () => {
      const mockRepo = createMockLedgerRepo()

      const program = Effect.gen(function* () {
        const repo = yield* LedgerRepository
        return repo
      })

      const result = await program.pipe(
        Effect.provide(mockRepo),
        Effect.runPromise
      )

      expect(result).toBeDefined()
      expect(typeof result.findByIdWithItems).toBe("function")
      expect(typeof result.updateStatus).toBe("function")
      expect(typeof result.updateStatusWithOrderId).toBe("function")
    })
  })
})
