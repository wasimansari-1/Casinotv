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
  console.log("🎰 TESTING SHAN444 (sdemo) CASINO STREAM END-TO-END");
  console.log("========================================================");

  const prov = PROVIDERS.shan444;
  const token = await getAuthToken("shan444", true);
  if (!token) {
    console.log("❌ Shan444 login failed! Check endpoint or credentials.");
    process.exit(1);
  }
  console.log(`✅ Shan444 Auth Token Acquired: ${token.slice(0, 24)}...`);

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

  const html = await pageRes.text();
  console.log(`GET Page Status: ${pageRes.status} | Length: ${html.length} | cfg: ${html.includes("cfg")} | loader.gif: ${html.includes("loader.gif")}`);

  const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
  if (cfgMatch) {
    const cfg = JSON.parse(cfgMatch[1]);
    console.log("🎉 FOUND CFG! streamId:", cfg.streamId, "| pingUrl:", cfg.pingUrl);
    const pingUrl = cfg.pingUrl.startsWith("http") ? cfg.pingUrl : new URL(cfg.pingUrl, watchUrl).href;
    const pingRes = await proxyFetch(pingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(pingUrl).origin,
        Referer: watchUrl,
        "User-Agent": UA,
        Accept: "*/*",
      },
      body: JSON.stringify({
        sid: cfg.sid,
        mode: "connecting",
        init: true,
        token: true,
        page: `${prov.base}/`,
        tz: "Asia/Kolkata",
        tzo: 330,
      }),
      timeout: 6000,
    });
    const pingJson = await pingRes.json().catch(() => null);
    console.log(`POST /ping Status: ${pingRes.status} | token: ${pingJson?.token ? "YES (" + pingJson.token.slice(0, 20) + "...)" : "NO"} | wsUrl: ${pingJson?.wsUrl}`);
  } else {
    console.log("⚠️ No cfg found. Preview:", html.slice(0, 200));
  }

  console.log("========================================================");
  process.exit(0);
})();
