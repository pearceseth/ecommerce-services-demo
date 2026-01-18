# Notes

This is a WIP. This is meant to showcase some design patterns and to learn Typescript but that leads to some things that should be pointed out.

1. The systems are split into microservices but share a common database for convenience. Depending on scale and ***budget*** a real system ***might*** want to have a DB per application for the sake of scaling and data segregation. However, this is often a premature optimization. 
2. Most services are running on a single pod and reference each other directly. There are no load balancers and so no concept here of multiple pods per service (each service is stateless). In a real system each service would use multiple pods to achieve high-availability. 
3. There is a tradeoff in the way this is built. The user experience is submit a purchase request and get a quick response that only fails if payment authorization fails. If there is an issue fullfilling the order, i.e. there is insufficient stock, this occurs asychronously and a user would need to be notified, presumably via email. That is left unimplemented here.  Some business rules might instead opt for the request to fail ***synchronously*** if there is insufficient stock instead so that the customer would see the issue in a UI when sumbitting the purchse request.
4. There are no user login or authN/authZ here to keep things simple and would make a good expansion point later. Having users logged in before submitting a purchase request tells the backend their identity securely. The same mechanism could be used on the backend to authorize admin endpoints.

# Engineering Design Document: E-Commerce Order Processing System

## 1. System Overview

### 1.1 Purpose and Scope

This system is an e-commerce order processing backend that handles the complete order lifecycle: receiving customer orders, authorizing payments, reserving inventory, capturing payments, and confirming orders. The system is designed to demonstrate production-grade distributed systems patterns while maintaining simplicity appropriate for a portfolio project.

### 1.2 Portfolio Demonstration Goals

This project showcases three key distributed systems patterns:

1. **Saga Orchestrator Pattern** - Coordinating distributed transactions across multiple services with compensating actions for rollback
2. **Transactional Outbox Pattern** - Ensuring reliable event publishing with exactly-once semantics using PostgreSQL
3. **Concurrency Control** - Preventing inventory oversell using PostgreSQL's `SELECT FOR UPDATE` pessimistic locking

### 1.3 Key Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Idempotency** | All operations use `client_request_id` to prevent duplicate processing |
| **Durability** | Ledger-first pattern ensures requests survive crashes |
| **Consistency** | Saga orchestrator guarantees all-or-nothing semantics |
| **Observability** | Structured logging and state transitions enable debugging |

### 1.4 Technology Stack

- **Runtime**: Node.js 22 LTS
- **Language**: TypeScript with Effect.js
- **Database**: PostgreSQL 18
- **Containerization**: Docker with multi-stage builds
- **Event Relay**: PostgreSQL LISTEN/NOTIFY
- **Observability**: Grafana LGTM stack (Loki, Grafana, Tempo, Prometheus)
- **Telemetry**: OpenTelemetry via `@effect/opentelemetry`

---

## 2. Service Architecture

The system consists of five services, each with distinct responsibilities:

```mermaid
graph TB
    Client[Client] --> EdgeAPI[Edge API]
    EdgeAPI --> |writes| DB[(PostgreSQL)]
    EdgeAPI --> |NOTIFY| Orchestrator[Orchestrator Service]
    Orchestrator --> OrdersService[Orders Service]
    Orchestrator --> InventoryService[Inventory Service]
    Orchestrator --> PaymentsService[Payments Service]
    OrdersService --> DB
    InventoryService --> DB
    PaymentsService --> DB
    Orchestrator --> DB
```

### 2.1 Edge API

**Responsibility**: Entry point for all client requests. Handles validation, idempotency, and payment authorization.

| Capability | Description |
|------------|-------------|
| Request validation | Validates order structure, product IDs, quantities |
| Idempotency | Deduplicates requests using `client_request_id` |
| Ledger writes | Creates durable record before any processing |
| Payment authorization | Synchronously authorizes payment (holds funds) |
| Outbox publishing | Writes event to outbox table atomically with ledger update |

**Does NOT**: Create orders, reserve inventory, or capture payments.

### 2.2 Orchestrator Service

**Responsibility**: Executes sagas by coordinating service calls and managing compensations on failure.

| Capability | Description |
|------------|-------------|
| Event listening | Subscribes to PostgreSQL NOTIFY for new authorized orders |
| Saga execution | Steps through saga states: create order → reserve inventory → capture payment → confirm |
| Compensation | On failure, executes compensating actions in reverse order |
| Retry logic | Exponential backoff for transient failures |
| State persistence | Updates ledger status at each step |
| Horizontal scaling | Multiple instances safely consume events via `SELECT FOR UPDATE SKIP LOCKED` |

