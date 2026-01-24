# Implementation Plan: GET /inventory/products/{product_id}/availability

## Status: COMPLETE

---

## 1. Overview

### Feature Description
Implement a GET endpoint to query the stock availability for a specific product by its ID.

### API Contract (from engineering-design.md)
```
GET /inventory/products/{product_id}/availability

Response (200 OK):
{
  "product_id": "uuid",
  "sku": "WIDGET-001",
  "stock_quantity": 150,
  "available": true
}

Response (404 Not Found):
{
  "error": "product_not_found",
  "message": "Product with ID {product_id} does not exist"
}
```

### Design Decisions

1. **Read-Only Operation**: This is a simple GET request with no side effects - no idempotency handling required
2. **Response Enrichment**: Include `sku` and `available` boolean for richer client experience
3. **Existing Service Method**: The `InventoryService.getAvailability()` method already exists and returns the stock quantity
4. **Consistency with Existing Patterns**: Follow the exact patterns established in `createProduct` and `addStock` routes

---

## 2. Implementation Steps

### Step 1: Extend InventoryService Interface (Optional Enhancement)

**File:** `services/inventory/src/services/InventoryService.ts`

The current `getAvailability` method returns just a `number`. Consider whether to:

**Option A (Minimal - Recommended):** Keep current interface, enrich response in API layer
- The route handler queries the product directly via `ProductService.findById()` to get SKU
- Simpler, follows single-responsibility principle
- Service layer stays focused on core domain logic

**Option B (Richer response):** Create a new `GetAvailabilityResponse` type
- Would require changes to service interface and implementation
- Overkill for a simple read operation

**Decision: Use Option A** - Query product in route handler to get SKU, keeping service layer simple.

### Step 2: Add GET Route Handler

**File:** `services/inventory/src/api/products.ts`

Create a new Effect handler `getAvailability` following the established patterns.

#### 2.1 Route Handler Structure

```typescript
const getAvailability = Effect.gen(function* () {
  // 1. Extract product_id from path parameters
  const request = yield* HttpServerRequest.HttpServerRequest
  const urlParts = request.url.split("/")
  // URL format: /inventory/products/{product_id}/availability
  const productsIndex = urlParts.indexOf("products")
  const productIdStr = urlParts[productsIndex + 1]

  // 2. Validate product_id is a valid UUID (use existing UUID_PATTERN)
  if (!productIdStr || !UUID_PATTERN.test(productIdStr)) {
    return yield* HttpServerResponse.json(
      {
        error: "validation_error",
        message: "Invalid product_id format. Must be a valid UUID."
      },
      { status: 400 }
    )
  }

  const productId = productIdStr as ProductId

  // 3. Get product to retrieve SKU (via ProductService)
  const productService = yield* ProductService
  const product = yield* productService.findById(productId)

  // 4. Get stock availability (via InventoryService)
  const inventoryService = yield* InventoryService
  const stockQuantity = yield* inventoryService.getAvailability(productId)

  // 5. Log the query
  yield* Effect.logInfo("Availability queried", {
    productId,
    sku: product.sku,
    stockQuantity
  })

  // 6. Build and return response (snake_case for JSON)
  const response = {
    product_id: productId,
    sku: product.sku,
    stock_quantity: stockQuantity,
    available: stockQuantity > 0
  }

  return HttpServerResponse.json(response, { status: 200 })
}).pipe(
  Effect.withSpan("GET /inventory/products/:product_id/availability"),
  Effect.flatten,
  // Error handling
  Effect.catchTags({
    // Product not found (404)
    ProductNotFoundError: (error) =>
      HttpServerResponse.json(
        {
          error: "product_not_found",
          message: `Product with ID ${error.productId} does not exist`
        },
        { status: 404 }
      ),

    // SQL errors (500)
    SqlError: (error) =>
      Effect.gen(function* () {
        yield* Effect.logError("Database error in getAvailability", { error })
        return HttpServerResponse.json(
          {
            error: "internal_error",
            message: "An unexpected error occurred"
          },
          { status: 500 }
        )
      }).pipe(Effect.flatten)
  })
)
```

