import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      // Route handlers reach for Next's request context. Outside a Next server
      // there is none, so the dispatcher supplies one and these stand in.
      "next/headers": here("./test/next/headers.ts"),
      "next/server": here("./test/next/server.ts"),
    },
  },
  test: {
    // The suite talks to a real Postgres, so tests within a file share a
    // database and must not run concurrently against each other.
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