### 2.3 Orders Service

**Responsibility**: Manages order records and their lifecycle states.

| Capability | Description |
|------------|-------------|
| Create order | Creates order record from ledger entry |
| Update status | Transitions order through states (CREATED → CONFIRMED / CANCELLED) |
| Cancel order | Marks order as cancelled (compensation) |
| Idempotent operations | Create/cancel are safe to retry |

### 2.4 Inventory Service

**Responsibility**: Manages product stock and reservations with concurrency control.

| Capability | Description |
|------------|-------------|
| Add stock | Increases product inventory with audit trail and idempotency |
| Create product | Adds new products to catalog with optional initial stock |
| Reserve stock | Atomically decrements stock and creates reservation record |
| Release stock | Returns reserved quantity to available stock (compensation) |
| Concurrency control | Uses `SELECT FOR UPDATE` to prevent oversell |
| Stock queries | Returns current availability |

### 2.5 Payments Service (Mock)

**Responsibility**: Simulates payment gateway operations for testing saga flows.

| Capability | Description |
|------------|-------------|
| Authorize | Holds funds on customer payment method |
| Capture | Converts authorization to actual charge |
| Void | Releases authorization hold (compensation) |
| Configurable behavior | Adjustable latency and failure rates for testing |

---

## 3. Database Design

All services share a single PostgreSQL instance with clear table ownership boundaries.

### 3.1 Entity-Relationship Diagram

```mermaid
erDiagram
    order_ledger ||--o{ order_ledger_items : contains
    order_ledger ||--o| orders : creates
    order_ledger ||--o{ outbox : publishes
    orders ||--o{ order_items : contains
    products ||--o{ order_ledger_items : references
    products ||--o{ order_items : references
    products ||--o{ inventory_reservations : has
    products ||--o{ inventory_adjustments : tracks
    orders ||--o{ inventory_reservations : reserves

    order_ledger {
        uuid id PK
        string client_request_id UK
        uuid user_id
        string email
        string status
        int total_amount_cents
        string currency
        string payment_authorization_id
        int retry_count
        timestamp next_retry_at
        timestamp created_at
        timestamp updated_at
    }

    order_ledger_items {
        uuid id PK
        uuid order_ledger_id FK
        uuid product_id FK
        int quantity
        int unit_price_cents
        timestamp created_at
    }

    orders {
        uuid id PK
        uuid order_ledger_id FK
        uuid user_id
        string status
        int total_amount_cents
        string currency
        timestamp created_at
        timestamp updated_at
    }

    order_items {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        int unit_price_cents
        timestamp created_at
    }

    products {
        uuid id PK
        string name
        string sku UK
        int price_cents
        int stock_quantity
        timestamp created_at
        timestamp updated_at
    }

    inventory_reservations {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        string status
        timestamp created_at
        timestamp released_at
    }

    inventory_adjustments {
        uuid id PK
        string idempotency_key UK
        uuid product_id FK
        int quantity_change
        int previous_quantity
        int new_quantity
        string reason
        string reference_id
        text notes
        string created_by
        timestamp created_at
    }

    outbox {
        uuid id PK
        string aggregate_type
        uuid aggregate_id
        string event_type
        jsonb payload
        string status
        timestamp created_at
        timestamp processed_at
    }
```

### 3.2 Table Ownership

| Service | Owned Tables |
|---------|--------------|
| Edge API | `order_ledger`, `order_ledger_items`, `outbox` |
| Orders Service | `orders`, `order_items` |
| Inventory Service | `products`, `inventory_reservations`, `inventory_adjustments` |
| Payments Service | None (stateless mock) |

### 3.3 Monetary Values: Integer Cents

All monetary amounts (prices, totals) are stored as **integers representing cents** rather than decimal types.

| Design Choice | Rationale |
|---------------|-----------|
| **PostgreSQL DECIMAL is exact** | Unlike floating-point, `DECIMAL`/`NUMERIC` has no precision issues in the database |
| **JavaScript has floating-point risk** | JS `number` is IEEE 754 double-precision; `0.1 + 0.2 = 0.30000000000000004` |
| **Integer cents eliminate risk** | All arithmetic stays in integer domain—no precision traps in application code |
| **Payment API compatibility** | Stripe, Square, and most payment APIs use cents; no conversion needed |
| **Simplicity** | No need for `decimal.js` or `BigInt` libraries in TypeScript |

