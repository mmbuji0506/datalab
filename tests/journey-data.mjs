import { createRng } from "../src/models.ts";

/**
 * A deterministic, deliberately messy retail export (semicolon-delimited, as
 * many spreadsheet exports are). Known planted problems:
 *  - amounts written as "TSh 12,500", some "N/A", one 40x outlier
 *  - discount written as "10%"
 *  - region spelled in mixed case / with trailing spaces
 *  - missing customer ages, and 5 exact duplicate rows
 */
export function buildMessyCsv(count = 150) {
  const random = createRng(2026);
  const regions = ["Dar es Salaam", "Arusha", "Mwanza", "Dodoma"];
  const channels = ["Walk-in", "Mobile", "Online"];
  const unitPrice = { "Dar es Salaam": 4200, Arusha: 3800, Mwanza: 3500, Dodoma: 3300 };
  const lines = ["order_id;region;channel;amount;units;discount;order_date;customer_age"];
  for (let index = 0; index < count; index += 1) {
    const region = regions[Math.floor(random() * regions.length)];
    const channel = channels[Math.floor(random() * channels.length)];
    const units = 1 + Math.floor(random() * 12);
    const discount = [0, 5, 10, 15][Math.floor(random() * 4)];
    const amount = Math.round(units * unitPrice[region] * (1 - discount / 100) + (random() - 0.5) * 1500);
    const regionText = index % 7 === 0 ? region.toUpperCase() : index % 11 === 0 ? `${region} ` : region;
    const amountText =
      index % 13 === 0 ? "N/A" : index === 40 ? String(amount * 40) : `TSh ${amount.toLocaleString("en-US")}`;
    const date = `2026-0${1 + (index % 9)}-${String(1 + (index % 28)).padStart(2, "0")}`;
    const age = index % 17 === 0 ? "" : String(18 + Math.floor(random() * 50));
    lines.push([index + 1, regionText, channel, `"${amountText}"`, units, `${discount}%`, date, age].join(";"));
  }
  for (const copy of [3, 9, 20, 33, 71]) lines.push(lines[copy + 1]);
  return lines.join("\n");
}
