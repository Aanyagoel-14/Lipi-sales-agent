/**
 * A catalogue per vertical.
 *
 * The vertical chosen at onboarding decides what a product *is*, not just how
 * it is labelled. Apparel sells one garment as thirty sellable things across
 * Size and Colour; an auto part is only real in relation to a vehicle, so its
 * axes are Fitment and Grade. Provisioning apparel for a parts business and
 * calling it "your twin" would be a lie the operator finds out about later.
 */

export type Vertical = "apparel" | "auto_parts" | "marine" | "wholesale";

export type CatalogueProduct = {
  name: string;
  category: string;
  axes: [string, string];
  optionsA: string[];
  optionsB: string[];
  /** Stock per optionA, in the same order, repeated across optionsB. */
  stock: number[][];
  priceInr: number;
  marginPct: number;
  leadTimeDays: number;
  attributes: Record<string, string>;
  supplier: string;
};

export type Catalogue = {
  suppliers: { name: string; onTimePct: number; avgLeadDays: number; defectRatePct: number; moq: number; responseHours: number }[];
  products: CatalogueProduct[];
  /** Terms the extractor should recognise for this trade. */
  vocabulary: { categories: Record<string, string>; optionAliases: Record<string, string> };
};

const APPAREL: Catalogue = {
  suppliers: [
    { name: "Fabrico Mills", onTimePct: 96, avgLeadDays: 6, defectRatePct: 0.8, moq: 60, responseHours: 4 },
    { name: "Northloom Textiles", onTimePct: 88, avgLeadDays: 9, defectRatePct: 1.9, moq: 100, responseHours: 11 },
    { name: "Hidecraft Leather", onTimePct: 92, avgLeadDays: 4, defectRatePct: 1.1, moq: 40, responseHours: 7 },
  ],
  products: [
    { name: "Polo Classic", category: "Polo", axes: ["Size", "Colour"], optionsA: ["S","M","L","XL","XXL"], optionsB: ["Cobalt","Olive","White"],
      stock: [[12,26,18,4,0],[8,14,22,11,3],[0,6,9,2,0]], priceInr: 1196, marginPct: 41, leadTimeDays: 6,
      attributes: { fabric: "Pique cotton", season: "SS26", fit: "Regular" }, supplier: "Fabrico Mills" },
    { name: "Tapered Chino", category: "Trouser", axes: ["Size", "Colour"], optionsA: ["S","M","L","XL","XXL"], optionsB: ["Stone","Navy","Olive"],
      stock: [[14,31,27,16,5],[9,22,19,8,2],[3,11,14,6,1]], priceInr: 1890, marginPct: 37, leadTimeDays: 9,
      attributes: { fabric: "Stretch twill", season: "SS26", fit: "Tapered" }, supplier: "Northloom Textiles" },
    { name: "Linen Shirt", category: "Shirt", axes: ["Size", "Colour"], optionsA: ["S","M","L","XL","XXL"], optionsB: ["White","Sand","Sky"],
      stock: [[0,2,5,1,0],[6,13,17,9,2],[4,9,12,7,3]], priceInr: 2240, marginPct: 44, leadTimeDays: 12,
      attributes: { fabric: "Washed linen", season: "SS26", fit: "Relaxed" }, supplier: "Fabrico Mills" },
    { name: "Leather Belt", category: "Accessory", axes: ["Size", "Colour"], optionsA: ["S","M","L","XL","XXL"], optionsB: ["Tan","Black"],
      stock: [[18,24,21,12,4],[15,28,25,14,6]], priceInr: 1450, marginPct: 52, leadTimeDays: 4,
      attributes: { material: "Full-grain leather", season: "Core" }, supplier: "Hidecraft Leather" },
  ],
  vocabulary: {
    categories: { polo: "Polo", polos: "Polo", shirt: "Shirt", shirts: "Shirt", linen: "Shirt", oxford: "Shirt",
      chino: "Trouser", chinos: "Trouser", trouser: "Trouser", trousers: "Trouser", pants: "Trouser",
      belt: "Accessory", belts: "Accessory" },
    optionAliases: { blue: "Cobalt", beige: "Sand", cream: "White" },
  },
};

