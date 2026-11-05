import { describe, expect, it } from "vitest";
import { CATALOGUE_CSV_EXAMPLE, catalogueCsvTemplate, parseCatalogueCsv } from "../src/lib/catalogue-import";

describe("catalogue CSV", () => {
  it("parses one row per sellable variant", () => {
    const rows = parseCatalogueCsv(CATALOGUE_CSV_EXAMPLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ product: "Polo Classic", axisAValue: "L", axisBValue: "Olive", stock: 14 });
  });

  it("reads size and colour as the product's two axes", () => {
    const [row] = parseCatalogueCsv(CATALOGUE_CSV_EXAMPLE);
    expect(row).toMatchObject({ axisAName: "Size", axisAValue: "L", axisBName: "Colour", axisBValue: "Olive" });
  });

  it("carries the currency and the description through", () => {
    const [row] = parseCatalogueCsv(catalogueCsvTemplate("inr"));
    expect(row).toMatchObject({ currency: "INR", description: "Pique cotton polo with a two-button placket." });
  });

  it("accepts the American spelling of colour", () => {
    const input = CATALOGUE_CSV_EXAMPLE.replace(",colour,", ",Color,");
    expect(parseCatalogueCsv(input)[0]).toMatchObject({ axisBName: "Colour", axisBValue: "Olive" });
  });

  it("leaves currency and description out when the file has neither", () => {
    const input = "product,category,size,colour,price_inr,stock,margin_pct,lead_time_days\nTote,Bags,One size,Black,800,12,30,4";
    const [row] = parseCatalogueCsv(input);
    expect(row).not.toHaveProperty("currency");
    expect(row).not.toHaveProperty("description");
  });

  it("still reads a file in the old axis-name format", () => {
    const input = [
      "product,category,axis_a_name,axis_a_value,axis_b_name,axis_b_value,price_inr,stock,margin_pct,lead_time_days",
      "Dotted Journal,Journal,Size,A5,Page Count,192 Pages,349,31,30,7",
    ].join("\n");
    expect(parseCatalogueCsv(input)[0]).toMatchObject({
      axisAName: "Size", axisAValue: "A5", axisBName: "Page Count", axisBValue: "192 Pages",
    });
  });

  it("supports commas and escaped quotes inside quoted cells", () => {
    const input = CATALOGUE_CSV_EXAMPLE.replace("Polo Classic,Polos", '"Polo, Classic","Polos ""Core"""');
    expect(parseCatalogueCsv(input)[0]).toMatchObject({ product: "Polo, Classic", category: 'Polos "Core"' });
  });

  it("reports missing columns before importing", () => {
    expect(() => parseCatalogueCsv("product,stock\nPolo,2")).toThrow(/Missing columns: size, colour, category/);
  });

  it("names the row whose colour is empty", () => {
    const input = CATALOGUE_CSV_EXAMPLE.replace(",XL,Olive,", ",XL,,");
    expect(() => parseCatalogueCsv(input)).toThrow(/Row 3: colour is empty/);
  });

  it("refuses a currency that is not a three-letter code", () => {
    const input = CATALOGUE_CSV_EXAMPLE.replace(",INR,", ",Rupees,");
    expect(() => parseCatalogueCsv(input)).toThrow(/currency must be a three-letter code/);
  });
});
