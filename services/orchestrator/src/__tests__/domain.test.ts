import { describe, it, expect } from "vitest"
import { Schema, DateTime } from "effect"
import { OutboxEvent, OutboxEventId, OutboxEventStatus, OrderAuthorizedPayload } from "../domain/OutboxEvent.js"
import { OrderLedger, OrderLedgerId, OrderLedgerStatus, OrderLedgerItem, UserId, ProductId } from "../domain/OrderLedger.js"
import { isValidTransition, SAGA_STEPS, getSagaStepIndex, VALID_TRANSITIONS } from "../domain/SagaState.js"
import {
  OrderCreationError,
  InventoryReservationError,
  PaymentCaptureError,
  OrderConfirmationError,
  ServiceConnectionError,
  InvalidStateTransitionError,
  LedgerNotFoundError,
  InvalidPayloadError
} from "../domain/errors.js"

describe("OutboxEvent", () => {
  describe("OutboxEventId", () => {
    it("should create a branded OutboxEventId", () => {
      const id = "test-event-id" as OutboxEventId
      expect(id).toBe("test-event-id")
    })
  })

  describe("OutboxEventStatus", () => {
    it("should accept valid statuses", () => {
      const decode = Schema.decodeUnknownSync(OutboxEventStatus)
      expect(decode("PENDING")).toBe("PENDING")
      expect(decode("PROCESSED")).toBe("PROCESSED")
      expect(decode("FAILED")).toBe("FAILED")
    })

    it("should reject invalid statuses", () => {
      const decode = Schema.decodeUnknownSync(OutboxEventStatus)
      expect(() => decode("INVALID")).toThrow()
    })
  })

  describe("OrderAuthorizedPayload", () => {
    it("should decode a valid payload", () => {
      const payload = {
        order_ledger_id: "ledger-123",
        user_id: "user-456",
        email: "test@example.com",
        total_amount_cents: 2999,
        currency: "USD",
        payment_authorization_id: "auth-789"
      }

      const result = Schema.decodeUnknownSync(OrderAuthorizedPayload)(payload)
      expect(result.order_ledger_id).toBe("ledger-123")
      expect(result.user_id).toBe("user-456")
      expect(result.email).toBe("test@example.com")
      expect(result.total_amount_cents).toBe(2999)
      expect(result.currency).toBe("USD")
      expect(result.payment_authorization_id).toBe("auth-789")
    })

    it("should reject payload missing required fields", () => {
      const incompletePayload = {
        order_ledger_id: "ledger-123",
        user_id: "user-456"
      }

      expect(() => Schema.decodeUnknownSync(OrderAuthorizedPayload)(incompletePayload)).toThrow()
    })
  })

  describe("OutboxEvent", () => {
    it("should create a valid OutboxEvent", () => {
      const now = DateTime.unsafeNow()
      const event = new OutboxEvent({
        id: "event-123" as OutboxEventId,
        aggregateType: "OrderLedger",
        aggregateId: "ledger-456",
        eventType: "OrderAuthorized",
        payload: { order_ledger_id: "ledger-456" },
        status: "PENDING",
        createdAt: now,
        processedAt: null,
        retryCount: 0,
        nextRetryAt: null
      })

      expect(event.id).toBe("event-123")
      expect(event.aggregateType).toBe("OrderLedger")
      expect(event.eventType).toBe("OrderAuthorized")
      expect(event.status).toBe("PENDING")
      expect(event.processedAt).toBeNull()
      expect(event.retryCount).toBe(0)
      expect(event.nextRetryAt).toBeNull()
    })
  })
})

