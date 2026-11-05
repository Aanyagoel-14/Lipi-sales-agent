import type { CatalogueImportRow } from "./onboarding";

/**
 * The template's columns. A product varies by size and colour, so those are
 * the two columns a seller fills in; the axis names they replace are implied.
 * `currency` is written into the template by the server, from what the
 * deployment invoices in, and `description` is the seller's own sentence or
 * two about the product.
 */
export const CATALOGUE_COLUMNS = [
  "product", "category", "size", "colour", "price_inr", "currency",
  "stock", "margin_pct", "lead_time_days", "description",
] as const;

/**
 * The columns the template used to have, where the seller named both axes
 * themselves. Still accepted, because a product that does not vary by colour
 * (a journal sold by size and page count) has no other way in, and because
 * files built from the old template are still out there.
 */
export const LEGACY_AXIS_COLUMNS = ["axis_a_name", "axis_a_value", "axis_b_name", "axis_b_value"] as const;

/** What the size and colour columns stand for, as the product's axis names. */
export const TEMPLATE_AXES = ["Size", "Colour"] as const;

/** Columns a file must have whichever way it names its axes. */
const COMMON_COLUMNS = ["product", "category", "price_inr", "stock", "margin_pct", "lead_time_days"] as const;

const MAX_DESCRIPTION = 500;

// Supports quoted cells and escaped quotes without adding a spreadsheet parser
// to the browser bundle. Newlines inside cells are deliberately rejected.
function cells(line: string) {
  const out: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { out.push(value.trim()); value = ""; }
    else value += char;
  }
  if (quoted) throw new Error("A quoted cell is not closed");
  out.push(value.trim());
  return out;
}

const csvCell = (value: string) => (/[",]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function parseCatalogueCsv(input: string): CatalogueImportRow[] {
  const lines = input.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("The file needs a header and at least one variant row");
  // "color" is read as "colour": both spellings are what people type.
  const header = cells(lines[0]!).map((v) => v.toLowerCase()).map((v) => (v === "color" ? "colour" : v));

  const sizeColour = header.includes("size") && header.includes("colour");
  const legacy = !sizeColour && LEGACY_AXIS_COLUMNS.every((column) => header.includes(column));
  const missing = [
    ...(sizeColour || legacy ? [] : (["size", "colour"] as const).filter((column) => !header.includes(column))),
    ...COMMON_COLUMNS.filter((column) => !header.includes(column)),
  ];
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`);

  const at = (row: string[], name: string) => (header.includes(name) ? row[header.indexOf(name)]?.trim() ?? "" : "");
  const number = (row: string[], name: "price_inr" | "stock" | "margin_pct" | "lead_time_days", line: number) => {
    const raw = at(row, name);
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 0) throw new Error(`Row ${line}: ${name} must be a whole number`);
    return value;
  };

  return lines.slice(1).map((line, i) => {
    const row = cells(line);
    const required = sizeColour
      ? (["product", "category", "size", "colour"] as const)
      : (["product", "category", ...LEGACY_AXIS_COLUMNS] as const);
    const absent = required.find((name) => !at(row, name));
    if (absent) throw new Error(`Row ${i + 2}: ${absent} is empty`);

    const currency = at(row, "currency").toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(`Row ${i + 2}: currency must be a three-letter code`);
    const description = at(row, "description");
    if (description.length > MAX_DESCRIPTION) {
      throw new Error(`Row ${i + 2}: description must be ${MAX_DESCRIPTION} characters or fewer`);
    }

    return {
      product: at(row, "product"), category: at(row, "category"),
      ...(sizeColour
        ? { axisAName: TEMPLATE_AXES[0], axisAValue: at(row, "size"), axisBName: TEMPLATE_AXES[1], axisBValue: at(row, "colour") }
        : {
            axisAName: at(row, "axis_a_name"), axisAValue: at(row, "axis_a_value"),
            axisBName: at(row, "axis_b_name"), axisBValue: at(row, "axis_b_value"),
          }),
      priceInr: number(row, "price_inr", i + 2), stock: number(row, "stock", i + 2),
      marginPct: number(row, "margin_pct", i + 2), leadTimeDays: number(row, "lead_time_days", i + 2),
      ...(currency ? { currency } : {}),
      ...(description ? { description } : {}),
    };
  });
}

/** The example rows the template ships with, in column order bar the currency. */
const EXAMPLE_ROWS = [
  ["Polo Classic", "Polos", "L", "Olive", "1196", "14", "41", "6", "Pique cotton polo with a two-button placket."],
  ["Polo Classic", "Polos", "XL", "Olive", "1196", "8", "41", "6", "Pique cotton polo with a two-button placket."],
];

/**
 * The downloadable template, with `currency` filled in on every row. The
 * currency is the server's to state, so the server builds this file; see
 * `/v1/catalogue/import/template`.
 */
export function catalogueCsvTemplate(currency: string): string {
  const rows = EXAMPLE_ROWS.map(([product, category, size, colour, price, stock, margin, lead, description]) =>
    [product, category, size, colour, price, currency, stock, margin, lead, description].map((v) => csvCell(v!)).join(","));
  return [CATALOGUE_COLUMNS.join(","), ...rows].join("\n");
}

/** The template as it reads for the deployment's default currency, for tests and docs. */
export const CATALOGUE_CSV_EXAMPLE = catalogueCsvTemplate("INR");