**Convention**: All `_amount` and `_price` columns store values in the smallest currency unit (cents for USD). For example, `$99.99` is stored as `9999`.

**Display formatting** happens only at API boundaries:
```typescript
const formatCurrency = (cents: number, currency = "USD"): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency })
    .format(cents / 100)
```

### 3.4 Schema Definitions

#### `order_ledger`
```sql
CREATE TABLE order_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_request_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AWAITING_AUTHORIZATION',
    total_amount_cents INT NOT NULL,  -- stored in cents (e.g., 9999 = $99.99)
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_authorization_id VARCHAR(255),
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_ledger_status ON order_ledger(status);
CREATE INDEX idx_order_ledger_next_retry ON order_ledger(next_retry_at) WHERE status IN ('AUTHORIZED', 'COMPENSATING');
```

#### `order_ledger_items`
```sql
CREATE TABLE order_ledger_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL REFERENCES order_ledger(id),
    product_id UUID NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,  -- stored in cents
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_ledger_items_ledger ON order_ledger_items(order_ledger_id);
```

#### `products`
```sql
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100) NOT NULL UNIQUE,
    price_cents INT NOT NULL,  -- stored in cents (e.g., 2999 = $29.99)
    stock_quantity INT NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

#### `inventory_reservations`
```sql
CREATE TABLE inventory_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INT NOT NULL CHECK (quantity > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    released_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(order_id, product_id)
);

CREATE INDEX idx_inventory_reservations_order ON inventory_reservations(order_id);
CREATE INDEX idx_inventory_reservations_status ON inventory_reservations(status);
```

#### `inventory_adjustments`
```sql
CREATE TABLE inventory_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    product_id UUID NOT NULL REFERENCES products(id),
    quantity_change INT NOT NULL,
    previous_quantity INT NOT NULL,
    new_quantity INT NOT NULL,
    reason VARCHAR(50) NOT NULL,
    reference_id VARCHAR(255),
    notes TEXT,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_adjustments_product ON inventory_adjustments(product_id);
CREATE INDEX idx_inventory_adjustments_created ON inventory_adjustments(created_at);
CREATE INDEX idx_inventory_adjustments_reason ON inventory_adjustments(reason);
```

#### `orders`
```sql
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL UNIQUE REFERENCES order_ledger(id),
    user_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    total_amount_cents INT NOT NULL,  -- stored in cents
    currency VARCHAR(3) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

#### `order_items`
```sql
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    product_id UUID NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,  -- stored in cents
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
```

#### `outbox`
```sql
CREATE TABLE outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_outbox_pending ON outbox(created_at) WHERE status = 'PENDING';
```

---

## 4. Saga Orchestrator Design

### 4.1 State Machine

```mermaid
stateDiagram-v2
    [*] --> AWAITING_AUTHORIZATION: Order submitted
    AWAITING_AUTHORIZATION --> AUTHORIZED: Payment authorized
    AWAITING_AUTHORIZATION --> AUTHORIZATION_FAILED: Authorization declined
    AUTHORIZATION_FAILED --> [*]

    AUTHORIZED --> ORDER_CREATED: Order created
    ORDER_CREATED --> INVENTORY_RESERVED: Stock reserved
    INVENTORY_RESERVED --> PAYMENT_CAPTURED: Payment captured
    PAYMENT_CAPTURED --> COMPLETED: Order confirmed
    COMPLETED --> [*]

    AUTHORIZED --> COMPENSATING: Create order failed
    ORDER_CREATED --> COMPENSATING: Reserve inventory failed
    INVENTORY_RESERVED --> COMPENSATING: Capture payment failed

    COMPENSATING --> FAILED: Compensation complete
    FAILED --> [*]
```

### 4.2 Saga Steps

| Step | Action | Compensation | Idempotency Key |
|------|--------|--------------|-----------------|
| 1 | Create order | Cancel order | `order_ledger_id` |
| 2 | Reserve inventory | Release inventory | `order_id + product_id` |
| 3 | Capture payment | Void/refund payment | `payment_authorization_id` |
| 4 | Confirm order | (none - final step) | `order_id` |

### 4.3 Step Execution Logic

Each saga step follows this pattern:

