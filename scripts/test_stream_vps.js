#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

// Native .env parser with zero external dependencies
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

const { getWatchUrl, proxyFetch, directFetch, UA, MOBILE_HEADERS } = require("../backend/streamCore");

(async () => {
  console.log("========================================================");
  console.log("🔍 Live VPS Stream & Platin CDN Diagnostic");
  console.log("========================================================");

  const proxyUrl = process.env.UPSTREAM_PROXY_URL || "NONE";
  console.log("1. Configured Proxy:", proxyUrl);

  // 1. Check IP info via proxy
  if (proxyUrl !== "NONE") {
    try {
      const geoRes = await proxyFetch("https://ipinfo.io/json", { timeout: 5000 });
      const geo = await geoRes.json();
      console.log(`✅ Phone Proxy Active! IP: ${geo.ip} | ISP: ${geo.org} | City: ${geo.city}, ${geo.country}`);
    } catch (e) {
      console.error("❌ Phone Proxy Check Failed:", e.message);
    }
  }

  // 2. Fetch fresh WatchLink from nice444
  console.log("\n2. Fetching fresh WatchLink ticket for 20-20 Teen Patti (99.0010)...");
  try {
    const watchData = await getWatchUrl("99.0010", { forceFresh: true });
    console.log("✅ WatchData received:", {
      url: watchData.url,
      origin: watchData.origin,
      provider: watchData.provider
    });

    const targetPingUrl = watchData.url.endsWith("/") ? `${watchData.url}ping` : `${watchData.url}/ping`;
    console.log("\n3. Testing Platin CDN /ping handshake via Phone Proxy...");
    console.log("Target Ping URL:", targetPingUrl);

    const pingPayload = {
      sid: "test_probe_" + Date.now(),
      mode: "connecting",
      init: true,
      token: true,
      tz: "Asia/Kolkata",
      tzo: 330,
      page: watchData.origin || "https://nice444.com/"
    };

    const pingRes = await proxyFetch(targetPingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(targetPingUrl).origin,
        Referer: watchData.url,
        "User-Agent": UA,
        ...MOBILE_HEADERS,
        Accept: "*/*",
      },
      body: JSON.stringify(pingPayload),
      timeout: 8000
    });

    console.log("HTTP Status:", pingRes.status, pingRes.statusText);
    const pingText = await pingRes.text();
    console.log("Upstream Platin Response Body:\n", pingText);

    try {
      const data = JSON.parse(pingText);
      if (data.token) {
        console.log("\n🎉 SUCCESS! Platin Token generated successfully!");
        console.log("WebSocket URL:", data.wsUrl);
        console.log("Stream ID:", data.streamId);
      } else if (data.stop || data.code === "B1") {
        console.log("\n⚠️ Platin Blocked: Upstream returned stop/B1. IP or session mismatch.");
      }
    } catch (_) {}

  } catch (err) {
    console.error("❌ Stream Error:", err.message);
  }

  console.log("========================================================");
  process.exit(0);
})();
