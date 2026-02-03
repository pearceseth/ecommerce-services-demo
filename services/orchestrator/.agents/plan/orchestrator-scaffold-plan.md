# Implementation Plan: Orchestrator Service Scaffold

## Status: COMPLETE

---

## Overview

Create the Orchestrator service scaffold for the e-commerce order processing system. Unlike other services in this monorepo, the Orchestrator does **not** expose an HTTP server. Instead, it:

1. Listens for PostgreSQL `NOTIFY` events on the `order_events` channel
2. Polls the outbox table as a fallback (every 5 seconds)
3. Claims pending events using `SELECT FOR UPDATE SKIP LOCKED` for safe horizontal scaling
4. Executes saga steps by calling Orders, Inventory, and Payments services via HTTP

This plan covers only the **scaffold setup** - the foundational structure, configuration, database connection, and main event loop. Saga execution logic and compensation handling will be implemented in subsequent plans.

---

## Scope

### In Scope (This Plan)
- [ ] Service folder structure following established patterns
- [ ] Package.json with dependencies
- [ ] TypeScript configuration
- [ ] Environment-based configuration (`src/config.ts`)
- [ ] Database connection layer (`src/db.ts`)
- [ ] Telemetry setup (`src/telemetry.ts`)
- [ ] PostgreSQL LISTEN subscription for `order_events`
- [ ] Polling fallback mechanism (every 5 seconds)
- [ ] Main entry point that runs indefinitely
- [ ] Layer composition (`src/layers.ts`)

### Out of Scope (Future Plans)
- Outbox repository and event claiming
- Service HTTP clients (Orders, Inventory, Payments)
- Saga state machine and step execution
- Compensation handling
- Retry logic with exponential backoff

---

## Technical Design

### 1. Folder Structure

```
services/orchestrator/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point - imports and runs main.ts
│   ├── main.ts               # Main Effect that runs the orchestrator loop
│   ├── config.ts             # OrchestratorConfig context tag + layer
│   ├── db.ts                 # DatabaseLive layer (same pattern as other services)
│   ├── telemetry.ts          # OpenTelemetry setup (same pattern as other services)
│   ├── layers.ts             # Layer composition
│   ├── domain/               # Domain models (future: saga states, events)
│   │   └── .gitkeep
│   ├── repositories/         # Data access (future: outbox, ledger)
│   │   └── .gitkeep
│   ├── services/             # Business logic (future: saga executor)
│   │   └── .gitkeep
│   └── clients/              # HTTP clients (future: orders, inventory, payments)
│       └── .gitkeep
```

### 2. Package Dependencies

Based on analysis of existing services, the orchestrator requires:

```json
{
  "name": "@ecommerce/orchestrator",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "effect": "^3.12.7",
    "@effect/platform": "^0.76.6",
    "@effect/platform-node": "^0.72.6",
    "@effect/sql": "^0.30.6",
    "@effect/sql-pg": "^0.24.6",
    "@effect/schema": "^0.76.5",
    "@effect/opentelemetry": "^0.42.4",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.2",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.57.2",
    "@opentelemetry/exporter-logs-otlp-http": "^0.57.2",
    "@opentelemetry/sdk-metrics": "^1.30.1",
    "@opentelemetry/sdk-logs": "^0.57.2",
    "@opentelemetry/sdk-trace-node": "^1.30.1"
  },
  "devDependencies": {
    "typescript": "^5.7.3",
    "tsx": "^4.19.2"
  }
}
```

**Note**: Version numbers should match those in the root `package.json` or other services to ensure workspace compatibility. Check existing services' package.json files for exact versions.

### 3. TypeScript Configuration

Extend the root `tsconfig.json` (same pattern as other services):

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 4. Configuration (`src/config.ts`)

Define configuration using Effect's `Context.Tag` pattern:

```typescript
import { Config, Context, Effect, Layer } from "effect"

export class OrchestratorConfig extends Context.Tag("OrchestratorConfig")<
  OrchestratorConfig,
  {
    // Polling interval for fallback event processing (in milliseconds)
    readonly pollIntervalMs: number
    // Service URLs for HTTP clients (used in future plans)
    readonly ordersServiceUrl: string
    readonly inventoryServiceUrl: string
    readonly paymentsServiceUrl: string
  }
>() {}

export const OrchestratorConfigLive = Layer.effect(
  OrchestratorConfig,
  Effect.gen(function* () {
    return {
      pollIntervalMs: yield* Config.number("POLL_INTERVAL_MS").pipe(
        Config.withDefault(5000)
      ),
      ordersServiceUrl: yield* Config.string("ORDERS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3003")
      ),
      inventoryServiceUrl: yield* Config.string("INVENTORY_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3001")
      ),
      paymentsServiceUrl: yield* Config.string("PAYMENTS_SERVICE_URL").pipe(
        Config.withDefault("http://localhost:3002")
      )
    }
  })
)
```