```
1. Check if step already completed (idempotency)
2. Execute the step
3. Update ledger status
4. Write outbox event (if applicable)
5. On failure:
   a. If transient: increment retry_count, set next_retry_at
   b. If permanent or max retries exceeded: transition to COMPENSATING
```

### 4.4 Compensation Execution

When entering `COMPENSATING` state:

```
1. Determine last successful step from ledger status
2. Execute compensations in reverse order:
   - If INVENTORY_RESERVED: void payment → release inventory → cancel order
   - If ORDER_CREATED: void payment → cancel order
   - If AUTHORIZED: void payment
3. Mark ledger as FAILED
```

### 4.5 Retry Policy

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 second |
| 3 | 4 seconds |
| 4 | 16 seconds |
| 5 | 64 seconds |
| 6+ | Mark as FAILED, begin compensation |

Formula: `delay = 4^(attempt - 2)` seconds (min 1s, max 5 attempts)

---

## 5. Outbox Pattern Implementation

### 5.1 Atomic Write Pattern

When the Edge API authorizes a payment, it performs a single transaction:

```sql
BEGIN;

-- Update ledger status
UPDATE order_ledger
SET status = 'AUTHORIZED',
    payment_authorization_id = $1,
    updated_at = NOW()
WHERE id = $2;

-- Write outbox event
INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
VALUES ('order_ledger', $2, 'OrderAuthorized', $3);

-- Notify listeners
NOTIFY order_events, 'OrderAuthorized';

COMMIT;
```

This ensures the event is only published if the business operation succeeds.

### 5.2 PostgreSQL LISTEN/NOTIFY

The orchestrator subscribes to notifications:

```typescript
// Orchestrator startup
await sql`LISTEN order_events`

// On notification
connection.on('notification', async (msg) => {
  if (msg.channel === 'order_events') {
    await processOutboxEvents()
  }
})
```

### 5.3 Event Relay Process

```
1. LISTEN for notifications on 'order_events' channel
2. On notification or poll interval:
   a. Claim pending events using SELECT FOR UPDATE SKIP LOCKED
   b. For each claimed event:
      - Process the event (execute saga step)
      - UPDATE outbox SET status = 'PROCESSED', processed_at = NOW()
   c. COMMIT to release locks
   d. If more pending events exist, continue processing
3. Also poll periodically (every 5s) as backup for missed notifications
```

### 5.4 Horizontal Scaling with SKIP LOCKED

Multiple orchestrator instances can safely consume from the same outbox using `SELECT FOR UPDATE SKIP LOCKED`:

```sql
BEGIN;

-- Claim a batch of work, skipping rows locked by other instances
SELECT * FROM outbox
WHERE status = 'PENDING'
ORDER BY created_at
LIMIT 10
FOR UPDATE SKIP LOCKED;

-- Process each event...

-- Mark as processed
UPDATE outbox
SET status = 'PROCESSED', processed_at = NOW()
WHERE id = ANY($1);

COMMIT;
```

**How the three mechanisms work together:**

| Mechanism | Purpose | Behavior |
|-----------|---------|----------|
| `NOTIFY` | Low latency | Wakes up all listening orchestrators immediately |
| `SELECT FOR UPDATE SKIP LOCKED` | Safe concurrency | Each event claimed by exactly one instance |
| Polling (every 5s) | Reliability | Catches events if NOTIFY was missed |

**Concurrent consumption example:**

```
NOTIFY fires → Both orchestrators wake up
                    ↓
    ┌───────────────────────────────────┐
    │ Orchestrator A    Orchestrator B  │
    │       ↓                 ↓         │
    │   SELECT FOR UPDATE SKIP LOCKED   │
    │       ↓                 ↓         │
    │   Claims event #1   Event #1 locked, skips
    │       ↓                 ↓         │
    │   Processes #1      Claims event #2 (if any)
    │       ↓                 ↓         │
    │   COMMIT            Processes #2  │
    └───────────────────────────────────┘
```

**Why NOTIFY is still valuable:**
- Without NOTIFY: orchestrators poll every 5 seconds → average 2.5s latency
- With NOTIFY: orchestrators wake immediately → sub-second latency
- NOTIFY is an optimization; SKIP LOCKED ensures correctness

### 5.5 Delivery Guarantees

| Guarantee | How Achieved |
|-----------|--------------|
| At-least-once | Events stay in outbox until processed; retries on failure |
| Ordering | Process by `created_at` ascending within aggregate |
| No duplicates | Saga steps are idempotent; safe to replay |
| No double-processing | `SELECT FOR UPDATE SKIP LOCKED` ensures single claim |

