#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

async function getFreshWatchUrl(token) {
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
  return d?.data?.url;
}

function curlTest(url, useProxy) {
  const args = [
    "-s",
    "--http2",
    "-H", "Referer: https://cbtfexchange.com/",
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Sec-Fetch-Dest: iframe",
    "-H", "Sec-Fetch-Mode: navigate",
    "-H", "Sec-Fetch-Site: cross-site",
    "-A", UA,
  ];
  if (useProxy && process.env.UPSTREAM_PROXY_URL) {
    args.push("-x", process.env.UPSTREAM_PROXY_URL);
  }
  args.push(url);
  return execFileSync("curl", args, { encoding: "utf8", timeout: 10000 });
}

(async () => {
  console.log("========================================================");
  console.log("🔬 TLS / IP ISOLATION TEST: curl --http2 (Proxy vs Direct)");
  console.log("========================================================");

  const token = await getAuthToken("cbtf", true);

  // Test 1: Fresh WatchURL + curl --http2 via Phone Proxy
  const url1 = await getFreshWatchUrl(token);
  console.log("\n1. Fresh Watch URL #1:", url1);
  if (url1) {
    const html1 = curlTest(url1, true);
    console.log(`[curl --http2 VIA PHONE PROXY] Length: ${html1.length} | cfg: ${html1.includes("cfg")} | loader.gif: ${html1.includes("loader.gif")}`);
    if (html1.includes("cfg")) console.log("🎉 PHONE PROXY + CURL HTTP2 UNLOCKED CFG!");
  }

  // Test 2: Fresh WatchURL + curl --http2 Direct VPS (no proxy)
  const url2 = await getFreshWatchUrl(token);
  console.log("\n2. Fresh Watch URL #2:", url2);
  if (url2) {
    const html2 = curlTest(url2, false);
    console.log(`[curl --http2 DIRECT VPS] Length: ${html2.length} | cfg: ${html2.includes("cfg")} | loader.gif: ${html2.includes("loader.gif")}`);
    console.log("HTML #2 Preview:\n", html2.slice(0, 1200));
  }

  console.log("\n========================================================");
  process.exit(0);
})();
