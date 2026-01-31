# Implementation Plan: Edge API - Database Connection, Health Check, and Migration Setup

# Status: COMPLETE

---

## Overview

Add database connection (PostgreSQL via `@effect/sql-pg`), a database-aware health check endpoint, and create database migrations for the `order_ledger`, `order_ledger_items`, and `outbox` tables. Restructure the service to follow the established folder pattern (`api/`, `domain/`, `services/`, `repositories/`) and add OpenTelemetry instrumentation, matching the patterns established by the Inventory and Orders services.

This plan covers the following `todo.md` items:
- **Edge API > Setup > Add database connection and health check endpoint**
- **Edge API > Setup > Create database migration for order_ledger, order_ledger_items, outbox tables**

---

## Prerequisites

- PostgreSQL 18 running (via `docker-compose up postgres`)
- Existing migration files 001-004 already exist in `/migrations/`
- The Edge API scaffold exists at `services/edge-api/` with a basic HTTP server

---

## Step 1: Install Dependencies

### 1.1 Add packages to `services/edge-api/package.json`

Add the following **dependencies** (matching versions from the Orders service `package.json`):

```json
{
  "dependencies": {
    "@effect/opentelemetry": "^0.60.0",
    "@effect/platform": "^0.94.0",
    "@effect/platform-node": "^0.104.0",
    "@effect/sql": "^0.49.0",
    "@effect/sql-pg": "^0.50.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-logs-otlp-http": "^0.210.0",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.210.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.210.0",
    "@opentelemetry/sdk-logs": "^0.210.0",
    "@opentelemetry/sdk-metrics": "^2.4.0",
    "@opentelemetry/sdk-node": "^0.210.0",
    "@opentelemetry/sdk-trace-node": "^2.4.0",
    "@opentelemetry/sdk-trace-web": "^2.4.0",
    "effect": "^3.19.0"
  }
}
```

Add the following **devDependencies**:

```json
{
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@vitest/coverage-v8": "^4.0.17",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.17"
  }
}
```

Add test scripts to the `scripts` section:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 1.2 Run `npm install` from the monorepo root

```bash
npm install
```

This will install dependencies for all workspaces including the new Edge API dependencies.

---

## Step 2: Create Database Migrations

### 2.1 Create `migrations/005_create_order_ledger.sql`

This migration creates the `order_ledger` and `order_ledger_items` tables as defined in `engineering-design.md` Section 3.4.

```sql
-- Order Ledger: Authoritative record of all order requests
-- Owned by Edge API - this is the durable record created before any processing
CREATE TABLE IF NOT EXISTS order_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_request_id VARCHAR(255) NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    email VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'AWAITING_AUTHORIZATION',
    total_amount_cents INT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_authorization_id VARCHAR(255),
    retry_count INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for orchestrator queries by status
CREATE INDEX IF NOT EXISTS idx_order_ledger_status ON order_ledger(status);

-- Index for retry scheduling
CREATE INDEX IF NOT EXISTS idx_order_ledger_next_retry ON order_ledger(next_retry_at)
    WHERE status IN ('AUTHORIZED', 'COMPENSATING');

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_order_ledger_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_ledger_updated_at_trigger ON order_ledger;
CREATE TRIGGER order_ledger_updated_at_trigger
    BEFORE UPDATE ON order_ledger
    FOR EACH ROW
    EXECUTE FUNCTION update_order_ledger_updated_at();
```

**Key design decisions:**
- `client_request_id` has a UNIQUE constraint for idempotency (prevents duplicate order processing)
- `status` tracks the saga state machine progression (see `engineering-design.md` Section 4.1)
- `total_amount_cents` stores monetary value in cents per project convention
- `retry_count` and `next_retry_at` support the orchestrator's retry logic
- Auto-updating `updated_at` trigger follows the Orders service pattern

### 2.2 Create `migrations/006_create_order_ledger_items.sql`

```sql
-- Order Ledger Items: Line items for each order request
-- Linked to order_ledger, captures what was ordered at submission time
CREATE TABLE IF NOT EXISTS order_ledger_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL REFERENCES order_ledger(id),
    product_id UUID NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fetching items by ledger entry
CREATE INDEX IF NOT EXISTS idx_order_ledger_items_ledger ON order_ledger_items(order_ledger_id);
```

**Key design decisions:**
- `product_id` is UUID but NOT a foreign key to `products` table. The Edge API does not own the products table (Inventory Service does). Cross-service references are intentionally not enforced at the DB level.
- `quantity` has a CHECK constraint to prevent zero or negative quantities
- `unit_price_cents` captures the price at order time (price snapshot)