describe("OrderLedger", () => {
  describe("OrderLedgerStatus", () => {
    it("should accept all valid statuses", () => {
      const decode = Schema.decodeUnknownSync(OrderLedgerStatus)
      const validStatuses = [
        "AWAITING_AUTHORIZATION",
        "AUTHORIZED",
        "AUTHORIZATION_FAILED",
        "ORDER_CREATED",
        "INVENTORY_RESERVED",
        "PAYMENT_CAPTURED",
        "COMPLETED",
        "COMPENSATING",
        "FAILED"
      ]

      validStatuses.forEach(status => {
        expect(decode(status)).toBe(status)
      })
    })

    it("should reject invalid statuses", () => {
      const decode = Schema.decodeUnknownSync(OrderLedgerStatus)
      expect(() => decode("INVALID_STATUS")).toThrow()
    })
  })

  describe("OrderLedger", () => {
    it("should create a valid OrderLedger", () => {
      const now = DateTime.unsafeNow()
      const ledger = new OrderLedger({
        id: "ledger-123" as OrderLedgerId,
        clientRequestId: "client-req-456",
        userId: "user-789" as UserId,
        email: "test@example.com",
        status: "AUTHORIZED",
        totalAmountCents: 5999,
        currency: "USD",
        paymentAuthorizationId: "auth-123",
        orderId: null,
        createdAt: now,
        updatedAt: now
      })

      expect(ledger.id).toBe("ledger-123")
      expect(ledger.status).toBe("AUTHORIZED")
      expect(ledger.totalAmountCents).toBe(5999)
      expect(ledger.orderId).toBeNull()
    })
  })

  describe("OrderLedgerItem", () => {
    it("should create a valid OrderLedgerItem", () => {
      const now = DateTime.unsafeNow()
      const item = new OrderLedgerItem({
        id: "item-123",
        orderLedgerId: "ledger-456" as OrderLedgerId,
        productId: "product-789" as ProductId,
        quantity: 2,
        unitPriceCents: 1500,
        createdAt: now
      })

      expect(item.id).toBe("item-123")
      expect(item.quantity).toBe(2)
      expect(item.unitPriceCents).toBe(1500)
    })

    it("should reject non-positive quantity", () => {
      const now = DateTime.unsafeNow()
      expect(() => new OrderLedgerItem({
        id: "item-123",
        orderLedgerId: "ledger-456" as OrderLedgerId,
        productId: "product-789" as ProductId,
        quantity: 0,
        unitPriceCents: 1500,
        createdAt: now
      })).toThrow()
    })
  })
})

describe("SagaState", () => {
  describe("isValidTransition", () => {
    it("should allow AUTHORIZED -> ORDER_CREATED", () => {
      expect(isValidTransition("AUTHORIZED", "ORDER_CREATED")).toBe(true)
    })

    it("should allow ORDER_CREATED -> INVENTORY_RESERVED", () => {
      expect(isValidTransition("ORDER_CREATED", "INVENTORY_RESERVED")).toBe(true)
    })

    it("should allow INVENTORY_RESERVED -> PAYMENT_CAPTURED", () => {
      expect(isValidTransition("INVENTORY_RESERVED", "PAYMENT_CAPTURED")).toBe(true)
    })

    it("should allow PAYMENT_CAPTURED -> COMPLETED", () => {
      expect(isValidTransition("PAYMENT_CAPTURED", "COMPLETED")).toBe(true)
    })

    it("should allow transitions to COMPENSATING from saga states", () => {
      expect(isValidTransition("AUTHORIZED", "COMPENSATING")).toBe(true)
      expect(isValidTransition("ORDER_CREATED", "COMPENSATING")).toBe(true)
      expect(isValidTransition("INVENTORY_RESERVED", "COMPENSATING")).toBe(true)
      expect(isValidTransition("PAYMENT_CAPTURED", "COMPENSATING")).toBe(true)
    })

    it("should disallow skipping states", () => {
      expect(isValidTransition("AUTHORIZED", "PAYMENT_CAPTURED")).toBe(false)
      expect(isValidTransition("ORDER_CREATED", "COMPLETED")).toBe(false)
    })

    it("should disallow transitions from terminal states", () => {
      expect(isValidTransition("COMPLETED", "ORDER_CREATED")).toBe(false)
      expect(isValidTransition("FAILED", "AUTHORIZED")).toBe(false)
      expect(isValidTransition("AUTHORIZATION_FAILED", "AUTHORIZED")).toBe(false)
    })

    it("should allow COMPENSATING -> FAILED", () => {
      expect(isValidTransition("COMPENSATING", "FAILED")).toBe(true)
    })
  })

  describe("SAGA_STEPS", () => {
    it("should have steps in correct order", () => {
      expect(SAGA_STEPS).toEqual([
        "ORDER_CREATED",
        "INVENTORY_RESERVED",
        "PAYMENT_CAPTURED",
        "COMPLETED"
      ])
    })
  })

  describe("getSagaStepIndex", () => {
    it("should return correct index for each step", () => {
      expect(getSagaStepIndex("ORDER_CREATED")).toBe(0)
      expect(getSagaStepIndex("INVENTORY_RESERVED")).toBe(1)
      expect(getSagaStepIndex("PAYMENT_CAPTURED")).toBe(2)
      expect(getSagaStepIndex("COMPLETED")).toBe(3)
    })

    it("should return -1 for non-saga-step statuses", () => {
      expect(getSagaStepIndex("AUTHORIZED")).toBe(-1)
      expect(getSagaStepIndex("COMPENSATING")).toBe(-1)
    })
  })

  describe("VALID_TRANSITIONS", () => {
    it("should have entries for all statuses", () => {
      const allStatuses = [
        "AWAITING_AUTHORIZATION",
        "AUTHORIZED",
        "AUTHORIZATION_FAILED",
        "ORDER_CREATED",
        "INVENTORY_RESERVED",
        "PAYMENT_CAPTURED",
        "COMPLETED",
        "COMPENSATING",
        "FAILED"
      ] as const

      allStatuses.forEach(status => {
        expect(VALID_TRANSITIONS[status]).toBeDefined()
        expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true)
      })
    })
  })
})

