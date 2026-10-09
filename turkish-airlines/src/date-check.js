/**
 * Date-dependence check: random pairs × one date per month for the next MONTHS.
 * Flags any pair whose award miles differ between dates.
 *
 * Usage:
 *   yarn date-check                         # 200 random pairs × 6 monthly dates
 *   SAMPLE=500 MONTHS=12 yarn date-check
 *   CONCURRENCY=3 yarn date-check
 *   AWARD_TYPE=AWARD_PROMOTION_TICKET yarn date-check
 */

import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const BASE = "https://www.turkishairlines.com";
const CALCULATOR_URL = `${BASE}/en-in/miles-and-smiles/miles-calculator/`;
const AWARD_URL = `${BASE}/api/v1/miles-and-smiles/calculate-award-miles`;

const SAMPLE = Number(process.env.SAMPLE ?? 200);
const MONTHS = Number(process.env.MONTHS ?? 6);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const AWARD_TYPE = process.env.AWARD_TYPE ?? "AWARD_TICKET";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAIRS_PATH = join(__dirname, "hardcoded-pairs.json");
const LOG_PATH = join(__dirname, "..", "date-check-results.jsonl");
const SUMMARY_PATH = join(__dirname, "..", "date-check-summary.json");

function formatDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`; // DD-MM-YYYY
}

function monthlyDates() {
  const out = [];
  for (let m = 0; m < MONTHS; m++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 7);
    d.setMonth(d.getMonth() + m);
    out.push(formatDate(d));
  }
  return out;
}

function labelToCode(label) {
  return label.includes(" - ") ? label.split(" - ").pop() : label;
}

function samplePairs() {
  const all = JSON.parse(readFileSync(PAIRS_PATH, "utf8")).map((p) => [
    labelToCode(p.origin),
    labelToCode(p.destination),
  ]);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return { total: all.length, pairs: all.slice(0, SAMPLE) };
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

async function callAward(session, origin, dest, date) {
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
    mergeCookies(session.jar, res.headers.getSetCookie?.() ?? []);
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json.success === true) return { ok: true, status: res.status, miles: simplifyMiles(json) };
      return { ok: false, status: res.status, error: JSON.stringify(json.statusDetailList).slice(0, 200) };
    } catch {
      return { ok: false, status: res.status, error: `NON_JSON: ${text.slice(0, 120)}` };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function main() {
  const dates = monthlyDates();
  const { total, pairs } = samplePairs();
  const jobs = pairs.flatMap(([origin, dest]) => dates.map((date) => ({ origin, dest, date })));

  console.log("=== Turkish Airlines date-dependence check ===");
  console.log(`sample=${pairs.length} of ${total} pairs  dates=${dates.join(", ")}`);
  console.log(`type=${AWARD_TYPE} CONCURRENCY=${CONCURRENCY} requests=${jobs.length}\n`);

  writeFileSync(LOG_PATH, "");
  const session = await bootstrapSession();
  const t0 = Date.now();

  const byPair = new Map(); // "DEL-IST" -> Map(date -> miles)
  const failures = [];
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const { origin, dest, date } = jobs[next++];
      let r = await callAward(session, origin, dest, date);
      if (!r.ok) r = await callAward(session, origin, dest, date);
      const n = ++done;

      appendFileSync(LOG_PATH, `${JSON.stringify({ n, origin, dest, date, ...r })}\n`);
      const key = `${origin}-${dest}`;
      if (r.ok) {
        const m = byPair.get(key) ?? new Map();
        m.set(date, r.miles);
        byPair.set(key, m);
      } else {
        failures.push({ pair: key, date, status: r.status, error: r.error });
      }

      if (n % 100 === 0 || n === jobs.length) {
        console.log(`[${String(n).padStart(5)}/${jobs.length}] failures=${failures.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const dateDependent = [];
  for (const [pair, m] of byPair) {
    const distinct = new Set([...m.values()].map((v) => JSON.stringify(v)));
    if (distinct.size > 1) dateDependent.push({ pair, byDate: Object.fromEntries(m) });
  }

  const elapsedSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const summary = {
    awardType: AWARD_TYPE,
    sampledPairs: pairs.length,
    totalPairs: total,
    dates,
    requests: jobs.length,
    elapsedSec,
    reqPerSec: Number((jobs.length / elapsedSec).toFixed(2)),
    pairsChecked: byPair.size,
    dateDependentCount: dateDependent.length,
    verdict: dateDependent.length === 0 && failures.length === 0 ? "DATE_INDEPENDENT" : "REVIEW",
    dateDependent,
    failures,
  };
  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log("\n=== Summary ===");
  console.log(`elapsed: ${elapsedSec}s  req/s: ${summary.reqPerSec}  failures: ${failures.length}`);
  console.log(`pairs checked: ${byPair.size}/${pairs.length}  date-dependent: ${dateDependent.length}`);
  console.log(`verdict: ${summary.verdict}`);
  for (const d of dateDependent.slice(0, 20)) {
    console.log(`\n${d.pair}`);
    for (const [date, miles] of Object.entries(d.byDate)) {
      console.log(`  ${date}  ${Object.values(miles).join("/")}`);
    }
  }
  for (const f of failures.slice(0, 20)) {
    console.log(`FAIL ${f.pair} ${f.date} HTTP_${f.status} ${f.error}`);
  }
  console.log(`\nsummary file: ${SUMMARY_PATH}`);
  console.log(`detail log: ${LOG_PATH}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
