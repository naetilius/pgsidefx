import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    include: [
      "src/__tests__/**/*.test.ts",
      "examples/**/test/**/*.test.ts",
    ],
  },
});

