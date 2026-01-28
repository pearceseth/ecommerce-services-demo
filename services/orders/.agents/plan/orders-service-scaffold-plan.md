# Implementation Plan: Orders Service Scaffold

## Status: COMPLETE

---

## Overview

Create the Orders Service scaffold as a hello world HTTP server with Effect.js. This service will manage order records and their lifecycle states (CREATED, CONFIRMED, CANCELLED). The scaffold establishes the foundational structure that subsequent tasks will build upon.

**Target Tasks from todo.md:**
- Create orders service scaffold (hello world HTTP server with Effect.js)
- Add database connection and health check endpoint
- Restructure to recommended folder pattern (api/, domain/, services/, repositories/)
- Create database migration for orders, order_items tables

---

## Pre-Implementation Checklist

Before writing any code, ensure:
- [ ] Node.js 22+ is available
- [ ] PostgreSQL is running (via `docker-compose up postgres`)
- [ ] Root `npm install` has been run

---

## Step 1: Create Directory Structure

Create the following folder structure under `services/orders/`:

```
services/orders/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # HTTP server setup
│   ├── layers.ts             # Effect layer composition
│   ├── config.ts             # Service configuration
│   ├── telemetry.ts          # OpenTelemetry setup
│   ├── db.ts                 # Database connection
│   ├── api/
│   │   └── health.ts         # Health check endpoint
│   ├── domain/
│   │   └── (empty for now)   # Will contain Order, OrderItem schemas
│   ├── services/
│   │   └── (empty for now)   # Will contain OrderService
│   └── repositories/
│       └── (empty for now)   # Will contain OrderRepository
├── Dockerfile
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Note:** Database migrations are stored at the project root in `/migrations/`, not within each service directory.

---

## Step 2: Create package.json

**File:** `services/orders/package.json`

```json
{
  "name": "@ecommerce/orders",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
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
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@vitest/coverage-v8": "^4.0.17",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^4.0.17"
  }
}
```

**Key Points:**
- Package name follows convention: `@ecommerce/orders`
- ESM only (`"type": "module"`)
- Includes all Effect.js dependencies matching inventory/payment services
- Includes PostgreSQL driver (`@effect/sql-pg`) since this service uses a database

---

## Step 3: Create tsconfig.json

**File:** `services/orders/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "noEmitOnError": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"]
}
```

**Key Points:**
- Strict mode enabled (mandatory for this codebase)
- NodeNext module resolution for ESM
- All safety checks enabled

---

## Step 4: Create Dockerfile

**File:** `services/orders/Dockerfile`

```dockerfile
FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

EXPOSE 3003
CMD ["node", "dist/index.js"]
```

**Key Points:**
- Multi-stage build for minimal production image
- Port 3003 (following convention: edge-api=3000, inventory=3001, payment=3002, orders=3003)
- Node 22 alpine base

---

## Step 5: Create vitest.config.ts

**File:** `services/orders/vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "src/repositories/**/*Live.ts",
        "src/services/**/*Live.ts"
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/index.ts",
        "src/server.ts",
        "src/db.ts",
        "src/layers.ts",
        "src/api/**/*.ts",
        "src/domain/**/*.ts"
      ]
    }
  }
})
```

---

## Step 6: Create Entry Point

**File:** `services/orders/src/index.ts`

```typescript
import "./server.js"
```

**Key Points:**
- Simple import that bootstraps the server
- `.js` extension required for ESM

---

## Step 7: Create Configuration

**File:** `services/orders/src/config.ts`

```typescript
import { Config, Context, Effect, Layer } from "effect"

export class OrdersConfig extends Context.Tag("OrdersConfig")<
  OrdersConfig,
  {
    readonly port: number
  }
>() {}

export const OrdersConfigLive = Layer.effect(
  OrdersConfig,
  Effect.gen(function* () {
    return {
      port: yield* Config.number("PORT").pipe(Config.withDefault(3003))
    }
  })
)
```

**Key Points:**
- Default port 3003
- Uses Effect's Config module for environment variable handling
- Context.Tag pattern for dependency injection

---

## Step 8: Create Telemetry Setup

**File:** `services/orders/src/telemetry.ts`

```typescript
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"

const serviceName = process.env.OTEL_SERVICE_NAME ?? "orders-service"
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"