### 2.3 Create `migrations/007_create_outbox.sql`

```sql
-- Outbox: Transactional outbox for reliable event publishing
-- Events are written atomically with business operations
-- The orchestrator processes these events via LISTEN/NOTIFY + polling
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Index for efficient pending event queries (used by orchestrator)
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(created_at) WHERE status = 'PENDING';
```

**Key design decisions:**
- `aggregate_type` + `aggregate_id` identify which entity produced the event (e.g., `'order_ledger'` + ledger UUID)
- `event_type` describes what happened (e.g., `'OrderAuthorized'`)
- `payload` is JSONB for flexible event data
- Partial index on `status = 'PENDING'` optimizes the orchestrator's polling query
- `processed_at` provides audit trail for when events were consumed

---

## Step 3: Restructure Source Folder Layout

Reorganize `services/edge-api/src/` from the current flat structure to the established layered pattern:

### 3.1 Target Folder Structure

```
services/edge-api/src/
  api/
    health.ts          # Health check route with DB connectivity test
  config.ts            # EdgeApiConfig Context.Tag + EdgeApiConfigLive layer
  db.ts                # PgClient.layerConfig with env-based configuration
  layers.ts            # Layer composition (Database + Config)
  telemetry.ts         # OpenTelemetry NodeSdk setup
  server.ts            # HTTP server bootstrap (routes + layers + launch)
  index.ts             # Entry point (imports server.js)
```

**Note:** `domain/`, `services/`, and `repositories/` directories are NOT needed yet. They will be created when the `POST /orders` and `GET /orders/{order_ledger_id}` endpoints are implemented. Do not create empty directories.

---

## Step 4: Create `src/db.ts` - Database Connection Layer

Create the database configuration layer following the exact pattern from `services/inventory/src/db.ts` and `services/orders/src/db.ts`.

```typescript
import { PgClient } from "@effect/sql-pg"
import { Config, Redacted } from "effect"

export const DatabaseLive = PgClient.layerConfig({
  host: Config.string("DATABASE_HOST").pipe(Config.withDefault("localhost")),
  port: Config.number("DATABASE_PORT").pipe(Config.withDefault(5432)),
  database: Config.string("DATABASE_NAME").pipe(Config.withDefault("ecommerce")),
  username: Config.string("DATABASE_USER").pipe(Config.withDefault("ecommerce")),
  password: Config.redacted("DATABASE_PASSWORD").pipe(
    Config.withDefault(Redacted.make("ecommerce"))
  )
})
```

**Critical patterns:**
- Use `Config.string()` / `Config.number()` for each parameter with `Config.withDefault()`
- Use `Config.redacted()` for password with `Redacted.make()` default
- Default values match the docker-compose PostgreSQL credentials
- This returns a `Layer` that provides `SqlClient.SqlClient` to downstream consumers

---

## Step 5: Create `src/config.ts` - Service Configuration

Follow the pattern from `services/orders/src/config.ts`:

```typescript
import { Config, Context, Effect, Layer } from "effect"

export class EdgeApiConfig extends Context.Tag("EdgeApiConfig")<
  EdgeApiConfig,
  {
    readonly port: number
  }
>() {}

export const EdgeApiConfigLive = Layer.effect(
  EdgeApiConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3000))
    }
  })
)
```

**Key details:**
- Tag name: `"EdgeApiConfig"` (unique per service)
- Default port: `3000` (matches docker-compose and the existing server.ts)
- Uses `Context.Tag` for dependency injection
- Additional config properties (e.g., service URLs for payments, orders, inventory) will be added in future plans when those integrations are implemented

---

## Step 6: Create `src/telemetry.ts` - OpenTelemetry Setup

Copy the exact pattern from `services/inventory/src/telemetry.ts`, changing only the default service name:

```typescript
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"

const serviceName = process.env.OTEL_SERVICE_NAME ?? "edge-api"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"

export const TelemetryLive = NodeSdk.layer(() => ({
  resource: {
    serviceName
  },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${otlpEndpoint}/v1/traces`
    })
  ),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`
    }),
    exportIntervalMillis: 10000
  }),
  logRecordProcessor: new BatchLogRecordProcessor(
    new OTLPLogExporter({
      url: `${otlpEndpoint}/v1/logs`
    })
  )
}))
```