const AUTO_PARTS: Catalogue = {
  suppliers: [
    { name: "Delphi Distribution", onTimePct: 94, avgLeadDays: 5, defectRatePct: 0.6, moq: 20, responseHours: 6 },
    { name: "Bharat Auto Spares", onTimePct: 85, avgLeadDays: 11, defectRatePct: 2.4, moq: 50, responseHours: 14 },
  ],
  products: [
    { name: "Front Brake Pad Set", category: "Braking", axes: ["Fitment", "Grade"],
      optionsA: ["Swift 2018-24", "i20 2020-24", "City 2017-23", "Creta 2020-24"], optionsB: ["OEM", "Aftermarket"],
      stock: [[14, 9, 22, 6], [31, 18, 27, 12]], priceInr: 2450, marginPct: 34, leadTimeDays: 5,
      attributes: { position: "Front axle", material: "Ceramic", warranty: "12 months" }, supplier: "Delphi Distribution" },
    { name: "Oil Filter", category: "Filtration", axes: ["Fitment", "Grade"],
      optionsA: ["Swift 2018-24", "i20 2020-24", "City 2017-23", "Creta 2020-24"], optionsB: ["OEM", "Aftermarket"],
      stock: [[46, 38, 51, 29], [72, 64, 80, 55]], priceInr: 420, marginPct: 48, leadTimeDays: 3,
      attributes: { thread: "M20 x 1.5", warranty: "6 months" }, supplier: "Bharat Auto Spares" },
    { name: "Headlamp Assembly", category: "Lighting", axes: ["Fitment", "Grade"],
      optionsA: ["Swift 2018-24", "i20 2020-24", "City 2017-23", "Creta 2020-24"], optionsB: ["OEM", "Aftermarket"],
      stock: [[3, 1, 5, 0], [8, 4, 9, 2]], priceInr: 8900, marginPct: 27, leadTimeDays: 14,
      attributes: { type: "LED projector", side: "Driver", warranty: "24 months" }, supplier: "Delphi Distribution" },
    { name: "Clutch Kit", category: "Transmission", axes: ["Fitment", "Grade"],
      optionsA: ["Swift 2018-24", "i20 2020-24", "City 2017-23", "Creta 2020-24"], optionsB: ["OEM", "Aftermarket"],
      stock: [[6, 4, 7, 2], [11, 9, 13, 5]], priceInr: 11400, marginPct: 31, leadTimeDays: 9,
      attributes: { includes: "Plate, cover, bearing", warranty: "18 months" }, supplier: "Bharat Auto Spares" },
  ],
  vocabulary: {
    categories: { brake: "Braking", brakes: "Braking", pad: "Braking", pads: "Braking",
      filter: "Filtration", filters: "Filtration", oil: "Filtration",
      headlamp: "Lighting", headlight: "Lighting", lamp: "Lighting",
      clutch: "Transmission" },
    optionAliases: { genuine: "OEM", original: "OEM", aftermarket: "Aftermarket", swift: "Swift 2018-24",
      i20: "i20 2020-24", city: "City 2017-23", creta: "Creta 2020-24" },
  },
};

