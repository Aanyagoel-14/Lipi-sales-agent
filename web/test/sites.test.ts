import { beforeEach, describe, expect, it } from "vitest";
import { createUser, createWorkspace, resetDatabase, signedIn } from "./helpers";
import { agent as anonymous } from "./dispatch";
import { prisma } from "@/server/lib/prisma";
import { setHostingProvider, type HostingProvider } from "@/server/sites/hosting";
import { buildStructure, generateSiteSchema, sitemapXml } from "@/server/sites/structure";
import { DARK_SLATE_PREMIUM, themeFor } from "@/server/sites/theme";

/**
 * The instant website builder (PRD §3).
 *
 * Three phases, three groups of cases: what a business profile turns into,
 * what a block binds to when somebody looks at the page, and what happens when
 * it is asked to go live. The fourth group is the one that matters most —
 * a generated site is actually served, and the page a visitor gets shows the
 * stock the business actually has.
 */

let workspaceId: string;

async function setup() {
  const { user } = await createUser();
  const workspace = await createWorkspace({ userId: user.id, policy: "nothing" });
  workspaceId = workspace.id;
  return signedIn();
}

/** The PRD's own request body (§3.1), unedited. */
const PRD_BODY = {
  business_profile: {
    name: "Apex Ceramic & Detailing",
    industry: "Automotive Services",
    target_geo: "Austin, TX",
    primary_goals: ["ONLINE_BOOKING", "CUSTOM_QUOTE_CALCULATION", "PHONE_CAPTURE"],
  },
  site_features: {
    embed_ai_voice_widget: true,
    embed_digital_twin_catalog: true,
    theme_mode: "DARK_SLATE_PREMIUM",
    custom_quote_formula: "BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)",
  },
  deployment_target: {
    custom_domain: "apexdetailaustin.com",
    auto_provision_ssl: true,
  },
};

beforeEach(async () => {
  await resetDatabase();
  setHostingProvider(null);
});

describe("phase 1 — intent to structure", () => {
  it("accepts the PRD's body verbatim and persists a site", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    expect(res.body.site.slug).toBe("apex-ceramic-detailing");
    expect(res.body.site.url).toContain("/s/apex-ceramic-detailing");
    expect(res.body.site.status).toBe("generated");

    const site = await prisma.generatedSite.findFirstOrThrow({ where: { workspaceId } });
    expect(site.name).toBe("Apex Ceramic & Detailing");
    expect(site.quoteFormula).toBe(PRD_BODY.site_features.custom_quote_formula);

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("site.generated");
  });

  it("answers at the PRD's own /api/v1 path as well", async () => {
    const agent = await setup();
    const res = await agent.post("/api/v1/builder/sites/generate").send(PRD_BODY).expect(201);
    expect(res.body.site.slug).toBe("apex-ceramic-detailing");
    expect(await prisma.generatedSite.count()).toBe(1);
  });

  // A goal is a promise the site makes to a visitor, so each one has to bring
  // the thing that keeps it.
  it("gives every primary goal a block that keeps its promise", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    const home = res.body.structure.pages.find((p: { path: string }) => p.path === "/");
    const types = home.blocks.map((b: { type: string }) => b.type);

    expect(types).toContain("booking");          // ONLINE_BOOKING
    expect(types).toContain("quote_calculator"); // CUSTOM_QUOTE_CALCULATION
    expect(types).toContain("phone_cta");        // PHONE_CAPTURE
    expect(types).toContain("catalogue");        // embed_digital_twin_catalog
    expect(types).toContain("assistant");        // embed_ai_voice_widget
  });

  it("gives booking, quote and catalogue pages of their own", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    const paths = res.body.structure.pages.map((p: { path: string }) => p.path);
    expect(paths).toEqual(["/", "/book", "/quote"]);
  });

  it("produces schema.org for a local business when a geography was given", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    expect(res.body.structure.schema).toMatchObject({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Apex Ceramic & Detailing",
      url: "https://apexdetailaustin.com",
      address: { "@type": "PostalAddress", addressLocality: "Austin, TX" },
    });
  });

  it("produces an Organization when no geography was given", () => {
    const structure = buildStructure(
      generateSiteSchema.parse({
        business_profile: { name: "Remote Co", industry: "Software", primary_goals: ["LEAD_CAPTURE"] },
      }),
    );
    expect(structure.schema["@type"]).toBe("Organization");
    expect(structure.schema.address).toBeUndefined();
  });

  it("produces a sitemap, and renders it as XML", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    expect(res.body.structure.sitemap).toEqual([
      { path: "/", changefreq: "weekly", priority: 1 },
      { path: "/book", changefreq: "monthly", priority: 0.7 },
      { path: "/quote", changefreq: "monthly", priority: 0.7 },
    ]);

    const site = await prisma.generatedSite.findFirstOrThrow();
    const xml = sitemapXml(site.structure as never, "https://apexdetailaustin.com");
    expect(xml).toContain("<loc>https://apexdetailaustin.com/book</loc>");
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
  });

  it("names the variables the quote form must ask for", async () => {
    const agent = await setup();
    const res = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    expect(res.body.structure.quote.variables).toEqual([
      "BASE_VEHICLE_SIZE", "COATING_GRADE", "PAINT_CORRECTION",
    ]);
  });

  // A quote form with nothing behind it is exactly the fake the master prompt
  // forbids, so the goal is refused rather than generated empty.
  it("refuses a quote goal with no formula", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/builder/sites/generate")
      .send({
        ...PRD_BODY,
        site_features: { ...PRD_BODY.site_features, custom_quote_formula: undefined },
      })
      .expect(422);

    expect(res.body.error).toContain("needs site_features.custom_quote_formula");
    expect(await prisma.generatedSite.count()).toBe(0);
  });

  // The operator's own request is where a bad formula should fail, not a
  // visitor's page load.
  it("refuses a malformed formula at generation, naming where it broke", async () => {
    const agent = await setup();
    const res = await agent
      .post("/v1/builder/sites/generate")
      .send({
        ...PRD_BODY,
        site_features: { ...PRD_BODY.site_features, custom_quote_formula: "A * (B + " },
      })
      .expect(422);

    expect(res.body.error).toContain("The quote formula is not valid");
    expect(await prisma.generatedSite.count()).toBe(0);
  });

  it("rejects a body with no goals", async () => {
    const agent = await setup();
    await agent
      .post("/v1/builder/sites/generate")
      .send({ ...PRD_BODY, business_profile: { ...PRD_BODY.business_profile, primary_goals: [] } })
      .expect(422);
  });

  // The slug is a public URL segment, so two tenants cannot both own one.
  it("gives a second site with the same name a distinct slug", async () => {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);
    const second = await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    expect(second.body.site.slug).toBe("apex-ceramic-detailing-2");
  });

  it("refuses an anonymous caller", async () => {
    await setup();
    await anonymous().post("/v1/builder/sites/generate").send(PRD_BODY).expect(401);
  });
});

