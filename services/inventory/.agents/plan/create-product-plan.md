# Implementation Plan: POST /inventory/products - Create Product

**Status: COMPLETE**

## Overview

This plan details the implementation of the Create Product endpoint for the Inventory Service. This endpoint allows creating new products in the catalog with optional initial stock quantity.

### Feature Summary
- **Endpoint**: `POST /inventory/products`
- **Purpose**: Create a new product with name, SKU, price, and optional initial stock
- **Key Concerns**: SKU uniqueness, idempotency, proper error handling, Effect.js patterns

---

## Prerequisites

Before implementing, ensure:
1. PostgreSQL is running with the `products` table migrated (migration `001_create_products.sql`)
2. The inventory service starts successfully (`npm run dev:inventory` or equivalent)
3. Familiarity with the existing codebase patterns in `services/inventory/src/`

---

## Implementation Steps

### Step 1: Enhance Error Types with Context (ADT Pattern)

**File**: `services/inventory/src/domain/errors.ts` (UPDATE)

Update error types to follow the ADT pattern with rich context for debugging, recovery, and logging. Each error should capture enough information to understand what failed and why.

```typescript
import { Data } from "effect"

/**
 * Product was not found in the database.
 * Context includes how the search was performed to aid debugging.
 */
export class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
  readonly searchedBy: "id" | "sku"  // How we looked for it
}> {}

/**
 * Attempted to create a product with a SKU that already exists.
 * Includes the existing product ID for potential recovery/redirect.
 */
export class DuplicateSkuError extends Data.TaggedError("DuplicateSkuError")<{
  readonly sku: string
  readonly existingProductId: string  // The product that already has this SKU
}> {}

/**
 * Insufficient stock to fulfill a reservation request.
 * Includes both requested and available quantities for user messaging.
 */
export class InsufficientStockError extends Data.TaggedError("InsufficientStockError")<{
  readonly productId: string
  readonly productSku: string         // Human-readable identifier
  readonly requested: number
  readonly available: number
}> {}

/**
 * Idempotency key was already used for a previous adjustment.
 * Includes the existing adjustment ID for idempotent response.
 */
export class DuplicateAdjustmentError extends Data.TaggedError("DuplicateAdjustmentError")<{
  readonly idempotencyKey: string
  readonly existingAdjustmentId: string  // Return existing result
}> {}
```

**Key Design Principles**:
1. **Identifiers**: Always include the ID/key of the resource involved
2. **Search context**: For "not found" errors, include how the search was performed
3. **Recovery data**: Include data that enables recovery (e.g., existingProductId for duplicates)
4. **User messaging**: Include human-readable values (SKU, quantities) for error messages
5. **Retryability**: For transient errors, consider adding `isRetryable: boolean`

---

### Step 2: Update the Domain Model

**File**: `services/inventory/src/domain/Product.ts`

The `CreateProductRequest` schema already exists but should be reviewed for completeness:

```typescript
// Current implementation - verify this matches API contract
export class CreateProductRequest extends Schema.Class<CreateProductRequest>("CreateProductRequest")({
  name: Schema.String,
  sku: Schema.String,
  price: Schema.String,  // Note: String for BigDecimal parsing
  initialStock: Schema.optionalWith(Schema.Int, { default: () => 0 })
}) {}
```

**Action Required**: Add validation constraints to the schema:

```typescript
import { Schema } from "effect"

// Enhanced request validation
export class CreateProductRequest extends Schema.Class<CreateProductRequest>("CreateProductRequest")({
  name: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Product name cannot be empty" }),
    Schema.maxLength(255, { message: () => "Product name cannot exceed 255 characters" })
  ),
  sku: Schema.String.pipe(
    Schema.minLength(1, { message: () => "SKU cannot be empty" }),
    Schema.maxLength(100, { message: () => "SKU cannot exceed 100 characters" }),
    Schema.pattern(/^[A-Za-z0-9\-_]+$/, {
      message: () => "SKU can only contain alphanumeric characters, hyphens, and underscores"
    })
  ),
  priceCents: Schema.Int.pipe(
    Schema.positive({ message: () => "Price must be positive" })
  ),
  initialStock: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.nonNegative({ message: () => "Initial stock cannot be negative" })
    ),
    { default: () => 0 }
  )
}) {}
```

