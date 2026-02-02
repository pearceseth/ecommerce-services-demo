# Implementation Tasks

## Inventory Service

### Setup
- [x] Create inventory service scaffold (hello world HTTP server with Effect.js)
- [x] Add database connection and health check endpoint
- [x] Restructure to recommended folder pattern (api/, domain/, services/, repositories/)
- [x] Create database migration for products, inventory_reservations, inventory_adjustments tables

### Endpoints
- [x] POST /inventory/products - Create product with optional initial stock
- [x] POST /inventory/products/{product_id}/stock - Add stock with idempotency
- [x] GET /inventory/products/{product_id}/availability - Query stock availability
- [x] POST /inventory/reservations - Reserve stock for order (SELECT FOR UPDATE)
- [x] DELETE /inventory/reservations/{order_id} - Release reservation (compensation)

---

## Payments Service (Mock)
_Stateless mock service - implement first for testing other services_

### Setup
- [x] Create payments service scaffold (hello world HTTP server with Effect.js)
- [x] Add configurable latency via MOCK_LATENCY_MS environment variable
- [x] Add configurable failure rate via MOCK_FAILURE_RATE environment variable

### Endpoints
- [x] POST /payments/authorize - Authorize payment, return authorization_id
- [x] POST /payments/capture/{authorization_id} - Capture authorized payment
- [x] POST /payments/void/{authorization_id} - Void authorization (compensation)

---

## Orders Service
_Manages order records and lifecycle states_

### Setup
- [x] Create orders service scaffold (hello world HTTP server with Effect.js)
- [x] Add database connection and health check endpoint
- [x] Restructure to recommended folder pattern (api/, domain/, services/, repositories/)
- [x] Create database migration for orders, order_items tables

### Endpoints
- [x] POST /orders - Create order from ledger entry (idempotent via order_ledger_id)
- [x] GET /orders/{order_id} - Get order details with items
- [x] PUT /orders/{order_id}/cancel - Cancel order (compensation, idempotent)
- [x] PUT /orders/{order_id}/confirm - Confirm order (final step, idempotent)

---

## Edge API
_Entry point for client requests - receives orders and authorizes payments_

### Setup
- [x] Add database connection and health check endpoint
- [x] Create database migration for order_ledger, order_ledger_items, outbox tables

### Endpoints
- [x] POST /orders - Validate, create ledger entry, authorize payment, write outbox event
- [x] GET /orders/{order_ledger_id} - Get order status and details

### Features
- [x] Idempotency using Idempotency-Key header (client_request_id)
- [x] Payment authorization via Payments Service (synchronous call)
- [x] Atomic outbox write with ledger update in single transaction
- [x] NOTIFY order_events after successful authorization

---

## Orchestrator Service
_Saga execution engine - implement last as it depends on all other services_

### Setup
- [ ] Create orchestrator service scaffold (Effect.js, no HTTP server needed)
- [ ] Add database connection for ledger and outbox access
- [ ] Implement LISTEN subscription for order_events channel
- [ ] Implement polling fallback (every 5s) for missed notifications

### Saga Execution
- [ ] Implement outbox event claiming with SELECT FOR UPDATE SKIP LOCKED
- [ ] Step 1: Create order via Orders Service
- [ ] Step 2: Reserve inventory via Inventory Service
- [ ] Step 3: Capture payment via Payments Service
- [ ] Step 4: Confirm order via Orders Service
- [ ] Update ledger status at each step

### Compensation Handling
- [ ] Detect permanent failures and transition to COMPENSATING state
- [ ] Execute compensations in reverse order based on last successful step
- [ ] Void payment authorization via Payments Service
- [ ] Release inventory reservation via Inventory Service
- [ ] Cancel order via Orders Service
- [ ] Mark ledger as FAILED after compensation complete

### Retry Logic
- [ ] Implement exponential backoff (1s, 4s, 16s, 64s) for transient failures
- [ ] Track retry_count and next_retry_at in ledger
- [ ] Transition to COMPENSATING after max retries exceeded (5 attempts)
