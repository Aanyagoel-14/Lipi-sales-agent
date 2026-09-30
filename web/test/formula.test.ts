import { describe, expect, it } from "vitest";
import {
  evaluateFormula,
  evaluateQuote,
  FormulaError,
  parseFormula,
  variablesIn,
} from "@/server/sites/formula";

/**
 * The quote formula language (PRD §3.1).
 *
 * An operator types an expression into a form and a stranger's browser then
 * asks for a price computed from it. Two thirds of this file is therefore
 * about what the language *cannot* do, because that is the part that matters:
 * there is no `eval` here and there must be no way to reach one.
 */

const evaluate = (source: string, scope: Record<string, number | boolean> = {}) =>
  evaluateFormula(parseFormula(source), scope);

describe("the PRD's own formula", () => {
  // BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)
  const PRD = "BASE_VEHICLE_SIZE * COATING_GRADE + (PAINT_CORRECTION ? 250 : 0)";

  it("parses and names exactly the variables it reads", () => {
    expect(variablesIn(parseFormula(PRD))).toEqual([
      "BASE_VEHICLE_SIZE", "COATING_GRADE", "PAINT_CORRECTION",
    ]);
  });

  it("computes the PRD's example with the correction", () => {
    // 3 × 120 + 250
    expect(evaluate(PRD, { BASE_VEHICLE_SIZE: 3, COATING_GRADE: 120, PAINT_CORRECTION: true })).toBe(610);
  });

  it("computes it without the correction", () => {
    expect(evaluate(PRD, { BASE_VEHICLE_SIZE: 3, COATING_GRADE: 120, PAINT_CORRECTION: false })).toBe(360);
  });

  it("produces a price in integer minor units", () => {
    const quote = evaluateQuote(parseFormula(PRD), {
      BASE_VEHICLE_SIZE: 2.5, COATING_GRADE: 99.99, PAINT_CORRECTION: true,
    });
    // 2.5 × 99.99 = 249.975, + 250 = 499.975 → 49,998 minor units
    expect(quote).toBe(49_998);
  });
});

describe("arithmetic", () => {
  it("respects precedence and associativity", () => {
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("10 - 3 - 2")).toBe(5);
    expect(evaluate("100 / 10 / 2")).toBe(5);
    expect(evaluate("-3 + 5")).toBe(2);
  });

  it("reads decimals", () => {
    expect(evaluate("1.5 * 2")).toBe(3);
    expect(evaluate(".5 + .25")).toBe(0.75);
  });

  it("compares", () => {
    expect(evaluate("3 > 2")).toBe(true);
    expect(evaluate("3 >= 3")).toBe(true);
    expect(evaluate("3 == 3")).toBe(true);
    expect(evaluate("3 != 3")).toBe(false);
    expect(evaluate("2 < 1")).toBe(false);
  });

  it("nests ternaries to the right", () => {
    expect(evaluate("A ? 1 : B ? 2 : 3", { A: false, B: true })).toBe(2);
    expect(evaluate("A ? 1 : B ? 2 : 3", { A: false, B: false })).toBe(3);
  });

  it("treats a boolean as 1 or 0 in arithmetic, and a number as truthy", () => {
    expect(evaluate("X * 10", { X: true })).toBe(10);
    expect(evaluate("X ? 1 : 2", { X: 5 })).toBe(1);
    expect(evaluate("X ? 1 : 2", { X: 0 })).toBe(2);
  });

  // `A || B` must not demand a value for B when A already decided it, which
  // is how an optional variable stays optional.
  it("short-circuits, so an unused variable need not be supplied", () => {
    expect(evaluate("A || B", { A: true })).toBe(true);
    expect(evaluate("A && B", { A: false })).toBe(false);
    expect(() => evaluate("A || B", { A: false })).toThrow(/No value was given for B/);
  });
});

