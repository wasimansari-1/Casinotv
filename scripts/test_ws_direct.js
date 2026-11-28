#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

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

const { PROVIDERS, getAuthToken, proxyFetch, getProxyAgent, UA, MOBILE_HEADERS } = require("../backend/streamCore");

(async () => {
  console.log("========================================================");
  console.log("⚡ Testing Platin WebSocket Tunnel directly via Phone Proxy");
  console.log("========================================================");

  const proxyUrl = process.env.UPSTREAM_PROXY_URL;
  const agent = proxyUrl ? getProxyAgent(proxyUrl) : null;

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
  const watchUrl = d?.data?.url || "";
  console.log("Fresh Watch URL:", watchUrl);
  const ticket = watchUrl.split("/w/")[1] || "";
  console.log("Ticket / Token:", ticket);

  const secKey = crypto.randomBytes(16).toString("base64");
  const wsHeaders = {
    "Connection": "Upgrade",
    "Upgrade": "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": secKey,
    "Origin": "https://live.livecdnplatin.com",
    "User-Agent": UA
  };

  const req = https.request({
    hostname: "livecdnplatin.com",
    port: 443,
    path: "/UNIVERSE-GE/websocket",
    method: "GET",
    headers: wsHeaders,
    agent: agent,
    timeout: 10000,
    rejectUnauthorized: false
  });

  req.on("response", (res) => {
    console.log(`❌ WebSocket Upgrade Rejected: HTTP ${res.statusCode} ${res.statusMessage}`);
    process.exit(1);
  });

  req.on("upgrade", (res, socket, head) => {
    console.log("🎉 101 SWITCHING PROTOCOLS! WebSocket Connected to Platin CDN!");

    // Helper to send a masked text WebSocket frame
    function sendWsText(text) {
      const payload = Buffer.from(text, "utf8");
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    // Parse unmasked incoming text frame from server
    socket.on("data", (chunk) => {
      // Find JSON start
      const str = chunk.toString("utf8");
      const jsonStart = str.indexOf("{");
      if (jsonStart !== -1) {
        const jsonEnd = str.lastIndexOf("}");
        if (jsonEnd > jsonStart) {
          const jsonStr = str.slice(jsonStart, jsonEnd + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            console.log("\n📩 Received Message from Platin CDN:");
            console.log("Command:", parsed.command);
            if (parsed.command === "takeConfiguration") {
              console.log("🎉🎉🎉 WEBRTC SDP OFFER RECEIVED! VIDEO STREAM FULLY UNLOCKED!");
              console.log("SDP preview:", parsed.sdp ? parsed.sdp.slice(0, 100) : "no sdp");
              setTimeout(() => process.exit(0), 1000);
            } else {
              console.log("Response:", JSON.stringify(parsed, null, 2));
            }
          } catch (_) {
            console.log("Raw message chunk:", str);
          }
        }
      }
    });

    // Test 1: Send play command with ticket as token
    console.log("\n1. Sending play command with ticket as token...");
    sendWsText(JSON.stringify({
      command: "play",
      streamId: "GAME10",
      token: ticket,
      room: "",
      trackList: [],
      subscriberId: "",
      subscriberCode: "",
      viewerInfo: "",
      role: "",
      userPublishId: ""
    }));

    // Test 2: After 3s, send play command with empty token
    setTimeout(() => {
      console.log("\n2. Sending play command with empty token...");
      sendWsText(JSON.stringify({
        command: "play",
        streamId: "GAME10",
        token: "",
        room: "",
        trackList: [],
        subscriberId: "",
        subscriberCode: "",
        viewerInfo: "",
        role: "",
        userPublishId: ""
      }));
    }, 3000);
  });

  req.on("error", (err) => {
    console.error("❌ Request Error:", err.message);
    process.exit(1);
  });

  req.end();

  setTimeout(() => {
    console.log("\nTest completed (timeout). Exiting.");
    process.exit(0);
  }, 10000);
})();