export const TelemetryLive = NodeSdk.layer(() => ({
  resource: { serviceName },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
  ),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
    exportIntervalMillis: 10000
  }),
  logRecordProcessor: new BatchLogRecordProcessor(
    new OTLPLogExporter({ url: `${otlpEndpoint}/v1/logs` })
  )
}))
```

**Key Points:**
- Service name defaults to "orders-service"
- Configurable OTLP endpoint via environment variable
- Exports traces, metrics, and logs to Grafana LGTM stack

---

## Step 9: Create Database Connection

**File:** `services/orders/src/db.ts`

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

**Key Points:**
- Uses `@effect/sql-pg` for PostgreSQL connection
- All connection params have sensible defaults for local development
- Password is redacted for security (won't appear in logs)

---

## Step 10: Create Health Check Endpoint

**File:** `services/orders/src/api/health.ts`

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

  return HttpServerResponse.json({
    status: "healthy",
    service: "orders",
    database: "connected",
    latency_ms: latencyMs,
    timestamp: new Date().toISOString()
  })
}).pipe(
  Effect.catchAll((error) =>
    Effect.succeed(
      HttpServerResponse.json(
        {
          status: "unhealthy",
          service: "orders",
          database: "disconnected",
          error: String(error),
          timestamp: new Date().toISOString()
        },
        { status: 503 }
      )
    )
  )
)

export const HealthRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthCheck)
)
```

**Key Points:**
- Tests database connectivity with `SELECT 1`
- Returns latency measurement for monitoring
- Returns 503 on database failure (matches Docker Compose health check expectations)
- Consistent response structure with other services

---

## Step 11: Create Layer Composition

**File:** `services/orders/src/layers.ts`

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrdersConfigLive } from "./config.js"

// For scaffold, we only have Database and Config
// Repositories and Services will be added in subsequent tasks
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrdersConfigLive
)
```

**Key Points:**
- Composes all layers needed by the application
- Database and Config are the foundation layers
- Repositories and Services will be added incrementally

---

## Step 12: Create HTTP Server

**File:** `services/orders/src/server.ts`

```typescript
import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"
import { HealthRoutes } from "./api/health.js"
import { AppLive } from "./layers.js"
import { OrdersConfig } from "./config.js"
import { TelemetryLive } from "./telemetry.js"

