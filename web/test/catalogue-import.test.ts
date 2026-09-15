import { describe, expect, it } from "vitest";
import { CATALOGUE_CSV_EXAMPLE, parseCatalogueCsv } from "../src/lib/catalogue-import";

describe("catalogue CSV", () => {
  it("parses one row per sellable variant", () => {
    const rows = parseCatalogueCsv(CATALOGUE_CSV_EXAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ product: "Polo Classic", axisAValue: "L", axisBValue: "Olive", stock: 14 });
  });

  it("supports commas and escaped quotes inside quoted cells", () => {
    const input = CATALOGUE_CSV_EXAMPLE.replace("Polo Classic,Polos", '"Polo, Classic","Polos ""Core"""');
    expect(parseCatalogueCsv(input)[0]).toMatchObject({ product: "Polo, Classic", category: 'Polos "Core"' });
  });

  it("reports missing columns before importing", () => {
    expect(() => parseCatalogueCsv("product,stock\nPolo,2")).toThrow(/Missing columns/);
  });
});
