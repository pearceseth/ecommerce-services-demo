# Best Practices

Guidelines and patterns discovered during implementation.

## Functional Programming Principles

### Prefer FP Concepts in Effect.js
- Use immutable data structures and pure functions where possible
- Leverage Effect's type system to make invalid states unrepresentable
- Use algebraic data types (ADTs) for domain modeling and error handling
- Prefer composition over inheritance
- Make side effects explicit through the Effect type

### Algebraic Data Types (ADTs)
- Use discriminated unions (tagged unions) for types that can be one of several variants
- Each variant should have a `_tag` field for pattern matching
- ADTs enable exhaustive pattern matching - the compiler ensures all cases are handled
- Effect.js provides `Data.TaggedError` and `Schema.TaggedError` for error ADTs

---

## Error Handling with ADTs

### Why Use TaggedError
- `Data.TaggedError` automatically collects stack traces, cause chains, and custom properties
- Simple interfaces like `{ _tag: "Error" }` lose this valuable context
- Tagged errors are yieldable - use directly in `Effect.gen` without `Effect.fail` wrapper
- The `_tag` discriminant enables type-safe pattern matching with `catchTag`/`catchTags`

### Designing Error Types with Context
Every error type should capture the context needed for:
1. **Debugging**: What operation failed? What were the inputs?
2. **Recovery**: Is this retryable? What alternative action can be taken?
3. **Logging**: What information helps diagnose the issue in production?
4. **User messaging**: What can we tell the user (without exposing internals)?

### Error Type Design Patterns

**Include identifiers that locate the failure:**
```typescript
class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string  // Which product wasn't found
}> {}

class InsufficientStockError extends Data.TaggedError("InsufficientStockError")<{
  readonly productId: string   // Which product
  readonly requested: number   // What was requested
  readonly available: number   // What was available
}> {}
```

**Include the operation context:**
```typescript
class PaymentFailedError extends Data.TaggedError("PaymentFailedError")<{
  readonly orderId: string           // Which order
  readonly amount: number            // What amount
  readonly reason: string            // Why it failed (from gateway)
  readonly isRetryable: boolean      // Can we try again?
}> {}
```

**Wrap external errors with domain context:**
```typescript
class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string         // "insert" | "update" | "select"
  readonly table: string             // Which table
  readonly cause: unknown            // Original error
}> {}
```

### Error Hierarchy Pattern
Group related errors into domain-specific unions:

```typescript
// Domain-specific errors
class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string
  readonly message: string
  readonly value: unknown
}> {}

class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string
  readonly id: string
}> {}

class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly resource: string
  readonly conflictingField: string
  readonly existingValue: string
}> {}

// Union type for all domain errors
type DomainError = ValidationError | NotFoundError | ConflictError
```

### Pattern Matching with catchTags
```typescript
const handleErrors = program.pipe(
  Effect.catchTags({
    ValidationError: (e) =>
      HttpServerResponse.json(
        { error: "validation_error", field: e.field, message: e.message },
        { status: 400 }
      ),
    NotFoundError: (e) =>
      HttpServerResponse.json(
        { error: "not_found", resource: e.resource, id: e.id },
        { status: 404 }
      ),
    ConflictError: (e) =>
      HttpServerResponse.json(
        { error: "conflict", message: `${e.resource} with ${e.conflictingField} already exists` },
        { status: 409 }
      )
  })
)
```

### Expected Errors vs Defects
- **Expected errors**: Domain failures tracked in the error channel (E in `Effect<A, E, R>`)
  - Examples: validation failures, not found, insufficient stock, payment declined
  - Recoverable through `catchTag`, `catchTags`, `catchAll`
- **Defects**: Unexpected failures that indicate bugs or system failures
  - Examples: null pointer, invariant violations, unhandled exceptions
  - Use `Effect.die` or let them propagate as defects
  - Catch with `catchAllCause` or `catchAllDefect` only at top level

### Error Mapping at Boundaries
Transform low-level errors into domain errors at architectural boundaries:

```typescript
const createProduct = (request: CreateProductRequest) =>
  repo.insert(request).pipe(
    // Map database constraint violation to domain error
    Effect.catchTag("SqlError", (sqlError) => {
      if (isUniqueViolation(sqlError, "sku")) {
        return Effect.fail(new DuplicateSkuError({ sku: request.sku }))
      }
      // Re-throw as defect if it's not an expected case
      return Effect.die(sqlError)
    })
  )
```