describe("Errors", () => {
  describe("OrderCreationError", () => {
    it("should create with all required fields", () => {
      const error = new OrderCreationError({
        orderLedgerId: "ledger-123",
        reason: "Order creation failed",
        statusCode: 500,
        isRetryable: true
      })

      expect(error._tag).toBe("OrderCreationError")
      expect(error.orderLedgerId).toBe("ledger-123")
      expect(error.reason).toBe("Order creation failed")
      expect(error.statusCode).toBe(500)
      expect(error.isRetryable).toBe(true)
    })

    it("should work without optional statusCode", () => {
      const error = new OrderCreationError({
        orderLedgerId: "ledger-123",
        reason: "Connection timeout",
        isRetryable: true
      })

      expect(error.statusCode).toBeUndefined()
    })
  })

  describe("InventoryReservationError", () => {
    it("should create with insufficient stock details", () => {
      const error = new InventoryReservationError({
        orderId: "order-123",
        reason: "Insufficient stock",
        statusCode: 409,
        isRetryable: false,
        insufficientStock: {
          productId: "product-456",
          productSku: "SKU-001",
          requested: 10,
          available: 5
        }
      })

      expect(error._tag).toBe("InventoryReservationError")
      expect(error.insufficientStock?.productId).toBe("product-456")
      expect(error.insufficientStock?.requested).toBe(10)
      expect(error.insufficientStock?.available).toBe(5)
    })
  })

  describe("PaymentCaptureError", () => {
    it("should create with all fields", () => {
      const error = new PaymentCaptureError({
        authorizationId: "auth-123",
        reason: "Authorization already voided",
        statusCode: 409,
        isRetryable: false
      })

      expect(error._tag).toBe("PaymentCaptureError")
      expect(error.authorizationId).toBe("auth-123")
      expect(error.isRetryable).toBe(false)
    })
  })

  describe("OrderConfirmationError", () => {
    it("should create with all fields", () => {
      const error = new OrderConfirmationError({
        orderId: "order-123",
        reason: "Order not found",
        statusCode: 404,
        isRetryable: false
      })

      expect(error._tag).toBe("OrderConfirmationError")
      expect(error.orderId).toBe("order-123")
    })
  })

  describe("ServiceConnectionError", () => {
    it("should create for each service type", () => {
      const ordersError = new ServiceConnectionError({
        service: "orders",
        operation: "createOrder",
        reason: "Connection refused",
        isRetryable: true
      })

      expect(ordersError._tag).toBe("ServiceConnectionError")
      expect(ordersError.service).toBe("orders")

      const inventoryError = new ServiceConnectionError({
        service: "inventory",
        operation: "reserveStock",
        reason: "Timeout",
        isRetryable: true
      })

      expect(inventoryError.service).toBe("inventory")

      const paymentsError = new ServiceConnectionError({
        service: "payments",
        operation: "capturePayment",
        reason: "DNS lookup failed",
        isRetryable: true
      })

      expect(paymentsError.service).toBe("payments")
    })
  })

  describe("InvalidStateTransitionError", () => {
    it("should create with transition details", () => {
      const error = new InvalidStateTransitionError({
        orderLedgerId: "ledger-123",
        fromStatus: "COMPLETED",
        toStatus: "ORDER_CREATED"
      })

      expect(error._tag).toBe("InvalidStateTransitionError")
      expect(error.fromStatus).toBe("COMPLETED")
      expect(error.toStatus).toBe("ORDER_CREATED")
    })
  })

  describe("LedgerNotFoundError", () => {
    it("should create with ledger id", () => {
      const error = new LedgerNotFoundError({
        orderLedgerId: "ledger-123"
      })

      expect(error._tag).toBe("LedgerNotFoundError")
      expect(error.orderLedgerId).toBe("ledger-123")
    })
  })

  describe("InvalidPayloadError", () => {
    it("should create with event details", () => {
      const error = new InvalidPayloadError({
        eventId: "event-123",
        eventType: "OrderAuthorized",
        reason: "Missing required field: user_id"
      })

      expect(error._tag).toBe("InvalidPayloadError")
      expect(error.eventId).toBe("event-123")
      expect(error.eventType).toBe("OrderAuthorized")
      expect(error.reason).toBe("Missing required field: user_id")
    })
  })
})