#### 2.2 Key Implementation Notes

1. **No Request Body**: GET request has no body - only path parameter
2. **No Idempotency Header**: Read operations don't need idempotency
3. **Reuse UUID_PATTERN**: The regex constant is already defined in the file
4. **Use ProductService.findById**: This method already exists and returns `Product` or `ProductNotFoundError`
5. **Logging Pattern**: Follow existing `Effect.logInfo` pattern with structured metadata
6. **Error Handling**: Only two error types possible - `ProductNotFoundError` and `SqlError`
7. **Response JSON Keys**: Use snake_case (`product_id`, `stock_quantity`) to match existing API conventions

#### 2.3 Optimization Consideration

The current implementation makes two database queries:
1. `productService.findById()` - to get the SKU
2. `inventoryService.getAvailability()` - to get stock quantity

**Alternative:** Create a single `getProductAvailability` method in `InventoryService` that returns both. However, this optimization is premature:
- The queries are fast (indexed by primary key)
- Code is simpler and more maintainable with separation
- Can optimize later if profiling shows a bottleneck

### Step 3: Register Route in Router

**File:** `services/inventory/src/api/products.ts`

Add the GET route to the `ProductRoutes` export:

```typescript
export const ProductRoutes = HttpRouter.empty.pipe(
  HttpRouter.post("/products", createProduct),
  HttpRouter.post("/products/:product_id/stock", addStock),
  HttpRouter.get("/products/:product_id/availability", getAvailability)  // NEW
)
```

### Step 4: Verify ProductService Has findById Method

**File:** `services/inventory/src/services/ProductService.ts`

Verify that `findById` is exposed in the service interface. Based on exploration, it should exist:

```typescript
readonly findById: (
  id: ProductId
) => Effect.Effect<Product, ProductNotFoundError | SqlError.SqlError>
```

If it doesn't exist, it needs to be added (see Step 4a).

### Step 4a: Add findById to ProductService (if missing)

**File:** `services/inventory/src/services/ProductService.ts`

Add to interface:
```typescript
readonly findById: (
  id: ProductId
) => Effect.Effect<Product, ProductNotFoundError | SqlError.SqlError>
```

**File:** `services/inventory/src/services/ProductServiceLive.ts`

Add implementation:
```typescript
findById: (id: ProductId) =>
  Effect.gen(function* () {
    const product = yield* productRepo.findById(id)
    return yield* Option.match(product, {
      onNone: () => Effect.fail(new ProductNotFoundError({ productId: id, searchedBy: "id" })),
      onSome: Effect.succeed
    })
  })
```

---

## 3. Testing Plan

### 3.1 Unit Tests