**Important Design Decision**: Change from `price: Schema.String` to `priceCents: Schema.Int` to follow the engineering design's "Integer Cents" pattern (Section 3.3). This eliminates precision issues and matches the database schema.

**Add a response schema** for the API response:

```typescript
export class CreateProductResponse extends Schema.Class<CreateProductResponse>("CreateProductResponse")({
  id: ProductId,
  name: Schema.String,
  sku: Schema.String,
  priceCents: Schema.Int,
  stockQuantity: Schema.Int,
  createdAt: Schema.DateTimeUtc
}) {}
```

---

### Step 3: Update ProductRepository Interface and Implement Live Layer

**File**: `services/inventory/src/repositories/ProductRepository.ts` (UPDATE)

Update the interface to use `Option<Product>` instead of `Product | null`:

```typescript
import { Context, Effect, Option } from "effect"
import type { Product, ProductId } from "../domain/Product.js"

export interface CreateProductRow {
  readonly name: string
  readonly sku: string
  readonly priceCents: number  // Changed from price: string
  readonly stockQuantity: number
}

export class ProductRepository extends Context.Tag("ProductRepository")<
  ProductRepository,
  {
    readonly insert: (row: CreateProductRow) => Effect.Effect<Product>
    readonly findById: (id: ProductId) => Effect.Effect<Option.Option<Product>>
    readonly findBySku: (sku: string) => Effect.Effect<Option.Option<Product>>
    readonly updateStock: (id: ProductId, quantity: number) => Effect.Effect<void>
  }
>() {}
```

**File**: `services/inventory/src/repositories/ProductRepositoryLive.ts` (NEW FILE)

Create the implementation:

```typescript
import { Layer, Effect, Option, DateTime } from "effect"
import { SqlClient } from "@effect/sql"
import { ProductRepository, type CreateProductRow } from "./ProductRepository.js"
import { Product, ProductId } from "../domain/Product.js"

// Helper to map database row to domain Product
const mapRowToProduct = (row: {
  id: string
  name: string
  sku: string
  price: string  // DECIMAL comes as string from pg
  stock_quantity: number
  created_at: Date
  updated_at: Date
}): Product => new Product({
  id: row.id as ProductId,
  name: row.name,
  sku: row.sku,
  priceCents: Math.round(parseFloat(row.price) * 100),  // "29.99" → 2999
  stockQuantity: row.stock_quantity,
  createdAt: DateTime.unsafeFromDate(row.created_at),
  updatedAt: DateTime.unsafeFromDate(row.updated_at)
})

export const ProductRepositoryLive = Layer.effect(
  ProductRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return {
      insert: (row: CreateProductRow) =>
        Effect.gen(function* () {
          const priceDecimal = (row.priceCents / 100).toFixed(2)  // 2999 → "29.99"
          const result = yield* sql`
            INSERT INTO products (name, sku, price, stock_quantity)
            VALUES (${row.name}, ${row.sku}, ${priceDecimal}::decimal, ${row.stockQuantity})
            RETURNING *
          `
          return mapRowToProduct(result[0])
        }),

      findById: (id: ProductId) =>
        Effect.gen(function* () {
          const result = yield* sql`
            SELECT * FROM products WHERE id = ${id}
          `
          return result.length > 0
            ? Option.some(mapRowToProduct(result[0]))
            : Option.none()
        }),

      findBySku: (sku: string) =>
        Effect.gen(function* () {
          const result = yield* sql`
            SELECT * FROM products WHERE sku = ${sku}
          `
          return result.length > 0
            ? Option.some(mapRowToProduct(result[0]))
            : Option.none()
        }),

      updateStock: (id: ProductId, quantity: number) =>
        Effect.gen(function* () {
          yield* sql`
            UPDATE products
            SET stock_quantity = ${quantity}, updated_at = NOW()
            WHERE id = ${id}
          `
        })
    }
  })
)
```

