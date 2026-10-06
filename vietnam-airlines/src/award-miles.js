const API =
  "https://integration-middleware-website.vietnamairlines.com/api/v1/mileage-calculator/public";
const ESTIMATE_URL = `${API}/0/ticketRedemption/estimate`;

const ORIGIN = process.env.ORIGIN ?? "SGN";
const DEST = process.env.DEST ?? "FUK";
const DATE = process.env.DATE ?? "2026-10-15";
const AIRLINE = process.env.AIRLINE ?? "VN";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function callEstimate() {
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
      origin: ORIGIN,
      destination: DEST,
      operatingAirline: AIRLINE,
      departureDate: DATE,
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function main() {
  console.log(`${ORIGIN} -> ${DEST} on ${DATE} (${AIRLINE})`);
  const { status, json, text } = await callEstimate();
  console.log("HTTP", status);
  if (!json) {
    console.log(text.slice(0, 500));
    return;
  }
  if (json.success && json.data) {
    const miles = Object.fromEntries(
      (json.data.bookClassList ?? []).map((c) => [c.bookClassName, c.totalMiles]),
    );
    console.log("peakSeason:", json.data.peakSeason);
    console.log("miles:", miles);
  } else {
    console.log(JSON.stringify(json, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  if (err.cause) console.error("cause:", err.cause);
  process.exit(1);
});
