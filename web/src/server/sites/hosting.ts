import { env } from "../env";

/**
 * Phase 3: putting a generated site somewhere (PRD §3).
 *
 * "Deploys static assets to global Cloudflare/Vercel Edge CDNs with automated
 * SSL provisioning, custom domain DNS, SEO tags." Every one of those needs a
 * credential this deployment does not have, so this is the same seam
 * `lib/payments.ts` is, for the same reason: a deployment that reports a URL
 * it did not create is worse than one that reports nothing, because the
 * operator tells a customer to visit it.
 *
 * What is *not* blocked, and is therefore built: the site is really served.
 * `/s/{slug}` renders the generated structure against live twin data, with the
 * SEO tags, the JSON-LD and the sitemap the generator produced. An operator can
 * look at their site, send somebody the link and watch the assistant answer on
 * it, today, on this deployment's own origin. What a provider would add is a
 * CDN, a custom domain and a certificate — not the site.
 */

export type DeploymentRequest = {
  slug: string;
  /** The origin this deployment already serves the site on. */
  originUrl: string;
  customDomain?: string;
  autoProvisionSsl: boolean;
};

export type DeploymentOutcome =
  | { ok: true; provider: string; url: string; sslProvisioned: boolean }
  | { ok: false; provider: string; reason: string };

export type HostingProvider = {
  name: string;
  configured(): boolean;
  deploy(request: DeploymentRequest): Promise<DeploymentOutcome>;
};

/**
 * No edge provider configured.
 *
 * It reports failure, names what would fix it, and — importantly — says the
 * site is still served at its own origin, because that is true and the
 * operator needs to know it. The route that calls this renders the difference
 * rather than hiding it.
 */
export const noHostingProvider: HostingProvider = {
  name: "none",
  configured: () => false,
  async deploy(request) {
    return {
      ok: false,
      provider: "none",
      reason:
        `No edge host is configured, so no CDN, custom domain or certificate was provisioned — ` +
        `set VERCEL_TOKEN or CLOUDFLARE_API_TOKEN. The site is served at ${request.originUrl}.`,
    };
  },
};

/**
 * Vercel.
 *
 * Deliberately not implemented as a fetch against an endpoint nobody here can
 * call: the deploy API takes a file bundle, and what this generator produces
 * is a structure rendered by *this* server, not a static bundle. Wiring it up
 * properly means an export step that does not exist yet, and writing a
 * plausible request that has never been sent would be exactly the pretence
 * this seam exists to avoid.
 *
 * It is declared so the shape of the work is visible and so `hostingProvider()`
 * has something to select when a token appears. It refuses honestly until then.
 */
export const vercelHostingProvider: HostingProvider = {
  name: "vercel",
  configured: () => Boolean(env.VERCEL_TOKEN),
  async deploy() {
    return {
      ok: false,
      provider: "vercel",
      reason:
        "Vercel deployment needs a static export of the generated site, which this generator does not " +
        "produce yet — the site is rendered by this server. See docs/impl/BLOCKERS.md B-005.",
    };
  },
};

let provider: HostingProvider | null = null;

export function hostingProvider(): HostingProvider {
  provider ??= vercelHostingProvider.configured() ? vercelHostingProvider : noHostingProvider;
  return provider;
}

/** The test seam. Reset by passing `null`. */
export function setHostingProvider(next: HostingProvider | null) {
  provider = next;
}

/**
 * The URL this deployment serves a site at, which is true whatever a provider
 * did or did not do.
 */
export const originUrlFor = (slug: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/s/${slug}`;
