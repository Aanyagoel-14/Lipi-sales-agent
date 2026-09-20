import { describe, expect, it } from "vitest";
import { detectContact, extractWithRules, vocabularyFor } from "@/server/services/extract";

const apparel = vocabularyFor("apparel");
const parts = vocabularyFor("auto_parts");
const marine = vocabularyFor("marine");
const wholesale = vocabularyFor("wholesale");

const AUG = new Date("2026-08-22T12:00:00Z");

describe("intent", () => {
  it.each([
    ["need 4 blue XL polos", "buy"],
    ["is the linen shirt back in stock", "inventory_request"],
    ["can I return this, it does not fit", "return"],
    ["attaching PO #4471, net 30", "purchase_order"],
    ["the stitching came apart, this is faulty", "complaint"],
  ])("reads %j as %s", (text, expected) => {
    expect(extractWithRules(text, apparel, AUG).intent).toBe(expected);
  });

  // Regression: only "best price" matched, so a wholesale buyer asking
  // "price for 500 units" fell through to `other`.
  it.each(["price for 500 units", "what is your rate for 500", "how much for 500 kg", "best price on 200"])(
    "treats %j as a quote request",
    (text) => {
      expect(extractWithRules(text, wholesale, AUG).intent).toBe("quote_request");
    },
  );
});

describe("quantity extraction avoids years and fitment numbers (H-2)", () => {
  // Audit finding H-2, reproduced verbatim: a bare 4-digit number that looks
  // like a calendar year must not be read as a quantity.
  it("does not read a season year as a quantity", () => {
    const out = extractWithRules("I want the 2026 season olive L polo", apparel, AUG);
    expect(out.quantity).toBeNull();
  });

  it("does not read a fitment year as a quantity", () => {
    // The auto-parts vertical's own vocabulary names fitments "Swift 2018-24",
    // "i20 2020-24", "City 2017-23" -- a bare year in that context is part of
    // the fitment, not a quantity the customer is asking for.
    const out = extractWithRules("brake pads for Swift 2018", parts, AUG);
    expect(out.quantity).toBeNull();
    expect(out.optionA).toBe("Swift 2018-24");
  });

  it("still reads an explicit quantity next to a year-shaped fitment", () => {
    const out = extractWithRules("need 3 brake pads for Swift 2018, aftermarket", parts, AUG);
    expect(out.quantity).toBe(3);
    expect(out.optionA).toBe("Swift 2018-24");
  });

  // A year-shaped number said WITH an explicit unit word is unambiguous and
  // must still win -- the fix must not overcorrect into ignoring every
  // 4-digit number.
  it("trusts a year-shaped number when it carries an explicit unit word", () => {
    const out = extractWithRules("need 2018 units of the polo", apparel, AUG);
    expect(out.quantity).toBe(2018);
  });

  it("still reads an ordinary small quantity correctly", () => {
    expect(extractWithRules("need 3 olive L polos", apparel, AUG).quantity).toBe(3);
  });

  it("ignores a ten-digit phone number entirely", () => {
    // \b\d{1,5}\b cannot match inside an unbroken longer digit run, so this
    // was already safe before the fix; kept as a guard against regressing it.
    expect(extractWithRules("call me on 9876543210 about 3 polos", apparel, AUG).quantity).toBe(3);
  });
});

describe("vocabulary is per trade", () => {
  it("resolves apparel colour aliases", () => {
    const out = extractWithRules("need 4 blue XL polos", apparel, AUG);
    expect(out.optionA).toBe("XL");
    expect(out.optionB).toBe("Cobalt");
    expect(out.category).toBe("Polo");
    expect(out.quantity).toBe(4);
  });

  // Regression: alias lookup stopped at the first alias present in the text.
  // "genuine" resolved to OEM, was not a Fitment, and Swift was lost entirely.
  it("resolves both axes when two aliases appear", () => {
    const out = extractWithRules("do you have genuine brake pads for a swift", parts, AUG);
    expect(out.optionA).toBe("Swift 2018-24");
    expect(out.optionB).toBe("OEM");
    expect(out.category).toBe("Braking");
  });

  it("resolves marine condition aliases", () => {
    const out = extractWithRules("is the twin engine cruiser available secondhand", marine, AUG);
    expect(out.optionA).toBe("Twin engine");
    expect(out.optionB).toBe("Brokerage");
    expect(out.category).toBe("Vessel");
  });

  it("does not leak one trade's words into another", () => {
    // "XL" is an apparel size and means nothing in a parts catalogue.
    expect(extractWithRules("need an XL", parts, AUG).optionA).toBeNull();
  });
});

