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

# Shared runner base
FROM base AS runner-base
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
EXPOSE 3003

# Development: runs as root
FROM runner-base AS runner-dev
ENV NODE_ENV=development
CMD ["node", "dist/index.js"]

# Production: runs as non-root user
FROM runner-base AS runner-prod
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser && \
    chown -R appuser:appgroup /app
USER appuser
CMD ["node", "dist/index.js"]
