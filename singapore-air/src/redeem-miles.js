/**
 * Smoke test: fetch a session token, then call milesRedemCall
 * for a hardcoded one-way DEL -> SIN Economy redemption.
 */

const BASE = "https://www.singaporeair.com";
const CALCULATOR_URL = `${BASE}/krisflyer/miles/miles-calculator`;
const REDEEM_URL = `${BASE}/krisflyer/miles/milesRedemCall`;

const ORIGIN = "Delhi - DEL";
const DESTINATION = "Hong Kong - HKG";
const TRIP_TYPE = "O"; // one-way
const CLASS_TYPE = "EN"; // Economy

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function mergeCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];

  for (const header of headers) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
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

  // Fallback: some runtimes expose a single set-cookie
  const single = res.headers.get("set-cookie");
  if (single && jar.size === 0) {
    mergeCookies(jar, [single]);
  }

  const html = await res.text();

  // Token may arrive as cookie _kfvstoken
  let token = jar.get("_kfvstoken");

  // Or embedded in the page HTML / inline scripts
  if (!token) {
    const match =
      html.match(/_kfvstoken["'\s:=]+["']([^"']+)["']/i) ||
      html.match(/kfvstoken["'\s:=]+["']([^"']+)["']/i);
    if (match) {
      token = match[1];
      jar.set("_kfvstoken", token);
    }
  }

  console.log("Session bootstrap status:", res.status);
  console.log("Cookies received:", [...jar.keys()].join(", ") || "(none)");
  console.log("_kfvstoken:", token ? `${token.slice(0, 40)}…` : "(missing)");

  return { jar, token, htmlSnippet: html.slice(0, 500) };
}

async function callRedeem({ jar, token }) {
  if (!token) {
    throw new Error(
      "No _kfvstoken found. Open the calculator in a browser and paste a fresh token, or the page may be blocking this request."
    );
  }

  const body = {
    _kfvstoken: token,
    data: {
      origin: ORIGIN,
      destination: DESTINATION,
      tripType: TRIP_TYPE,
      classType: CLASS_TYPE,
    },
  };

  console.log("\nRequest body:", JSON.stringify(body, null, 2));

  const res = await fetch(REDEEM_URL, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/json",
      origin: BASE,
      referer: CALCULATOR_URL,
      cookie: cookieHeader(jar),
    },
    body: JSON.stringify(body),
  });

  mergeCookies(jar, res.headers.getSetCookie?.() ?? []);

  const text = await res.text();
  console.log("\nResponse status:", res.status);
  console.log("Response headers content-type:", res.headers.get("content-type"));

  try {
    const json = JSON.parse(text);
    console.log("\nResponse JSON:");
    console.log(JSON.stringify(json, null, 2));
    return json;
  } catch {
    console.log("\nNon-JSON response (first 1000 chars):");
    console.log(text.slice(0, 1000));
    return text;
  }
}

async function main() {
  console.log("=== Singapore Air redeem miles smoke test ===");
  console.log(`${ORIGIN} → ${DESTINATION} | trip=${TRIP_TYPE} | class=${CLASS_TYPE}\n`);

  const session = await bootstrapSession();
  await callRedeem(session);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
