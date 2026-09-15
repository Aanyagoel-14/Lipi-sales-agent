import { z } from "zod";

/**
 * Public, unauthenticated schemas for the webchat widget. `visitorId` is a
 * client-minted opaque id (see `public/static/widget.js`), not a real
 * session token — see the trust-boundary note at the top of
 * `services/webchat.ts` for why that is an intentional, narrow scope.
 */
const touchSchema = z.object({
  utmSource: z.string().trim().max(200).nullable().default(null),
  utmMedium: z.string().trim().max(200).nullable().default(null),
  utmCampaign: z.string().trim().max(200).nullable().default(null),
  utmTerm: z.string().trim().max(200).nullable().default(null),
  utmContent: z.string().trim().max(200).nullable().default(null),
  adClickId: z.string().trim().max(300).nullable().default(null),
  landingPage: z.string().trim().max(2000).nullable().default(null),
  referrer: z.string().trim().max(2000).nullable().default(null),
});

export const sessionSchema = z.object({
  visitorId: z.string().trim().min(8).max(80),
  touch: touchSchema.default({
    utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null,
    utmContent: null, adClickId: null, landingPage: null, referrer: null,
  }),
});

export const messageSchema = z.object({
  visitorId: z.string().trim().min(8).max(80),
  text: z.string().trim().min(1).max(2000),
  name: z.string().trim().max(120).optional(),
});

export const updatesSchema = z.object({
  visitorId: z.string().trim().min(8).max(80),
  conversationId: z.string().trim().min(1).max(60),
  sinceIso: z.string().trim().max(40).optional(),
});
