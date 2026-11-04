import { env } from "@/server/env";
import { route } from "@/server/lib/http";
import { resolveWorkspaceId } from "@/server/lib/workspace";
import { catalogueCsvTemplate } from "@/lib/catalogue-import";

/**
 * The catalogue CSV template, with its currency column filled in. Built here
 * rather than in the browser because the currency is the deployment's: it is
 * what invoices and payment links are issued in, and the import refuses a
 * file that states another.
 */
export const GET = route(async () => {
  await resolveWorkspaceId();
  return new Response(catalogueCsvTemplate(env.STRIPE_CURRENCY.toUpperCase()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="lipi-catalogue-template.csv"',
    },
  });
});
