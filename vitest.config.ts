import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "test",
    globals: true,
    environment: "node",
    // Browser-backed tests can be slow; give them generous headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