describe("the theme tokens", () => {
  // PRD §8.1, verbatim.
  it("uses the PRD's own palette for DARK_SLATE_PREMIUM", () => {
    expect(DARK_SLATE_PREMIUM.canvas).toBe("#0B0F19");
    expect(DARK_SLATE_PREMIUM.surface).toBe("#111827");
    expect(DARK_SLATE_PREMIUM.primary).toBe("#6366F1");
    expect(DARK_SLATE_PREMIUM.success).toBe("#10B981");
    expect(DARK_SLATE_PREMIUM.alert).toBe("#EF4444");
  });

  it("falls back to the PRD's mode for anything it does not know", () => {
    expect(themeFor("NONSENSE")).toEqual(DARK_SLATE_PREMIUM);
  });
});

describe("phase 2 — dynamic twin binding", () => {
  it("binds the catalogue block to live stock, not to a snapshot", async () => {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    const { resolveBlocks } = await import("@/server/sites/generate");
    const site = await prisma.generatedSite.findFirstOrThrow();
    const structure = site.structure as never as { pages: { blocks: unknown[] }[] };

    const before = await resolveBlocks(workspaceId, site.slug, (structure as never as { pages: never[] }).pages[0]!);
    const catalogueBefore = before.find((block) => block.type === "catalogue")!;
    const first = (catalogueBefore.data.products as { id: string; available: number }[])[0]!;

    // Sell some of it, then look again.
    await prisma.variant.updateMany({
      where: { productId: first.id },
      data: { reserved: { increment: 1 } },
    });

    const after = await resolveBlocks(workspaceId, site.slug, (structure as never as { pages: never[] }).pages[0]!);
    const catalogueAfter = after.find((block) => block.type === "catalogue")!;
    const same = (catalogueAfter.data.products as { id: string; available: number }[]).find((p) => p.id === first.id)!;

    expect(same.available).toBeLessThan(first.available);
  });

  it("gives the quote block its variables and the endpoint, never the formula", async () => {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    const { resolveBlocks } = await import("@/server/sites/generate");
    const site = await prisma.generatedSite.findFirstOrThrow();
    const pages = (site.structure as never as { pages: never[] }).pages;
    const blocks = await resolveBlocks(workspaceId, site.slug, pages[0]!);
    const quote = blocks.find((block) => block.type === "quote_calculator")!;

    expect(quote.data.variables).toEqual(["BASE_VEHICLE_SIZE", "COATING_GRADE", "PAINT_CORRECTION"]);
    expect(quote.data.quoteEndpoint).toBe("/v1/builder/sites/apex-ceramic-detailing/quote");
    expect(JSON.stringify(quote.data)).not.toContain("COATING_GRADE *");
  });

  // Inventing testimonials for a real business is not a placeholder.
  it("says there are no reviews rather than inventing any", async () => {
    const agent = await setup();
    await agent
      .post("/v1/builder/sites/generate")
      .send({
        ...PRD_BODY,
        business_profile: { ...PRD_BODY.business_profile, primary_goals: ["CONTENT_MARKETING"] },
        site_features: { ...PRD_BODY.site_features, custom_quote_formula: undefined },
      })
      .expect(201);

    const site = await prisma.generatedSite.findFirstOrThrow();
    expect(JSON.stringify(site.structure)).not.toMatch(/testimonial|five stars|excellent service/i);
  });
});