---

## Effect.js Patterns

### HTTP Request Body Parsing
- Use `HttpServerRequest.schemaBodyJson(Schema)` to parse and validate JSON request bodies in a single step
- This returns an Effect that yields either validated data or `ParseError`
- Always handle `RequestError` (body parsing failures) and `ParseError` (validation failures) separately

### Error Handling in Routes
- Use `Effect.catchTags({})` to handle specific error types with appropriate HTTP status codes
- Always include a catch-all handler for unexpected errors to prevent exposing internal details
- Log unexpected errors server-side but return generic messages to clients
- Map domain errors to HTTP status codes consistently across all routes

### Service/Repository Pattern
- Define interfaces using `Context.Tag` for dependency injection
- Implement `*Live` layers that depend on other layers
- Repositories return `Option<T>` for queries that may not find data (not `null`)
- Use `Option.match({ onNone, onSome })` to handle both cases explicitly
- Services convert `Option.none()` to typed errors when appropriate
- Compose layers in `layers.ts` with explicit dependency chains

### Option vs Null
- Prefer `Option<T>` over `T | null` for optional values - it's more idiomatic in Effect.js
- `Option.none()` and `Option.some(value)` provide type-safe optional handling
- Use `Option.match`, `Option.getOrElse`, or `Option.map` for transformations
- Example repository pattern:
  ```typescript
  readonly findById: (id: ProductId) => Effect.Effect<Option<Product>>
  ```
- Example service consumption:
  ```typescript
  const product = yield* repo.findById(id).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new ProductNotFoundError({ productId: id })),
      onSome: Effect.succeed
    }))
  )
  ```

### Schema Validation
- Add validation constraints directly in Schema definitions (minLength, maxLength, pattern, positive, etc.)
- Use branded types (e.g., `Schema.UUID.pipe(Schema.brand("ProductId"))`) for type safety
- Define separate Request and Response schemas for API contracts

## Database Patterns

### Monetary Values
- Store all monetary amounts as integers in cents (e.g., $29.99 = 2999)
- Convert at repository boundary: cents → decimal for storage, decimal → cents for retrieval
- Use `Math.round()` when converting to avoid floating-point precision issues
- This eliminates JavaScript floating-point precision problems and matches payment API conventions

### SQL Queries
- Always use parameterized queries via `sql` template literals to prevent SQL injection
- Map snake_case database columns to camelCase domain properties in repository layer
- PostgreSQL DECIMAL values come back as strings; parse explicitly

### Idempotency
- Use unique constraints (e.g., SKU, idempotency_key) as the final guard against duplicates
- Check for existence before insert, but rely on DB constraints for race conditions
- Return existing resource on duplicate rather than error (for true idempotency)

## Anti-Patterns to Avoid

### Error Handling Anti-Patterns
- **Don't use plain objects for errors** - `{ _tag: "Error", message: "..." }` loses stack traces and cause chains
- **Don't use generic error types** - `class AppError` with a message string loses type safety; use specific tagged errors
- **Don't throw exceptions** - Use `Effect.fail()` or yield tagged errors; throwing bypasses the type system
- **Don't catch and ignore** - Either handle the error meaningfully or let it propagate
- **Don't expose internal errors to users** - Map to user-friendly messages at the API boundary
- **Don't forget context** - Errors without identifiers (productId, orderId) are hard to debug in production

### Bad Error Example
```typescript
// DON'T: Generic error with just a message
class AppError extends Error {
  constructor(message: string) { super(message) }
}
throw new AppError("Product not found")  // Which product? No type safety!
```

### Good Error Example
```typescript
// DO: Specific error with context
class ProductNotFoundError extends Data.TaggedError("ProductNotFoundError")<{
  readonly productId: string
  readonly searchedBy: "id" | "sku"
}> {}
yield* new ProductNotFoundError({ productId: "abc-123", searchedBy: "id" })
```

### General Anti-Patterns
- Don't use `price: Schema.String` for monetary values - use integer cents
- Don't use string concatenation for SQL queries
- Don't mix snake_case and camelCase inconsistently - convert at boundaries
- Don't forget to handle all Effect error channels in route handlers
- Don't use `null` for optional values - use `Option<T>`
- Don't mutate data - create new instances with changes