**Key Implementation Notes**:
1. PostgreSQL DECIMAL comes back as a string - convert to cents with `Math.round(parseFloat(price) * 100)`
2. Use parameterized queries (template literals with `sql`) to prevent SQL injection
3. Map snake_case database columns to camelCase domain properties
4. Return `Option.some(product)` or `Option.none()` for queries - more idiomatic than `null`

---

### Step 4: Implement the ProductService Live Layer

**File**: `services/inventory/src/services/ProductServiceLive.ts` (NEW FILE)

```typescript
import { Layer, Effect, Option } from "effect"
import { ProductService } from "./ProductService.js"
import { ProductRepository } from "../repositories/ProductRepository.js"
import { DuplicateSkuError, ProductNotFoundError } from "../domain/errors.js"
import type { CreateProductRequest, ProductId } from "../domain/Product.js"

export const ProductServiceLive = Layer.effect(
  ProductService,
  Effect.gen(function* () {
    const repo = yield* ProductRepository

    return {
      create: (request: CreateProductRequest) =>
        Effect.gen(function* () {
          // Check for duplicate SKU first
          const existing = yield* repo.findBySku(request.sku)
          if (Option.isSome(existing)) {
            // Include rich context: the SKU and the existing product's ID
            return yield* Effect.fail(new DuplicateSkuError({
              sku: request.sku,
              existingProductId: existing.value.id  // Enables recovery/redirect
            }))
          }

          // Insert the new product
          const product = yield* repo.insert({
            name: request.name,
            sku: request.sku,
            priceCents: request.priceCents,
            stockQuantity: request.initialStock
          })

          return product
        }),

      findById: (id: ProductId) =>
        repo.findById(id).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new ProductNotFoundError({
              productId: id,
              searchedBy: "id"  // Context: how we searched
            })),
            onSome: Effect.succeed
          }))
        ),

      findBySku: (sku: string) =>
        repo.findBySku(sku).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new ProductNotFoundError({
              productId: sku,
              searchedBy: "sku"  // Context: how we searched
            })),
            onSome: Effect.succeed
          }))
        )
    }
  })
)
```

**Key Implementation Notes**:
1. **Rich error context**: Each error includes all context needed for debugging and recovery
2. `DuplicateSkuError` includes `existingProductId` - enables returning existing product in idempotent scenarios
3. `ProductNotFoundError` includes `searchedBy` - helps debugging ("did we search by wrong field?")
4. Use `Option.match({ onNone, onSome })` for exhaustive handling of optional results
5. All operations return `Effect` types for composability

---

### Step 5: Update the Layers Composition

**File**: `services/inventory/src/layers.ts`

```typescript
import { Layer } from "effect"
import { DatabaseLive } from "./db.js"
import { ProductRepositoryLive } from "./repositories/ProductRepositoryLive.js"
import { ProductServiceLive } from "./services/ProductServiceLive.js"

// Repository layer depends on database
const RepositoryLive = ProductRepositoryLive.pipe(
  Layer.provide(DatabaseLive)
)

// Service layer depends on repository
const ServiceLive = ProductServiceLive.pipe(
  Layer.provide(RepositoryLive)
)

// Export composed application layer
export const AppLive = Layer.mergeAll(
  DatabaseLive,
  ServiceLive
)
```

**Alternative pattern** (more explicit dependencies):

```typescript
export const AppLive = ProductServiceLive.pipe(
  Layer.provide(ProductRepositoryLive),
  Layer.provide(DatabaseLive)
)
```

---

### Step 6: Implement the HTTP Route Handler

**File**: `services/inventory/src/api/products.ts`

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import { CreateProductRequest } from "../domain/Product.js"
import { ProductService } from "../services/ProductService.js"
import { ParseResult } from "effect"