---

## 6. Concurrency Control

### 6.1 The Oversell Problem

Without concurrency control, two concurrent requests for the last item could both succeed:

```
Time    Transaction A              Transaction B
─────────────────────────────────────────────────
T1      SELECT stock (1 item)
T2                                 SELECT stock (1 item)
T3      UPDATE stock = 0
T4                                 UPDATE stock = -1  ← OVERSELL!
```

### 6.2 SELECT FOR UPDATE Solution

```sql
BEGIN;

-- Lock the product row
SELECT stock_quantity
FROM products
WHERE id = $1
FOR UPDATE;

-- Check availability
-- If sufficient, decrement and create reservation
UPDATE products
SET stock_quantity = stock_quantity - $2,
    updated_at = NOW()
WHERE id = $1
  AND stock_quantity >= $2;

-- Check if update succeeded (affected 1 row)
-- If yes, create reservation record
INSERT INTO inventory_reservations (order_id, product_id, quantity, status)
VALUES ($3, $1, $2, 'RESERVED');

COMMIT;
```

With `FOR UPDATE`, Transaction B blocks until Transaction A commits:

```
Time    Transaction A              Transaction B
─────────────────────────────────────────────────
T1      SELECT FOR UPDATE (1 item)
T2                                 SELECT FOR UPDATE (blocks...)
T3      UPDATE stock = 0
T4      COMMIT
T5                                 (unblocks, sees 0 items)
T6                                 ROLLBACK (insufficient stock)
```

### 6.3 Multi-Item Orders

For orders with multiple products, lock rows in consistent order to prevent deadlocks:

```sql
-- Always lock products in ID order
SELECT id, stock_quantity
FROM products
WHERE id = ANY($1)
ORDER BY id
FOR UPDATE;
```

### 6.4 Transaction Isolation

| Setting | Value | Reason |
|---------|-------|--------|
| Isolation level | READ COMMITTED | Default, sufficient with explicit locking |
| Lock timeout | 5 seconds | Fail fast if contention is high |

---

## 7. Request Flow

### 7.1 Happy Path

```mermaid
sequenceDiagram
    participant Client
    participant EdgeAPI
    participant DB
    participant Orchestrator
    participant Orders
    participant Inventory
    participant Payments

    Client->>EdgeAPI: POST /orders
    EdgeAPI->>DB: Insert order_ledger (AWAITING_AUTH)
    EdgeAPI->>Payments: Authorize payment
    Payments-->>EdgeAPI: Authorization ID
    EdgeAPI->>DB: Update ledger (AUTHORIZED) + Insert outbox
    DB-->>Orchestrator: NOTIFY order_events
    EdgeAPI-->>Client: 202 Accepted (order_id)

    Note over Orchestrator: Saga begins
    Orchestrator->>DB: SELECT FROM outbox FOR UPDATE SKIP LOCKED
    Orchestrator->>Orders: Create order
    Orders->>DB: Insert order
    Orders-->>Orchestrator: Order created
    Orchestrator->>DB: Update ledger (ORDER_CREATED)

    Orchestrator->>Inventory: Reserve stock
    Inventory->>DB: SELECT FOR UPDATE products
    Inventory->>DB: Decrement stock, insert reservation
    Inventory-->>Orchestrator: Reserved
    Orchestrator->>DB: Update ledger (INVENTORY_RESERVED)

    Orchestrator->>Payments: Capture payment
    Payments-->>Orchestrator: Captured
    Orchestrator->>DB: Update ledger (PAYMENT_CAPTURED)

    Orchestrator->>Orders: Confirm order
    Orders->>DB: Update order status (CONFIRMED)
    Orchestrator->>DB: Update ledger (COMPLETED)
```

### 7.2 Inventory Failure Path

```mermaid
sequenceDiagram
    participant Orchestrator
    participant DB
    participant Orders
    participant Inventory
    participant Payments

    Note over Orchestrator: Order created, now reserving...
    Orchestrator->>Inventory: Reserve stock
    Inventory->>DB: SELECT FOR UPDATE (0 available)
    Inventory-->>Orchestrator: Error: Insufficient stock

    Note over Orchestrator: Begin compensation
    Orchestrator->>DB: Update ledger (COMPENSATING)

    Orchestrator->>Payments: Void authorization
    Payments-->>Orchestrator: Voided

    Orchestrator->>Orders: Cancel order
    Orders->>DB: Update order (CANCELLED)
    Orders-->>Orchestrator: Cancelled

    Orchestrator->>DB: Update ledger (FAILED)
```

