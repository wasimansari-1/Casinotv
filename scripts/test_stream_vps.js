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
  console.log("🎰 TESTING SHAN444 (sdemo) CFG & 2-STEP PING");
  console.log("========================================================");

  const prov = PROVIDERS.shan444;
  // Use cached auth token (no unnecessary re-login)
  const token = await getAuthToken("shan444", false);
  if (!token) {
    console.log("❌ Shan444 login failed!");
    process.exit(1);
  }
  console.log(`✅ Shan444 Auth Token Ready (Cached/Active)`);

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
        "Sec-Ch-Ua": MOBILE_HEADERS["Sec-Ch-Ua"],
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      },
      body: JSON.stringify({ streamId: "99.0010", timestamp: Date.now() }),
      timeout: 8000,
    }
  );

  const d = await watchRes.json().catch(() => null);
  const watchUrl = d?.data?.url;
  console.log(`✅ WatchLink HTTP ${watchRes.status} -> URL: ${watchUrl || JSON.stringify(d)}`);
  if (!watchUrl) process.exit(1);

  const pageRes = await proxyFetch(watchUrl, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Referer: `${prov.base}/`,
      ...MOBILE_HEADERS,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "cross-site",
    },
    timeout: 8000,
  });

  const setCookie = pageRes.headers.get("set-cookie") || "";
  const html = await pageRes.text();
  console.log(`GET Page Status: ${pageRes.status} | Length: ${html.length} | Set-Cookie: ${setCookie ? "YES" : "none"}`);

  const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
  if (!cfgMatch) {
    console.log("⚠️ No cfg found. Preview:", html.slice(0, 200));
    process.exit(1);
  }

  const cfg = JSON.parse(cfgMatch[1]);
  console.log("📋 CFG DETAILS:", JSON.stringify({
    sid: cfg.sid,
    pingUrl: cfg.pingUrl,
    oneTimeToken: cfg.oneTimeToken,
    frameAllow: cfg.frameAllow,
  }, null, 2));

  const pingUrl = cfg.pingUrl.startsWith("http") ? cfg.pingUrl : new URL(cfg.pingUrl, watchUrl).href;
  const pageOrigin = `${prov.base}/`;
  const pingHeaders = {
    "Content-Type": "application/json",
    Origin: new URL(pingUrl).origin,
    Referer: watchUrl,
    "User-Agent": UA,
    "Sec-Ch-Ua": MOBILE_HEADERS["Sec-Ch-Ua"],
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    Accept: "*/*",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  if (setCookie) pingHeaders["Cookie"] = setCookie.split(";")[0];

  // Step 1: exact player.js init ping (init: true, NO token: true)
  const res1 = await proxyFetch(pingUrl, {
    method: "POST",
    headers: pingHeaders,
    body: JSON.stringify({
      sid: cfg.sid,
      mode: "connecting",
      init: true,
      quality: null,
      diag: [],
      tz: "Asia/Kolkata",
      tzo: 330,
      page: pageOrigin,
    }),
    timeout: 6000,
  });
  const txt1 = await res1.text();
  console.log(`\nStep 1 (init: true) -> HTTP ${res1.status}:`, txt1);

  // Step 2: exact player.js playToken ping (init: false, token: true)
  const res2 = await proxyFetch(pingUrl, {
    method: "POST",
    headers: pingHeaders,
    body: JSON.stringify({
      sid: cfg.sid,
      mode: "connecting",
      init: false,
      quality: null,
      diag: [],
      token: true,
      page: pageOrigin,
    }),
    timeout: 6000,
  });
  const txt2 = await res2.text();
  console.log(`Step 2 (token: true) -> HTTP ${res2.status}:`, txt2);

  console.log("========================================================");
  process.exit(0);
})();