// Root route - service identification
const rootRoute = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.succeed(
      HttpServerResponse.text("Orders Service - E-commerce Demo")
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
    const config = yield* OrdersConfig

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

**Key Points:**
- Uses `Layer.unwrapEffect` to access config before creating server
- Mounts health routes at root level
- `HttpServer.withLogAddress` logs the listening address on startup
- Layer composition: HTTP → App (DB + Config) → Telemetry

---

## Step 13: Create Database Migration

**File:** `migrations/004_create_orders_tables.sql` (at project root)

Migrations are stored centrally in the `/migrations/` directory at the project root, following the existing convention (001_create_products.sql, 002_create_inventory_adjustments.sql, 003_create_inventory_reservations.sql).

```sql
-- Orders table: main order record
-- Links to order_ledger via order_ledger_id for saga traceability
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_ledger_id UUID NOT NULL UNIQUE,  -- Links to Edge API's order_ledger
    user_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    total_amount_cents INT NOT NULL,       -- Stored in cents (e.g., 9999 = $99.99)
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ledger_id ON orders(order_ledger_id);

-- Order items table: line items for each order
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,              -- References inventory service's products
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price_cents INT NOT NULL,         -- Stored in cents
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Index for fetching items by order
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at_trigger ON orders;
CREATE TRIGGER orders_updated_at_trigger
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_orders_updated_at();

-- Comment on status values for documentation
COMMENT ON COLUMN orders.status IS 'Order status: CREATED, CONFIRMED, CANCELLED';
COMMENT ON COLUMN orders.total_amount_cents IS 'Total in cents (e.g., 9999 = $99.99)';
COMMENT ON COLUMN order_items.unit_price_cents IS 'Price per unit in cents';
```

**Key Points:**
- Uses IF NOT EXISTS for idempotent migrations
- `order_ledger_id` is UNIQUE to enforce 1:1 relationship with ledger entries
- All monetary values stored as integer cents (per engineering-design.md)
- Foreign key with CASCADE delete for order_items
- Auto-updating `updated_at` trigger
- CHECK constraint ensures positive quantities

---

## Step 14: Update Root package.json

Add the new workspace script to the root `package.json`:

```json
{
  "scripts": {
    "dev:orders": "npm run dev --workspace=@ecommerce/orders"
  }
}
```

---

## Step 15: Run npm install

After creating `services/orders/package.json`, run from the repository root:

```bash
npm install
```

This will install dependencies for the new orders service via npm workspaces.

---

## Step 16: Run Database Migration

Apply the migration to create the orders tables:

```bash
docker-compose up -d postgres  # Ensure PostgreSQL is running
psql -h localhost -U ecommerce -d ecommerce -f migrations/004_create_orders_tables.sql
```

Or using docker-compose exec:

```bash
docker-compose exec -T postgres psql -U ecommerce -d ecommerce < migrations/004_create_orders_tables.sql
```

---

## Verification Steps

After implementation, verify the scaffold works correctly:

### 1. Type Check
```bash
npm run typecheck --workspace=@ecommerce/orders
```
Expected: No errors

### 2. Build
```bash
npm run build --workspace=@ecommerce/orders
```
Expected: Compiles to `services/orders/dist/`

### 3. Start Service (requires PostgreSQL)
```bash
docker-compose up -d postgres
npm run dev:orders
```
Expected: Server starts on port 3003 with log output showing address

### 4. Test Health Endpoint
```bash
curl http://localhost:3003/health
```
Expected response:
```json
{
  "status": "healthy",
  "service": "orders",
  "database": "connected",
  "latency_ms": <number>,
  "timestamp": "<ISO timestamp>"
}
```

### 5. Test Root Endpoint
```bash
curl http://localhost:3003/
```
Expected: `Orders Service - E-commerce Demo`

### 6. Verify Database Tables
```bash
docker-compose exec postgres psql -U ecommerce -d ecommerce -c "\dt"
```
Expected: `orders` and `order_items` tables listed

---

## Files Created Summary

| File | Purpose |
|------|---------|
| `services/orders/package.json` | NPM package definition |
| `services/orders/tsconfig.json` | TypeScript configuration |
| `services/orders/Dockerfile` | Container build definition |
| `services/orders/vitest.config.ts` | Test configuration |
| `services/orders/src/index.ts` | Entry point |
| `services/orders/src/server.ts` | HTTP server setup |
| `services/orders/src/config.ts` | Service configuration |
| `services/orders/src/layers.ts` | Effect layer composition |
| `services/orders/src/telemetry.ts` | OpenTelemetry setup |
| `services/orders/src/db.ts` | Database connection |
| `services/orders/src/api/health.ts` | Health check endpoint |
| `migrations/004_create_orders_tables.sql` | Database schema (at project root) |

---

## Design Decisions & Rationale

### Port Number (3003)
Following the established convention:
- Edge API: 3000
- Inventory: 3001
- Payment: 3002
- **Orders: 3003**
- Orchestrator: No HTTP (uses LISTEN/NOTIFY)

### Database Schema Design
- `order_ledger_id` is UNIQUE, not just a foreign key, because each ledger entry should create exactly one order (idempotency via orchestrator)
- No explicit foreign key to `order_ledger` table since that's owned by Edge API (cross-service boundary)
- No explicit foreign key to `products` table since that's owned by Inventory service
- Status column uses VARCHAR to allow future status additions without migration

### Layer Composition
Scaffold includes minimal layers (Database + Config). The pattern is:
1. Scaffold: DB + Config
2. Add repositories: Repos depend on DB
3. Add services: Services depend on Repos
4. Routes use Services

This incremental approach matches the todo.md task breakdown.

---

## Patterns Applied

| Pattern | Application |
|---------|-------------|
| Effect.js Layers | Dependency injection via Context.Tag and Layer |
| Configuration | Environment variables with defaults via Config module |
| Health Checks | Database connectivity test with latency measurement |
| OpenTelemetry | Traces, metrics, logs export to LGTM stack |
| Monorepo | npm workspaces with @ecommerce scope |
| ESM | Pure ES modules with .js extensions |
| Integer Cents | Monetary values stored as cents, not decimals |

---

## Next Steps (Out of Scope for This Plan)

The following will be implemented in subsequent plans:
1. **POST /orders** - Create order from ledger entry
2. **GET /orders/{order_id}** - Get order details with items
3. **PUT /orders/{order_id}/cancel** - Cancel order (compensation)
4. **PUT /orders/{order_id}/confirm** - Confirm order (final step)
