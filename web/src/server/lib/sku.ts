/**
 * SKU generation (L-1d fix).
 *
 * A SKU is generated once, at the moment a variant is created, and stored on
 * the row. Every call site that creates a variant — the manual product form,
 * the CSV importer, and demo provisioning — goes through this one function,
 * so the format is consistent everywhere a SKU is shown or logged.
 *
 * The audit's finding: SKUs used to be rebuilt on every read from the
 * product's *current* name and the variant's *current* option values.
 * Renaming a product ("Polo Classic" -> "Polo Classic V2") silently changed
 * the SKU of every one of its variants, which broke anything that had
 * written the old SKU down — an inventory connector's mapping, a past
 * `TwinEvent` payload, an operator's own paper trail. Storing it fixes that:
 * a rename no longer touches history.
 */
export function generateSku(productName: string, optionA: string, optionB: string): string {
  const slug = (s: string) => s.trim().replace(/\s+/g, "-").toUpperCase();
  return `${slug(productName)}-${slug(optionA)}-${slug(optionB)}`;
}
