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
  console.log("🔬 DEEP PROBE: Platin WatchLink HTML & Header Reverse-Eng");
  console.log("========================================================");

  // 1. Get fresh watch link from CBTF
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
  const watchUrl = d?.data?.url;
  console.log("Fresh Watch URL:", watchUrl);
  if (!watchUrl) return;

  // Test variations of GET on watchUrl
  const refererTests = [
    { name: "No Referer", referer: "" },
    { name: "CBTF Base", referer: "https://cbtfexchange.com/" },
    { name: "CBTF Casino Base", referer: "https://casino.cbtfexchange.com/" },
    { name: "CBTF Live Casino", referer: "https://cbtfexchange.com/live-casino/99.0010" },
    { name: "Platin Self", referer: "https://live.livecdnplatin.com/" },
    { name: "Nice444", referer: "https://nice444.com/" },
    { name: "Startexch", referer: "https://startexch99.com/" },
  ];

  for (const t of refererTests) {
    try {
      const headers = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"macOS"',
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Upgrade-Insecure-Requests": "1",
      };
      if (t.referer) headers["Referer"] = t.referer;

      const res = await proxyFetch(watchUrl, {
        method: "GET",
        headers,
        timeout: 5000,
      });

      const body = await res.text();
      const hasCfg = body.includes("cfg");
      const hasPlayer = body.includes("player.js");
      const hasLoader = body.includes("loader.gif");
      console.log(`[${t.name}] -> Status: ${res.status} | Length: ${body.length} | cfg: ${hasCfg} | player.js: ${hasPlayer} | loader.gif: ${hasLoader}`);
      if (hasCfg || hasPlayer || body.length > 500) {
        console.log(`🎉🎉🎉 SUCCESS WITH: ${t.name}!`);
        console.log("Body preview:", body.slice(0, 300));
        break;
      }
    } catch (e) {
      console.log(`[${t.name}] -> Error: ${e.message}`);
    }
  }

  // Also check if Platin's /player/player.js or other files can be fetched directly
  console.log("\n--- Checking Static Assets from Platin ---");
  for (const asset of ["player.js", "loader.gif", "index.html"]) {
    try {
      const aRes = await proxyFetch(`https://live.livecdnplatin.com/player/${asset}`, {
        method: "GET",
        headers: { "User-Agent": UA, Referer: "https://live.livecdnplatin.com/" },
        timeout: 5000,
      });
      console.log(`Asset /player/${asset} -> HTTP ${aRes.status} | Length: ${(await aRes.text()).length}`);
    } catch (e) {
      console.log(`Asset /player/${asset} -> Error: ${e.message}`);
    }
  }

  console.log("\n========================================================");
  process.exit(0);
})();
