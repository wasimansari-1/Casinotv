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
  console.log("🔬 Deep Upstream Platin /ping Protocol Reverse-Engineering");
  console.log("========================================================");

  const provKey = "cbtf";
  const prov = PROVIDERS[provKey];
  const token = await getAuthToken(provKey, true);

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

  const urlObj = new URL(watchUrl);
  const ticketPath = urlObj.pathname; // e.g. /w/XYZ

  const variations = [
    { name: "/w/TICKET/ping", url: `https://live.livecdnplatin.com${ticketPath}/ping` },
    { name: "/w/TICKET/ping (page: cbtfexchange.com)", url: `https://live.livecdnplatin.com${ticketPath}/ping`, page: "https://cbtfexchange.com" },
    { name: "/w/TICKET/ping (page: casino.cbtfexchange.com)", url: `https://live.livecdnplatin.com${ticketPath}/ping`, page: "https://casino.cbtfexchange.com" },
    { name: "/w/TICKET/ping (page: nice444.com)", url: `https://live.livecdnplatin.com${ticketPath}/ping`, page: "https://nice444.com" },
    { name: "/w/TICKET/ping (no page)", url: `https://live.livecdnplatin.com${ticketPath}/ping`, page: "" },
    { name: "/ping (with ticket query)", url: `https://live.livecdnplatin.com/ping?ticket=${encodeURIComponent(ticketPath.replace("/w/", ""))}` },
    { name: "/ping (with sid)", url: `https://live.livecdnplatin.com/ping` },
  ];

  for (const v of variations) {
    const payload = {
      sid: "test_" + Date.now(),
      mode: "connecting",
      init: true,
      token: true,
      tz: "Asia/Kolkata",
      tzo: 330,
      quality: null,
      diag: []
    };
    if (v.page !== undefined) {
      if (v.page) payload.page = v.page;
    } else {
      payload.page = "https://cbtfexchange.com/";
    }

    try {
      const res = await proxyFetch(v.url, {
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
        body: JSON.stringify(payload),
        timeout: 5000
      });

      const text = await res.text();
      console.log(`[${v.name}] -> HTTP ${res.status}:`, text.slice(0, 150));
      if (text.includes("token")) {
        console.log(`🎉🎉🎉 SUCCESS WITH: ${v.name}!`);
        console.log("Full response:", text);
        break;
      }
    } catch (e) {
      console.log(`[${v.name}] -> Error:`, e.message);
    }
  }

  console.log("========================================================");
  process.exit(0);
})();