describe("quoting from a generated site", () => {
  async function generated() {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);
    return agent;
  }

  it("computes the price from the site's own formula", async () => {
    await generated();
    // 3 × 120 + 250 = 610 → 61,000 minor units
    const res = await anonymous()
      .post("/v1/builder/sites/apex-ceramic-detailing/quote")
      .send({ variables: { BASE_VEHICLE_SIZE: 3, COATING_GRADE: 120, PAINT_CORRECTION: true } })
      .expect(200);

    expect(res.body.amountMinorUnits).toBe(61_000);
  });

  // Public on purpose: a generated site is served to strangers and the
  // calculator on it has to work for them.
  it("is callable without a credential, and sends CORS headers", async () => {
    await generated();
    const res = await anonymous()
      .post("/v1/builder/sites/apex-ceramic-detailing/quote")
      .send({ variables: { BASE_VEHICLE_SIZE: 1, COATING_GRADE: 1, PAINT_CORRECTION: false } })
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // A missing value is refused, never defaulted: quoting a price the business
  // never agreed to is the failure this prevents.
  it("refuses a request that leaves a variable out", async () => {
    await generated();
    const res = await anonymous()
      .post("/v1/builder/sites/apex-ceramic-detailing/quote")
      .send({ variables: { BASE_VEHICLE_SIZE: 3 } })
      .expect(422);

    expect(res.body.error).toContain("No value was given for");
  });

  it("refuses a variable that is not a number or a yes/no", async () => {
    await generated();
    await anonymous()
      .post("/v1/builder/sites/apex-ceramic-detailing/quote")
      .send({ variables: { BASE_VEHICLE_SIZE: "three", COATING_GRADE: 120, PAINT_CORRECTION: true } })
      .expect(422);
  });

  it("404s for a site that does not exist", async () => {
    await generated();
    await anonymous().post("/v1/builder/sites/no-such-site/quote").send({ variables: {} }).expect(404);
  });

  it("409s for a site with no calculator", async () => {
    const agent = await setup();
    await agent
      .post("/v1/builder/sites/generate")
      .send({
        business_profile: { name: "Plain Co", industry: "Retail", primary_goals: ["LEAD_CAPTURE"] },
      })
      .expect(201);

    await anonymous().post("/v1/builder/sites/plain-co/quote").send({ variables: {} }).expect(409);
  });
});

describe("phase 3 — deployment", () => {
  async function generated() {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);
    return agent;
  }

  // The useful distinction is not success versus failure: the site is served
  // either way. What a provider adds is a CDN, a domain and a certificate.
  it("reports honestly that no edge host is configured, and still serves the site", async () => {
    const agent = await generated();
    const res = await agent.post("/v1/builder/sites/apex-ceramic-detailing/deploy").expect(200);

    expect(res.body.edge.ok).toBe(false);
    expect(res.body.edge.provider).toBe("none");
    expect(res.body.edge.reason).toContain("No edge host is configured");
    expect(res.body.site.url).toContain("/s/apex-ceramic-detailing");
    expect(res.body.site.liveUrl).toBeNull();

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("site.deploy_failed");
  });

  it("records the live URL when a provider does take it", async () => {
    const provider: HostingProvider = {
      name: "vercel",
      configured: () => true,
      async deploy(request) {
        return {
          ok: true,
          provider: "vercel",
          url: `https://${request.customDomain ?? request.slug}`,
          sslProvisioned: request.autoProvisionSsl,
        };
      },
    };
    setHostingProvider(provider);

    const agent = await generated();
    const res = await agent.post("/v1/builder/sites/apex-ceramic-detailing/deploy").expect(200);

    expect(res.body.edge).toMatchObject({ ok: true, url: "https://apexdetailaustin.com", sslProvisioned: true });
    const site = await prisma.generatedSite.findFirstOrThrow();
    expect(site.status).toBe("deployed");
    expect(site.liveUrl).toBe("https://apexdetailaustin.com");

    const events = await prisma.twinEvent.findMany();
    expect(events.map((e) => e.type)).toContain("site.deployed");
  });

  it("404s on another tenant's site", async () => {
    await generated();
    const { user: other } = await createUser("other@test.local");
    await createWorkspace({ userId: other.id, name: "Other Co" });
    const intruder = await signedIn("other@test.local");

    await intruder.get("/v1/builder/sites/apex-ceramic-detailing").expect(404);
    await intruder.post("/v1/builder/sites/apex-ceramic-detailing/deploy").expect(404);
  });
});

describe("listing and reading back", () => {
  it("lists what the workspace generated and reads one back in full", async () => {
    const agent = await setup();
    await agent.post("/v1/builder/sites/generate").send(PRD_BODY).expect(201);

    const list = await agent.get("/v1/builder/sites").expect(200);
    expect(list.body.sites).toHaveLength(1);

    const one = await agent.get("/v1/builder/sites/apex-ceramic-detailing").expect(200);
    expect(one.body.site.profile).toMatchObject({ name: "Apex Ceramic & Detailing" });
    expect(one.body.site.structure).toBeDefined();
  });
});