**Environment Variables**:
| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | 5000 | Polling fallback interval |
| `ORDERS_SERVICE_URL` | http://localhost:3003 | Orders service base URL |
| `INVENTORY_SERVICE_URL` | http://localhost:3001 | Inventory service base URL |
| `PAYMENTS_SERVICE_URL` | http://localhost:3002 | Payments service base URL |
| `DATABASE_HOST` | localhost | PostgreSQL host |
| `DATABASE_PORT` | 5432 | PostgreSQL port |
| `DATABASE_NAME` | ecommerce | Database name |
| `DATABASE_USER` | ecommerce | Database user |
| `DATABASE_PASSWORD` | ecommerce | Database password |
| `OTEL_SERVICE_NAME` | orchestrator | Service name for telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | http://localhost:4318 | OTLP endpoint |

### 5. Database Connection (`src/db.ts`)

Copy the exact pattern from other services:

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

### 6. Telemetry (`src/telemetry.ts`)

Copy the exact pattern from other services:

```typescript
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node"

const serviceName = process.env.OTEL_SERVICE_NAME ?? "orchestrator"
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

### 7. Layer Composition (`src/layers.ts`)

Compose all layers for dependency injection:

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { OrchestratorConfigLive } from "./config.js"

// For scaffold, just database and config
// Future: Add repositories and services
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  OrchestratorConfigLive
)
```

### 8. Main Orchestrator Loop (`src/main.ts`)

The main Effect that:
1. Sets up PostgreSQL LISTEN for real-time notifications
2. Runs a polling loop as fallback
3. Processes events when triggered by either mechanism

```typescript
import { Effect, Schedule, Fiber, Duration, Queue, PubSub, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import { OrchestratorConfig } from "./config.js"

/**
 * Process pending outbox events.
 * For scaffold, this is a placeholder that logs.
 * Future: Implement actual event claiming and saga execution.
 */
const processEvents = Effect.gen(function* () {
  yield* Effect.logDebug("Processing pending events...")
  // Placeholder for future implementation:
  // 1. SELECT FROM outbox WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
  // 2. For each event, execute saga step
  // 3. UPDATE outbox SET status = 'PROCESSED', processed_at = NOW()
  yield* Effect.logDebug("Event processing complete")
})

/**
 * Subscribe to PostgreSQL NOTIFY on 'order_events' channel.
 * When notification received, trigger event processing.
 */
const listenForNotifications = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  yield* Effect.logInfo("Subscribing to order_events channel...")

  // Use @effect/sql-pg's listen capability
  // Note: The actual implementation depends on @effect/sql-pg API
  // This may need to use the underlying pg client directly
  yield* sql`LISTEN order_events`

  yield* Effect.logInfo("Subscribed to order_events channel")

  // The listen is set up; notifications will be handled by the connection
  // In @effect/sql-pg, we may need to use a different approach
  // See implementation notes below
})

/**
 * Polling fallback - runs every POLL_INTERVAL_MS
 * Catches any events that NOTIFY might have missed
 */
const pollingLoop = Effect.gen(function* () {
  const config = yield* OrchestratorConfig

  yield* Effect.logInfo("Starting polling loop", { intervalMs: config.pollIntervalMs })

  // Repeat processEvents forever with the configured interval
  yield* processEvents.pipe(
    Effect.repeat(
      Schedule.spaced(Duration.millis(config.pollIntervalMs))
    )
  )
})

/**
 * Main orchestrator program.
 * Runs LISTEN subscription and polling loop concurrently.
 * Never terminates under normal operation.
 */
export const main = Effect.gen(function* () {
  yield* Effect.logInfo("Orchestrator starting...")

  // Verify database connectivity
  const sql = yield* PgClient.PgClient
  const result = yield* sql`SELECT 1 as health_check`
  yield* Effect.logInfo("Database connection verified", { check: result[0] })

  // Run both notification listener and polling loop concurrently
  // Both should run forever; if either fails, the whole program fails
  yield* Effect.all([
    listenForNotifications,
    pollingLoop
  ], { concurrency: "unbounded" })
}).pipe(
  Effect.withSpan("orchestrator-main"),
  Effect.catchAllCause((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError("Orchestrator fatal error", { cause })
      return yield* Effect.failCause(cause)
    })
  )
)
```

