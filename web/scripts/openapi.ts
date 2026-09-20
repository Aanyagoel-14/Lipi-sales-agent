import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openapiDocument, OPENAPI_PATH } from "../src/app/v1/openapi";

/**
 * Writes the generated document to `docs/openapi.json`.
 *
 * The file is checked in so its diff is reviewable next to the change that
 * caused it, and `test/openapi.test.ts` regenerates it on every run — so it
 * is a build artefact that cannot go stale rather than a second source of
 * truth. Run this after changing anything in `src/app/v1/contract.ts`.
 */
const document = `${JSON.stringify(openapiDocument(), null, 2)}\n`;

mkdirSync(dirname(OPENAPI_PATH), { recursive: true });
writeFileSync(OPENAPI_PATH, document);

console.log(`Wrote ${OPENAPI_PATH}`);
