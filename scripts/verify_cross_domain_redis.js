const http = require("http");

function fetchPlayer(eventId, referer) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(`http://localhost:5050/api/stream/player/${eventId}`);
    const req = http.get(u, {
      headers: {
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({
        status: res.statusCode,
        duration: Date.now() - t0,
        len: data.length,
        hasCfg: data.includes('id="cfg"'),
        isBlocked: data.includes("UNAUTHORIZED EMBED") || data.includes("Access blocked"),
        body: data
      }));
    });
    req.on("error", reject);
  });
}

async function runBenchmark() {
  console.log("==================================================================");
  console.log("   CROSS-DOMAIN REDIS MULTIPLEXER BENCHMARK TEST");
  console.log("==================================================================");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Initial hit from Domain A (e.g. chimneysolutions.info or universeapi.site)
    console.log("\n[STEP 1] Requesting Table 99.0010 from DOMAIN A (https://universeapi.site)");
    const resA = await fetchPlayer("99.0010", "https://universeapi.site/");
    assert(resA.status === 200, `Domain A received HTTP 200 (duration: ${resA.duration}ms)`);
    assert(resA.hasCfg && !resA.isBlocked, "Domain A received clean player HTML with cfg");

    // 2. Immediate hit from DOMAIN B (https://exchange444.com)
    console.log("\n[STEP 2] Requesting Table 99.0010 from DOMAIN B (https://exchange444.com)");
    const resB1 = await fetchPlayer("99.0010", "https://exchange444.com/");
    assert(resB1.status === 200, `Domain B received HTTP 200 (duration: ${resB1.duration}ms)`);
    assert(resB1.duration < 50, `Domain B served directly from Redis/RAM cache in ${resB1.duration}ms (target <50ms)`);
    assert(resB1.hasCfg && !resB1.isBlocked, "Domain B received clean player HTML without re-fetching from upstream!");

    // 3. Request from DOMAIN C (https://dream444.fun)
    console.log("\n[STEP 3] Requesting Table 99.0010 from DOMAIN C (https://dream444.fun)");
    const resC = await fetchPlayer("99.0010", "https://dream444.fun/");
    assert(resC.status === 200, `Domain C received HTTP 200 (duration: ${resC.duration}ms)`);
    assert(resC.duration < 50, `Domain C served directly from Redis/RAM cache in ${resC.duration}ms (target <50ms)`);
    assert(resC.hasCfg && !resC.isBlocked, "Domain C received clean player HTML from Redis");

    // 4. Request from DOMAIN D (https://aura.igambli.com)
    console.log("\n[STEP 4] Requesting Table 99.0010 from DOMAIN D (https://aura.igambli.com)");
    const resD = await fetchPlayer("99.0010", "https://aura.igambli.com/");
    assert(resD.status === 200, `Domain D received HTTP 200 (duration: ${resD.duration}ms)`);
    assert(resD.duration < 50, `Domain D served directly from Redis in ${resD.duration}ms (target <50ms)`);
    assert(resD.hasCfg && !resD.isBlocked, "Domain D received clean player HTML from Redis");

    // 5. Test routine ping from Domain B
    console.log("\n[STEP 5] Testing Routine Heartbeat Ping from Domain B");
    const pingStart = Date.now();
    const pingRes = await new Promise((resolve) => {
      const pReq = http.request("http://localhost:5050/api/stream/proxy-ping?eventId=99.0010", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Referer": "https://exchange444.com/" }
      }, (r) => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => resolve({ status: r.statusCode, duration: Date.now() - pingStart, data: JSON.parse(d) }));
      });
      pReq.write(JSON.stringify({ init: false }));
      pReq.end();
    });
    assert(pingRes.status === 200, `Ping returned HTTP 200 in ${pingRes.duration}ms`);
    assert(pingRes.data.state === "live" && pingRes.data.token, `Ping data contains live state and token (${pingRes.data.token.slice(0, 15)}...)`);

    console.log("\n==================================================================");
    console.log(`BENCHMARK SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================================");

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Test error:", err);
    process.exit(1);
  }
}

runBenchmark();
