const streamCore = require("../backend/streamCore");
const redisClient = require("../backend/redisClient");

async function runTests() {
  console.log("==================================================================");
  console.log("   80-YEAR ARCHITECT SYSTEM ENGINE VERIFICATION SUITE");
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
    // 1. Test JWT Expiry Decoding
    console.log("\n[TEST 1] Dynamic JWT Sentinel: Expiry Claim Decoder");
    const testExp = Math.floor(Date.now() / 1000) + 7200; // 2 hours in future
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");
    const payload = Buffer.from(JSON.stringify({ user: "test", exp: testExp })).toString("base64");
    const mockJwt = `${header}.${payload}.mockSignature`;

    const decodedExpMs = streamCore.getJwtExpiryMs(mockJwt);
    assert(Math.abs(decodedExpMs - testExp * 1000) < 1000, `Decoded JWT exp matches exact timestamp (${new Date(decodedExpMs).toISOString()})`);

    const nonJwtExpMs = streamCore.getJwtExpiryMs("non-jwt-opaque-token");
    assert(nonJwtExpMs > Date.now(), "Non-JWT token gracefully falls back to default validity window");

    // 2. Test Live Provider Token Fetch with Dynamic JWT Sentinel
    console.log("\n[TEST 2] Live Provider Dynamic Token Sentinel (CBTF)");
    const tStart = Date.now();
    const token = await streamCore.getAuthToken("cbtf");
    const duration = Date.now() - tStart;
    assert(typeof token === "string" && token.length > 20, `CBTF Token successfully acquired (${token.slice(0, 15)}... in ${duration}ms)`);

    const cbtfExpMs = streamCore.getJwtExpiryMs(token);
    const remainingMin = Math.round((cbtfExpMs - Date.now()) / 60000);
    assert(remainingMin > 0, `CBTF JWT dynamic expiration parsed: ${remainingMin} minutes remaining`);

    // 3. Test Redis Shared Cache hit
    console.log("\n[TEST 3] Redis Distributed Multiplexer & Cache Speed");
    const t2Start = Date.now();
    const cachedToken = await streamCore.getAuthToken("cbtf");
    const t2Duration = Date.now() - t2Start;
    assert(cachedToken === token, "Subsequent token request serves identical multiplexed token");
    assert(t2Duration < 20, `Redis/RAM cache hit in ${t2Duration}ms (target <20ms) - 0 upstream requests`);

    // 4. Test Invalidation & Reactive Recovery
    console.log("\n[TEST 4] Reactive 401 Recovery: Cache Invalidation");
    await streamCore.invalidateAuthToken("cbtf");
    const redisCheck = await redisClient.get("auth:cbtf");
    assert(redisCheck === null, "InvalidateAuthToken cleanly purged Redis key auth:cbtf");

    // Re-acquire to restore valid state
    const restoredToken = await streamCore.getAuthToken("cbtf");
    assert(typeof restoredToken === "string", "Self-healing token restoration succeeded");

    // 5. Test WatchLink Resolution for Flagship Casino Table 99.0010
    console.log("\n[TEST 5] Single-Flight Stream Harvester: Casino TV 99.0010");
    const watchData = await streamCore.getWatchUrl("99.0010");
    assert(watchData && watchData.url && watchData.url.startsWith("http"), `WatchLink generated: ${watchData.url ? watchData.url.slice(0, 40) : "none"}...`);
    assert(watchData.expiresAt > Date.now(), `WatchData dynamic TTL calculated: expires in ${Math.round((watchData.expiresAt - Date.now()) / 1000)}s`);

    // 6. Test Live Sports Events Discovery
    console.log("\n[TEST 6] Multi-Provider Sports TV Discovery Engine");
    const sportsEvents = await streamCore.getLiveSportsEvents();
    assert(Array.isArray(sportsEvents), `Live sports events array retrieved (Total found: ${sportsEvents.length})`);

    console.log("\n==================================================================");
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================================");

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("Fatal test error:", err);
    process.exit(1);
  }
}

runTests();