describe("what it refuses", () => {
  // The whole reason this is a parser and not `eval`.
  it("has no function calls, property access or assignment", () => {
    for (const source of [
      "process.exit(1)",
      "A.b",
      "A['b']",
      "require('fs')",
      "A = 1",
      "(() => 1)()",
      "`${A}`",
      "A; B",
    ]) {
      expect(() => parseFormula(source), source).toThrow(FormulaError);
    }
  });

  // A bare name parses as a variable — `constructor` and `globalThis` are
  // spelled like one and there is nothing to do with them but look them up.
  // The danger was never the parse; it was the lookup. Every object literal
  // inherits `constructor`, `toString` and `__proto__` from `Object.prototype`,
  // so `name in scope` used to be true for names nobody put there, and the
  // lookup returned a function that flowed into the arithmetic as NaN and out
  // the other side as a price.
  it("resolves only names somebody actually put in the scope", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "globalThis"]) {
      expect(() => evaluate(name), name).toThrow(/No value was given for/);
      expect(() => evaluate(`${name} * 2`), name).toThrow(/No value was given for/);
    }
  });

  it("refuses a scope value that is not a number or a yes/no", () => {
    // @ts-expect-error — the point is what happens when the type is wrong.
    expect(() => evaluate("A + 1", { A: "10" })).toThrow(/not a number or a yes\/no/);
    // @ts-expect-error — likewise.
    expect(() => evaluate("A + 1", { A: null })).toThrow(/not a number or a yes\/no/);
  });

  it("refuses an unbalanced expression", () => {
    for (const source of ["(1 + 2", "1 + ", "1 ? 2", "* 3", ")"]) {
      expect(() => parseFormula(source), source).toThrow(FormulaError);
    }
  });

  it("refuses an empty formula", () => {
    expect(() => parseFormula("   ")).toThrow(/empty/);
  });

  // Length is not a bound on nesting: 1,500 open parentheses is 1,501
  // characters and 1,500 stack frames.
  it("refuses a formula that nests deeper than a person would write", () => {
    expect(() => parseFormula("(".repeat(1500) + "1")).toThrow(/nests more than/);
    expect(() => parseFormula("(".repeat(21) + "1" + ")".repeat(21))).toThrow(/nests more than/);
    expect(evaluate("(".repeat(19) + "1" + ")".repeat(19))).toBe(1);
  });

  it("refuses a formula long enough to be an attack", () => {
    expect(() => parseFormula("1 + ".repeat(1000) + "1")).toThrow(/too long/);
  });

  // A missing variable is an error, never a zero: silently treating
  // `PAINT_CORRECTION` as false quotes a price the business never agreed to.
  it("refuses a variable the scope does not hold", () => {
    expect(() => evaluate("A + 1")).toThrow(/No value was given for A/);
  });

  it("refuses a variable that is not a usable number", () => {
    expect(() => evaluate("A + 1", { A: Number.NaN })).toThrow(/not a usable number/);
    expect(() => evaluate("A + 1", { A: Number.POSITIVE_INFINITY })).toThrow(/not a usable number/);
  });

  // `Infinity` renders as a price, and the customer is the one who finds out.
  it("refuses division by zero", () => {
    expect(() => evaluate("1 / 0")).toThrow(/Division by zero/);
    expect(() => evaluate("1 / A", { A: 0 })).toThrow(/Division by zero/);
  });

  it("refuses a negative price", () => {
    expect(() => evaluateQuote(parseFormula("0 - 5"), {})).toThrow(/negative price/);
  });

  it("says where a syntax error is", () => {
    try {
      parseFormula("1 + @");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      expect((error as FormulaError).position).toBe(4);
    }
  });
});

describe("parsing once and evaluating many times", () => {
  it("reuses the tree across visitors", () => {
    const tree = parseFormula("BASE * GRADE");
    expect(evaluateFormula(tree, { BASE: 2, GRADE: 3 })).toBe(6);
    expect(evaluateFormula(tree, { BASE: 4, GRADE: 5 })).toBe(20);
  });
});
