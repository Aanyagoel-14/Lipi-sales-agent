import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { endpoints, openapiDocument, OPENAPI_PATH } from "@/app/v1/openapi";

/**
 * Guards the document against the one failure a specification has: saying
 * something the code does not do.
 *
 * Two halves. This file proves the checked-in file is exactly what the Zod
 * schemas generate, so it cannot go stale without the suite going red;
 * `api-contract.test.ts` proves the schemas describe what the routes really
 * answer with. Neither is worth much without the other.
 */
const checkedIn = () => readFileSync(OPENAPI_PATH, "utf8");

describe("the OpenAPI document", () => {
  it("is checked in", () => {
    expect(existsSync(OPENAPI_PATH), `${OPENAPI_PATH} is missing — run \`npm run openapi\``).toBe(true);
  });

  it("matches what the schemas generate", () => {
    const generated = `${JSON.stringify(openapiDocument(), null, 2)}\n`;
    expect(checkedIn(), "docs/openapi.json has drifted — run `npm run openapi`").toBe(generated);
  });

  it("documents a route that exists, at every path", async () => {
    const modules = import.meta.glob("../src/app/v1/**/route.ts");
    // `/v1/customers/{id}` is `src/app/v1/customers/[id]/route.ts` on disk.
    const onDisk = new Set(
      Object.keys(modules).map((file) =>
        file.replace("../src/app", "").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}"),
      ),
    );

    for (const endpoint of endpoints) {
      expect(onDisk, `${endpoint.method.toUpperCase()} ${endpoint.path} is documented but not routed`)
        .toContain(endpoint.path);
    }
  });

  it("exports the method it documents, at every path", async () => {
    const modules = import.meta.glob("../src/app/v1/**/route.ts") as Record<
      string,
      () => Promise<Record<string, unknown>>
    >;

    for (const endpoint of endpoints) {
      const file = `../src/app${endpoint.path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      const handlers = await modules[file]!();
      expect(handlers[endpoint.method.toUpperCase()], `${endpoint.path} exports no ${endpoint.method.toUpperCase()}`)
        .toBeTypeOf("function");
    }
  });

  it("answers a preflight at every documented path, so a browser can reach it", async () => {
    const modules = import.meta.glob("../src/app/v1/**/route.ts") as Record<
      string,
      () => Promise<Record<string, unknown>>
    >;

    for (const endpoint of endpoints) {
      const file = `../src/app${endpoint.path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      const handlers = await modules[file]!();
      expect(handlers.OPTIONS, `${endpoint.path} exports no OPTIONS`).toBeTypeOf("function");
    }
  });

  it("names every error the API can actually answer with", () => {
    const document = openapiDocument();
    const operation = document.paths["/v1/customers"]!.get as { responses: Record<string, unknown> };

    // The four a caller has to branch on. A generated client that knows only
    // about 200 turns a revoked key into an unparseable body.
    for (const status of ["401", "403", "404", "422", "429"]) {
      expect(Object.keys(operation.responses)).toContain(status);
    }
  });
});
