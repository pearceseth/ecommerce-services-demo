# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies (from root)
npm install

# Run Edge API in dev mode with hot reload
npm run dev:edge-api

# Build all services
npm run build

# Type check all services
npm run typecheck

# Docker: Start all services with PostgreSQL
docker-compose up --build

# Docker: Start just PostgreSQL for local development
docker-compose up postgres
```

## Project Structure

This is a **TypeScript monorepo** using npm workspaces:

```
services/          # Microservices (each runs in separate Docker container)
  edge-api/        # Entry point API - receives order requests
packages/          # Shared libraries (future)
```

## Tech Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript with strict mode
- **Framework**: Effect.js ecosystem
  - `effect` - Core functional programming library
  - `@effect/platform` - HTTP server
  - `@effect/sql-pg` - PostgreSQL client
- **Database**: PostgreSQL 18
- **Container**: Docker with multi-stage builds

## Architecture Overview

**Pattern**: Saga Orchestration with Ledger-First Design

**Services**:
- **Edge API** - Entry point, handles order requests, payment authorization
- **Orders Service** - Order creation and management (planned)
- **Payments Service** - Payment authorization and capture (planned)
- **Inventory Service** - Stock management and reservation (planned)
- **Saga Orchestrator** - Polls ledger and coordinates workflows (planned)

**Request Flow**:
1. **Synchronous Phase**: Ledger entry creation → Payment authorization → Return response
2. **Asynchronous Phase**: Orchestrator polls AUTHORIZED entries → Creates order → Reserves inventory → Captures payment → Confirms order

## Key Design Principles

- **Ledger-first**: All requests recorded durably before processing
- **Idempotency**: All saga steps are idempotent via `client_request_id`
- **Atomic inventory**: Check-and-decrement prevents oversell
- **Evolution path**: Polling → Transactional outbox → Event-driven

## Database Schema

- `order_ledger` - Authoritative request record with status tracking
- `order_ledger_items` - Line items for orders
- `products` - Product catalog with `stock_quantity`
- `inventory_reservations` - Reservation tracking (RESERVED/RELEASED)
- `outbox` (future) - For transactional outbox pattern
