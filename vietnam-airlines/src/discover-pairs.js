import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API =
  "https://integration-middleware-website.vietnamairlines.com/api/v1/mileage-calculator/public";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = process.env.OUT ?? path.join(__dirname, "hardcoded-pairs.json");

const AIRLINE = process.env.AIRLINE ?? "VN";
// network: BFS from seed origins through every discovered destination
// all: query get-destination for every origin returned by get-origin
const MODE = (process.env.DISCOVER_MODE ?? "network").toLowerCase();
const SEED_COUNTRIES = (process.env.SEED_COUNTRIES ?? "VN")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
const DELAY_MS = Number(process.env.DELAY_MS ?? 100);

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "*/*",
        lang: "en",
        origin: "https://www.vietnamairlines.com",
        referer: "https://www.vietnamairlines.com/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(1000 * attempt);
    return getJson(url, attempt + 1);
  }
}

const isRealAirport = (a) => a?.code && a.country && a.country !== "XX" && a.city;

async function getOrigins() {
  const json = await getJson(`${API}/airport-pairs/${AIRLINE}/get-origin`);
  return (json.data ?? []).filter(isRealAirport);
}

async function getDestinations(origin) {
  const json = await getJson(`${API}/airport-pairs/${AIRLINE}/${origin}/get-destination`);
  return (json.data ?? []).filter(isRealAirport);
}

async function main() {
  const origins = await getOrigins();
  const airports = new Map(origins.map((a) => [a.code, a]));
  console.log(`get-origin: ${origins.length} airports (after filtering junk)`);

  const queue =
    MODE === "all"
      ? origins.map((a) => a.code)
      : origins.filter((a) => SEED_COUNTRIES.includes(a.country)).map((a) => a.code);
  const seen = new Set(queue);
  const pairs = new Map();
  let done = 0;
  let failed = 0;

  console.log(`mode=${MODE} seeds=${queue.length} concurrency=${CONCURRENCY}`);

  async function worker() {
    while (queue.length) {
      const origin = queue.shift();
      try {
        const dests = await getDestinations(origin);
        for (const d of dests) {
          if (!airports.has(d.code)) airports.set(d.code, d);
          pairs.set(`${origin}-${d.code}`, { origin, destination: d.code });
          if (MODE === "network" && !seen.has(d.code)) {
            seen.add(d.code);
            queue.push(d.code);
          }
        }
      } catch (err) {
        failed++;
        console.error(`  ${origin}: ${err.message}`);
      }
      done++;
      if (done % 25 === 0) {
        console.log(`  ${done} origins queried, ${queue.length} queued, ${pairs.size} pairs`);
      }
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }

  // Workers can exit while others are still pushing new origins, so loop until drained.
  while (queue.length) {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  const list = [...pairs.values()].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination),
  );
  await writeFile(OUT_PATH, JSON.stringify(list, null, 2) + "\n");

  const activeOrigins = new Set(list.map((p) => p.origin));
  console.log(
    `\nDone: ${done} origins queried (${failed} failed), ${activeOrigins.size} with routes, ${list.length} pairs`,
  );
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  if (err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