**Implementation Notes for LISTEN/NOTIFY**:

The `@effect/sql-pg` library doesn't have built-in LISTEN/NOTIFY support in the same way as raw `pg`. There are two approaches:

**Approach A: Use raw pg client (Recommended for scaffold)**
```typescript
import { Effect } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"

// Create a dedicated connection for LISTEN (doesn't use pool)
const createListenConnection = Effect.gen(function* () {
  // Get connection config from environment
  const client = new pg.Client({
    host: process.env.DATABASE_HOST ?? "localhost",
    port: parseInt(process.env.DATABASE_PORT ?? "5432"),
    database: process.env.DATABASE_NAME ?? "ecommerce",
    user: process.env.DATABASE_USER ?? "ecommerce",
    password: process.env.DATABASE_PASSWORD ?? "ecommerce"
  })

  yield* Effect.promise(() => client.connect())

  client.on("notification", (msg) => {
    if (msg.channel === "order_events") {
      // Trigger event processing
      // This needs to signal the Effect runtime - see below
    }
  })

  yield* Effect.promise(() => client.query("LISTEN order_events"))

  return client
})
```

**Approach B: Use Effect PubSub for coordination**

The notification handler needs to signal the Effect runtime. Use `PubSub` or `Queue`:

```typescript
const setupNotificationHandler = Effect.gen(function* () {
  const notificationQueue = yield* Queue.unbounded<string>()

  // ... setup pg client ...
  client.on("notification", (msg) => {
    // Schedule event processing
    Effect.runFork(Queue.offer(notificationQueue, msg.channel))
  })

  return notificationQueue
})

// Then in main loop:
const notificationLoop = Effect.gen(function* () {
  const queue = yield* setupNotificationHandler
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* Queue.take(queue)  // Blocks until notification
      yield* processEvents
    })
  )
})
```

For the scaffold, **use Approach A with a simple flag or callback**. The full PubSub coordination can be refined when implementing the actual saga execution.

### 9. Entry Point (`src/index.ts`)

```typescript
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { main } from "./main.js"
import { AppLive } from "./layers.js"
import { TelemetryLive } from "./telemetry.js"

// Compose main with all dependencies
const program = main.pipe(
  Effect.provide(AppLive),
  Effect.provide(TelemetryLive)
)

// Run the orchestrator
// Unlike HTTP services, we don't use Layer.launch
// Instead, we run the main Effect directly
NodeRuntime.runMain(program)
```

### 10. Root Package.json Updates

Add the orchestrator service to the root workspace configuration. Check if the root `package.json` has a `workspaces` field and add:

```json
{
  "workspaces": [
    "services/edge-api",
    "services/inventory",
    "services/orders",
    "services/payment",
    "services/orchestrator"  // Add this
  ]
}
```

Also add scripts:
```json
{
  "scripts": {
    "dev:orchestrator": "npm run dev -w @ecommerce/orchestrator",
    "build:orchestrator": "npm run build -w @ecommerce/orchestrator"
  }
}
```

---

## Implementation Steps

### Step 1: Create Service Folder Structure
1. Create `services/orchestrator/` directory
2. Create `src/` subdirectory
3. Create placeholder directories: `domain/`, `repositories/`, `services/`, `clients/`
4. Add `.gitkeep` files to empty directories

### Step 2: Create Package Configuration
1. Create `package.json` with dependencies matching other services' versions
2. Create `tsconfig.json` extending root config

### Step 3: Implement Core Files
1. Create `src/db.ts` - Database connection layer
2. Create `src/config.ts` - Configuration context and layer
3. Create `src/telemetry.ts` - OpenTelemetry setup
4. Create `src/layers.ts` - Layer composition

### Step 4: Implement Main Loop
1. Create `src/main.ts` with:
   - Database connectivity check
   - LISTEN subscription setup
   - Polling loop with configurable interval
   - Placeholder `processEvents` function
2. Create `src/index.ts` entry point

### Step 5: Update Root Configuration
1. Add orchestrator to workspace in root `package.json`
2. Add npm scripts for dev and build

