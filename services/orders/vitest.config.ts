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
