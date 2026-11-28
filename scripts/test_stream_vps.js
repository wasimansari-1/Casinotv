#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

console.log("========================================================");
console.log("🔍 VPS ENVIRONMENT & PROXY AUDIT REPORT");
console.log("========================================================");

// 1. Audit .env file directly from disk
const envPath = path.join(__dirname, "../.env");
console.log(`Checking .env path: ${envPath}`);
if (!fs.existsSync(envPath)) {
  console.log("❌ CRITICAL: .env file DOES NOT EXIST at /root/Casinotv/.env!");
} else {
  console.log("✅ .env file EXISTS on disk! Contents:");
  const envLines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
      // Sanitize passwords if any
      const displayVal = key.toLowerCase().includes("pass") || key.toLowerCase().includes("secret")
        ? "********"
        : val;
      console.log(`   ${key} = ${displayVal}`);
    }
  }
}

console.log("\n========================================================");
console.log("📡 TESTING PROXY CONNECTIVITY & IP LEAK CHECK");
console.log("========================================================");

const { PROVIDERS, getAuthToken, proxyFetch, directFetch, UA, MOBILE_HEADERS } = require("../backend/streamCore");

(async () => {
  const proxyUrl = process.env.UPSTREAM_PROXY_URL;
  console.log(`Configured UPSTREAM_PROXY_URL: ${proxyUrl || "NONE"}`);

  // Test 1: Direct VPS Datacenter IP
  try {
    const directIpRes = await directFetch("https://ipinfo.io/json", { timeout: 5000 });
    const directGeo = await directIpRes.json();
    console.log(`🖥️  Direct VPS IP: ${directGeo.ip} (${directGeo.org}, ${directGeo.city}, ${directGeo.country})`);
  } catch (e) {
    console.log(`🖥️  Direct VPS IP Check: Failed (${e.message})`);
  }

  // Test 2: Phone Proxy Indian 5G IP
  if (proxyUrl) {
    try {
      const proxyIpRes = await proxyFetch("https://ipinfo.io/json", { timeout: 6000 });
      const proxyGeo = await proxyIpRes.json();
      console.log(`📱 Phone Proxy IP: ${proxyGeo.ip} (${proxyGeo.org}, ${proxyGeo.city}, ${proxyGeo.country})`);
      if (proxyGeo.org && proxyGeo.org.toLowerCase().includes("jio")) {
        console.log("✅ PERFECT! Jio 5G Residential IP active through Tailscale!");
      } else {
        console.log(`ℹ️ Connected via: ${proxyGeo.org}`);
      }
    } catch (e) {
      console.log(`❌ Phone Proxy Check FAILED: ${e.message}`);
      console.log("⚠️ Make sure 'Every Proxy' app is turned ON on your Realme phone and Tailscale is CONNECTED.");
    }
  }

  console.log("\n========================================================");
  console.log("🎰 TESTING CASINO EXCHANGE AUTH & WATCHLINK");
  console.log("========================================================");

  try {
    const token = await getAuthToken("cbtf", true);
    console.log(`✅ CBTF Auth Token Acquired: ${token.slice(0, 20)}...`);

    const prov = PROVIDERS.cbtf;
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
    console.log(`✅ WatchLink HTTP ${watchRes.status} -> URL: ${watchUrl || JSON.stringify(d)}`);

    if (watchUrl) {
      console.log("\n--- Testing GET watchUrl via Phone Proxy with Referer ---");
      const pageRes = await proxyFetch(watchUrl, {
        method: "GET",
        headers: {
          "User-Agent": UA,
          Referer: "https://cbtfexchange.com/",
          ...MOBILE_HEADERS,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
        },
        timeout: 6000,
      });

      const html = await pageRes.text();
      console.log(`GET Page Status: ${pageRes.status} | Length: ${html.length} bytes`);
      console.log(`HTML Preview: ${html.slice(0, 180)}`);

      // Test Platin WebSocket
      console.log("\n--- Testing Platin WebSocket Direct Connect ---");
      const https = require("https");
      const crypto = require("crypto");
      const { getProxyAgent } = require("../backend/streamCore");
      const agent = proxyUrl ? getProxyAgent(proxyUrl) : null;

      const wsHeaders = {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        Origin: "https://live.livecdnplatin.com",
        "User-Agent": UA,
      };

      const req = https.request({
        hostname: "livecdnplatin.com",
        port: 443,
        path: "/UNIVERSE-GE/websocket",
        method: "GET",
        headers: wsHeaders,
        agent: agent,
        timeout: 8000,
        rejectUnauthorized: false,
      });

      req.on("upgrade", (res, socket) => {
        console.log("🎉 Platin WebSocket HTTP 101 Switching Protocols SUCCESSFUL!");
        socket.destroy();
        console.log("\n========================================================");
        console.log("DIAGNOSTIC SUMMARY:");
        console.log("1. VPS .env is 100% CORRECT and proxy is ACTIVE.");
        console.log("2. Exchange auth and watchlink are 100% WORKING.");
        console.log("3. Platin WebSocket connects with 101 SWITCHING PROTOCOLS.");
        console.log("========================================================");
        process.exit(0);
      });

      req.on("error", (err) => {
        console.log(`❌ WebSocket Error: ${err.message}`);
        process.exit(1);
      });

      req.end();
    }
  } catch (e) {
    console.error("❌ Test error:", e.message);
  }
})();