### Step 6: Verify Setup
1. Run `npm install` from root to link workspace
2. Run `npm run typecheck -w @ecommerce/orchestrator` to verify TypeScript
3. Start PostgreSQL via docker-compose
4. Run `npm run dev:orchestrator` to verify startup
5. Verify logs show:
   - "Orchestrator starting..."
   - "Database connection verified"
   - "Subscribed to order_events channel"
   - "Starting polling loop"

---

## Validation Criteria

### Functional
- [ ] Orchestrator starts without errors
- [ ] Database connection is established and verified
- [ ] PostgreSQL LISTEN is set up on `order_events` channel
- [ ] Polling loop runs at configured interval (default 5 seconds)
- [ ] Logs are emitted via Effect's logging (visible in console)
- [ ] Service shuts down gracefully on SIGINT/SIGTERM

### Structural
- [ ] Folder structure matches other services' conventions
- [ ] Package.json has correct dependencies and workspace name
- [ ] TypeScript compiles without errors
- [ ] All environment variables have sensible defaults
- [ ] Telemetry layer is integrated for future observability

### Code Quality
- [ ] Follows Effect.js patterns from best-practices.md
- [ ] Uses `Effect.gen` for effectful code
- [ ] Uses `Context.Tag` for dependency injection
- [ ] Uses `Layer` for composition
- [ ] Uses typed logging with `Effect.logInfo`, `Effect.logDebug`, etc.
- [ ] No imperative side effects outside of Effect

---

## Error Handling

### Startup Failures
- **Database connection failure**: Log error and exit with non-zero code
- **Configuration errors**: Effect.Config validation fails, log and exit
- **LISTEN setup failure**: Log error and continue with polling-only mode (graceful degradation)

### Runtime Failures
- **Polling iteration failure**: Log error, continue with next iteration (don't crash)
- **Notification handler failure**: Log error, rely on polling fallback

---

## Testing Considerations

While unit tests are not in scope for the scaffold, the following can be manually verified:

1. **Start with docker-compose postgres**: `docker-compose up postgres`
2. **Run orchestrator**: `npm run dev:orchestrator`
3. **Trigger NOTIFY manually**: `psql -c "NOTIFY order_events, 'test'"`
4. **Verify logs show notification received**
5. **Wait 5 seconds and verify polling log appears**

---

## Future Extension Points

This scaffold is designed to be extended with:

1. **OutboxRepository** (`src/repositories/OutboxRepository.ts`)
   - `claimPendingEvents()` - SELECT FOR UPDATE SKIP LOCKED
   - `markProcessed()` - Update status to PROCESSED

2. **Service HTTP Clients** (`src/clients/`)
   - `OrdersClient.ts` - POST /orders, POST /orders/:id/confirmation, POST /orders/:id/cancellation
   - `InventoryClient.ts` - POST /reservations, DELETE /reservations/:order_id
   - `PaymentsClient.ts` - POST /payments/capture/:id, POST /payments/void/:id

3. **SagaExecutor Service** (`src/services/SagaExecutor.ts`)
   - State machine for saga steps
   - Step execution with idempotency checks
   - Status updates to order_ledger

4. **CompensationHandler** (`src/services/CompensationHandler.ts`)
   - Reverse execution on failure
   - Compensation order tracking

---

## Dependencies on Other Services

The orchestrator will call these existing endpoints:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| Orders | `POST /orders` | Create order from ledger |
| Orders | `GET /orders/:order_id` | Get order status |
| Orders | `POST /orders/:order_id/confirmation` | Confirm order |
| Orders | `POST /orders/:order_id/cancellation` | Cancel order (compensation) |
| Inventory | `POST /reservations` | Reserve stock for order |
| Inventory | `DELETE /reservations/:order_id` | Release reservation (compensation) |
| Payments | `POST /payments/capture/:authorization_id` | Capture authorized payment |
| Payments | `POST /payments/void/:authorization_id` | Void authorization (compensation) |

---

## References

- `engineering-design.md` - Section 4 (Saga Orchestrator Design), Section 5 (Outbox Pattern)
- `.claude/resources/best-practices.md` - Effect.js patterns and conventions
- `services/edge-api/src/` - HTTP client pattern (PaymentClient, PaymentClientLive)
- `services/orders/src/` - Layer composition pattern
- `services/inventory/src/` - Repository pattern with transactions
