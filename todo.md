# Implementation Tasks

## Inventory Service

### Setup
- [x] Create inventory service scaffold (hello world HTTP server with Effect.js)
- [x] Add database connection and health check endpoint
- [x] Restructure to recommended folder pattern (api/, domain/, services/, repositories/)
- [x] Create database migration for products, inventory_reservations, inventory_adjustments tables

### Endpoints
- [ ] POST /inventory/products - Create product with optional initial stock
- [ ] POST /inventory/products/{product_id}/stock - Add stock with idempotency
- [ ] GET /inventory/products/{product_id}/availability - Query stock availability
- [ ] POST /inventory/reserve - Reserve stock for order (SELECT FOR UPDATE)
- [ ] POST /inventory/release - Release reservation (compensation)

---

## Payments Service
_TODO: Add tasks_

## Orders Service
_TODO: Add tasks_

## Edge API
_TODO: Add tasks_

## Orchestrator Service
_TODO: Add tasks_
