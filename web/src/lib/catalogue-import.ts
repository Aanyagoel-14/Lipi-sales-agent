import type { CatalogueImportRow } from "./onboarding";

export const CATALOGUE_COLUMNS = [
  "product", "category", "axis_a_name", "axis_a_value", "axis_b_name",
  "axis_b_value", "price_inr", "stock", "margin_pct", "lead_time_days",
] as const;

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

export function parseCatalogueCsv(input: string): CatalogueImportRow[] {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("The file needs a header and at least one variant row");
  const header = cells(lines[0]!).map((v) => v.toLowerCase());
  const missing = CATALOGUE_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}`);

  const at = (row: string[], name: typeof CATALOGUE_COLUMNS[number]) => row[header.indexOf(name)]?.trim() ?? "";
  const number = (row: string[], name: "price_inr" | "stock" | "margin_pct" | "lead_time_days", line: number) => {
    const raw = at(row, name);
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 0) throw new Error(`Row ${line}: ${name} must be a whole number`);
    return value;
  };

  return lines.slice(1).map((line, i) => {
    const row = cells(line);
    const required = ["product", "category", "axis_a_name", "axis_a_value", "axis_b_name", "axis_b_value"] as const;
    const absent = required.find((name) => !at(row, name));
    if (absent) throw new Error(`Row ${i + 2}: ${absent} is empty`);
    return {
      product: at(row, "product"), category: at(row, "category"),
      axisAName: at(row, "axis_a_name"), axisAValue: at(row, "axis_a_value"),
      axisBName: at(row, "axis_b_name"), axisBValue: at(row, "axis_b_value"),
      priceInr: number(row, "price_inr", i + 2), stock: number(row, "stock", i + 2),
      marginPct: number(row, "margin_pct", i + 2), leadTimeDays: number(row, "lead_time_days", i + 2),
    };
  });
}

export const CATALOGUE_CSV_EXAMPLE = `${CATALOGUE_COLUMNS.join(",")}\nPolo Classic,Polos,Size,L,Colour,Olive,1196,14,41,6\nPolo Classic,Polos,Size,XL,Colour,Olive,1196,8,41,6`;