describe("deadlines", () => {
  it("resolves a weekday to the next such day", () => {
    // 22 Aug 2026 is a Saturday, so Friday is the 28th.
    expect(extractWithRules("need them before friday", apparel, AUG).deadline).toBe("2026-08-28");
  });

  it("marks a deadline as high priority", () => {
    expect(extractWithRules("need them before friday", apparel, AUG).priority).toBe("high");
  });

  it("leaves priority normal without urgency", () => {
    expect(extractWithRules("do you sell polos", apparel, AUG).priority).toBe("normal");
  });
});

describe("ways of saying buy", () => {
  // Regression: only a handful of verbs matched, so "give me 4 blue XL polos"
  // read as `other` and the twin stalled on a customer ready to pay.
  it.each([
    "give me 4 blue XL polos",
    "get me 4 blue XL polos",
    "send me 4 blue XL polos",
    "I'll take 4 blue XL polos",
    "book 4 blue XL polos for me",
    "reserve 4 blue XL polos",
  ])("reads %j as a buy", (text) => {
    const out = extractWithRules(text, apparel, AUG);
    expect(out.intent).toBe("buy");
    expect(out.quantity).toBe(4);
  });

  it("still treats a price question as a quote, not a buy", () => {
    expect(extractWithRules("how much to give me 4 polos", apparel, AUG).intent).toBe("quote_request");
  });
});

/**
 * Contact details are read by pattern, never by the model (issue #16): a
 * wrong phone number written into the twin as fact is worse than no phone
 * number, and a model asked "is this an email" will eventually say yes to
 * something that is not one. So these cases run against `detectContact`
 * directly — it is the same function on both extraction paths.
 */
describe("contact details a visitor types in passing", () => {
  it.each([
    ["mail me at priya@shop.test", "priya@shop.test"],
    ["my email's Priya.Sharma+polos@Shop.co.in, send the invoice there", "priya.sharma+polos@shop.co.in"],
    ["write to ops@lipi.test.", "ops@lipi.test"],
  ])("reads the address out of %j", (text, expected) => {
    expect(detectContact(text).email).toBe(expected);
  });

  it.each([
    ["call me on 9876543210", "9876543210"],
    ["+91 98765 43210 is my number", "+919876543210"],
    ["reach me at 098765-43210", "09876543210"],
  ])("reads the number out of %j", (text, expected) => {
    expect(detectContact(text).phone).toBe(expected);
  });

  it("gives a name only when the visitor says it is one", () => {
    expect(detectContact("my name is Priya Sharma").name).toBe("Priya Sharma");
    expect(detectContact("this is Arjun from Kochi Traders").name).toBe("Arjun");
  });

  // The rest of the extractor already has to tell a quantity from a year;
  // these are the numbers that must never be read as a way to reach someone.
  it.each([
    "need 3 olive L polos",
    "brake pads for Swift 2018",
    "the 2026 season polo, 12 units",
    "order ord_4471 has not arrived",
    "that came to 1,20,000 rupees",
  ])("finds no phone number in %j", (text) => {
    expect(detectContact(text).phone).toBeNull();
  });

  it("does not read the domain of an address as a phone number", () => {
    expect(detectContact("mail me at priya1234567890@shop.test").phone).toBeNull();
  });

  it("does not mistake a sentence about looking for something for a name", () => {
    expect(detectContact("I'm looking for olive polos").name).toBeNull();
    expect(detectContact("call me back tomorrow").name).toBeNull();
  });

  it("finds nothing in an ordinary message", () => {
    expect(detectContact("do you have olive polos in L")).toEqual({ name: null, email: null, phone: null });
  });
});

describe("what the extractor carries the contact on", () => {
  it("hands the rules path's result the contact it found", () => {
    const out = extractWithRules("need 3 olive L polos, mail me at priya@shop.test", apparel, AUG);

    expect(out.contact.email).toBe("priya@shop.test");
    expect(out.intent).toBe("buy");
    expect(out.quantity).toBe(3);
  });
});
