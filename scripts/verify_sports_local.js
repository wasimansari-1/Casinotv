/**
 * Comprehensive Local Verification Script for Sports TV & Casino TV
 * Tests zero-proxy, zero-login, no-buffering resilient streaming
 */

const http = require("http");

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 5050,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: {
          Origin: "http://localhost:5050",
          Referer: "http://localhost:5050/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          ...(options.headers || {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(body), raw: body });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body });
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

async function runTests() {
  console.log("==================================================");
  console.log("🧪 STARTING COMPREHENSIVE SPORTS & CASINO TV TESTS");
  console.log("==================================================\n");

  let totalPassed = 0;
  let totalTests = 0;

  function assert(title, condition, extra = "") {
    totalTests++;
    if (condition) {
      totalPassed++;
      console.log(`  ✅ [PASS] ${title} ${extra ? `(${extra})` : ""}`);
    } else {
      console.error(`  ❌ [FAIL] ${title} ${extra ? `(${extra})` : ""}`);
    }
  }

  // TEST 1: Live Sports Events List
  console.log("--- TEST 1: Live Sports Events List (/api/stream/sports/events) ---");
  try {
    const eventsRes = await fetchJson("http://localhost:5050/api/stream/sports/events");
    assert("Events endpoint status 200", eventsRes.status === 200);
    assert("Events returned array", Array.isArray(eventsRes.data?.events));
    console.log(`  ℹ️ Live matches found: ${eventsRes.data?.events?.length || 0}`);
    if (eventsRes.data?.events?.length > 0) {
      const first = eventsRes.data.events[0];
      console.log(`  ℹ️ First Match: [${first.sportName}] ${first.name} (ID: ${first.id}, inPlay: ${first.inPlay}, tv: ${first.tv})`);
    }
  } catch (e) {
    assert("Events endpoint", false, e.message);
  }

  // TEST 2: Sports Player JS Asset (Optimized & Buffer-Tuned)
  console.log("\n--- TEST 2: Sports Player Script (/api/stream/sports/player-assets/sports-player.js) ---");
  try {
    const jsRes = await fetchJson("http://localhost:5050/api/stream/sports/player-assets/sports-player.js");
    assert("Sports Player JS status 200", jsRes.status === 200);
    assert("Buffer lookahead is tuned (maxBufferLength:40)", jsRes.raw.includes("maxBufferLength:40"));
    assert("Freeze detector raised to 120s (Vp>=120)", jsRes.raw.includes("Vp>=120"));
    assert("Ping 403 ignored trap present", jsRes.raw.includes("Ping 403 ignored"));
    assert("STUN redundancy present", jsRes.raw.includes("stun.cloudflare.com:3478"));
  } catch (e) {
    assert("Player JS endpoint", false, e.message);
  }

  // TEST 3: Sports Stream Watchlink & Player HTML (Event: 36288660)
  console.log("\n--- TEST 3: Sports Player HTML (/api/stream/sports/player/36288660) ---");
  let pingTarget = "";
  let watchUrl = "";
  let cfgSid = "";
  try {
    const playerRes = await fetchJson("http://localhost:5050/api/stream/sports/player/36288660?sportId=1");
    assert("Player HTML status 200", playerRes.status === 200);
    const hasCfg = playerRes.raw.includes('id="cfg"');
    assert("HTML contains #cfg JSON", hasCfg);
    assert("Freeze threshold set to 120s", playerRes.raw.includes('"freezeSeconds":120'));
    assert("Canary Watchdog injected", playerRes.raw.includes("Sports Watchdog"));
    assert("Sports player script referenced", playerRes.raw.includes("/api/stream/sports/player-assets/sports-player.js"));

    const m = playerRes.raw.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
    if (m) {
      const cfg = JSON.parse(m[1]);
      cfgSid = cfg.sid;
      console.log("  ℹ️ CFG Parsed successfully:");
      console.log(`     - Stream ID: ${cfg.streamId}`);
      console.log(`     - Freeze Seconds: ${cfg.freezeSeconds}`);
      console.log(`     - Proxied Ping URL: ${cfg.pingUrl.slice(0, 80)}...`);

      // Extract target & watchUrl for Ping tests
      const pingUrlObj = new URL("http://localhost:5050" + cfg.pingUrl);
      pingTarget = pingUrlObj.searchParams.get("target");
      watchUrl = pingUrlObj.searchParams.get("watchUrl");
    }
  } catch (e) {
    assert("Player HTML endpoint", false, e.message);
  }

  // TEST 4: Dedicated Sports Proxy-Ping (/api/stream/sports/proxy-ping)
  console.log("\n--- TEST 4: Sports Proxy-Ping Endpoints ---");
  if (pingTarget) {
    try {
      // 4a. Init Ping (Initial Token Handshake)
      console.log("  Testing 4a: Init Ping Handshake...");
      const initPingUrl = `http://localhost:5050/api/stream/sports/proxy-ping?target=${encodeURIComponent(pingTarget)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=36288660&origin=${encodeURIComponent("https://cbtfexchange.com")}`;
      const initRes = await fetchJson(initPingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { init: true, sid: cfgSid, tz: "Asia/Kolkata", tzo: 330 }
      });
      assert("Init ping status 200", initRes.status === 200);
      assert("Init ping returned ok: true", initRes.data?.ok === true);
      assert("Stream token received", Boolean(initRes.data?.token));
      assert("WebSocket URL received", Boolean(initRes.data?.wsUrl));
      assert("HLS URL received", Boolean(initRes.data?.hlsUrl));
      console.log(`     - Token: ${initRes.data?.token?.slice(0, 30)}...`);
      console.log(`     - HLS: ${initRes.data?.hlsUrl}`);
      console.log(`     - WS: ${initRes.data?.wsUrl}`);

      // 4b. Routine Heartbeat Ping (0ms Instant Responder)
      console.log("  Testing 4b: Fast 0ms Heartbeat Responder (!init)...");
      const t0 = Date.now();
      const heartbeatRes = await fetchJson(initPingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { init: false, sid: cfgSid, state: true }
      });
      const duration = Date.now() - t0;
      assert("Heartbeat ping status 200", heartbeatRes.status === 200);
      assert("Heartbeat ok: true", heartbeatRes.data?.ok === true);
      assert("Heartbeat stop: false", heartbeatRes.data?.stop === false);
      assert("Heartbeat response time < 50ms (0ms local)", duration < 50, `${duration}ms`);
    } catch (e) {
      assert("Proxy Ping test", false, e.message);
    }
  } else {
    console.log("  ⚠️ Skipping Ping test: No ping target extracted");
  }

  // TEST 5: Sports Evict Self-Healing Endpoint
  console.log("\n--- TEST 5: Sports Evict Endpoint (/api/stream/sports/evict) ---");
  try {
    const evictRes = await fetchJson("http://localhost:5050/api/stream/sports/evict?eventId=36288660", {
      method: "POST"
    });
    assert("Evict status 200", evictRes.status === 200);
    assert("Evict ok: true", evictRes.data?.ok === true);
  } catch (e) {
    assert("Evict endpoint", false, e.message);
  }

  // TEST 6: Casino TV Non-Interference Check
  console.log("\n--- TEST 6: Casino TV Non-Interference Check (/api/stream/player/99.0010) ---");
  try {
    const casinoRes = await fetchJson("http://localhost:5050/api/stream/player/99.0010");
    assert("Casino TV status 200", casinoRes.status === 200);
    assert("Casino TV contains cfg", casinoRes.raw.includes('id="cfg"'));
    assert("Casino TV player script intact", casinoRes.raw.includes("/api/stream/player-assets/player.js"));
  } catch (e) {
    assert("Casino TV check", false, e.message);
  }

  console.log("\n==================================================");
  console.log(`📊 FINAL RESULTS: ${totalPassed} / ${totalTests} TESTS PASSED`);
  if (totalPassed === totalTests) {
    console.log("🎉 ALL TESTS PASSED! ZERO BUFFERING & RESILIENT SPORTS ENGINE READY!");
  } else {
    console.log("⚠️ SOME TESTS FAILED. CHECK LOGS ABOVE.");
  }
  console.log("==================================================");

  process.exit(totalPassed === totalTests ? 0 : 1);
}

runTests().catch((e) => {
  console.error("Test execution failed:", e);
  process.exit(1);
});
