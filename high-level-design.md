# System Architecture Summary: E-Commerce Order Processing with Asynchronous Inventory Reservation

## 1. Overview

This system processes customer orders using a combination of synchronous API operations and asynchronous workflow orchestration. The design ensures reliability, idempotency, and correctness across multiple services (Orders, Payments, Inventory) while maintaining a responsive user experience.

The architecture uses:
- A ledger-first pattern for durable request recording
- Synchronous payment authorization
- A polling-based saga orchestrator
- Asynchronous inventory reservation to prevent oversell
- A future upgrade path to a transactional outbox and event-driven orchestration

## 2. High-Level Request Flow

### Synchronous (User-Facing) Steps

1. User submits an order request.
2. API validates the request.
3. API writes a ledger entry with status `AWAITING_AUTHORIZATION`.
4. API calls the Payments Service to authorize payment.
5. If authorization succeeds:
   - API updates the ledger entry to `AUTHORIZED`.
   - API returns a success response ("Order received, processing").
6. If authorization fails:
   - API updates the ledger entry to `AUTHORIZATION_FAILED`.
   - API returns an error to the user.

### Asynchronous (Orchestrator-Driven) Steps

1. Orchestrator polls the ledger for entries with `status = AUTHORIZED`.
2. For each entry, the orchestrator executes the saga:
   - Create order in Orders Service.
   - Reserve inventory in Inventory Service.
   - Capture payment.
   - Confirm order.
3. On any failure, the orchestrator performs compensating actions:
   - Cancel order.
   - Release inventory.
   - Void or refund payment authorization.
4. Orchestrator updates the ledger entry to `COMPLETED` or `FAILED`.

## 3. Ledger Schema (Durable Inbox)

### Table: `order_ledger`

Stores the authoritative record of the user's order request.

| Column | Description |
|--------|-------------|
| `id` | Primary key (UUID) |
| `client_request_id` | Idempotency key (unique) |
| `user_id` | Customer placing the order |
| `status` | Workflow state (`AWAITING_AUTHORIZATION`, `AUTHORIZED`, `PROCESSING`, `COMPLETED`, `FAILED`) |
| `total_amount` | Total order cost at time of request |
| `currency` | Currency code |
| `created_at` | Timestamp |
| `updated_at` | Timestamp |

### Table: `order_ledger_items`

Stores line items associated with a ledger entry.

| Column | Description |
|--------|-------------|
| `id` | Primary key |
| `order_ledger_id` | FK to `order_ledger.id` |
| `product_id` | Product being ordered |
| `quantity` | Quantity requested |
| `unit_price` | Price snapshot at time of order |
| `created_at` | Timestamp |

## 4. Saga Orchestrator State Machine

### Primary States

- `AWAITING_AUTHORIZATION`
- `AUTHORIZED`
- `ORDER_CREATED`
- `INVENTORY_RESERVED`
- `PAYMENT_CAPTURED`
- `COMPLETED`

### Failure Path

- `COMPENSATING`
- `FAILED`

### Compensating Actions

- Cancel order in Orders Service
- Release inventory reservations
- Void or refund payment authorization

All saga steps and compensations are idempotent and retryable.

## 5. Inventory Model (Asynchronous Reservation)

### Tables Owned by Inventory Service

#### `products`

| Column | Description |
|--------|-------------|
| `id` | Product ID |
| `name` | Product name |
| `stock_quantity` | Current available stock |

#### `inventory_reservations`

| Column | Description |
|--------|-------------|
| `id` | Primary key |
| `order_id` | Associated order |
| `product_id` | Product being reserved |
| `quantity` | Quantity reserved |
| `status` | `RESERVED` or `RELEASED` |
| `created_at` | Timestamp |

### Reservation Behavior

1. Orchestrator calls `ReserveStock(orderId, items[])`.
2. Inventory Service performs an atomic check-and-decrement.
3. If reservation fails:
   - Orchestrator cancels the order.
   - Orchestrator voids the payment authorization.
   - Ledger entry is marked `FAILED`.

This prevents oversell without requiring synchronous locking or Redis-based seat reservations.

## 6. Payment Flow

### Authorization (Synchronous)

- Performed by the API before the saga begins.
- Ensures the user has valid payment and funds are held.

### Capture (Asynchronous)

- Performed by the orchestrator after inventory is successfully reserved.

### Compensation

- If inventory reservation fails → void authorization.
- If capture fails → release inventory and cancel order.

## 7. Orchestrator Polling (Initial Implementation)

The orchestrator periodically executes:

```sql
SELECT * FROM order_ledger WHERE status = 'AUTHORIZED';
```

This approach is:
- Simple
- Reliable
- Easy to implement
- Immune to lost events
- Ideal for a first version

## 8. Transactional Outbox (Future Upgrade Path)

### Table: `outbox`

| Column | Description |
|--------|-------------|
| `id` | Primary key |
| `aggregate_type` | e.g., `order_ledger` |
| `aggregate_id` | Ledger entry ID |
| `event_type` | e.g., `OrderAuthorized` |
| `payload` | JSON event body |
| `status` | `PENDING`, `SENT`, `FAILED` |
| `created_at` | Timestamp |
| `sent_at` | Timestamp |

### Purpose

- Ensures atomic write of business data + event.
- Enables reliable event-driven orchestration.
- Matches patterns used by large-scale systems (e.g., Shopify, Stripe).

## 9. Benefits of This Architecture

- Strong idempotency guarantees
- Crash-safe request handling
- No oversell due to atomic inventory reservation
- Clean separation of synchronous and asynchronous concerns
- Easy to evolve into a fully event-driven system
- Realistic and production-inspired design