const MARINE: Catalogue = {
  suppliers: [
    { name: "Konkan Marine Works", onTimePct: 91, avgLeadDays: 21, defectRatePct: 0.4, moq: 1, responseHours: 9 },
    { name: "Blue Harbour Trading", onTimePct: 87, avgLeadDays: 30, defectRatePct: 0.9, moq: 1, responseHours: 18 },
  ],
  products: [
    { name: "Coastal Cruiser 28", category: "Vessel", axes: ["Configuration", "Condition"],
      optionsA: ["Single engine", "Twin engine"], optionsB: ["New", "Brokerage"],
      stock: [[2, 1], [1, 3]], priceInr: 4850000, marginPct: 18, leadTimeDays: 90,
      attributes: { length: "28 ft", hull: "GRP", berths: "4", survey: "2026" }, supplier: "Konkan Marine Works" },
    { name: "Harbour Tender 14", category: "Tender", axes: ["Configuration", "Condition"],
      optionsA: ["Outboard 40hp", "Outboard 60hp"], optionsB: ["New", "Brokerage"],
      stock: [[4, 2], [3, 1]], priceInr: 780000, marginPct: 24, leadTimeDays: 35,
      attributes: { length: "14 ft", hull: "Aluminium", berths: "0" }, supplier: "Blue Harbour Trading" },
    { name: "Inboard Service Kit", category: "Parts", axes: ["Configuration", "Condition"],
      optionsA: ["250hr", "500hr"], optionsB: ["New", "Brokerage"],
      stock: [[9, 0], [6, 0]], priceInr: 46000, marginPct: 39, leadTimeDays: 12,
      attributes: { includes: "Impeller, filters, anodes", warranty: "12 months" }, supplier: "Konkan Marine Works" },
  ],
  vocabulary: {
    categories: { boat: "Vessel", vessel: "Vessel", cruiser: "Vessel", yacht: "Vessel",
      tender: "Tender", dinghy: "Tender", service: "Parts", kit: "Parts", parts: "Parts" },
    optionAliases: { used: "Brokerage", secondhand: "Brokerage", "second-hand": "Brokerage", brokerage: "Brokerage", new: "New" },
  },
};

const WHOLESALE: Catalogue = {
  suppliers: [
    { name: "Ratnagiri Packers", onTimePct: 93, avgLeadDays: 7, defectRatePct: 1.2, moq: 200, responseHours: 5 },
    { name: "Deccan Bulk Supply", onTimePct: 89, avgLeadDays: 10, defectRatePct: 1.7, moq: 500, responseHours: 12 },
  ],
  products: [
    { name: "Arabica Coffee Beans", category: "Beverage", axes: ["Pack size", "Grade"],
      optionsA: ["1 kg", "5 kg", "25 kg"], optionsB: ["Standard", "Premium"],
      stock: [[420, 180, 64], [260, 110, 38]], priceInr: 620, marginPct: 29, leadTimeDays: 7,
      attributes: { origin: "Chikmagalur", roast: "Medium", shelfLife: "12 months" }, supplier: "Ratnagiri Packers" },
    { name: "Basmati Rice", category: "Grain", axes: ["Pack size", "Grade"],
      optionsA: ["1 kg", "5 kg", "25 kg"], optionsB: ["Standard", "Premium"],
      stock: [[900, 540, 210], [430, 260, 96]], priceInr: 185, marginPct: 22, leadTimeDays: 5,
      attributes: { origin: "Punjab", ageing: "12 months" }, supplier: "Deccan Bulk Supply" },
    { name: "Cold Pressed Groundnut Oil", category: "Oil", axes: ["Pack size", "Grade"],
      optionsA: ["1 L", "5 L", "15 L"], optionsB: ["Standard", "Premium"],
      stock: [[310, 140, 48], [175, 82, 21]], priceInr: 240, marginPct: 26, leadTimeDays: 6,
      attributes: { process: "Cold pressed", shelfLife: "9 months" }, supplier: "Ratnagiri Packers" },
    { name: "Turmeric Powder", category: "Spice", axes: ["Pack size", "Grade"],
      optionsA: ["500 g", "5 kg", "25 kg"], optionsB: ["Standard", "Premium"],
      stock: [[260, 95, 30], [140, 52, 12]], priceInr: 145, marginPct: 34, leadTimeDays: 4,
      attributes: { curcumin: "3.5%", origin: "Erode" }, supplier: "Deccan Bulk Supply" },
  ],
  vocabulary: {
    categories: { coffee: "Beverage", beans: "Beverage", rice: "Grain", basmati: "Grain",
      oil: "Oil", groundnut: "Oil", turmeric: "Spice", spice: "Spice", masala: "Spice" },
    optionAliases: { premium: "Premium", standard: "Standard", regular: "Standard" },
  },
};

export const CATALOGUES: Record<Vertical, Catalogue> = {
  apparel: APPAREL,
  auto_parts: AUTO_PARTS,
  marine: MARINE,
  wholesale: WHOLESALE,
};

export const catalogueFor = (vertical: Vertical) => CATALOGUES[vertical];
