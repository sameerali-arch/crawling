/**
 * Builds src/hardcoded-pairs.json from tk-city-codes.js.
 * - One direction per pair (award miles are identical both ways).
 * - Drops same-country pairs (one-way award tickets can't start and end in the same country),
 *   except Türkiye domestic, which is a valid award route.
 *
 * Usage:
 *   yarn pairs:build
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TK_CITY_CODES } from "./tk-city-codes.js";

const DOMESTIC_COUNTRY = "TR";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "hardcoded-pairs.json");

const airports = TK_CITY_CODES.flatMap(([city, codes, country]) =>
  codes.map((code) => ({ city, code, country }))
).sort((a, b) => a.code.localeCompare(b.code));

const label = (a) => `${a.city} - ${a.code}`;

const pairs = [];
let sameCountry = 0;
for (let i = 0; i < airports.length; i++) {
  for (let j = i + 1; j < airports.length; j++) {
    const a = airports[i];
    const b = airports[j];
    if (a.country === b.country && a.country !== DOMESTIC_COUNTRY) {
      sameCountry++;
      continue;
    }
    pairs.push({ origin: label(a), destination: label(b) });
  }
}

writeFileSync(OUT_PATH, `${JSON.stringify(pairs, null, 2)}\n`);

console.log(`airports: ${airports.length}`);
console.log(`one-direction pairs: ${(airports.length * (airports.length - 1)) / 2}`);
console.log(`dropped same-country: ${sameCountry}`);
console.log(`hardcoded pairs: ${pairs.length}`);
console.log(`file: ${OUT_PATH}`);
