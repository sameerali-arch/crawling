/**
 * Airport-combination probe for milesRedemCall.
 * SIA and Scoot airport lists are separate — pick with NETWORK=.
 *
 * Usage:
 *   yarn rate-limit                              # SIA hardcoded SUCCESS ODs
 *   NETWORK=sia MODE=hardcoded yarn rate-limit   # same (default)
 *   NETWORK=scoot yarn rate-limit                # Scoot hardcoded SUCCESS ODs
 *   NETWORK=scoot MODE=all yarn rate-limit       # Scoot full matrix rediscovery
 *   NETWORK=scoot MODE=hub yarn rate-limit       # Scoot ↔ SIN only
 *   DELAY_MS=50 LIMIT=100 yarn rate-limit
 */

import { writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import HARDCODED_SIA_PAIRS from "./hardcoded-pairs.json" with { type: "json" };
import HARDCODED_SCOOT_PAIRS from "./hardcoded-scoot-pairs.json" with {
  type: "json",
};
import { SIA_CITY_CODES } from "./sia-city-codes.js";
import { SCOOT_CITY_CODES } from "./scoot-city-codes.js";

const BASE = "https://www.singaporeair.com";
const CALCULATOR_URL = `${BASE}/krisflyer/miles/miles-calculator`;
const REDEEM_URL = `${BASE}/krisflyer/miles/milesRedemCall`;

const NETWORK = (process.env.NETWORK ?? "sia").toLowerCase(); // sia | scoot
const TRIP_TYPE = "O";
const CLASS_TYPE = "EN";
const MODE = (process.env.MODE ?? "hardcoded").toLowerCase(); // hardcoded | hub | all
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(
  __dirname,
  "..",
  NETWORK === "scoot" ? "rate-limit-scoot-results.jsonl" : "rate-limit-results.jsonl"
);
const SUMMARY_PATH = join(
  __dirname,
  "..",
  NETWORK === "scoot" ? "rate-limit-scoot-summary.json" : "rate-limit-summary.json"
);

const CITY_CODES =
  NETWORK === "scoot" ? SCOOT_CITY_CODES : SIA_CITY_CODES;

const HARDCODED_PAIRS =
  NETWORK === "scoot" ? HARDCODED_SCOOT_PAIRS : HARDCODED_SIA_PAIRS;

if (NETWORK !== "sia" && NETWORK !== "scoot") {
  console.error(`Invalid NETWORK="${NETWORK}". Use sia or scoot.`);
  process.exit(1);
}

function buildAirports() {
  const out = [];
  for (const [city, codes] of CITY_CODES) {
    for (const code of codes) {
      out.push({
        city,
        code,
        label: `${city} - ${code}`,
      });
    }
  }
  return out;
}

function labelToAirport(label) {
  const code = label.includes(" - ") ? label.split(" - ").pop() : label;
  return { city: label.replace(` - ${code}`, ""), code, label };
}

function buildPairs(airports) {
  if (MODE === "hardcoded") {
    return HARDCODED_PAIRS.map((p) => ({
      origin: labelToAirport(p.origin),
      destination: labelToAirport(p.destination),
    }));
  }

  const pairs = [];
  for (const origin of airports) {
    for (const destination of airports) {
      if (origin.code === destination.code) continue;
      if (MODE === "hub") {
        if (origin.code !== "SIN" && destination.code !== "SIN") continue;
      }
      pairs.push({ origin, destination });
    }
  }
  return pairs;
}

function mergeCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];

  for (const header of headers) {
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

function failKey(row) {
  if (row.error) return `NETWORK: ${row.error}`;
  if (row.httpStatus && (row.httpStatus < 200 || row.httpStatus >= 300)) {
    return `HTTP_${row.httpStatus}: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (row.apiStatus === "NON_JSON") {
    return `NON_JSON: ${row.bodyPreview ?? ""}`.slice(0, 180);
  }
  if (row.apiStatus && row.apiStatus !== "SUCCESS") {
    const code = row.errorCode ? `[${row.errorCode}] ` : "";
    const msg = row.message || row.bodyPreview || row.apiStatus;
    return `API_${row.apiStatus}: ${code}${msg}`.slice(0, 200);
  }
  return null;
}

async function bootstrapSession() {
  const jar = new Map();

  const res = await fetch(CALCULATOR_URL, {
    redirect: "follow",
    headers: {
      "user-agent": UA,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });

  mergeCookies(jar, res.headers.getSetCookie?.() ?? []);
  const single = res.headers.get("set-cookie");
  if (single && jar.size === 0) mergeCookies(jar, [single]);

  const html = await res.text();
  let token = jar.get("_kfvstoken");

  if (!token) {
    const match =
      html.match(/_kfvstoken["'\s:=]+["']([^"']+)["']/i) ||
      html.match(/kfvstoken["'\s:=]+["']([^"']+)["']/i);
    if (match) {
      token = match[1];
      jar.set("_kfvstoken", token);
    }
  }

  if (!token) throw new Error("No _kfvstoken from calculator page");

  console.log(`Session OK (HTTP ${res.status}), token=${token.slice(0, 36)}…`);
  return { jar, token };
}

async function callRedeem(session, originLabel, destinationLabel) {
  const started = Date.now();
  const body = {
    _kfvstoken: session.token,
    data: {
      origin: originLabel,
      destination: destinationLabel,
      tripType: TRIP_TYPE,
      classType: CLASS_TYPE,
    },
  };

  const row = {
    origin: originLabel,
    destination: destinationLabel,
    httpStatus: 0,
    apiStatus: null,
    message: null,
    errorCode: null,
    miles: null,
    cabinClass: null,
    redeemVO: null,
    ms: 0,
    retryAfter: null,
    error: null,
    bodyPreview: null,
    raw: null,
    ts: new Date().toISOString(),
  };

  try {
    const res = await fetch(REDEEM_URL, {
      method: "POST",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        origin: BASE,
        referer: CALCULATOR_URL,
        cookie: cookieHeader(session.jar),
      },
      body: JSON.stringify(body),
    });

    row.httpStatus = res.status;
    row.retryAfter = res.headers.get("retry-after");
    mergeCookies(session.jar, res.headers.getSetCookie?.() ?? []);
    if (session.jar.get("_kfvstoken")) {
      session.token = session.jar.get("_kfvstoken");
    }

    const text = await res.text();
    row.bodyPreview = text.slice(0, 300);

    try {
      const json = JSON.parse(text);
      row.raw = json;
      row.apiStatus = json.status ?? null;
      // SIA uses mixed casings: ErrorCode / ErrorMessage on failures
      row.message =
        json.ErrorMessage ??
        json.errorMessage ??
        json.message ??
        json.response?.ErrorMessage ??
        json.response?.errorMessage ??
        json.response?.message ??
        json.error?.message ??
        null;
      row.errorCode =
        json.ErrorCode ??
        json.errorCode ??
        json.code ??
        json.response?.ErrorCode ??
        json.response?.errorCode ??
        json.error?.code ??
        null;

      const first = json.response?.redeemMiles?.[0];
      if (first) {
        row.cabinClass = first.cabinClass ?? null;
        row.redeemVO = first.redeemVO ?? null;
        row.miles = first.redeemVO?.map((r) => r.miles) ?? null;
      }

      if (!row.message && typeof json.response === "string") {
        row.message = json.response;
      }
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
  const airports = buildAirports();
  let pairs = buildPairs(airports);
  if (LIMIT != null) pairs = pairs.slice(0, LIMIT);

  console.log("=== Airport combination probe ===");
  console.log(
    `NETWORK=${NETWORK} MODE=${MODE} pairs=${pairs.length} airports=${airports.length} trip=${TRIP_TYPE} class=${CLASS_TYPE} DELAY_MS=${DELAY_MS}`
  );
  console.log(`log=${LOG_PATH}\n`);

  writeFileSync(LOG_PATH, "");

  const session = await bootstrapSession();
  const t0 = Date.now();

  const counts = {
    success: 0,
    httpFail: 0,
    apiFail: 0,
    nonJson: 0,
    networkError: 0,
  };
  const failBuckets = new Map(); // key -> { count, examples: [] }

  for (let i = 0; i < pairs.length; i++) {
    const { origin, destination } = pairs[i];
    const n = i + 1;
    const row = await callRedeem(session, origin.label, destination.label);

    // Persist compact log line (drop huge raw on success to keep file smaller)
    const logRow = {
      n,
      origin: row.origin,
      destination: row.destination,
      httpStatus: row.httpStatus,
      apiStatus: row.apiStatus,
      message: row.message,
      errorCode: row.errorCode,
      cabinClass: row.cabinClass,
      miles: row.miles,
      redeemVO: row.redeemVO,
      ms: row.ms,
      retryAfter: row.retryAfter,
      error: row.error,
      bodyPreview: row.apiStatus === "SUCCESS" ? undefined : row.bodyPreview,
      raw: row.apiStatus === "SUCCESS" ? undefined : row.raw,
      ts: row.ts,
    };
    appendFileSync(LOG_PATH, `${JSON.stringify(logRow)}\n`);

    const ok = row.apiStatus === "SUCCESS" && row.httpStatus === 200 && !row.error;
    if (row.error) counts.networkError++;
    else if (row.httpStatus < 200 || row.httpStatus >= 300) counts.httpFail++;
    else if (row.apiStatus === "NON_JSON") counts.nonJson++;
    else if (ok) counts.success++;
    else counts.apiFail++;

    if (!ok) {
      const key = failKey(row) ?? "UNKNOWN";
      const bucket = failBuckets.get(key) ?? { count: 0, examples: [] };
      bucket.count++;
      if (bucket.examples.length < 5) {
        bucket.examples.push(`${row.origin} → ${row.destination}`);
      }
      failBuckets.set(key, bucket);
    }

    const label = ok
      ? `OK miles=${(row.miles ?? []).join("/")}`
      : `FAIL ${failKey(row)}`;

    console.log(
      `[${String(n).padStart(4)}/${pairs.length}] ${row.ms}ms  ${origin.code}→${destination.code}  ${label}`
    );

    if (DELAY_MS > 0 && i < pairs.length - 1) await sleep(DELAY_MS);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  const failureSummary = [...failBuckets.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => ({
      key,
      count: v.count,
      examples: v.examples,
    }));

  const summary = {
    network: NETWORK,
    mode: MODE,
    airports: airports.length,
    pairs: pairs.length,
    elapsedSec: Number(elapsedSec),
    counts,
    failureSummary,
  };

  writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  console.log("\n=== Summary ===");
  console.log(`elapsed: ${elapsedSec}s`);
  console.log(JSON.stringify(counts, null, 2));
  console.log("\n=== Failure buckets (what they look like) ===");
  for (const f of failureSummary) {
    console.log(`\n[${f.count}x] ${f.key}`);
    console.log(`  examples: ${f.examples.join(" | ")}`);
  }
  console.log(`\nsummary file: ${SUMMARY_PATH}`);
  console.log(`detail log: ${LOG_PATH}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
