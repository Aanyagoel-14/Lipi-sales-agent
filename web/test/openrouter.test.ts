import { describe, expect, it } from "vitest";
import { stripReasoning, tidyMarkdownLists, unglueTrailingSentence } from "@/server/lib/openrouter";

describe("tidying run-together lists", () => {
  // The bug: asked for JSON, the model writes its list with spaces instead of
  // newlines, and markdown renders one paragraph full of stray dashes.
  it("puts each bullet on its own line", () => {
    const run = "Here's what we have:  - **Leather Belt** — ₹1,450  - **Linen Shirt** — ₹2,240  - **Polo Classic** — ₹1,196";
    expect(tidyMarkdownLists(run)).toBe(
      "Here's what we have:\n- **Leather Belt** — ₹1,450\n- **Linen Shirt** — ₹2,240\n- **Polo Classic** — ₹1,196",
    );
  });

  it("leaves a reply that already has line breaks alone", () => {
    const good = "Here's what we have:\n- **Belt** — ₹1,450\n- **Shirt** — ₹2,240";
    expect(tidyMarkdownLists(good)).toBe(good);
  });

  // A single dash is punctuation far more often than it is a list.
  it("leaves ordinary prose with a dash alone", () => {
    const prose = "We have 9 in stock - shall I reserve two for you?";
    expect(tidyMarkdownLists(prose)).toBe(prose);
  });

  it("leaves hyphenated words and em dashes alone", () => {
    const prose = "Metro delivery is 2-3 days — and it ships today.";
    expect(tidyMarkdownLists(prose)).toBe(prose);
  });
});

describe("stripping reasoning", () => {
  it("removes a closed think block", () => {
    expect(stripReasoning("<think>hmm, stock is 9</think>\n\n9 left.")).toBe("9 left.");
  });

  it("removes an unclosed one, which has no answer after it", () => {
    expect(stripReasoning("9 left.<think>wait, let me reconsider")).toBe("9 left.");
  });

  it("leaves an ordinary reply untouched", () => {
    expect(stripReasoning("9 left in XL/Cobalt.")).toBe("9 left in XL/Cobalt.");
  });
});

describe("ungluing a trailing sentence", () => {
  it("splits a question that ran onto the last list item", () => {
    const glued = "Here you go:\n- **Belt** — ₹1,450\n- **Chino** — ₹1,890  Which size would you like?";
    expect(unglueTrailingSentence(glued)).toBe(
      "Here you go:\n- **Belt** — ₹1,450\n- **Chino** — ₹1,890\n\nWhich size would you like?",
    );
  });

  it("leaves a bullet whose spacing is just spacing", () => {
    const fine = "- **Belt** — ₹1,450  in Black and Tan";
    expect(unglueTrailingSentence(fine)).toBe(fine);
  });

  it("leaves ordinary paragraphs alone", () => {
    const prose = "We have 9 in stock.  Would you like two?";
    expect(unglueTrailingSentence(prose)).toBe(prose);
  });
});
