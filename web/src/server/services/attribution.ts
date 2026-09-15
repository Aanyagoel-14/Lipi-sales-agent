import type { Prisma } from "@/generated/prisma/client";

/**
 * Ad-to-customer attribution (Req 3).
 *
 * The moment that matters is the *first* page a visitor's browser ever hit
 * with the webchat widget on it — that is the only point where the ad
 * platform's own query parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`)
 * are actually present in the address bar. By the time that visitor
 * replies to a proactive engagement message three page views later, the
 * parameters are long gone from the URL; there is nothing left to read.
 * So capture happens once, in `services/webchat.ts` at session creation,
 * and this module only ever *copies* that first-touch record onto the
 * `Customer` row — it never re-derives or overwrites it.
 *
 * "Never overwrite" is deliberate: a returning customer who clicks a
 * retargeting ad a month after their first purchase should not have their
 * original acquisition channel silently replaced by the retargeting
 * campaign. First touch is where the relationship is credited, in the same
 * spirit most ad platforms model attribution.
 */

export type AttributionTouch = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  adClickId: string | null;
  landingPage: string | null;
  referrer: string | null;
};

export const EMPTY_TOUCH: AttributionTouch = {
  utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null,
  utmContent: null, adClickId: null, landingPage: null, referrer: null,
};

/** True when a touch actually carries some attribution signal, so a bare
 *  direct visit (no query string, no referrer) does not stamp a customer
 *  with eight null columns and a `firstTouchAt` that means nothing. */
export const hasAttribution = (t: AttributionTouch) =>
  Object.entries(t).some(([, v]) => v !== null);

/**
 * The `Customer.update()` data to apply *only when this is the customer's
 * first touch*. Callers must check that themselves (e.g. `isNew` from
 * `ingest()`) — this function does not query, it only shapes the write, so
 * it stays usable inside an existing transaction without an extra round
 * trip.
 */
export function firstTouchData(touch: AttributionTouch, now: Date): Prisma.CustomerUpdateInput {
  if (!hasAttribution(touch)) return {};
  return {
    utmSource: touch.utmSource, utmMedium: touch.utmMedium, utmCampaign: touch.utmCampaign,
    utmTerm: touch.utmTerm, utmContent: touch.utmContent, adClickId: touch.adClickId,
    landingPage: touch.landingPage, referrer: touch.referrer, firstTouchAt: now,
  };
}
