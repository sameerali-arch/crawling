/**
 * Smoke test: plain fetch to calculate-award-miles.
 * Expect Akamai/PerimeterX to block this unless COOKIE is pasted from a real browser.
 *
 *   node src/award-miles.js
 *   ORIGIN=BOM DEST=IST DATE=09-01-2027 node src/award-miles.js
 *   COOKIE='...' BFP='...' node src/award-miles.js
 */

import { randomUUID } from "node:crypto";

const BASE = "https://www.turkishairlines.com";
const CALCULATOR_URL = `${BASE}/en-in/miles-and-smiles/miles-calculator/`;
const AWARD_URL = `${BASE}/api/v1/miles-and-smiles/calculate-award-miles`;

const ORIGIN = process.env.ORIGIN ?? "DEL";
const DEST = process.env.DEST ?? "IST";
const DATE = process.env.DATE ?? "09-01-2027"; // DD-MM-YYYY
const AWARD_TYPE = process.env.AWARD_TYPE ?? "AWARD_TICKET"; // or AWARD_PROMOTION_TICKET

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

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

  console.log("Calculator page status:", res.status);
  console.log("Cookies received:", [...jar.keys()].join(", ") || "(none)");
  return jar;
}

async function callAward(jar) {
  const body = {
    originatingFlightDate: DATE,
    originatingFlightDeparture: ORIGIN,
    originatingFlightArrival: DEST,
    awardType: AWARD_TYPE,
  };

  const headers = {
    "user-agent": UA,
    accept: "application/json",
    "accept-language": "en",
    "content-type": "application/json",
    origin: BASE,
    referer: CALCULATOR_URL,
    "x-platform": "WEB",
    "x-country": "in",
    "x-clientid": randomUUID(),
    "x-requestid": randomUUID(),
    cookie: process.env.COOKIE ?? cookieHeader(jar),
  };
  if (process.env.BFP) headers["x-bfp"] = process.env.BFP;

  console.log("\nRequest body:", JSON.stringify(body));

  const res = await fetch(AWARD_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();

  console.log("\nResponse status:", res.status);
  console.log("content-type:", res.headers.get("content-type"));

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log("Non-JSON (first 800 chars):\n", text.slice(0, 800));
  }
}

async function main() {
  console.log("=== Turkish Airlines award miles smoke test ===");
  console.log(`${ORIGIN} → ${DEST} | ${DATE} | ${AWARD_TYPE}\n`);
  const jar = await bootstrapSession();
  await callAward(jar);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