### 7.3 Payment Capture Failure Path

```mermaid
sequenceDiagram
    participant Orchestrator
    participant DB
    participant Orders
    participant Inventory
    participant Payments

    Note over Orchestrator: Inventory reserved, now capturing...
    Orchestrator->>Payments: Capture payment
    Payments-->>Orchestrator: Error: Card declined

    Note over Orchestrator: Begin compensation
    Orchestrator->>DB: Update ledger (COMPENSATING)

    Orchestrator->>Inventory: Release reservation
    Inventory->>DB: Update reservation (RELEASED)
    Inventory->>DB: Increment stock_quantity
    Inventory-->>Orchestrator: Released

    Orchestrator->>Orders: Cancel order
    Orders->>DB: Update order (CANCELLED)
    Orders-->>Orchestrator: Cancelled

    Orchestrator->>DB: Update ledger (FAILED)
```

---

## 8. API Contracts

### 8.1 Edge API

#### Create Order
```
POST /orders
Content-Type: application/json
Idempotency-Key: {client_request_id}

Request:
{
  "user_id": "uuid",
  "email": "customer@example.com",
  "items": [
    {
      "product_id": "uuid",
      "quantity": 2
    }
  ],
  "payment": {
    "method": "card",
    "token": "tok_xxx"
  }
}

Response (202 Accepted):
{
  "order_ledger_id": "uuid",
  "status": "AUTHORIZED",
  "message": "Order received, processing"
}

Response (402 Payment Required):
{
  "error": "payment_declined",
  "message": "Payment authorization failed"
}

Response (409 Conflict):
{
  "error": "duplicate_request",
  "order_ledger_id": "uuid",
  "status": "AUTHORIZED"
}
```

#### Get Order Status
```
GET /orders/{order_ledger_id}

Response (200 OK):
{
  "order_ledger_id": "uuid",
  "status": "COMPLETED",
  "order": {
    "id": "uuid",
    "items": [...],
    "total_amount_cents": 9999,  // $99.99 in cents
    "currency": "USD"
  }
}
```

### 8.2 Internal Service Interfaces

#### Orders Service
```
CreateOrder(order_ledger_id, user_id, items[]) → order_id
CancelOrder(order_id) → void
ConfirmOrder(order_id) → void
```

#### Inventory Service
```
AddStock(product_id, quantity, reason, idempotency_key, reference_id?, notes?) → adjustment
CreateProduct(name, sku, price_cents, initial_stock?) → product
ReserveStock(order_id, items[]) → reservation_ids[]
ReleaseStock(order_id) → void
GetAvailability(product_ids[]) → Map<product_id, quantity>
```

#### Payments Service (Mock)
```
Authorize(user_id, amount_cents, currency, token) → authorization_id
Capture(authorization_id) → capture_id
Void(authorization_id) → void
```

### 8.3 Inventory Service HTTP API

#### Add Stock
```
POST /inventory/products/{product_id}/stock
Content-Type: application/json
Idempotency-Key: {adjustment_request_id}

Request:
{
  "quantity": 100,
  "reason": "warehouse_receiving",  // warehouse_receiving | manual_adjustment | return_to_stock | correction
  "reference_id": "PO-2024-001",    // Optional: external reference (PO number, etc.)
  "notes": "Q1 restock shipment"    // Optional
}

Response (200 OK):
{
  "product_id": "uuid",
  "sku": "WIDGET-001",
  "previous_quantity": 50,
  "added_quantity": 100,
  "new_quantity": 150,
  "adjustment_id": "uuid",
  "created_at": "2024-01-15T10:30:00Z"
}

Response (404 Not Found):
{
  "error": "product_not_found",
  "message": "Product with ID {product_id} does not exist"
}

Response (409 Conflict - Idempotent Retry):
{
  "adjustment_id": "uuid",
  "message": "This adjustment was already processed",
  "previous_quantity": 50,
  "added_quantity": 100,
  "new_quantity": 150
}
```