**Key details:**
- Default service name: `"edge-api"` (overridden by `OTEL_SERVICE_NAME` env var in docker-compose)
- Default OTLP endpoint: `"http://localhost:4318"` (overridden in docker-compose to point to observability container)
- Exports traces, metrics, and logs via OTLP HTTP
- Batch processing with 10-second metric export interval

---

## Step 7: Create `src/api/health.ts` - Health Check Route

Follow the exact pattern from `services/orders/src/api/health.ts`:

```typescript
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

const healthCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const startTime = Date.now()

  // Test database connection
  yield* sql`SELECT 1`

  const latencyMs = Date.now() - startTime

  return yield* HttpServerResponse.json({
    status: "healthy",
    service: "edge-api",
    database: "connected",
    latency_ms: latencyMs,
    timestamp: new Date().toISOString()
  })
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      {
        status: "unhealthy",
        service: "edge-api",
        database: "disconnected",
        error: String(error),
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    )
  )
)

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
```

**Key implementation details:**
- Uses `SqlClient.SqlClient` from `@effect/sql` (NOT `PgClient.PgClient`). This is the abstract SQL client interface that `PgClient` implements. Using the abstract interface is more portable.
- Executes `SELECT 1` to verify actual database connectivity (not just connection pool existence)
- Measures round-trip latency in milliseconds
- Returns `200 OK` with `"healthy"` status on success
- Returns `503 Service Unavailable` with `"unhealthy"` status on failure
- Uses `Effect.catchAll` to handle any error (database connection failures, timeouts, etc.)
- Response uses `snake_case` keys for JSON (matching existing API convention)
- `service: "edge-api"` identifies this service in the health response

---

## Step 8: Create `src/layers.ts` - Layer Composition

Follow the pattern from `services/orders/src/layers.ts`, simplified since there are no repositories or services yet:

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { EdgeApiConfigLive } from "./config.js"

// Export composed application layer
// Will be expanded with repository and service layers when endpoints are added
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  EdgeApiConfigLive
)
```

**Key details:**
- Currently only composes Database and Config layers
- Will be extended with repository/service layers when `POST /orders` and `GET /orders/{order_ledger_id}` endpoints are implemented
- Uses `Layer.mergeAll()` to combine all layers into a single application layer

---

## Step 9: Update `src/server.ts` - Server Bootstrap

Rewrite `server.ts` to follow the Orders service pattern with layer composition, config-based port, routes, and telemetry:

```typescript
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { AppLive } from "./layers.js"
import { EdgeApiConfig } from "./config.js"
import { TelemetryLive } from "./telemetry.js"

// Root route - service identification
const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(
      HttpServerResponse.text("Edge API - E-commerce Demo")
    )
  )
)

// Compose all routes
const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes)
)

// Create HTTP server with dynamic port from config
const HttpLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* EdgeApiConfig

    return router.pipe(
      HttpServer.serve(),
      HttpServer.withLogAddress,
      Layer.provide(
        NodeHttpServer.layer(createServer, { port: config.port })
      )
    )
  })
)

// Compose final application layer
const MainLive = HttpLive.pipe(
  Layer.provide(AppLive),
  Layer.provide(TelemetryLive)
)

// Launch the server
Layer.launch(MainLive).pipe(NodeRuntime.runMain)
```

**Changes from current server.ts:**
1. Imports `HealthRoutes` from `./api/health.js` (database-aware health check)
2. Imports `AppLive` from `./layers.js` (provides Database + Config)
3. Imports `EdgeApiConfig` from `./config.js` (for dynamic port)
4. Imports `TelemetryLive` from `./telemetry.js` (OpenTelemetry)
5. Uses `Layer.unwrapEffect` to read config before creating the HTTP layer
6. Uses `Layer.provide(AppLive)` for dependency injection
7. Uses `Layer.provide(TelemetryLive)` for observability
8. Root route text changed to `"Edge API - E-commerce Demo"`
9. Removes the inline `/health` route (now in `api/health.ts`)

**`src/index.ts` remains unchanged:**
```typescript
import "./server.js"
```

---

## Step 10: Update `docker-compose.yml` - Environment Variables

The current docker-compose.yml provides `DATABASE_URL` for the Edge API, but the `db.ts` pattern expects individual environment variables. Update the edge-api service section to match the other services:

**Replace:**
```yaml
  edge-api:
    environment:
      PORT: 3000
      DATABASE_URL: postgres://ecommerce:ecommerce@postgres:5432/ecommerce
      OTEL_SERVICE_NAME: edge-api
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
```

**With:**
```yaml
  edge-api:
    environment:
      PORT: 3000
      DATABASE_HOST: postgres
      DATABASE_PORT: 5432
      DATABASE_NAME: ecommerce
      DATABASE_USER: ecommerce
      DATABASE_PASSWORD: ecommerce
      OTEL_SERVICE_NAME: edge-api
      OTEL_EXPORTER_OTLP_ENDPOINT: http://observability:4318
