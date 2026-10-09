/**
 * One-off route discovery for every Lotusmiles partner airline.
 * get-origin returns the same airport list for every airline, so it is fetched once;
 * get-destination is airline-specific and is called for every (airline, origin).
 * Writes [{ airline, origin, destination }] to src/hardcoded-pairs.json after each airline.
 *
 * Usage:
 *   yarn discover                       # all airlines, full sweep
 *   AIRLINES=VN,AF yarn discover        # subset (replaces those airlines in the file)
 *   RESUME=1 yarn discover              # skip airlines already in the file
 *   CONCURRENCY=8 DELAY_MS=0 yarn discover
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API =
  "https://integration-middleware-website.vietnamairlines.com/api/v1/mileage-calculator/public";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = process.env.OUT ?? path.join(__dirname, "hardcoded-pairs.json");

const ALL_AIRLINES = [
  "VN", "FM", "SU", "AR", "AM", "UX", "AF", "AZ", "NH", "CI", "MU", "CZ", "OK",
  "DL", "GA", "BL", "KQ", "KE", "AE", "ME", "KL", "SV", "SK", "RO", "VS", "MF",
];
const AIRLINES = process.env.AIRLINES
  ? process.env.AIRLINES.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : ALL_AIRLINES;
const RESUME = process.env.RESUME === "1";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const MAX_RETRY_ROUNDS = Number(process.env.MAX_RETRY_ROUNDS ?? 3);

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
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(1000 * attempt);
    return getJson(url, attempt + 1);
  }
}

const isRealAirport = (a) => a?.code && a.country && a.country !== "XX" && a.city;

async function getOrigins() {
  const json = await getJson(`${API}/airport-pairs/VN/get-origin`);
  return (json.data ?? []).filter(isRealAirport).map((a) => a.code);
}

async function getDestinations(airline, origin) {
  const json = await getJson(`${API}/airport-pairs/${airline}/${origin}/get-destination`);
  return (json.data ?? []).filter(isRealAirport).map((a) => a.code);
}

function loadExisting() {
  if (!existsSync(OUT_PATH)) return [];
  const list = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  // Older files have no airline field and are VN-only.
  return list.map((p) => ({ airline: p.airline ?? "VN", ...p }));
}

function save(pairs) {
  const sorted = [...pairs].sort(
    (a, b) =>
      a.airline.localeCompare(b.airline) ||
      a.origin.localeCompare(b.origin) ||
      a.destination.localeCompare(b.destination),
  );
  writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

async function sweepAirline(airline, origins) {
  const pairs = [];
  let pending = [...origins];
  let queried = 0;

  for (let round = 0; round <= MAX_RETRY_ROUNDS && pending.length; round++) {
    if (round > 0) {
      console.log(`  ${airline}: retry round ${round} for ${pending.length} failed origins`);
      await sleep(5000 * round);
    }
    const queue = pending;
    const failed = [];

    async function worker() {
      while (queue.length) {
        const origin = queue.shift();
        try {
          for (const destination of await getDestinations(airline, origin)) {
            pairs.push({ airline, origin, destination });
          }
        } catch (err) {
          failed.push(origin);
          if (round === MAX_RETRY_ROUNDS) console.error(`  ${airline} ${origin}: ${err.message}`);
        }
        queried++;
        if (queried % 500 === 0) {
          console.log(`  ${airline}: ${queried}/${origins.length} origins, ${pairs.length} pairs`);
        }
        if (DELAY_MS) await sleep(DELAY_MS);
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    pending = failed;
  }

  return { pairs, failed: pending };
}

async function main() {
  const existing = loadExisting();
  const doneAirlines = new Set(existing.map((p) => p.airline));
  const todo = RESUME ? AIRLINES.filter((a) => !doneAirlines.has(a)) : AIRLINES;
  // Keep pairs for airlines not being re-swept in this run.
  let pairs = existing.filter((p) => !todo.includes(p.airline));

  const origins = await getOrigins();
  console.log(`get-origin: ${origins.length} airports (after filtering junk)`);
  console.log(
    `airlines=${todo.join(",") || "(none)"} concurrency=${CONCURRENCY} delay=${DELAY_MS}ms` +
      (RESUME ? ` (resume: skipping ${AIRLINES.length - todo.length})` : ""),
  );
  console.log(`out=${OUT_PATH}\n`);

  const t0 = Date.now();
  const report = [];

  for (const airline of todo) {
    const started = Date.now();
    const { pairs: found, failed } = await sweepAirline(airline, origins);
    pairs = pairs.filter((p) => p.airline !== airline).concat(found);
    save(pairs);

    const activeOrigins = new Set(found.map((p) => p.origin)).size;
    const sec = ((Date.now() - started) / 1000).toFixed(0);
    report.push({ airline, pairs: found.length, origins: activeOrigins, failed: failed.length });
    console.log(
      `${airline}: ${found.length} pairs from ${activeOrigins} origins in ${sec}s` +
        (failed.length ? `  (${failed.length} origins FAILED: ${failed.slice(0, 10).join(",")})` : ""),
    );
  }

  const min = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nDone in ${min} min. Total pairs in file: ${pairs.length}`);
  console.table(report);
  if (report.some((r) => r.failed)) {
    console.log("Some origins failed; re-run those airlines with AIRLINES=XX,YY yarn discover");
  }
}

main().catch((err) => {
  console.error(err);
  if (err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
