# ecommerce-services-demo

This is a demo project of an ecommerce backend system meant to learn Typescript and the Effect ecosystem as well as practice some design patterns like:

1. Distributed Saga
2. Event Outbox
3. Concurrency controls with PostgresQL

The system will have a few components:

1. An Edge API
    For registering user order requests, getting inital payment authorization from the payment service (the actual payment will be faked) and persisting the request in a ledger for durability.
2. A Payment service
    That will fake payment actions to a 3rd party payment processor and will include randomized failures.
3. An Order Service
    For registering orders against a limited set of products.
4. An Inventory Service
    For managing inventory of each product including concurrency guards to prevent overallocation.
4. A Saga Orchestrator
    For ensuring that processing an order submission works in a safe way without losing events.

For more details see [engineering-design](engineering-design.md).

## Getting Started

### Prerequisites

- Node.js 22+
- Docker and Docker Compose

### Running with Docker Compose

The easiest way to run the entire stack:

```bash
# Remove any existing data (to ensure migrations run)
docker-compose down -v

# Build and start all services
docker-compose up --build
```

This starts:
- **PostgreSQL** on port 5432 (migrations run automatically on first start)
- **Grafana LGTM** on port 3005 (logs, traces, metrics)
- **Edge API** on port 3000
- **Inventory Service** on port 3001

### Running for Local Development

If you prefer to run services locally with hot reload:

```bash
# 1. Install dependencies
npm install

# 2. Start PostgreSQL only
docker-compose up postgres -d

# 3. Run migrations (first time only)
psql postgres://ecommerce:ecommerce@localhost:5432/ecommerce -f migrations/001_create_products.sql

# 4. Start a service in dev mode
npm run dev:inventory    # Inventory service on port 3001
npm run dev:edge-api     # Edge API on port 3000
```

### Testing the Inventory Service

```bash
# Create a product
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget Pro",
    "sku": "WIDGET-PRO-001",
    "priceCents": 2999,
    "initialStock": 100
  }'

# Health check
curl http://localhost:3001/health
```

### Running Tests

```bash
# Run tests for the inventory service
npm test --workspace=@ecommerce/inventory

# Run with coverage
npm run test:coverage --workspace=@ecommerce/inventory

# Type check all services
npm run typecheck
```

### Observability

The stack includes a Grafana LGTM (Loki, Grafana, Tempo, Mimir) container for observability:

- **Grafana UI**: http://localhost:3005 (no login required)
- **Logs**: View in Grafana → Explore → Loki
- **Traces**: View in Grafana → Explore → Tempo
- **Metrics**: View in Grafana → Explore → Prometheus

Services export telemetry via OpenTelemetry Protocol (OTLP) to the observability container.