```

This makes the Edge API environment configuration consistent with the Inventory and Orders services.

---

## Step 11: Add vitest Configuration

Create `services/edge-api/vitest.config.ts` to enable testing (matching the Orders service pattern):

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node"
  }
})
```

---

## Step 12: Verification Checklist

After implementation, verify the following:

### 12.1 Type Check
```bash
npm run typecheck
```
All services should pass type checking with no errors.

### 12.2 Build
```bash
npm run build
```
All services should compile successfully.

### 12.3 Docker Compose Integration Test
```bash
docker-compose up --build
```

Verify:
1. PostgreSQL starts and migrations 005, 006, 007 run successfully
2. Edge API starts and connects to PostgreSQL
3. Health check responds correctly:
   ```bash
   curl http://localhost:3000/health
   ```
   Expected response:
   ```json
   {
     "status": "healthy",
     "service": "edge-api",
     "database": "connected",
     "latency_ms": <number>,
     "timestamp": "<ISO 8601>"
   }
   ```
4. Root route still works:
   ```bash
   curl http://localhost:3000/
   ```
   Expected: `Edge API - E-commerce Demo`

### 12.4 Database Table Verification
Connect to the database and verify tables were created:
```bash
docker-compose exec postgres psql -U ecommerce -d ecommerce -c "\dt"
```

Expected tables include: `order_ledger`, `order_ledger_items`, `outbox` (in addition to existing tables).

Verify indexes:
```bash
docker-compose exec postgres psql -U ecommerce -d ecommerce -c "\di"
```

Expected indexes include: `idx_order_ledger_status`, `idx_order_ledger_next_retry`, `idx_order_ledger_items_ledger`, `idx_outbox_pending`.

---

## Summary of Files to Create/Modify

| Action | File Path | Description |
|--------|-----------|-------------|
| **Modify** | `services/edge-api/package.json` | Add database, SQL, OpenTelemetry, and test dependencies |
| **Create** | `migrations/005_create_order_ledger.sql` | Order ledger table with indexes and trigger |
| **Create** | `migrations/006_create_order_ledger_items.sql` | Order ledger items table with index |
| **Create** | `migrations/007_create_outbox.sql` | Outbox table with partial index |
| **Create** | `services/edge-api/src/db.ts` | PgClient database connection layer |
| **Create** | `services/edge-api/src/config.ts` | EdgeApiConfig Context.Tag and layer |
| **Create** | `services/edge-api/src/telemetry.ts` | OpenTelemetry NodeSdk layer |
| **Create** | `services/edge-api/src/api/health.ts` | Database-aware health check route |
| **Create** | `services/edge-api/src/layers.ts` | Layer composition (Database + Config) |
| **Modify** | `services/edge-api/src/server.ts` | Full rewrite with layer-based bootstrap |
| **Modify** | `docker-compose.yml` | Edge API env vars: individual DB config |
| **Create** | `services/edge-api/vitest.config.ts` | Vitest test configuration |

**Files unchanged:** `services/edge-api/src/index.ts`, `services/edge-api/tsconfig.json`, `services/edge-api/Dockerfile`, `services/edge-api/.dockerignore`

---

## Coding Standards Reminders

These are drawn from `best-practices.md` and the existing codebase patterns:

1. **Import paths**: Use `.js` extensions in all imports (e.g., `"./db.js"`). This is required for Node.js ES module resolution with TypeScript.
2. **Effect.gen**: Use `function*` generators with `yield*` for sequential Effect composition.
3. **Error handling**: Use `Effect.catchAll` for catch-all error handlers, `Effect.catchTags` for specific tagged errors.
4. **Layer composition**: Use `Layer.mergeAll()` to combine independent layers, `Layer.provide()` for dependency chains.
5. **Config**: Use `Config.withDefault()` for all environment variables to enable local development without docker.
6. **Passwords**: Always use `Config.redacted()` with `Redacted.make()` for sensitive values.
7. **SQL template literals**: Use `sql\`SELECT 1\`` parameterized template syntax, never string concatenation.
8. **Response format**: Use `snake_case` for JSON response keys.
9. **No unused code**: TypeScript strict mode will flag unused locals/parameters.
10. **Monetary values**: Always store as integer cents, never as floats or decimals.