**File:** `services/inventory/__tests__/api/products.test.ts` (create if doesn't exist)

#### Test Cases:

1. **Happy Path - Product with stock**
   - Setup: Create mock product with `stockQuantity: 100`
   - Input: Valid UUID for existing product
   - Expected: 200 OK with `stock_quantity: 100`, `available: true`

2. **Happy Path - Product with zero stock**
   - Setup: Create mock product with `stockQuantity: 0`
   - Input: Valid UUID for existing product
   - Expected: 200 OK with `stock_quantity: 0`, `available: false`

3. **Product Not Found**
   - Setup: No product exists with given ID
   - Input: Valid UUID that doesn't exist
   - Expected: 404 with `error: "product_not_found"`

4. **Invalid UUID Format**
   - Input: Malformed UUID (e.g., "not-a-uuid", "12345")
   - Expected: 400 with `error: "validation_error"`

5. **SQL Error Handling**
   - Setup: Mock repository to throw `SqlError`
   - Expected: 500 with `error: "internal_error"`, error logged

### 3.2 Integration Test (Manual or E2E)

1. Start PostgreSQL (`docker-compose up postgres`)
2. Run inventory service (`npm run dev:inventory`)
3. Create a product: `POST /inventory/products`
4. Query availability: `GET /inventory/products/{id}/availability`
5. Add stock: `POST /inventory/products/{id}/stock`
6. Query availability again - verify updated quantity

---

## 4. Response Schema Details

### Success Response (200 OK)

```json
{
  "product_id": "550e8400-e29b-41d4-a716-446655440000",
  "sku": "WIDGET-PRO-001",
  "stock_quantity": 150,
  "available": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `product_id` | UUID string | The product's unique identifier |
| `sku` | string | The product's SKU for display/reference |
| `stock_quantity` | integer | Current available stock (always >= 0) |
| `available` | boolean | `true` if `stock_quantity > 0`, else `false` |

### Error Response (404 Not Found)

```json
{
  "error": "product_not_found",
  "message": "Product with ID 550e8400-e29b-41d4-a716-446655440000 does not exist"
}
```

### Error Response (400 Bad Request)

```json
{
  "error": "validation_error",
  "message": "Invalid product_id format. Must be a valid UUID."
}
```

### Error Response (500 Internal Server Error)

```json
{
  "error": "internal_error",
  "message": "An unexpected error occurred"
}
```

---

## 5. Files to Modify

| File | Change |
|------|--------|
| `services/inventory/src/api/products.ts` | Add `getAvailability` handler and register route |
| `services/inventory/src/services/ProductService.ts` | Verify/add `findById` method (if missing) |
| `services/inventory/src/services/ProductServiceLive.ts` | Verify/add `findById` implementation (if missing) |

---

## 6. Dependencies & Imports

No new dependencies required. Verify these imports exist in `products.ts`:

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlError } from "@effect/sql"
import { Effect, DateTime } from "effect"
import { ProductId } from "../domain/Product.js"
import { ProductService } from "../services/ProductService.js"
import { InventoryService } from "../services/InventoryService.js"
import type { ProductNotFoundError } from "../domain/errors.js"
```

---

## 7. Validation Checklist

Before marking complete, verify:

- [ ] Route returns 200 with correct JSON structure for existing products
- [ ] Route returns 404 for non-existent product IDs
- [ ] Route returns 400 for malformed UUIDs
- [ ] Route returns 500 and logs error for database failures
- [ ] Response uses snake_case keys (`product_id`, `stock_quantity`)
- [ ] `available` boolean correctly reflects `stock_quantity > 0`
- [ ] Tracing span is created (`Effect.withSpan`)
- [ ] Logging includes structured metadata
- [ ] TypeScript compiles with no errors
- [ ] Existing tests still pass

---

## 8. Future Considerations (Out of Scope)

1. **Bulk Availability Query**: `POST /inventory/availability` with array of product IDs
   - Would be useful for checking multiple items at once (shopping cart)
   - Returns map of `product_id -> availability`

2. **Reserved Stock Visibility**: When reservations are implemented, consider:
   - `stock_quantity`: Total in warehouse
   - `available_quantity`: Stock minus active reservations
   - `reserved_quantity`: Currently held for pending orders

3. **Caching**: For high-traffic scenarios, consider:
   - Short-lived cache (1-5 seconds) for availability responses
   - Cache invalidation on stock changes

These are future enhancements and should not be implemented in this task.

---

## 9. Estimated Complexity

**Complexity: Low**

This is a straightforward read-only endpoint that:
- Follows established patterns exactly
- Uses existing service methods
- Has no complex business logic
- Requires minimal error handling

Estimated implementation: One focused session with minimal risk of complications.

---

## 10. Implementation Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `ProductService.findById` doesn't exist | Low | Check service interface first; add if needed |
| Path parameter extraction inconsistent | Low | Follow exact pattern from `addStock` handler |
| Response schema disagreement | Low | Documented in engineering-design.md; extends with `available` boolean |

**Overall Risk: Low** - This is a well-defined, simple feature with clear patterns to follow.