#### Create Product
```
POST /inventory/products
Content-Type: application/json

Request:
{
  "name": "Widget Pro",
  "sku": "WIDGET-PRO-001",
  "price_cents": 2999,   // $29.99 in cents
  "initial_stock": 100   // Optional: defaults to 0
}

Response (201 Created):
{
  "id": "uuid",
  "name": "Widget Pro",
  "sku": "WIDGET-PRO-001",
  "price_cents": 2999,   // $29.99 in cents
  "stock_quantity": 100,
  "created_at": "2024-01-15T10:30:00Z"
}

Response (409 Conflict):
{
  "error": "duplicate_sku",
  "message": "Product with SKU WIDGET-PRO-001 already exists",
  "existing_product_id": "uuid"
}
```

---

## 9. Error Handling & Observability

### 9.1 Error Taxonomy

| Type | Examples | Handling |
|------|----------|----------|
| **Transient** | Network timeout, DB connection lost, 503 | Retry with exponential backoff |
| **Permanent** | Invalid product ID, insufficient stock, card declined | Fail immediately, compensate |
| **Bug** | Null pointer, schema mismatch | Log, alert, manual intervention |

### 9.2 Retry Behavior

```typescript
const isTransient = (error: Error): boolean => {
  return error instanceof NetworkError ||
         error instanceof TimeoutError ||
         (error instanceof HttpError && error.status >= 500)
}

const isPermanent = (error: Error): boolean => {
  return error instanceof InsufficientStockError ||
         error instanceof PaymentDeclinedError ||
         error instanceof ValidationError
}
```

### 9.3 Observability Stack Architecture

```mermaid
graph LR
    subgraph Services
        EdgeAPI[Edge API]
        Orchestrator[Orchestrator]
        Orders[Orders Service]
        Inventory[Inventory Service]
        Payments[Payments Service]
    end

    subgraph Grafana LGTM Stack
        OtelCollector[OpenTelemetry Collector]
        Loki[(Loki)]
        Tempo[(Tempo)]
        Prometheus[(Prometheus)]
        Grafana[Grafana UI]
    end

    EdgeAPI -->|OTLP| OtelCollector
    Orchestrator -->|OTLP| OtelCollector
    Orders -->|OTLP| OtelCollector
    Inventory -->|OTLP| OtelCollector
    Payments -->|OTLP| OtelCollector

    OtelCollector -->|logs| Loki
    OtelCollector -->|traces| Tempo
    OtelCollector -->|metrics| Prometheus

    Loki --> Grafana
    Tempo --> Grafana
    Prometheus --> Grafana
```

All services export telemetry via OpenTelemetry Protocol (OTLP) to a unified collector, which routes data to appropriate backends.

### 9.4 Effect Observability Integration

Effect provides first-class observability primitives that integrate with OpenTelemetry:

| Effect Feature | OpenTelemetry Mapping | Usage |
|----------------|----------------------|-------|
| `Effect.log*` | Logs → Loki | `Effect.logInfo("Order created")` |
| `Metric.counter` | Metrics → Prometheus | `ordersCreated.increment()` |
| `Metric.histogram` | Metrics → Prometheus | `sagaDuration.record(ms)` |
| `Effect.withSpan` | Traces → Tempo | `Effect.withSpan("reserveInventory")(effect)` |

**Required packages:**
```json
{
  "@effect/opentelemetry": "~0.x.x",
  "@opentelemetry/api": "^1.x.x",
  "@opentelemetry/exporter-trace-otlp-http": "^0.x.x",
  "@opentelemetry/exporter-metrics-otlp-http": "^0.x.x"
}
```

**Example: Instrumented saga step**
```typescript
import { Effect, Metric } from "effect"
import * as Otel from "@effect/opentelemetry"

const sagaStepDuration = Metric.histogram("saga_step_duration_seconds", {
  boundaries: [0.01, 0.05, 0.1, 0.5, 1, 5]
})

const reserveInventory = (orderId: string, items: Item[]) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Reserving inventory", { orderId, itemCount: items.length })

    const result = yield* inventoryService.reserve(orderId, items)

    yield* Effect.logInfo("Inventory reserved", { orderId, reservationIds: result })
    return result
  }).pipe(
    Effect.withSpan("reserveInventory", { attributes: { orderId } }),
    Metric.trackDuration(sagaStepDuration)
  )
```

### 9.5 Logging Strategy

