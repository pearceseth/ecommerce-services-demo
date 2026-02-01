import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/__tests__/**",
        "src/index.ts",
        "src/server.ts",
        "src/db.ts",
        "src/layers.ts",
        "src/telemetry.ts",
        "src/repositories/**", // Excluded - covered by integration tests
        "src/services/PaymentClientLive.ts" // Excluded - covered by integration tests
      ]
    }
  }
})
