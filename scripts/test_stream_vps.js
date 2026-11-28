#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const { getWatchUrl, proxyFetch, UA, MOBILE_HEADERS } = require("../backend/streamCore");

(async () => {
  console.log("========================================================");
  console.log("🔍 Testing GET player page first, then POST /ping");
  console.log("========================================================");

  // 1. Get fresh watch link
  const watchData = await getWatchUrl("99.0010", { forceFresh: true });
  console.log("1. Watch URL:", watchData.url);

  // 2. Step 1 of real browser: GET /w/TICKET
  console.log("\n2. Executing Step 1: GET player HTML page...");
  const pageRes = await proxyFetch(watchData.url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Referer: watchData.origin || "https://nice444.com/",
      ...MOBILE_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
    },
    timeout: 8000,
  });

  console.log("GET Page Status:", pageRes.status);
  const cookieHeader = pageRes.headers.get("set-cookie") || "";
  console.log("Set-Cookie:", cookieHeader || "none");
  const html = await pageRes.text();
  console.log("HTML length:", html.length);
  console.log("HTML preview:\n", html.slice(0, 300));

  // Extract embedded cfg if present
  const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
  if (cfgMatch) {
    console.log("Found embedded cfg:", cfgMatch[1]);
  }

  // 3. Step 2 of real browser: POST /ping with variations of page origin
  const targetPingUrl = watchData.url.endsWith("/") ? `${watchData.url}ping` : `${watchData.url}/ping`;
  console.log("\n3. Testing POST /ping...");

  const pageCandidates = [
    "https://nice444.com",
    "https://casino.nice444.com",
    "https://nice444.com/",
    "https://cbtfexchange.com",
    "https://startexch99.com"
  ];

  for (const pageCandidate of pageCandidates) {
    const pingPayload = {
      sid: "probe_" + Date.now(),
      mode: "connecting",
      init: true,
      token: true,
      tz: "Asia/Kolkata",
      tzo: 330,
      page: pageCandidate
    };

    const pingHeaders = {
      "Content-Type": "application/json",
      Origin: new URL(targetPingUrl).origin,
      Referer: watchData.url,
      "User-Agent": UA,
      ...MOBILE_HEADERS,
      Accept: "*/*",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    if (cookieHeader) pingHeaders["Cookie"] = cookieHeader.split(";")[0];

    const pingRes = await proxyFetch(targetPingUrl, {
      method: "POST",
      headers: pingHeaders,
      body: JSON.stringify(pingPayload),
      timeout: 6000
    });

    const pingText = await pingRes.text();
    console.log(`Page: [${pageCandidate}] -> Status: ${pingRes.status} -> Response:`, pingText);
    if (pingText.includes("token")) {
      console.log("🎉 SUCCESS WITH PAGE:", pageCandidate);
      break;
    }
  }

  console.log("========================================================");
  process.exit(0);
})();
