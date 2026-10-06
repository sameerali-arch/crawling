/**
 * Date-range probe for calculate-award-miles.
 * Walks every day for the next MONTHS on fixed OD pair(s) to measure rate limits,
 * latency, and whether award miles change by date.
 *
 * Usage:
 *   yarn rate-limit                                   # DEL-IST, next 5 months, sequential
 *   PAIRS=DEL-IST,BOM-JFK MONTHS=5 yarn rate-limit
 *   CONCURRENCY=5 yarn rate-limit                     # burst test
 *   DELAY_MS=200 LIMIT=20 yarn rate-limit
 *   AWARD_TYPE=AWARD_PROMOTION_TICKET yarn rate-limit
 */

import { writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const BASE = "https://www.turkishairlines.com";
const CALCULATOR_URL = `${BASE}/en-in/miles-and-smiles/miles-calculator/`;
const AWARD_URL = `${BASE}/api/v1/miles-and-smiles/calculate-award-miles`;

const PAIRS = (process.env.PAIRS ?? "DEL-IST")
  .split(",")
  .map((p) => p.trim().toUpperCase().split("-"))
  .filter((p) => p.length === 2);
const MONTHS = Number(process.env.MONTHS ?? 5);
const AWARD_TYPE = process.env.AWARD_TYPE ?? "AWARD_TICKET";
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const STOP_AFTER_BLOCKS = Number(process.env.STOP_AFTER_BLOCKS ?? 10);

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, "..", "rate-limit-results.jsonl");
const SUMMARY_PATH = join(__dirname, "..", "rate-limit-summary.json");

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`; // DD-MM-YYYY
}

function buildDates() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + MONTHS);

  const out = [];
  for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    out.push(formatDate(d));
  }
  return out;
}

function buildJobs(dates) {
  const jobs = [];
  for (const [origin, dest] of PAIRS) {
    for (const date of dates) jobs.push({ origin, dest, date });
  }
  return jobs;
}

function mergeCookies(jar, setCookieHeaders) {
  for (const header of setCookieHeaders ?? []) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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
  for (const cabin of json?.data?.awardMilesList ?? []) {
    const code = cabin.cabinType?.code;
    for (const m of cabin.milesCountList ?? []) {
      out[`${code}_${m.seatGuaranteed ? "guaranteed" : "saver"}`] = m.milesCount;
    }
  }
  return out;
}

function failKey(row) {
  if (row.error) return `NETWORK: ${row.error}`;
  if (row.httpStatus < 200 || row.httpStatus >= 300) {
    return `HTTP_${row.httpStatus}: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (row.apiStatus === "NON_JSON") {
    return `NON_JSON: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (!row.success) {
    return `API_FAIL: ${JSON.stringify(row.statusDetailList ?? row.bodyPreview)}`.slice(0, 200);
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

async function bootstrapSession() {
  const jar = new Map();
  const res = await fetch(CALCULATOR_URL, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  mergeCookies(jar, res.headers.getSetCookie?.() ?? []);
  await res.text();
  console.log(`Session OK (HTTP ${res.status}), cookies=${jar.size}`);
  return { jar, clientId: randomUUID() };
}

async function callAward(session, { origin, dest, date }) {
  const started = Date.now();
  const row = {
    origin,
    dest,
    date,
    httpStatus: 0,
    apiStatus: null,
    success: false,
    miles: null,
    statusDetailList: null,
    ms: 0,
    retryAfter: null,
    error: null,
    bodyPreview: null,
    ts: new Date().toISOString(),
  };

  try {
    const res = await fetch(AWARD_URL, {
      method: "POST",
      headers: {
        "user-agent": UA,
        accept: "application/json",
        "accept-language": "en",
        "content-type": "application/json",
        origin: BASE,
        referer: CALCULATOR_URL,
        "x-platform": "WEB",
        "x-country": "in",
        "x-clientid": session.clientId,
        "x-requestid": randomUUID(),
        cookie: cookieHeader(session.jar),
      },
      body: JSON.stringify({
        originatingFlightDate: date,
        originatingFlightDeparture: origin,
        originatingFlightArrival: dest,
        awardType: AWARD_TYPE,
      }),
    });

    row.httpStatus = res.status;
    row.retryAfter = res.headers.get("retry-after");
    mergeCookies(session.jar, res.headers.getSetCookie?.() ?? []);

    const text = await res.text();
    row.bodyPreview = text.slice(0, 300);

    try {
      const json = JSON.parse(text);
      row.apiStatus = "JSON";
      row.success = json.success === true;
      row.statusDetailList = json.statusDetailList ?? null;
      if (row.success) row.miles = simplifyMiles(json);
    } catch {
      row.apiStatus = "NON_JSON";
    }
  } catch (err) {
    row.error = err.message;
  }

  row.ms = Date.now() - started;
  return row;
}

async function main() {
  const dates = buildDates();
  let jobs = buildJobs(dates);
  if (LIMIT != null) jobs = jobs.slice(0, LIMIT);

  console.log("=== Turkish Airlines date-range rate-limit probe ===");
  console.log(
    `pairs=${PAIRS.map((p) => p.join("-")).join(",")} dates=${dates.length} (${dates[0]} → ${dates.at(-1)}) jobs=${jobs.length}`
  );
  console.log(
    `type=${AWARD_TYPE} CONCURRENCY=${CONCURRENCY} DELAY_MS=${DELAY_MS} STOP_AFTER_BLOCKS=${STOP_AFTER_BLOCKS}`
  );
  console.log(`log=${LOG_PATH}\n`);

  writeFileSync(LOG_PATH, "");

  const session = await bootstrapSession();
  const t0 = Date.now();

  const counts = { success: 0, httpFail: 0, apiFail: 0, nonJson: 0, networkError: 0 };
  const statusCounts = {};
  const failBuckets = new Map();
  const latencies = [];
  const pricingByPair = new Map(); // "DEL-IST" -> Map(signature -> { count, firstDate, lastDate, miles })
  let firstBlockAt = null;
  let consecutiveBlocks = 0;
  let stoppedEarly = false;
  let done = 0;
  let next = 0;

  async function worker() {
    while (!stoppedEarly && next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      const row = await callAward(session, job);
      const n = ++done;

      latencies.push(row.ms);
      statusCounts[row.httpStatus] = (statusCounts[row.httpStatus] ?? 0) + 1;

      const ok = row.httpStatus === 200 && row.success && !row.error;
      if (row.error) counts.networkError++;
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
        const pairKey = `${row.origin}-${row.dest}`;
        const sig = JSON.stringify(row.miles);
        const byPair = pricingByPair.get(pairKey) ?? new Map();
        const entry = byPair.get(sig) ?? { count: 0, firstDate: row.date, lastDate: row.date, miles: row.miles };
        entry.count++;
        entry.lastDate = row.date;
        byPair.set(sig, entry);
        pricingByPair.set(pairKey, byPair);
      } else {
        const key = failKey(row) ?? "UNKNOWN";
        const bucket = failBuckets.get(key) ?? { count: 0, examples: [] };
        bucket.count++;
        if (bucket.examples.length < 5) {
          bucket.examples.push(`${row.origin}→${row.dest} ${row.date}`);
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
        ? `OK ${Object.values(row.miles).join("/")}`
        : `FAIL ${failKey(row)}`;
      console.log(
        `[${String(n).padStart(4)}/${jobs.length}] ${String(row.ms).padStart(5)}ms  ${row.origin}→${row.dest} ${row.date}  ${label}`
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
    pairs: PAIRS.map((p) => p.join("-")),
    months: MONTHS,
    awardType: AWARD_TYPE,
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

  console.log("\n=== Pricing by date ===");
  for (const [pair, p] of Object.entries(pricing)) {
    console.log(`${pair}: ${p.distinctPricings} distinct pricing(s) → ${p.dateDependent ? "DATE-DEPENDENT" : "same for all dates"}`);
    for (const v of p.variants) {
      console.log(`  ${v.count}x ${JSON.stringify(v.miles)}  (${v.firstDate} … ${v.lastDate})`);
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
 