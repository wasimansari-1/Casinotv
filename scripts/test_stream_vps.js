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
  console.log("🔍 Testing All Providers (CBTF, Startexch, Nice444)");
  console.log("========================================================");

  const tableId = "99.0010";
  const providersToTest = ["cbtf", "startexch", "nice444"];

  for (const provKey of providersToTest) {
    const prov = PROVIDERS[provKey];
    console.log(`\n--- Testing Provider: ${prov.name} (${provKey}) ---`);
    try {
      const token = await getAuthToken(provKey, true);
      console.log(`✅ Auth Token acquired for ${prov.name}`);

      const watchHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Origin: prov.base,
        Referer: `${prov.base}/`,
        "User-Agent": UA,
        ...MOBILE_HEADERS,
      };

      const watchBody = JSON.stringify({
        streamId: tableId,
        timestamp: Date.now(),
      });

      const res = await proxyFetch(
        `${prov.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`,
        {
          method: "POST",
          headers: watchHeaders,
          body: watchBody,
          timeout: 8000,
        }
      );

      const d = await res.json();
      console.log(`WatchLink Status: ${res.status}`);
      const watchUrl = d?.data?.url;
      console.log(`Watch URL:`, watchUrl || d);

      if (watchUrl) {
        // Test GET page with provider origin as referer
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
          timeout: 6000,
        });

        const html = await pageRes.text();
        console.log(`GET Page Status: ${pageRes.status} | Length: ${html.length}`);
        if (html.includes("cfg")) {
          console.log("🎉 FOUND EMBEDDED CFG IN HTML!");
        } else {
          console.log("HTML Preview:", html.slice(0, 150));
        }

        // Test POST /ping
        const targetPingUrl = watchUrl.endsWith("/") ? `${watchUrl}ping` : `${watchUrl}/ping`;
        const pingRes = await proxyFetch(targetPingUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(targetPingUrl).origin,
            Referer: watchUrl,
            "User-Agent": UA,
            ...MOBILE_HEADERS,
            Accept: "*/*",
          },
          body: JSON.stringify({
            sid: "probe_" + Date.now(),
            mode: "connecting",
            init: true,
            token: true,
            page: `${prov.base}/`,
          }),
          timeout: 6000,
        });

        const pingText = await pingRes.text();
        console.log(`POST /ping Status: ${pingRes.status} | Response:`, pingText);
        if (pingText.includes("token")) {
          console.log(`🎉🎉🎉 SUCCESS WITH ${prov.name}! Token acquired!`);
        }
      }
    } catch (e) {
      console.error(`❌ Error with ${prov.name}:`, e.message);
    }
  }

  console.log("\n========================================================");
  process.exit(0);
})();
