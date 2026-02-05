FROM node:22-alpine AS base

FROM base AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy tracing package
COPY packages/tracing ./packages/tracing

# Copy this service
COPY services/edge-api ./services/edge-api

# Install all dependencies
RUN npm install

# Build tracing first, then service
RUN npm run build --workspace=@ecommerce/tracing
RUN npm run build --workspace=@ecommerce/edge-api

# Runner stage
FROM base AS runner-base
WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built tracing package
COPY --from=builder /app/packages/tracing/dist ./packages/tracing/dist
COPY --from=builder /app/packages/tracing/package.json ./packages/tracing/

# Copy built service
COPY --from=builder /app/services/edge-api/dist ./services/edge-api/dist
COPY --from=builder /app/services/edge-api/package.json ./services/edge-api/

WORKDIR /app/services/edge-api
EXPOSE 3000

# Development
FROM runner-base AS runner-dev
ENV NODE_ENV=development
CMD ["node", "dist/index.js"]

# Production
FROM runner-base AS runner-prod
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser && \
    chown -R appuser:appgroup /app
USER appuser
CMD ["node", "dist/index.js"]
