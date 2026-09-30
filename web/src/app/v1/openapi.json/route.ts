import { json, route } from "@/server/lib/http";
import { preflight } from "@/server/lib/origins";
import { openapiDocument } from "../openapi";

/**
 * The machine-readable contract, unauthenticated.
 *
 * It describes the API; it contains no tenant's data and no secret, and a
 * document an integrator has to hold a key to read is a document they cannot
 * point a client generator at before they have one.
 */
export const GET = route(async () => json(openapiDocument()));

export const OPTIONS = route(preflight);