All logs are structured JSON with consistent fields:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "orchestrator",
  "traceId": "abc123",
  "spanId": "def456",
  "order_ledger_id": "uuid",
  "saga_step": "reserve_inventory",
  "message": "Inventory reserved successfully",
  "duration_ms": 45
}
```

Key events to log:
- Saga step started/completed/failed
- Compensation started/completed
- Retry attempts
- State transitions

**Correlation**: All logs include `traceId` and `spanId` for correlation with distributed traces in Grafana.

### 9.6 Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `orders_created_total` | Counter | Orders entering the system |
| `orders_completed_total` | Counter | Successfully completed orders |
| `orders_failed_total` | Counter | Orders that failed and compensated |
| `saga_step_duration_seconds` | Histogram | Time per saga step |
| `inventory_reservation_failures` | Counter | Stock unavailable events |
| `payment_failures` | Counter | Payment declined/failed events |

### 9.7 Grafana LGTM Stack

The observability stack runs as a single Docker container for local development:

| Component | Purpose | Access |
|-----------|---------|--------|
| **Grafana** | Unified dashboard for logs, metrics, traces | http://localhost:3001 |
| **Loki** | Log aggregation and querying | (internal) |
| **Tempo** | Distributed trace storage | (internal) |
| **Prometheus** | Metrics storage and alerting | (internal) |
| **OTel Collector** | Receives OTLP from services | :4317 (gRPC), :4318 (HTTP) |

**Default credentials**: admin / admin

**Key Grafana features:**
- **Explore**: Query logs, metrics, and traces
- **Trace to logs**: Click a trace span to see correlated logs
- **Exemplars**: Jump from a metric spike to the exact trace that caused it

---

## 10. Deployment Architecture

### 10.1 Docker Compose Setup

```yaml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: ecommerce
      POSTGRES_USER: ecommerce
      POSTGRES_PASSWORD: ecommerce
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ecommerce"]
      interval: 5s
      timeout: 5s
      retries: 5

  observability:
    image: grafana/otel-lgtm:latest
    ports:
      - "3001:3000"   # Grafana UI
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin

  edge-api:
    build: ./services/edge-api
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://ecommerce:ecommerce@postgres:5432/ecommerce
      OTEL_SERVICE_NAME: edge-api
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
    depends_on:
      postgres:
        condition: service_healthy
      observability:
        condition: service_started

  orchestrator:
    build: ./services/orchestrator
    environment:
      DATABASE_URL: postgres://ecommerce:ecommerce@postgres:5432/ecommerce
      OTEL_SERVICE_NAME: orchestrator
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
    depends_on:
      postgres:
        condition: service_healthy
      observability:
        condition: service_started
    deploy:
      replicas: 2  # Safe to scale horizontally via SKIP LOCKED

  orders-service:
    build: ./services/orders
    environment:
      DATABASE_URL: postgres://ecommerce:ecommerce@postgres:5432/ecommerce
      OTEL_SERVICE_NAME: orders-service
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
    depends_on:
      postgres:
        condition: service_healthy
      observability:
        condition: service_started

  inventory-service:
    build: ./services/inventory
    environment:
      DATABASE_URL: postgres://ecommerce:ecommerce@postgres:5432/ecommerce
      OTEL_SERVICE_NAME: inventory-service
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
    depends_on:
      postgres:
        condition: service_healthy
      observability:
        condition: service_started

  payments-service:
    build: ./services/payments
    environment:
      MOCK_LATENCY_MS: 100
      MOCK_FAILURE_RATE: 0.05
      OTEL_SERVICE_NAME: payments-service
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
    depends_on:
      observability:
        condition: service_started
```

### 10.2 Service Dependencies

```mermaid
graph TD
    DB[(PostgreSQL)]
    Obs[Grafana LGTM]
    EdgeAPI[Edge API]
    Orchestrator[Orchestrator]
    Orders[Orders Service]
    Inventory[Inventory Service]
    Payments[Payments Service]

    EdgeAPI --> DB
    EdgeAPI -.->|telemetry| Obs
    Orchestrator --> DB
    Orchestrator --> Orders
    Orchestrator --> Inventory
    Orchestrator --> Payments
    Orchestrator -.->|telemetry| Obs
    Orders --> DB
    Orders -.->|telemetry| Obs
    Inventory --> DB
    Inventory -.->|telemetry| Obs
    Payments -.->|telemetry| Obs
```

### 10.3 Health Checks

Each service exposes `GET /health`:

```json
{
  "status": "healthy",
  "database": "connected",
  "uptime_seconds": 3600
}
```

Docker Compose uses these for dependency ordering and restart policies.
