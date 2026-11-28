#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
      const idx = trimmed.indexOf("=");
      if (!process.env[trimmed.slice(0, idx).trim()]) {
        process.env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
}

const { PROVIDERS, getAuthToken, proxyFetch, UA, MOBILE_HEADERS } = require("../backend/streamCore");

(async () => {
  console.log("========================================================");
  console.log("🔬 Testing Platin 2-Step Ping Protocol via Phone Proxy");
  console.log("========================================================");

  const prov = PROVIDERS.cbtf;
  const token = await getAuthToken("cbtf", true);
  const watchRes = await proxyFetch(
    `${prov.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Origin: prov.base,
        Referer: `${prov.base}/`,
        "User-Agent": UA,
        ...MOBILE_HEADERS,
      },
      body: JSON.stringify({ streamId: "99.0010", timestamp: Date.now() }),
      timeout: 8000,
    }
  );

  const d = await watchRes.json();
  const watchUrl = d?.data?.url || "";
  console.log("Watch URL:", watchUrl);
  if (!watchUrl) return;

  const targetPingUrl = watchUrl.endsWith("/") ? `${watchUrl}ping` : `${watchUrl}/ping`;
  const sid = "sid_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);

  // Step 1: Exact player.js boot ping (init: true, WITHOUT token: true)
  console.log("\nStep 1: Sending initial boot ping (init: true)...");
  const p1 = {
    sid: sid,
    mode: "connecting",
    init: true,
    tz: "Asia/Kolkata",
    tzo: 330,
    page: "https://cbtfexchange.com"
  };

  const res1 = await proxyFetch(targetPingUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://live.livecdnplatin.com",
      Referer: watchUrl,
      "User-Agent": UA,
      ...MOBILE_HEADERS,
      Accept: "*/*",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(p1),
    timeout: 6000
  });

  console.log(`Step 1 Status: ${res1.status}`);
  const text1 = await res1.text();
  console.log("Step 1 Response:", text1);

  // Step 2: Exact playToken ping (token: true, init: false)
  console.log("\nStep 2: Sending token request ping (token: true)...");
  const p2 = {
    sid: sid,
    mode: "connecting",
    token: true,
    page: "https://cbtfexchange.com"
  };

  const res2 = await proxyFetch(targetPingUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://live.livecdnplatin.com",
      Referer: watchUrl,
      "User-Agent": UA,
      ...MOBILE_HEADERS,
      Accept: "*/*",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    },
    body: JSON.stringify(p2),
    timeout: 6000
  });

  console.log(`Step 2 Status: ${res2.status}`);
  const text2 = await res2.text();
  console.log("Step 2 Response:", text2);

  console.log("========================================================");
  process.exit(0);
})();