// POST /inventory/products - Create a new product
const createProduct = Effect.gen(function* () {
  // Parse and validate request body
  const body = yield* HttpServerRequest.schemaBodyJson(CreateProductRequest)

  // Get the service and create the product
  const productService = yield* ProductService
  const product = yield* productService.create(body)

  // Map domain model to response
  const response = {
    id: product.id,
    name: product.name,
    sku: product.sku,
    priceCents: product.priceCents,
    stockQuantity: product.stockQuantity,
    createdAt: product.createdAt
  }

  return yield* HttpServerResponse.json(response, { status: 201 })
}).pipe(
  // Error handling - map domain errors to HTTP responses
  // Each handler leverages the rich context from the error ADT
  Effect.catchTags({
    // Schema validation errors (400 Bad Request)
    ParseError: (error) =>
      HttpServerResponse.json(
        {
          error: "validation_error",
          message: "Invalid request data",
          details: formatParseError(error)
        },
        { status: 400 }
      ),

    // Duplicate SKU (409 Conflict)
    // Use rich context: existingProductId enables idempotent behavior
    DuplicateSkuError: (error) =>
      HttpServerResponse.json(
        {
          error: "duplicate_sku",
          message: `Product with SKU '${error.sku}' already exists`,
          existingProductId: error.existingProductId  // Client can redirect/fetch existing
        },
        { status: 409 }
      ),

    // Product not found (404 Not Found)
    // Use rich context: searchedBy helps client understand what failed
    ProductNotFoundError: (error) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product not found`,
          productId: error.productId,
          searchedBy: error.searchedBy  // "id" or "sku" - aids debugging
        },
        { status: 404 }
      ),

    // Request body parsing errors (400 Bad Request)
    RequestError: (error) =>
      HttpServerResponse.json(
        {
          error: "request_error",
          message: "Failed to parse request body"
          // Note: Don't expose error.message to avoid leaking internals
        },
        { status: 400 }
      )
  }),
  // Catch any unexpected errors (500 Internal Server Error)
  // Log full error server-side, return minimal info to client
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      // Log the full error with context for debugging
      yield* Effect.logError("Unexpected error in createProduct", { error })

      return yield* HttpServerResponse.json(
        {
          error: "internal_error",
          message: "An unexpected error occurred"
          // Never expose internal details to client
        },
        { status: 500 }
      )
    })
  )
)

// Helper to format parse errors for API response
const formatParseError = (error: ParseResult.ParseError): string => {
  // Extract user-friendly message from ParseError
  // TreeFormatter provides readable error messages
  return ParseResult.TreeFormatter.formatErrorSync(error)
}

// Export the router with all product routes
export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct)
)
```

**Key Implementation Notes**:

1. **Request Parsing**: Use `HttpServerRequest.schemaBodyJson(CreateProductRequest)` to parse and validate the JSON body in one step. This yields either the validated data or a `ParseError`.

2. **Rich Error Context in Responses**: Each error handler leverages the context from the error ADT:
   - `DuplicateSkuError.existingProductId` → returned to client for idempotent redirects
   - `ProductNotFoundError.searchedBy` → returned to client for debugging

3. **Error Handling Pattern**: Use `Effect.catchTags()` to handle specific error types:
   - `ParseError`: Schema validation failures → 400
   - `DuplicateSkuError`: Business rule violation → 409 (includes existingProductId)
   - `ProductNotFoundError`: Resource not found → 404 (includes searchedBy context)
   - `RequestError`: Body parsing failures → 400
   - Catch-all for unexpected errors → 500 (logs full error, returns minimal info)

4. **Security**: Never expose internal error details to clients. Log full errors server-side for debugging.

5. **ParseError Formatting**: Use `ParseResult.TreeFormatter.formatErrorSync()` for user-friendly validation messages.

---

### Step 7: Wire Up the Route in Server

**File**: `services/inventory/src/server.ts`

The `ProductRoutes` are already mounted at `/inventory` prefix in the existing server.ts:

```typescript
const router = HttpRouter.empty.pipe(
  HttpRouter.mount("/", rootRoute),
  HttpRouter.mount("/", HealthRoutes),
  HttpRouter.mount("/inventory", ProductRoutes)  // Already mounted!
)
```

**Verify**: The route will be accessible at `POST /inventory/products` since:
- Base mount: `/inventory`
- Route definition: `/products`
- Final path: `/inventory/products`

---

### Step 8: Update Domain Model for Integer Cents

**File**: `services/inventory/src/domain/Product.ts`

Update the `Product` class to use integer cents instead of BigDecimal:

```typescript
import { Schema } from "effect"

export const ProductId = Schema.UUID.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

// Domain model uses integer cents for price
export class Product extends Schema.Class<Product>("Product")({
  id: ProductId,
  name: Schema.String,
  sku: Schema.String,
  priceCents: Schema.Int,  // Changed from BigDecimal
  stockQuantity: Schema.Int,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

// Request validation
export class CreateProductRequest extends Schema.Class<CreateProductRequest>("CreateProductRequest")({
  name: Schema.String.pipe(
    Schema.minLength(1, { message: () => "Product name cannot be empty" }),
    Schema.maxLength(255, { message: () => "Product name cannot exceed 255 characters" })
  ),
  sku: Schema.String.pipe(
    Schema.minLength(1, { message: () => "SKU cannot be empty" }),
    Schema.maxLength(100, { message: () => "SKU cannot exceed 100 characters" }),
    Schema.pattern(/^[A-Za-z0-9\-_]+$/, {
      message: () => "SKU can only contain alphanumeric characters, hyphens, and underscores"
    })
  ),
  priceCents: Schema.Int.pipe(
    Schema.positive({ message: () => "Price must be positive" })
  ),
  initialStock: Schema.optionalWith(
    Schema.Int.pipe(
      Schema.nonNegative({ message: () => "Initial stock cannot be negative" })
    ),
    { default: () => 0 }
  )
}) {}
```

**Migration Consideration**: The database stores `price` as `DECIMAL(12, 2)`. Two options:

**Option A** (Recommended): Keep DB as DECIMAL, convert at repository boundary
- Pros: DB remains human-readable, no migration needed
- Cons: Conversion logic in repository

**Option B**: Change DB to `price_cents INT`
- Pros: Consistency, no conversion
- Cons: Requires migration, existing data conversion

For this plan, **use Option A** to avoid migrations and keep DB compatible with other potential systems.

---

### Step 9: Repository Update for Cents Conversion

**File**: `services/inventory/src/repositories/ProductRepositoryLive.ts`

Update the mapping functions to handle cents conversion:

```typescript
// Map DB row (DECIMAL) to domain (cents)
const mapRowToProduct = (row: {
  id: string
  name: string
  sku: string
  price: string  // DECIMAL comes as string "29.99"
  stock_quantity: number
  created_at: Date
  updated_at: Date
}): Product => new Product({
  id: row.id as ProductId,
  name: row.name,
  sku: row.sku,
  priceCents: Math.round(parseFloat(row.price) * 100),  // "29.99" → 2999
  stockQuantity: row.stock_quantity,
  createdAt: DateTime.unsafeFromDate(row.created_at),
  updatedAt: DateTime.unsafeFromDate(row.updated_at)
})

// In insert method, convert cents to decimal for storage
insert: (row: CreateProductRow) =>
  Effect.gen(function* () {
    const priceDecimal = (row.priceCents / 100).toFixed(2)  // 2999 → "29.99"
    const result = yield* sql`
      INSERT INTO products (name, sku, price, stock_quantity)
      VALUES (${row.name}, ${row.sku}, ${priceDecimal}::decimal, ${row.stockQuantity})
      RETURNING *
    `
    return mapRowToProduct(result[0])
  })
```

Update `CreateProductRow` interface:

```typescript
export interface CreateProductRow {
  readonly name: string
  readonly sku: string
  readonly priceCents: number  // Changed from price: string
  readonly stockQuantity: number
}
```

---

## Error Response Formats

### 201 Created - Success
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Widget Pro",
  "sku": "WIDGET-PRO-001",
  "priceCents": 2999,
  "stockQuantity": 100,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### 400 Bad Request - Validation Error
```json
{
  "error": "validation_error",
  "message": "Invalid request data",
  "details": "Expected priceCents to be a positive number, but got -100"
}
```

### 400 Bad Request - Parse Error
```json
{
  "error": "request_error",
  "message": "Failed to parse request body"
}
```

### 404 Not Found - Product Not Found
Rich context from `ProductNotFoundError` ADT helps debugging:
```json
{
  "error": "product_not_found",
  "message": "Product not found",
  "productId": "abc-123",
  "searchedBy": "sku"
}
```

### 409 Conflict - Duplicate SKU
Rich context from `DuplicateSkuError` ADT enables idempotent behavior:
```json
{
  "error": "duplicate_sku",
  "message": "Product with SKU 'WIDGET-PRO-001' already exists",
  "existingProductId": "550e8400-e29b-41d4-a716-446655440000"
}
```
The `existingProductId` allows clients to fetch or redirect to the existing product.

### 500 Internal Server Error
Minimal information to client; full error logged server-side:
```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred"
}
```

---

## Testing Plan

### Manual Testing with curl

```bash
# Start the service
npm run dev:inventory

# Create a product (success case)
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget Pro",
    "sku": "WIDGET-PRO-001",
    "priceCents": 2999,
    "initialStock": 100
  }'

# Expected: 201 Created with product JSON

# Create same product again (duplicate SKU)
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget Pro v2",
    "sku": "WIDGET-PRO-001",
    "priceCents": 3999
  }'

# Expected: 409 Conflict

# Invalid request (missing required field)
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget"
  }'

# Expected: 400 Bad Request

# Invalid request (negative price)
curl -X POST http://localhost:3001/inventory/products \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget",
    "sku": "WIDGET-002",
    "priceCents": -100
  }'

# Expected: 400 Bad Request with validation error
```

### Database Verification

```sql
-- Verify product was created
SELECT * FROM products WHERE sku = 'WIDGET-PRO-001';

-- Should show:
-- id | name | sku | price | stock_quantity | created_at | updated_at
-- uuid | Widget Pro | WIDGET-PRO-001 | 29.99 | 100 | timestamp | timestamp
```

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/domain/errors.ts` | MODIFY | Enhance error ADTs with rich context (searchedBy, existingProductId, etc.) |
| `src/domain/Product.ts` | MODIFY | Add validation constraints, use priceCents |
| `src/repositories/ProductRepository.ts` | MODIFY | Use Option<Product> instead of Product \| null, update CreateProductRow |
| `src/repositories/ProductRepositoryLive.ts` | CREATE | SQL implementation with Option returns |
| `src/services/ProductService.ts` | NO CHANGE | Interface already defined |
| `src/services/ProductServiceLive.ts` | CREATE | Business logic with Option.match pattern, rich error context |
| `src/api/products.ts` | MODIFY | Implement POST route handler with ADT-aware error handling |
| `src/layers.ts` | MODIFY | Add service/repository layers |
| `src/server.ts` | NO CHANGE | Already mounts ProductRoutes |

---

## Checklist for Implementation

- [ ] Enhance error types in `errors.ts` with rich context (ADT pattern)
- [ ] Update `CreateProductRequest` schema with validation constraints
- [ ] Change from BigDecimal/string price to integer cents pattern
- [ ] Update `ProductRepository.ts` interface to use `Option<Product>` instead of `Product | null`
- [ ] Create `ProductRepositoryLive.ts` with SQL queries returning `Option`
- [ ] Create `ProductServiceLive.ts` with business logic using `Option.match` and rich error context
- [ ] Update `layers.ts` to compose new layers
- [ ] Implement POST route in `products.ts` with ADT-aware error handling
- [ ] Test with curl commands (verify error responses include context)
- [ ] Verify database entries
- [ ] Run TypeScript type check (`npm run typecheck`)

---

## Potential Issues and Mitigations

| Issue | Mitigation |
|-------|------------|
| SQL injection | Use parameterized queries via `sql` template literals |
| Race condition on SKU check | Rely on DB UNIQUE constraint as final guard |
| BigDecimal parsing errors | Use integer cents to avoid parsing |
| Unhandled Effect errors | Catch-all error handler with logging |
| Price precision loss | Math.round() when converting to/from cents |

---

## References

- Engineering Design Document: `engineering-design.md` sections 3.3 (Integer Cents), 8.3 (API Contract)
- Project Best Practices: `.claude/resources/best-practices.md` (FP principles, error ADT patterns)
- Effect.js Platform docs: https://effect.website/docs/platform/introduction/
- Effect Schema docs: https://effect.website/docs/schema/introduction/
- Effect Error Handling: https://effect.website/docs/error-management/expected-errors/
- Effect Yieldable Errors: https://effect.website/docs/error-management/yieldable-errors/
- Existing patterns: `services/inventory/src/api/health.ts`
