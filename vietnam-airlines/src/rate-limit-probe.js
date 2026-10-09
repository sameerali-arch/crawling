/**
 * Date-range probe for the Lotusmiles ticketRedemption/estimate endpoint.
 * Walks every STEP_DAYS day for the next MONTHS on OD pair(s) to measure rate limits,
 * latency, and how award miles change by date (peak vs off-peak).
 *
 * Usage:
 *   yarn rate-limit                                   # VN SGN-HAN, next 5 months, sequential
 *   PAIRS=SGN-HAN,AF:CDG-JFK MONTHS=12 yarn rate-limit   # AIRLINE: prefix, default AIRLINE (VN)
 *   CONCURRENCY=5 yarn rate-limit                     # burst test
 *   DELAY_MS=200 LIMIT=20 yarn rate-limit
 *   yarn crawl                                        # every pair in src/hardcoded-pairs.json
 *   AIRLINES=VN STEP_DAYS=7 yarn crawl                # one airline, one date per week per pair
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API =
  "https://integration-middleware-website.vietnamairlines.com/api/v1/mileage-calculator/public";
const ESTIMATE_URL = `${API}/0/ticketRedemption/estimate`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAIRS_FILE = process.env.PAIRS_FILE ?? join(__dirname, "hardcoded-pairs.json");
const LOG_PATH = join(__dirname, "..", "rate-limit-results.jsonl");
const SUMMARY_PATH = join(__dirname, "..", "rate-limit-summary.json");

const MODE = (process.env.MODE ?? "pairs").toLowerCase(); // pairs | hardcoded
const AIRLINE = (process.env.AIRLINE ?? "VN").toUpperCase();
const AIRLINES = process.env.AIRLINES
  ? process.env.AIRLINES.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  : null;
const MONTHS = Number(process.env.MONTHS ?? 5);
const STEP_DAYS = Number(process.env.STEP_DAYS ?? 1);
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const STOP_AFTER_BLOCKS = Number(process.env.STOP_AFTER_BLOCKS ?? 10);

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function loadPairs() {
  let pairs;
  if (MODE === "hardcoded") {
    let list;
    try {
      list = JSON.parse(readFileSync(PAIRS_FILE, "utf8"));
    } catch (err) {
      throw new Error(`Cannot read ${PAIRS_FILE} (run "yarn discover" first): ${err.message}`);
    }
    pairs = list.map((p) => [p.airline ?? AIRLINE, p.origin, p.destination]);
  } else {
    pairs = (process.env.PAIRS ?? "SGN-HAN")
      .split(",")
      .map((p) => {
        const [airline, route] = p.includes(":") ? p.split(":") : [AIRLINE, p];
        return [airline, ...route.split("-")].map((s) => s.trim().toUpperCase());
      })
      .filter((p) => p.length === 3);
  }
  return AIRLINES ? pairs.filter(([airline]) => AIRLINES.includes(airline)) : pairs;
}

const PAIRS = loadPairs();
const pairLabel = ([airline, origin, dest]) => `${airline}:${origin}-${dest}`;

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`; // YYYY-MM-DD
}

function buildDates() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + MONTHS);

  const out = [];
  for (const d = new Date(start); d < end; d.setDate(d.getDate() + STEP_DAYS)) {
    out.push(formatDate(d));
  }
  return out;
}

function buildJobs(dates) {
  const jobs = [];
  for (const [airline, origin, dest] of PAIRS) {
    for (const date of dates) jobs.push({ airline, origin, dest, date });
  }
  return jobs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function simplifyMiles(json) {
  const out = {};
  for (const c of json?.data?.bookClassList ?? []) {
    out[c.bookClassName] = c.totalMiles;
  }
  return out;
}

function failKey(row) {
  if (row.error) return `NETWORK: ${row.error}`;
  if (row.notOffered) return `NOT_OFFERED: ${row.apiCode} ${row.apiMessage ?? ""}`.slice(0, 180);
  if (row.httpStatus < 200 || row.httpStatus >= 300) {
    return `HTTP_${row.httpStatus}: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (row.apiStatus === "NON_JSON") {
    return `NON_JSON: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (!row.success) {
    return `API_FAIL: ${row.apiCode} ${row.apiMessage ?? row.bodyPreview}`.slice(0, 200);
  }
  return null;
}

function isBlock(row) {
  return (
    row.httpStatus === 403 ||
    row.httpStatus === 429 ||
    row.apiStatus === "NON_JSON"
  );
}

const seasonLabel = (peak) => (peak === true ? "PEAK" : peak === false ? "off-peak" : "n/a");

async function callEstimate({ airline, origin, dest, date }) {
  const started = Date.now();
  const row = {
    airline,
    origin,
    dest,
    date,
    httpStatus: 0,
    apiStatus: null,
    apiCode: null,
    apiMessage: null,
    success: false,
    notOffered: false,
    peak: null,
    miles: null,
    ms: 0,
    retryAfter: null,
    error: null,
    bodyPreview: null,
    ts: new Date().toISOString(),
  };

  try {
    const res = await fetch(ESTIMATE_URL, {
      method: "POST",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "content-type": "application/json",
        lang: "en",
        origin: "https://www.vietnamairlines.com",
        referer: "https://www.vietnamairlines.com/",
      },
      body: JSON.stringify({
        origin,
        destination: dest,
        operatingAirline: airline,
        departureDate: date,
      }),
    });

    row.httpStatus = res.status;
    row.retryAfter = res.headers.get("retry-after");

    const text = await res.text();
    row.bodyPreview = text.slice(0, 300);

    try {
      const json = JSON.parse(text);
      row.apiStatus = "JSON";
      row.apiCode = json.code ?? null;
      row.apiMessage = json.message ?? null;
      row.success = json.success === true && json.code === "0" && !!json.data;
      // The API answers unknown/unpriced routes with 400 OTHER_ERROR.
      row.notOffered = res.status === 400 && json.code === "OTHER_ERROR";
      if (row.success) {
        row.peak = json.data.peakSeason ?? null;
        row.miles = simplifyMiles(json);
      }
    } catch {
      row.apiStatus = "NON_JSON";
    }
  } catch (err) {
    row.error = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
  }

  row.ms = Date.now() - started;
  return row;
}

async function main() {
  const dates = buildDates();
  let jobs = buildJobs(dates);
  if (LIMIT != null) jobs = jobs.slice(0, LIMIT);

  console.log("=== Vietnam Airlines date-range rate-limit probe ===");
  console.log(
    `mode=${MODE} pairs=${PAIRS.length <= 10 ? PAIRS.map(pairLabel).join(",") : PAIRS.length} dates=${dates.length} (${dates[0]} → ${dates.at(-1)}, step ${STEP_DAYS}d) jobs=${jobs.length}`
  );
  console.log(
    `airlines=${AIRLINES?.join(",") ?? "all in pairs"} CONCURRENCY=${CONCURRENCY} DELAY_MS=${DELAY_MS} STOP_AFTER_BLOCKS=${STOP_AFTER_BLOCKS}`
  );
  console.log(`log=${LOG_PATH}\n`);

  writeFileSync(LOG_PATH, "");

  const t0 = Date.now();

  const counts = { success: 0, notOffered: 0, httpFail: 0, apiFail: 0, nonJson: 0, networkError: 0 };
  const statusCounts = {};
  const failBuckets = new Map();
  const latencies = [];
  const pricingByPair = new Map(); // "VN:SGN-HAN" -> Map(signature -> { count, firstDate, lastDate, peak, miles })
  const peakDates = new Set();
  const offPeakDates = new Set();
  let firstBlockAt = null;
  let consecutiveBlocks = 0;
  let stoppedEarly = false;
  let done = 0;
  let next = 0;

  async function worker() {
    while (!stoppedEarly && next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      const row = await callEstimate(job);
      const n = ++done;

      latencies.push(row.ms);
      statusCounts[row.httpStatus] = (statusCounts[row.httpStatus] ?? 0) + 1;

      const ok = row.httpStatus === 200 && row.success && !row.error;
      if (row.error) counts.networkError++;
      else if (row.notOffered) counts.notOffered++;
      else if (row.httpStatus < 200 || row.httpStatus >= 300) counts.httpFail++;
      else if (row.apiStatus === "NON_JSON") counts.nonJson++;
      else if (ok) counts.success++;
      else counts.apiFail++;

      appendFileSync(
        LOG_PATH,
        `${JSON.stringify({ n, ...row, bodyPreview: ok ? undefined : row.bodyPreview })}\n`
      );

      if (ok) {
        consecutiveBlocks = 0;
        if (row.peak === true) peakDates.add(row.date);
        else if (row.peak === false) offPeakDates.add(row.date);
        const pairKey = pairLabel([row.airline, row.origin, row.dest]);
        const sig = JSON.stringify({ peak: row.peak, miles: row.miles });
        const byPair = pricingByPair.get(pairKey) ?? new Map();
        const entry = byPair.get(sig) ?? {
          count: 0,
          firstDate: row.date,
          lastDate: row.date,
          peak: row.peak,
          miles: row.miles,
        };
        entry.count++;
        if (row.date < entry.firstDate) entry.firstDate = row.date;
        if (row.date > entry.lastDate) entry.lastDate = row.date;
        byPair.set(sig, entry);
        pricingByPair.set(pairKey, byPair);
      } else {
        const key = failKey(row) ?? "UNKNOWN";
        const bucket = failBuckets.get(key) ?? { count: 0, examples: [] };
        bucket.count++;
        if (bucket.examples.length < 5) {
          bucket.examples.push(`${row.airline} ${row.origin}→${row.dest} ${row.date}`);
        }
        failBuckets.set(key, bucket);

        if (isBlock(row)) {
          consecutiveBlocks++;
          if (firstBlockAt == null) {
            firstBlockAt = { request: n, elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)) };
          }
          if (consecutiveBlocks >= STOP_AFTER_BLOCKS) stoppedEarly = true;
        }
      }

      const label = ok
        ? `OK ${seasonLabel(row.peak).padEnd(8)} ${Object.values(row.miles).join("/")}`
        : `FAIL ${failKey(row)}`;
      console.log(
        `[${String(n).padStart(4)}/${jobs.length}] ${String(row.ms).padStart(5)}ms  ${row.airline} ${row.origin}→${row.dest} ${row.date}  ${label}`
      );

      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const elapsedSec = (Date.now() - t0) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);

  const pricing = Object.fromEntries(
    [...pricingByPair.entries()].map(([pair, sigs]) => [
      pair,
      {
        distinctPricings: sigs.size,
        dateDependent: sigs.size > 1,
        variants: [...sigs.values()].sort((a, b) => b.count - a.count),
      },
    ])
  );

  const failureSummary = [...failBuckets.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => ({ key, count: v.count, examples: v.examples }));

  const summary = {
    mode: MODE,
    airlines: [...new Set(PAIRS.map(([airline]) => airline))],
    pairCount: PAIRS.length,
    pairs: PAIRS.length <= 100 ? PAIRS.map(pairLabel) : undefined,
    months: MONTHS,
    stepDays: STEP_DAYS,
    concurrency: CONCURRENCY,
    delayMs: DELAY_MS,
    jobs: jobs.length,
    completed: done,
    stoppedEarly,
    firstBlockAt,
    elapsedSec: Number(elapsedSec.toFixed(1)),
    reqPerSec: Number((done / elapsedSec).toFixed(2)),
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? null,
    },
    counts,
    statusCounts,
    peakDates: [...peakDates].sort(),
    pricing,
    failureSummary,
  };

  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log("\n=== Summary ===");
  console.log(
    `elapsed: ${summary.elapsedSec}s  req/s: ${summary.reqPerSec}  completed: ${done}/${jobs.length}${stoppedEarly ? "  (STOPPED EARLY: blocked)" : ""}`
  );
  console.log(`latency p50/p95/p99/max: ${Object.values(summary.latencyMs).join("/")} ms`);
  console.log(JSON.stringify(counts, null, 2));
  if (firstBlockAt) {
    console.log(`first block at request #${firstBlockAt.request} after ${firstBlockAt.elapsedSec}s`);
  }
  console.log(`peak dates seen: ${peakDates.size}, off-peak dates seen: ${offPeakDates.size}`);

  console.log("\n=== Pricing by date ===");
  for (const [pair, p] of Object.entries(pricing)) {
    console.log(`${pair}: ${p.distinctPricings} distinct pricing(s) → ${p.dateDependent ? "DATE-DEPENDENT" : "same for all dates"}`);
    for (const v of p.variants) {
      console.log(`  ${v.count}x ${seasonLabel(v.peak)} ${JSON.stringify(v.miles)}  (${v.firstDate} … ${v.lastDate})`);
    }
  }

  if (failureSummary.length) {
    console.log("\n=== Failure buckets ===");
    for (const f of failureSummary) {
      console.log(`\n[${f.count}x] ${f.key}`);
      console.log(`  examples: ${f.examples.join(" | ")}`);
    }
  }

  console.log(`\nsummary file: ${SUMMARY_PATH}`);
  console.log(`detail log: ${LOG_PATH}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
