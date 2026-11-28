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

const { PROVIDERS, getAuthToken, proxyFetch, UA, MOBILE_HEADERS, GAME_MAP } = require("../backend/streamCore");

(async () => {
  console.log("========================================================");
  console.log("🔍 Scanning Live Casino Tables (Checking for active CFG)");
  console.log("========================================================");

  const testTables = [
    { id: "99.0018", name: "Dragon Tiger" },
    { id: "99.0030", name: "Lucky 7" },
    { id: "99.0013", name: "1 Day Teen Patti" },
    { id: "99.0010", name: "20-20 Teen Patti" }
  ];

  const provKey = "cbtf";
  const prov = PROVIDERS[provKey];
  const token = await getAuthToken(provKey, true);
  console.log(`Using provider: ${prov.name}`);

  for (const table of testTables) {
    console.log(`\nTesting [${table.id}] ${table.name}...`);
    try {
      const res = await proxyFetch(
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
          body: JSON.stringify({ streamId: table.id, timestamp: Date.now() }),
          timeout: 8000,
        }
      );

      const d = await res.json();
      const watchUrl = d?.data?.url;
      if (!watchUrl) {
        console.log(`WatchLink error:`, d);
        continue;
      }

      // Test with referer prov.casinoBase vs prov.base
      const pageRes = await proxyFetch(watchUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Referer: `${prov.casinoBase}/`,
          ...MOBILE_HEADERS,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
        },
        timeout: 6000,
      });

      const html = await pageRes.text();
      console.log(`Status: ${pageRes.status} | HTML Length: ${html.length}`);
      if (html.includes("cfg")) {
        console.log(`🎉🎉🎉 SUCCESS! TABLE ${table.name} HAS LIVE STREAM CFG!`);
        console.log("CFG snippet:", html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/)?.[1]);
        break;
      } else {
        console.log(`Returned 339-byte loader (${html.slice(0, 100)}...)`);
      }
    } catch (e) {
      console.error(`Error on ${table.name}:`, e.message);
    }
  }

  console.log("\n========================================================");
  process.exit(0);
})();
