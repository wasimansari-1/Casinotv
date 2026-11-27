const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const https = require("https");
const express = require("express");
const cors = require("cors");
const securityEngine = require("./securityEngine");
const {
  getAuthToken,
  invalidateAuthToken,
  getJwtExpiryMs,
  getWatchUrl,
  invalidateWatchUrl,
  rotateTableSession,
  getSportsWatchUrl,
  getLiveSportsEvents,
  GAME_MAP,
  PROVIDERS,
  UA,
  MOBILE_HEADERS,
  proxyFetch,
  directFetch,
  providerManager,
  redisClient,
  CONFIG,
} = require("./streamCore");

const router = express.Router();

// High-speed persistent HTTP agent & chunk cache for zero-drop HLS proxying
const hlsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 35,
  timeout: 15000,
});
const tsCache = new Map();
const inFlightTs = new Map();

async function fetchFullTsSegment(targetUrl) {
  if (tsCache.has(targetUrl)) {
    return tsCache.get(targetUrl);
  }
  if (inFlightTs.has(targetUrl)) {
    return inFlightTs.get(targetUrl);
  }

  const task = (async () => {
    try {
      const headRes = await fetch(targetUrl, {
        method: "HEAD",
        headers: { "User-Agent": UA },
      });
      const totalLength = parseInt(
        headRes.headers.get("content-length") || "0",
        10,
      );

      if (!totalLength) {
        const r = await fetch(targetUrl, { headers: { "User-Agent": UA } });
        const buf = Buffer.from(await r.arrayBuffer());
        if (tsCache.size > 50) {
          const firstKey = tsCache.keys().next().value;
          tsCache.delete(firstKey);
        }
        tsCache.set(targetUrl, buf);
        return buf;
      }

      const CHUNK_SIZE = 64 * 1024;
      const numChunks = Math.ceil(totalLength / CHUNK_SIZE);
      const promises = [];

      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE - 1, totalLength - 1);
        promises.push(
          new Promise((resolve, reject) => {
            const u = new URL(targetUrl);
            const req = https.request(
              {
                hostname: u.hostname,
                port: 443,
                path: u.pathname + u.search,
                method: "GET",
                agent: hlsAgent,
                headers: {
                  "User-Agent": UA,
                  Range: `bytes=${start}-${end}`,
                  Connection: "keep-alive",
                },
              },
              (res) => {
                const bufs = [];
                res.on("data", (c) => bufs.push(c));
                res.on("end", () => resolve(Buffer.concat(bufs)));
              },
            );
            req.on("error", reject);
            req.end();
          }),
        );
      }

      const chunks = await Promise.all(promises);
      const full = Buffer.concat(chunks);

      if (tsCache.size > 50) {
        const firstKey = tsCache.keys().next().value;
        tsCache.delete(firstKey);
      }
      tsCache.set(targetUrl, full);
      return full;
    } finally {
      inFlightTs.delete(targetUrl);
    }
  })();

  inFlightTs.set(targetUrl, task);
  return task;
}

// Memory cache for modified player HTML (TTL 1 Hour in RAM, 2 Hours in Redis) to ensure 100% instant responses
const CASINO_CACHE_TTL = 3600 * 1000;
const playerCache = new Map();
const inFlightPlayers = new Map();
const inFlightPings = new Map();
const pingCache = new Map();
const tableTokenCache = new Map(); // eventId -> { token, wsUrl, streamId, expiresAt }

// Active Table Tracker: Tracks real viewer touch events per table to avoid blind batch warming
const _activeTableTouches = new Map(); // eventId -> lastTouchTimestamp

function recordTableTouch(eventId) {
  if (!eventId) return;
  const now = Date.now();
  _activeTableTouches.set(eventId, now);
  // Persist touch in Redis (30-min TTL) to coordinate across all PM2 workers
  redisClient.set(`active_table:${eventId}`, now, 1800).catch(() => {});
}

async function isTableActive(eventId, maxAgeMs = 20 * 60 * 1000) {
  if (!eventId) return false;
  // Flagship table (20-20 Teen Patti) is always considered active
  if (eventId === "99.0010") return true;
  const localTouch = _activeTableTouches.get(eventId);
  if (localTouch && Date.now() - localTouch < maxAgeMs) {
    return true;
  }
  const redisTouch = await redisClient.get(`active_table:${eventId}`).catch(() => null);
  if (redisTouch && Date.now() - Number(redisTouch) < maxAgeMs) {
    _activeTableTouches.set(eventId, Number(redisTouch));
    return true;
  }
  return false;
}

// Calculate accurate token expiry from JWT payload to prevent premature expiry
function resolveTokenExpiry(token, fallbackMs = 60000) {
  try {
    if (token && typeof token === "string" && token.includes(".")) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf8"),
        );
        if (payload && payload.exp && typeof payload.exp === "number") {
          return payload.exp * 1000;
        }
      }
    }
  } catch (_) {}
  return Date.now() + fallbackMs;
}

// Strict validity check: Token must be non-empty and unexpired
function isTokenValid(tokenObj) {
  if (!tokenObj || !tokenObj.token) return false;
  const expiresAt = Number(tokenObj.expiresAt) || 0;
  return Date.now() < (expiresAt - 2000);
}

// Helper: Return proxied WebSocket URL so browsers never get blocked by upstream Origin 403 checks
const fallbackWsUrl = `/api/stream/ws?target=${encodeURIComponent("wss://livecdnplatin.com/UNIVERSE-GE/websocket")}`;
function getProxiedWsUrl(originalWsUrl, defaultHost = "livecdnplatin.com") {
  if (!originalWsUrl) return fallbackWsUrl;
  let clean = String(originalWsUrl).trim();
  if (clean.startsWith("/api/stream/ws")) return clean;
  if (
    clean === "edge" ||
    clean.startsWith("edge/") ||
    clean.startsWith("/edge/")
  ) {
    clean = `wss://${defaultHost}/UNIVERSE-GE/websocket`;
  } else if (clean.startsWith("//")) {
    clean = `wss:${clean}`;
  } else if (clean.startsWith("/")) {
    clean = `wss://${defaultHost}${clean}`;
  } else if (!clean.startsWith("ws://") && !clean.startsWith("wss://")) {
    clean = `wss://${defaultHost}/${clean}`;
  }
  return `/api/stream/ws?target=${encodeURIComponent(clean)}`;
}

// Dynamically inject live valid token and proxied wsUrl into player HTML
function injectLiveTokenIntoHtml(html, eventId) {
  let tokenObj = tableTokenCache.get(eventId);
  const valid = isTokenValid(tokenObj);
  const token = valid ? tokenObj.token : "";
  const ws = valid ? getProxiedWsUrl(tokenObj.wsUrl) : fallbackWsUrl;

  if (token) {
    return html.replace(
      /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
      (match, p1) => {
        try {
          const cfg = JSON.parse(p1);
          cfg.token = token;
          cfg.wsUrl = ws;
          return `<script type="application/json" id="cfg">${JSON.stringify(cfg)}</script>`;
        } catch (_) {
          return match;
        }
      },
    );
  }
  return html;
}

// Helper: Pre-warm or force-fetch a single casino table in memory/Redis with distributed lock
async function warmCasinoTable(eventId, forceFresh = false) {
  // Coordinate across PM2 cluster: only 1 worker warms this table at a time
  const lockKey = `warmer:${eventId}`;
  const acquired = await redisClient.acquireLock(lockKey, 30);
  if (!acquired) {
    return false;
  }

  try {
    // 1. FAST PATH: Check if we already have valid HTML and an ACTIVE VALID token (0 proxy calls!)
    // Once ANY domain or warmer loads a table, it remains 100% active in Redis as long as the token is valid
    if (!forceFresh) {
      let existingHtml = await redisClient.get(`html:${eventId}`);
      if (
        existingHtml &&
        typeof existingHtml === "string" &&
        existingHtml.includes("cfg") &&
        !existingHtml.includes("Access blocked")
      ) {
        let existingToken =
          tableTokenCache.get(eventId) ||
          (await redisClient.get(`table_token:${eventId}`).catch(() => null));
        if (isTokenValid(existingToken)) {
          tableTokenCache.set(eventId, existingToken);
          playerCache.set(`casino_${eventId}`, {
            html: existingHtml,
            expiresAt: Date.now() + CASINO_CACHE_TTL,
            timestamp: Date.now(),
          });
          return true;
        }
      }
    }

    // 2. FRESH TICKET FETCH: On user demand or when ticket actually expires
    const watchData = await getWatchUrl(eventId, { forceFresh: true });
    const watchUrl = typeof watchData === "string" ? watchData : watchData.url;
    const providerOrigin = watchData.origin
      ? watchData.origin.endsWith("/")
        ? watchData.origin
        : `${watchData.origin}/`
      : "https://nice444.com/";
    const session = watchData.session || null;

    // Fetch player HTML via dedicated residential proxy session for this table
    let pageRes = await proxyFetch(watchUrl, {
      session: session,
      headers: {
        "User-Agent": UA,
        Referer: providerOrigin,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 8000,
    }).catch(() => null);

    if (pageRes && pageRes.ok) {
      let html = await pageRes.text();

      // Strict validation: Don't cache blocked or invalid player HTML
      if (
        html.includes("Access blocked") ||
        html.includes("copied player") ||
        !html.includes("cfg")
      ) {
        console.warn(
          `[Stream Warmer] Upstream rejected WatchLink ticket for ${eventId}. Rotating session...`,
        );
        await invalidateWatchUrl(eventId);
        rotateTableSession(eventId, "Warmer ticket rejected");
        return false;
      }

      html = transformPlayerHtml(
        html,
        watchUrl,
        false,
        eventId,
        providerOrigin,
        session,
      );
      playerCache.set(`casino_${eventId}`, {
        html,
        expiresAt: Date.now() + CASINO_CACHE_TTL,
        timestamp: Date.now(),
      });
      // 15 Minutes in Redis - Fresh session active and ready
      await redisClient.set(`html:${eventId}`, html, 900).catch(() => {});
      console.log(
        `[Stream Warmer] Pre-warmed & cached table ${eventId} in memory/Redis (TTL: 15m)`,
      );

      // Pre-warm ping handshake to acquire and cache the valid JWT token in tableTokenCache!
      const cfgMatch = html.match(
        /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
      );
      if (cfgMatch) {
        try {
          const cfg = JSON.parse(cfgMatch[1]);
          const targetUrl = cfg.pingUrl.includes("target=")
            ? decodeURIComponent(
                new URL(cfg.pingUrl, "http://localhost").searchParams.get(
                  "target",
                ),
              )
            : cfg.pingUrl;
          if (targetUrl) {
            let pingRes = null;
            const pingBody = JSON.stringify({
              sid: cfg.sid,
              mode: "connecting",
              init: true,
              page: providerOrigin,
              tz: "Asia/Kolkata",
              tzo: 330,
            });

            // Perform CDN ping handshake via matching proxy session to acquire active token
            pingRes = await proxyFetch(targetUrl, {
              method: "POST",
              session: session,
              headers: {
                "Content-Type": "application/json",
                Origin: new URL(targetUrl).origin,
                Referer: watchUrl,
                "User-Agent": UA,
                Accept: "*/*",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
              },
              body: pingBody,
              timeout: 6000,
            }).catch(() => null);
            if (pingRes) {
              const pingData = await pingRes.json().catch(() => null);
              if (pingData && pingData.token && pingData.wsUrl) {
                const proxiedWs = getProxiedWsUrl(pingData.wsUrl);
                const expMs = resolveTokenExpiry(pingData.token);
                const tokenPayload = {
                  token: pingData.token,
                  wsUrl: proxiedWs,
                  streamId:
                    pingData.streamId ||
                    (GAME_MAP[eventId] && GAME_MAP[eventId].streamId) ||
                    "GAME10",
                  expiresAt: expMs,
                };
                tableTokenCache.set(eventId, tokenPayload);
                const tokenTtlSec = Math.max(30, Math.floor((expMs - Date.now()) / 1000));
                await redisClient
                  .set(`table_token:${eventId}`, tokenPayload, tokenTtlSec)
                  .catch(() => {});
                pingCache.set(targetUrl, {
                  data: { ...pingData, wsUrl: proxiedWs },
                  timestamp: Date.now(),
                });

                // Update caches with modified HTML
                cfg.token = pingData.token;
                cfg.wsUrl = proxiedWs;
                html = html.replace(
                  /<script type="application\/json" id="cfg">[^<]+<\/script>/,
                  `<script type="application/json" id="cfg">${JSON.stringify(cfg)}</script>`,
                );
                playerCache.set(`casino_${eventId}`, {
                  html,
                  expiresAt: Date.now() + CASINO_CACHE_TTL,
                  timestamp: Date.now(),
                });
                await redisClient
                  .set(`html:${eventId}`, html, 1800)
                  .catch(() => {});

                console.log(
                  `[Stream Warmer] Pre-warmed valid token & handshake for table ${eventId} (${tokenPayload.streamId}) in RAM & Redis (Valid for ${tokenTtlSec}s)`,
                );
              }
            }
          }
        } catch (_) {}
      }

      return true;
    }
  } catch (err) {
    console.warn(`[Stream Warmer] Notice for table ${eventId}:`, err.message);
    return false;
  } finally {
    await redisClient.releaseLock(lockKey).catch(() => {});
  }
  return false;
}

let _isWarming = false;
async function warmAllCasinoTables() {
  if (_isWarming) return;
  _isWarming = true;
  try {
    const tableIds = Object.keys(GAME_MAP);
    console.log(
      `[Stream Warmer] Fast parallel pre-warming for all ${tableIds.length} tables...`,
    );
    // Warm in parallel batches of 4 (1 table per provider)
    const batchSize = 4;
    for (let i = 0; i < tableIds.length; i += batchSize) {
      const batch = tableIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((id) => warmCasinoTable(id)));
      if (i + batchSize < tableIds.length) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    console.log(
      `[Stream Warmer] All ${tableIds.length} tables pre-warmed & ready in memory/Redis.`,
    );
  } finally {
    _isWarming = false;
  }
}

// 80-Year Systems Architecture: Proactive Token Sentinel & Demand-Driven Warmer Daemon
// 1. Proactive Token Sentinel (Every 20s): Checks active tables and auto-renews tokens BEFORE they expire
// 2. Continuous Warmer Cycle (Every 4 min): Keeps active table HTML & stream links primed in Redis
// 3. Sequential leaky-bucket spacing (3.5s ± 400ms jitter) prevents provider rate-limits
let _warmerCronRunning = false;
async function runContinuousWarmerCycle() {
  if (_warmerCronRunning) return;
  _warmerCronRunning = true;
  const lockKey = "cron:table_warmer_daemon";
  // Distributed cluster lock for 240s
  const acquired = await redisClient.acquireLock(lockKey, 240);
  if (!acquired) {
    _warmerCronRunning = false;
    return;
  }

  try {
    const tableIds = Object.keys(GAME_MAP);
    const activeTables = [];
    for (const id of tableIds) {
      if (await isTableActive(id)) {
        activeTables.push(id);
      }
    }
    if (!activeTables.includes("99.0010")) {
      activeTables.unshift("99.0010");
    }

    console.log(
      `[Demand Warmer] Refreshing ${activeTables.length} active tables: [${activeTables.join(", ")}]`,
    );

    for (let i = 0; i < activeTables.length; i++) {
      const id = activeTables[i];
      await warmCasinoTable(id);

      if (i < activeTables.length - 1) {
        // Leaky-bucket delay: 3500ms ± 400ms random jitter (3100ms - 3900ms)
        const jitter = Math.floor(Math.random() * 800) - 400;
        const delayMs = 3500 + jitter;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    console.log(
      `[Demand Warmer] Cycle completed: ${activeTables.length} active tables maintained with zero upstream spikes.`,
    );
  } catch (err) {
    console.warn("[Demand Warmer] Warning during cycle:", err.message);
  } finally {
    _warmerCronRunning = false;
    await redisClient.releaseLock(lockKey).catch(() => {});
  }
}

// Pure On-Demand Architecture: Background warmer crons disabled to preserve 100% of proxy bandwidth.
// Tables are cached in Redis for 15-30 minutes upon user request and served in 0ms without background hammering.
// (Crons removed to eliminate proxy quota drain and prevent provider rate-limits)

// Health Check & Monitoring API (Real-Time Provider Observability)
router.get("/health", async (req, res) => {
  const redisStatus = redisClient.getStatus();
  const providerSummary = providerManager.getHealthSummary();
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    redis: redisStatus,
    config: {
      concurrency: CONFIG.concurrency,
      minIntervalMs: CONFIG.minIntervalMs,
      maxRetries: CONFIG.maxRetries,
      cooldownMs: CONFIG.cooldownMs,
      watchlinkTtlSec: CONFIG.watchlinkTtlSec,
    },
    providers: providerSummary,
  });
});

router.get("/metrics", async (req, res) => {
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    providers: providerManager.getHealthSummary(),
  });
});

// 1. Get all supported Casino tables
router.get("/tables", (req, res) => {
  const list = Object.entries(GAME_MAP).map(([id, meta]) => ({
    id,
    name: meta.name,
    streamId: meta.streamId,
    category: meta.category,
    playerUrl: `/api/stream/player/${id}`,
  }));
  res.json({ success: true, count: list.length, tables: list });
});

// 2. Dummy flag and telemetry sinks (Neutralizes anti-devtools & session killer calls)
router.all("/dummy-flag", (req, res) => res.status(200).json({ ok: true }));
router.all("/dummy-bye", (req, res) => res.status(200).json({ ok: true }));

// 3. Get all active Sports Events (Cricket, Soccer, Tennis)
router.get("/sports/events", async (req, res) => {
  try {
    const events = await getLiveSportsEvents();
    res.json({ success: true, count: events.length, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, events: [] });
  }
});

// Helper: Transform upstream player HTML with full bypass patches & watermark removal
function transformPlayerHtml(
  html,
  watchUrl,
  isSports = false,
  eventId = "",
  providerOrigin = "",
  session = "",
) {
  // 1. Completely remove watermark elements and foreign domain strings
  html = html.replace(/<div id="wm">[\s\S]*?<\/div>/gi, "");
  html = html.replace(
    /#wm\{[^}]*\}/gi,
    "#wm{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;height:0!important;width:0!important;}",
  );
  html = html.replace(/www\.nice444\.com/gi, "");
  html = html.replace(/nice444\.com/gi, "");
  html = html.replace(/startexch99\.com/gi, "");
  html = html.replace(/asstarplay\.com/gi, "");
  html = html.replace(/cbtfexchange\.com/gi, "");

  // Universal style injection to ensure watermark, block images and foreign domains are 100% hidden
  const cleanWatermarkStyle = `
    <style>
      #wm, [id="wm"], .watermark, #watermark, #blockImg, [id="blockImg"] {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        height: 0 !important;
        width: 0 !important;
      }
    </style>
  `;

  html = html.replace(
    "</head>",
    `${cleanWatermarkStyle}\n</head>`,
  );

  // 2. Extract and modify the embedded JSON config
  const cfgMatch = html.match(
    /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
  );
  if (cfgMatch) {
    try {
      const originalCfg = JSON.parse(cfgMatch[1]);

      // Resolve ping URL (whether absolute or relative)
      const fullPingUrl = originalCfg.pingUrl.startsWith("http")
        ? originalCfg.pingUrl
        : new URL(originalCfg.pingUrl, watchUrl).href;

      // Construct proxied ping URL that routes through our backend with eventId, provider origin and matching proxy session context
      const proxiedPingUrl = `/api/stream/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=${encodeURIComponent(eventId)}&origin=${encodeURIComponent(providerOrigin)}&session=${encodeURIComponent(session || "")}`;

      const modifiedCfg = {
        ...originalCfg,
        streamId:
          originalCfg.streamId ||
          (eventId && GAME_MAP[eventId]
            ? GAME_MAP[eventId].streamId
            : "GAME10"),
        pingUrl: proxiedPingUrl,
        flagUrl: "/api/stream/dummy-flag",
        byeUrl: "/api/stream/dummy-bye",
        devtoolsGuard: false,
        devtoolsRedirect: "",
        blockedUrl: "",
        home: "", // Neutralize home domain validation
        webrtcTimeout: 30,
        freezeSeconds: 120, // 2 minutes instead of 5s - eliminates false freeze reloads & stutter
        oneTimeToken: false, // Ensure player retains valid token and never drops to loader
        frameAllow: {
          enforce: false,
          outer: { apps: false, hosts: [], sites: [] },
          parent: { apps: false, hosts: [], sites: [] },
        },
      };

      html = html.replace(
        /<script type="application\/json" id="cfg">[^<]+<\/script>/,
        `<script type="application/json" id="cfg">${JSON.stringify(modifiedCfg)}</script>`,
      );
    } catch (e) {
      console.error("[Transform] Error modifying cfg JSON:", e);
    }
  }

  // 3. Rewrite static asset paths with specific script matching
  const ts = Date.now();
  if (isSports) {
    html = html.replace(
      /src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g,
      `src="/api/stream/player-assets/sports-player.js?ts=${ts}"`,
    );
  } else {
    html = html.replace(
      /href=["']\/player\/loader\.gif[^"']*["']/g,
      'href="/api/stream/player-assets/loader.gif"',
    );
    html = html.replace(
      /src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g,
      `src="/api/stream/player-assets/player.js?ts=${ts}"`,
    );
    html = html.replace(
      /background:\s*url\(['"]?\/player\/loader\.gif[^'"]*['"]?\)/g,
      'background:url("/api/stream/player-assets/loader.gif")',
    );
  }

  // 4. Inject client runtime patch for DevTools immunity, watermark purge & Permissions-Policy
  const runtimePatch = `
    <script>
      (function() {
        // Watermark continuous purge
        var purgeWm = function() {
          var wm = document.getElementById('wm');
          if (wm) wm.remove();
          var wms = document.querySelectorAll('#wm, [id="wm"], .watermark');
          wms.forEach(function(el) { el.remove(); });
        };
        try {
          var mo = new MutationObserver(purgeWm);
          mo.observe(document.documentElement, { childList: true, subtree: true });
          document.addEventListener('DOMContentLoaded', purgeWm);
        } catch(e) {}

        if (navigator.sendBeacon) {
          navigator.sendBeacon = function() { return true; };
        }
        var origReplace = window.location.replace;
        window.location.replace = function(url) {
          console.warn('[Proxy Bypass] Suppressed redirect to:', url);
          return false;
        };
        var _origAddEvent = window.addEventListener;
        window.addEventListener = function(type, listener, options) {
          if (type === 'unload') {
            return _origAddEvent.call(this, 'pagehide', listener, options);
          }
          return _origAddEvent.call(this, type, listener, options);
        };
        try {
          Object.defineProperty(window.location, 'ancestorOrigins', {
            get: function() { return ['https://nice444.com', 'https://startexch99.com', 'https://tv.ltve.live']; },
            configurable: true
          });
        } catch(e) {}
      })();
    </script>
  `;
  html = html.replace("</head>", `${runtimePatch}</head>`);
  return html;
}

// 4. Transparent Casino TV Iframe Player (Full Proxy & Bypass Engine)
router.get("/player/:eventId", async (req, res) => {
  const { eventId } = req.params;

  // Master Security Whitelist Guard
  const access = await securityEngine.verifyAccess(req, "casino");
  if (!access.allowed) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res
      .status(403)
      .send(
        securityEngine.renderUnauthorizedScreen(
          access.domain,
          "Casino",
          access.reason,
          access.heading,
        ),
      );
  }

  const forceFresh = Boolean(req.query.force || req.query.fresh);
  recordTableTouch(eventId);

  // 1. FAST PATH: Check RAM cache first (serves in 0ms)
  if (!forceFresh) {
    const cached = playerCache.get(`casino_${eventId}`);
    if (
      cached &&
      Date.now() < cached.expiresAt &&
      cached.html &&
      !cached.html.includes("Access blocked") &&
      cached.html.includes("cfg")
    ) {
      // Fast path: Synchronize active table token if present in Redis
      let tokenObj = tableTokenCache.get(eventId);
      if (!tokenObj || !tokenObj.token) {
        const redisToken = await redisClient
          .get(`table_token:${eventId}`)
          .catch(() => null);
        if (redisToken && redisToken.token) {
          tokenObj = redisToken;
          tableTokenCache.set(eventId, tokenObj);
        }
      }
      const finalHtml = tokenObj?.token ? injectLiveTokenIntoHtml(cached.html, eventId) : cached.html;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );
      return res.send(finalHtml);
    }

    // 2. UNIVERSAL REDIS CACHE: Shared across all PM2 workers & ALL domains (serves in 5-15ms)
    // Once ANY table is loaded once by ANY domain or warmer, it serves from Redis instantly!
    const redisHtml = await redisClient.get(`html:${eventId}`);
    if (
      redisHtml &&
      typeof redisHtml === "string" &&
      redisHtml.includes("cfg") &&
      !redisHtml.includes("Access blocked")
    ) {
      playerCache.set(`casino_${eventId}`, {
        html: redisHtml,
        expiresAt: Date.now() + CASINO_CACHE_TTL,
      });

      // Fast path: Synchronize active table token if present in Redis
      let tokenObj = tableTokenCache.get(eventId);
      if (!tokenObj || !tokenObj.token) {
        const redisToken = await redisClient
          .get(`table_token:${eventId}`)
          .catch(() => null);
        if (redisToken && redisToken.token) {
          tokenObj = redisToken;
          tableTokenCache.set(eventId, tokenObj);
        }
      }

      // Pure Redis-First Serving: Never block or hammer upstream if HTML is already cached!
      const finalHtml = tokenObj?.token ? injectLiveTokenIntoHtml(redisHtml, eventId) : redisHtml;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );
      return res.send(finalHtml);
    }
  }

  // 3. CLUSTER-WIDE SINGLE-FLIGHT MUTEX ON COLD START:
  // If Table X is not in Redis, ensure only 1 PM2 worker across the entire server fetches it!
  // All other concurrent requests across all 1,000 domains wait on the distributed lock
  // and then receive the freshly cached HTML directly from Redis in 0ms!
  const clusterLockKey = `lock:fetch_table:${eventId}`;
  const acquiredLock = await redisClient.acquireLock(clusterLockKey, 20);

  if (!acquiredLock && !forceFresh) {
    console.log(`[Distributed Harvester] Another worker is currently pre-warming table ${eventId}. Waiting...`);
    const unlocked = await redisClient.waitForLock(clusterLockKey, 12000, 200);
    if (unlocked) {
      const redisHtmlAfterWait = await redisClient.get(`html:${eventId}`);
      if (
        redisHtmlAfterWait &&
        typeof redisHtmlAfterWait === "string" &&
        redisHtmlAfterWait.includes("cfg") &&
        !redisHtmlAfterWait.includes("Access blocked")
      ) {
        playerCache.set(`casino_${eventId}`, {
          html: redisHtmlAfterWait,
          expiresAt: Date.now() + CASINO_CACHE_TTL,
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Permissions-Policy", "unload=*");
        res.setHeader(
          "Content-Security-Policy",
          securityEngine.getFrameAncestorsCSP(),
        );
        return res.send(injectLiveTokenIntoHtml(redisHtmlAfterWait, eventId));
      }
    }
  }

  // Deduplicate in-flight requests within the local node process
  if (inFlightPlayers.has(eventId)) {
    try {
      const html = await inFlightPlayers.get(eventId);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );
      return res.send(injectLiveTokenIntoHtml(html, eventId));
    } catch (_) {}
  }

  const fetchTask = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `[Casino Player] Fetching player for ${eventId} (attempt ${attempt})`,
        );

        // Force fresh WatchLink if previous attempt failed
        const watchData = await getWatchUrl(eventId, {
          forceFresh: attempt > 1,
        });
        const watchUrl =
          typeof watchData === "string" ? watchData : watchData.url;
        const referer = watchData.origin
          ? watchData.origin.endsWith("/")
            ? watchData.origin
            : `${watchData.origin}/`
          : "https://casino.nice444.com/";
        const session = watchData.session || null;

        // Fetch player HTML via dedicated residential proxy session for this table
        let pageRes = await proxyFetch(watchUrl, {
          session: session,
          headers: {
            "User-Agent": UA,
            Referer: referer,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Sec-Fetch-Dest": "iframe",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "cross-site",
            "Upgrade-Insecure-Requests": "1",
          },
          timeout: 8000,
        }).catch(() => null);

        if (!pageRes.ok) {
          console.warn(
            `[Casino Player] Upstream returned status ${pageRes.status} for ${eventId}`,
          );
          await invalidateWatchUrl(eventId);
          rotateTableSession(eventId, `Upstream status ${pageRes.status}`);
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          throw new Error(`Upstream stream service returned ${pageRes.status}`);
        }

        let html = await pageRes.text();

        // VALIDATION: Ensure upstream didn't return an Access Blocked or corrupted page
        if (
          html.includes("Access blocked") ||
          html.includes("copied player") ||
          !html.includes("cfg")
        ) {
          console.warn(
            `[Casino Player] Upstream returned blocked/invalid player for ${eventId}`,
          );
          await invalidateWatchUrl(eventId);
          rotateTableSession(eventId, "Upstream ticket rejected");
          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          throw new Error("Upstream rejected player ticket");
        }

        html = transformPlayerHtml(
          html,
          watchUrl,
          false,
          eventId,
          referer,
          session,
        );

        // Cache player HTML for 15 minutes in RAM and distributed Redis
        playerCache.set(`casino_${eventId}`, {
          html,
          expiresAt: Date.now() + CASINO_CACHE_TTL,
          timestamp: Date.now(),
        });
        redisClient
          .set(`html:${eventId}`, html, 900) // 15 Minutes in Redis - Always fresh
          .catch(() => {});

        // Fast pre-warm initial ping handshake before returning HTML so client gets 0ms ping!
        const cfgMatch = html.match(
          /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
        );
        if (cfgMatch) {
          try {
            const cfg = JSON.parse(cfgMatch[1]);
            const targetUrl = cfg.pingUrl.includes("target=")
              ? decodeURIComponent(
                  new URL(cfg.pingUrl, "http://localhost").searchParams.get(
                    "target",
                  ),
                )
              : cfg.pingUrl;
            if (targetUrl) {
              const pingBody = JSON.stringify({
                sid: cfg.sid,
                mode: "connecting",
                init: true,
                page: referer,
                tz: "Asia/Kolkata",
                tzo: 330,
              });

              // Pre-warm ping handshake via matching proxy session to acquire active token
              let data = await proxyFetch(targetUrl, {
                method: "POST",
                session: session,
                headers: {
                  "Content-Type": "application/json",
                  Origin: new URL(targetUrl).origin,
                  Referer: watchUrl,
                  "User-Agent": UA,
                  Accept: "*/*",
                  "Sec-Fetch-Dest": "empty",
                  "Sec-Fetch-Mode": "cors",
                  "Sec-Fetch-Site": "same-origin",
                },
                body: pingBody,
                timeout: 6000,
              })
                .then(async (r) => (r.ok ? r.json() : null))
                .catch(() => null);

              if (data && data.token && data.wsUrl) {
                const proxiedWs = getProxiedWsUrl(data.wsUrl);
                const expMs = resolveTokenExpiry(data.token);
                const tokenPayload = {
                  token: data.token,
                  wsUrl: proxiedWs,
                  streamId:
                    data.streamId ||
                    (GAME_MAP[eventId] && GAME_MAP[eventId].streamId) ||
                    "GAME10",
                  expiresAt: expMs,
                };
                tableTokenCache.set(eventId, tokenPayload);
                const tokenTtlSec = Math.max(30, Math.floor((expMs - Date.now()) / 1000));
                redisClient
                  .set(`table_token:${eventId}`, tokenPayload, tokenTtlSec)
                  .catch(() => {});
                pingCache.set(targetUrl, {
                  data: { ...data, wsUrl: proxiedWs },
                  timestamp: Date.now(),
                });

                // Also inject active token and wsUrl directly into cfg so browser plays immediately!
                cfg.token = data.token;
                cfg.wsUrl = proxiedWs;
                html = html.replace(
                  /<script type="application\/json" id="cfg">[^<]+<\/script>/,
                  `<script type="application/json" id="cfg">${JSON.stringify(cfg)}</script>`,
                );

                // Update caches with token-injected HTML so subsequent hits get immediate ready-to-play stream
                playerCache.set(`casino_${eventId}`, {
                  html,
                  expiresAt: Date.now() + CASINO_CACHE_TTL,
                  timestamp: Date.now(),
                });
                redisClient.set(`html:${eventId}`, html, 1800).catch(() => {});
              }
            }
          } catch (_) {}
        }

        return html;
      } catch (err) {
        console.error(`[Casino Player Error] Attempt ${attempt}:`, err.message);
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw err;
      }
    }
  })();

  inFlightPlayers.set(eventId, fetchTask);
  try {
    const html = await fetchTask;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader(
      "Content-Security-Policy",
      securityEngine.getFrameAncestorsCSP(),
    );
    return res.send(injectLiveTokenIntoHtml(html, eventId));
  } catch (err) {
    // Resilient fallback: If upstream failed, serve previously cached HTML if available
    const stale = playerCache.get(`casino_${eventId}`);
    if (stale && stale.html && !stale.html.includes("Access blocked")) {
      console.log(
        `[Casino Player] Serving stale cache fallback for table ${eventId}`,
      );
      stale.expiresAt = Date.now() + 120000;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );
      return res.send(injectLiveTokenIntoHtml(stale.html, eventId));
    }

    // Clean player fallback: Auto-retrying black screen with centered loader GIF (no synthetic error card)
    const cleanPlayerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#64748b;font-family:sans-serif}.msg{text-align:center}</style><script>setTimeout(function(){location.reload();}, 3000);</script></head><body><div class="msg"><img src="/api/stream/player-assets/loader.gif" style="width:48px;height:48px;display:block;margin:0 auto 10px;opacity:0.7"><div style="color:#94a3b8;font-size:12px;font-weight:500;">Connecting live stream...</div></div></body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(cleanPlayerHtml);
  } finally {
    inFlightPlayers.delete(eventId);
    await redisClient.releaseLock(clusterLockKey).catch(() => {});
  }
});

// 5. Transparent Sports TV Iframe Player (Cricket, Soccer, Tennis Live Streams)
router.get("/sports/player/:eventId", async (req, res) => {
  const { eventId } = req.params;
  const sportId = req.query.sportId || "4";

  // Master Security Whitelist Guard
  const access = await securityEngine.verifyAccess(req, "sports");
  if (!access.allowed) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res
      .status(403)
      .send(
        securityEngine.renderUnauthorizedScreen(
          access.domain,
          "Sports",
          access.reason,
          access.heading,
        ),
      );
  }

  const cacheKey = `sports_${eventId}`;
  const cached = playerCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader(
      "Content-Security-Policy",
      securityEngine.getFrameAncestorsCSP(),
    );
    return res.send(cached.html);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(
        `[Sports Player] Fetching sports stream for match ${eventId} (attempt ${attempt})`,
      );

      const watchData = await getSportsWatchUrl(eventId, sportId);
      const watchUrl = watchData.url;
      const referer = watchData.origin
        ? `${watchData.origin}/`
        : "https://nice444.com/";

      const pageRes = await proxyFetch(watchUrl, {
        headers: {
          "User-Agent": UA,
          Referer: referer,
        },
      });

      if (!pageRes.ok) {
        console.warn(
          `[Sports Player] Upstream returned status ${pageRes.status} for ${eventId}`,
        );
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        return res
          .status(pageRes.status)
          .send(`Sports stream service returned ${pageRes.status}`);
      }

      let html = await pageRes.text();
      html = transformPlayerHtml(html, watchUrl, true, eventId);

      // Cache player HTML for 25 seconds
      playerCache.set(cacheKey, { html, expiresAt: Date.now() + 25000 });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );

      return res.send(html);
    } catch (err) {
      const isNoTv = err.message && err.message.includes("No live TV coverage");
      if (isNoTv) {
        console.log(
          `[Sports Player] Notice for match ${eventId}: No TV broadcast feed currently available upstream`,
        );
      } else {
        console.error(`[Sports Player Error] Attempt ${attempt}:`, err.message);
      }

      if (attempt === 1 && !isNoTv) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Permissions-Policy", "unload=*");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");

      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { margin: 0; background: #07090e; color: #94a3b8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; }
            .icon { font-size: 40px; margin-bottom: 12px; }
            h2 { font-size: 16px; font-weight: 600; color: #f1f5f9; margin: 0 0 6px; }
            p { font-size: 12px; color: #64748b; margin: 0; max-width: 280px; line-height: 1.4; }
          </style>
        </head>
        <body>
          <div class="icon">📡</div>
          <h2>Live TV Feed Unavailable</h2>
          <p>This match does not have an active live satellite TV broadcast right now or the match has concluded.</p>
        </body>
        </html>
      `);
    }
  }
});

const fs = require("fs");
const path = require("path");

let _cachedPatchedPlayerJs = null;
function getPatchedPlayerJs() {
  if (_cachedPatchedPlayerJs) return _cachedPatchedPlayerJs;
  const filePath = path.join(__dirname, "player.js");
  let text = fs.readFileSync(filePath, "utf8");

  // Patch out domain checks & devtools detector
  text = text.replace(/function L\(\)\{/g, "function L(){return!1;");
  text = text.replace(/function S\(\)\{/g, "function S(){return!1;");
  text = text.replace(/function I\(\)\{/g, "function I(){return!1;");
  text = text.replace(/function w\(e\)\{/g, "function w(e){return;");
  text = text.replace(/t\.devtoolsGuard/g, "false");
  text = text.replace(/devtoolsGuard:!0/g, "devtoolsGuard:!1");

  // 1. Neutralize Network Lost screen blur
  text = text.replace(
    /showNetworkLostEffects\(\)\{/g,
    "showNetworkLostEffects(){return;",
  );

  // 1b. Once stream plays, NEVER show loader again (Eliminates flashing loaders during active streaming)
  text = text.replace(
    /showLoading\(\)\{/g,
    "showLoading(){if(window.webrtcPlayer&&window.webrtcPlayer.everPlayed)return;",
  );
  text = text.replace(
    /if\(!window\.webrtcPlayer\|\|!window\.webrtcPlayer\.everPlayed\)return;/g,
    "",
  );

  // 2. Infinite retry on table startup instead of giving up after 5 tries
  text = text.replace(
    /for\(let t=0;t<5&&!p\.ready&&!p\.ended;t\+\+\)t&&await new Promise\(e=>setTimeout\(e,3e3\)\),await p\.ping\(!0\);/g,
    "for(let t=0;!p.ready&&!p.ended;t++){if(t>0)await new Promise(e=>setTimeout(e,2000));try{await p.ping(!0)}catch(e){}}",
  );

  // 3. Neutralize 'The table didn\'t open. Please refresh the page.' (variable l) and premature black screen
  text = text.replace(
    /if\(!p\.ready\)throw new Error\(l\);/g,
    'if(!p.ready){p.ready=!0;if(!p.streamId)p.streamId=(t&&t.streamId)||"GAME30";if(!p.wsUrl)p.wsUrl="wss://livecdnplatin.com/UNIVERSE-GE/websocket";}',
  );
  text = text.replace(
    /g\.say\(l,!0\)/g,
    '(function(){console.warn("[Auto-Retrying Stream]");return false;})()',
  );
  text = text.replace(
    /if\(p\.ended\)return;g\.hideLoading\(\);/g,
    "if(p.ended)return;",
  );

  // 4. Neutralize session killer ("The dealer has closed your session")
  text = text.replace(/403===a\.status/g, "false");
  text = text.replace(
    /g\.say\(a,!0\)/g,
    '(function(){console.warn("[Session Suppressed]");return false;})()',
  );

  // 5. Neutralize visibility killswitch
  text = text.replace(/"visibilitychange"/g, '"disabled_visibility"');

  // 6. Neutralize aggressive 5-second freeze detector (eliminates stutter, buffering, and loops)
  text = text.replace(
    /e\.reconnect\("frozen"\)/g,
    '(function(){console.warn("[Stream Jitter Handled]");})()',
  );

  // 7. Guaranteed mobile autoplay (muted + playsinline before play())
  text = text.replace(
    /tryPlay\(\)\{const e=this\.video\.play\(\);/g,
    'tryPlay(){this.video.muted=!0;this.video.defaultMuted=!0;this.video.playsInline=!0;this.video.setAttribute("playsinline","");this.video.setAttribute("webkit-playsinline","");const e=this.video.play();',
  );

  // 8. Instant 300ms Auto-Reconnect (Replaces 15s - 30s penalty backoff with instant 0.3s retry)
  text = text.replace(
    /this\.reconnectTimer\s*=\s*setTimeout\(\(\)\s*=>\s*this\.retryNow\(\),\s*r\)/g,
    "this.reconnectTimer = setTimeout(() => this.retryNow(), 300)",
  );

  // 8b. Ensure retryNow explicitly requests a fresh token and handshake (init: true, token: true)
  text = text.replace(
    /p\.ping\(\)\.then\(\(\)\s*=>\s*\{/g,
    "p.ping(!0,!0).then(()=>{",
  );

  // 9. Preserve everPlayed flag across socket jitter (Prevents recurring loader screens)
  text = text.replace(/\(this\.everPlayed\s*=\s*!1\)/g, "(void 0)");

  _cachedPatchedPlayerJs = text;
  return text;
}

// 6. Casino Static Assets Proxy (/api/stream/player-assets/player.js)
router.get("/player-assets/player.js", (req, res) => {
  try {
    const text = getPatchedPlayerJs();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(text);
  } catch (err) {
    console.error("[Asset Proxy Error]:", err.message);
    res.status(500).send("Error loading player script");
  }
});

// 7. Sports Static Assets Proxy (/api/stream/player-assets/sports-player.js) - Local RAM Asset
router.get("/player-assets/sports-player.js", (req, res) => {
  try {
    const rawPath = path.join(__dirname, "sports_player_raw.js");
    if (fs.existsSync(rawPath)) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.sendFile(rawPath);
    }
    const fallbackPath = path.join(__dirname, "player.js");
    if (fs.existsSync(fallbackPath)) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.sendFile(fallbackPath);
    }
    return res.status(404).send("Sports player asset not found");
  } catch (err) {
    console.error("[Sports Asset Error]:", err.message);
    res.status(500).send("Error loading sports asset");
  }
});

// 8. Other player static assets (loader.gif, etc.) - Direct Fetch First (0 MB Proxy Quota)
router.get("/player-assets/:asset", async (req, res) => {
  try {
    const { asset } = req.params;
    if (asset === "loader.gif") {
      const gifPath = path.join(__dirname, "loader.gif");
      if (fs.existsSync(gifPath)) {
        res.setHeader("Content-Type", "image/gif");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.sendFile(gifPath);
      }
    }
    if (asset === "player.js") {
      const jsPath = path.join(__dirname, "player.js");
      if (fs.existsSync(jsPath)) {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.sendFile(jsPath);
      }
    }
    if (asset === "sports-player.js") {
      const jsPath = path.join(__dirname, "sports_player_raw.js");
      if (fs.existsSync(jsPath)) {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.sendFile(jsPath);
      }
    }

    const upstreamAssetUrl = `https://live.livecdnplatin.com/player/${asset}`;

    // Direct fetch from CDN (0 MB proxy bandwidth!)
    let upstreamRes;
    try {
      upstreamRes = await directFetch(upstreamAssetUrl, {
        headers: {
          "User-Agent": UA,
          Referer: "https://live.livecdnplatin.com/",
        },
        timeout: 5000,
      });
    } catch (_) {
      upstreamRes = await proxyFetch(upstreamAssetUrl, {
        headers: {
          "User-Agent": UA,
          Referer: "https://live.livecdnplatin.com/",
        },
        timeout: 8000,
      });
    }

    if (!upstreamRes || !upstreamRes.ok) {
      return res
        .status(upstreamRes ? upstreamRes.status : 404)
        .send("Asset not found");
    }

    let contentType =
      upstreamRes.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    res.status(500).send("Error proxying asset");
  }
});

// ============================================================================
// 80-Year Systems Architecture: Dynamic Stream Eviction & Autonomous Re-Harvesting
// ============================================================================
// Called by Client Canary Watchdog or Admin when a stream stalls or a token expires.
// 1. Instantly flushes stale token & HTML cache from Redis and local RAM.
// 2. Triggers the 0.1s Failover Brain to acquire a fresh stream link from the backup pool.
// 3. Viewers NEVER need a User ID - everything is multiplexed through our single-flight engine.
// 4. Zero-Proxy Direct Mobile Emulation ensures upstream accepts connection without third-party proxies.
router.post("/evict", express.json(), async (req, res) => {
  const eventId = String(req.body?.eventId || req.query?.eventId || "").trim();
  const reason = String(req.body?.reason || "client_canary_stalled").trim();

  if (!eventId) {
    return res.status(400).json({ ok: false, error: "eventId is required" });
  }

  console.warn(
    `[Stream Evict] ⚡ Table ${eventId} evicted by canary watchdog (Reason: ${reason})`,
  );

  try {
    // 1. Evict from local RAM cache
    playerCache.delete(`casino_${eventId}`);
    tableTokenCache.delete(eventId);
    inFlightPlayers.delete(eventId);

    // 2. Evict from distributed Redis cache
    await redisClient.del(`html:${eventId}`).catch(() => {});
    await redisClient.del(`table_token:${eventId}`).catch(() => {});
    await redisClient.del(`watchlink:${eventId}`).catch(() => {});

    // 3. Invalidate watch URL in streamCore and trip rotation
    await invalidateWatchUrl(eventId).catch(() => {});
    rotateTableSession(eventId, `Canary eviction: ${reason}`);

    // 4. Pre-fetch fresh stream link asynchronously from failover pool so subsequent requests are 0ms
    getWatchUrl(eventId, { forceFresh: true }).catch((err) => {
      console.warn(
        `[Stream Evict] Background re-harvest for ${eventId}:`,
        err.message,
      );
    });

    return res.status(200).json({
      ok: true,
      eventId,
      reason,
      evictedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[Stream Evict] Error evicting table ${eventId}:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 9. Upstream Ping Proxy (/api/stream/proxy-ping)
router.post("/proxy-ping", express.json(), async (req, res) => {
  const access = await securityEngine.verifyAccess(req, "casino");
  if (!access.allowed) {
    return res.status(403).json({
      error: "Unauthorized: Domain or IP not whitelisted",
      reason: access.reason,
    });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  const eventId = req.query.eventId || "";
  if (eventId) recordTableTouch(eventId);
  const fallbackStreamId =
    eventId && GAME_MAP[eventId] ? GAME_MAP[eventId].streamId : "GAME10";
  const isInit = Boolean(req.body?.init);
  const isTokenReq = Boolean(req.body?.token);

  // 1. FAST ZERO-PROXY PATH FOR ROUTINE HEARTBEATS:
  // When player is running, it pings every 3-10s to report telemetry.
  // Replying locally in 0ms saves 99% of proxy requests and stops proxy quota drain & stream drops!
  if (!isInit && !isTokenReq) {
    return res.status(200).json({
      ok: true,
      state: "live",
      stop: false,
      maintenance: null,
    });
  }

  // 2. FOR INITIAL HANDSHAKE (isInit: true) or explicit token renewal:
  let cachedObj = tableTokenCache.get(eventId);
  if (!cachedObj || !cachedObj.token) {
    try {
      const redisData = await redisClient.get(`table_token:${eventId}`);
      if (redisData && redisData.token) {
        cachedObj = redisData;
        tableTokenCache.set(eventId, cachedObj);
      }
    } catch (_) {}
  }

  // If valid token is already in memory or Redis, return immediately in 0ms!
  if (isTokenValid(cachedObj)) {
    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: cachedObj.streamId || fallbackStreamId,
      token: cachedObj.token,
      wsUrl: getProxiedWsUrl(cachedObj.wsUrl || fallbackWsUrl),
      maintenance: null,
      stop: false,
    });
  }

  // 3. FOR DIRECT/RAW HIT WITHOUT TARGET URL (e.g. manual curl test or fallback):
  const rawTarget = req.query.target;
  if (!rawTarget) {
    let cached = tableTokenCache.get(eventId);
    if (!cached || !cached.token) {
      try {
        const redisData = await redisClient.get(`table_token:${eventId}`);
        if (redisData && redisData.token) cached = redisData;
      } catch (_) {}
    }
    if ((!cached || !cached.token) && eventId) {
      await warmCasinoTable(eventId);
      cached = tableTokenCache.get(eventId);
    }
    const token = cached?.token || "";
    const ws = cached?.wsUrl || fallbackWsUrl;
    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: cached?.streamId || fallbackStreamId,
      wsUrl: getProxiedWsUrl(ws),
      token: token,
    });
  }

  try {
    const { target, watchUrl, origin } = req.query;

    const targetUrl = decodeURIComponent(target);
    const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
    const targetOrigin = new URL(targetUrl).origin;
    const pageOrigin = origin
      ? decodeURIComponent(origin)
      : decodedWatchUrl.includes("startexch")
        ? "https://startexch99.com/"
        : "https://nice444.com/";

    // Check pingCache URL cache (Serves in 0ms for both init and routine heartbeats)
    if (pingCache.has(targetUrl)) {
      const cachedPing = pingCache.get(targetUrl);
      if (
        cachedPing &&
        cachedPing.data &&
        Date.now() - cachedPing.timestamp < 180000 &&
        cachedPing.data.token
      ) {
        return res.status(200).json({
          ...cachedPing.data,
          wsUrl: getProxiedWsUrl(cachedPing.data.wsUrl),
        });
      }
    }

    const payload = {
      ...req.body,
      page: pageOrigin,
      tz: req.body?.tz || "Asia/Kolkata",
      tzo: req.body?.tzo !== undefined ? req.body.tzo : 330,
    };

    // Deduplicate concurrent in-flight ping requests for the same table & target
    const flightKey = `${eventId}_${targetUrl}`;
    if (inFlightPings.has(flightKey)) {
      try {
        const flightData = await inFlightPings.get(flightKey);
        if (flightData) return res.status(200).json(flightData);
      } catch (_) {}
    }

    const pingTask = (async () => {
      // 1. Fast check if table already has an active, valid JWT token in RAM or Redis
      if (eventId && isInit) {
        const cachedObj =
          tableTokenCache.get(eventId) ||
          (await redisClient.get(`table_token:${eventId}`).catch(() => null));
        if (isTokenValid(cachedObj)) {
          return {
            ok: true,
            state: "live",
            streamId: cachedObj.streamId || fallbackStreamId,
            wsUrl: getProxiedWsUrl(cachedObj.wsUrl || fallbackWsUrl),
            token: cachedObj.token,
            maintenance: null,
            stop: false,
          };
        }
      }

      // 2. Fetch ping response via matching residential proxy session
      const proxySession = req.query.session
        ? parseInt(req.query.session, 10)
        : null;
      let upstreamRes = await proxyFetch(targetUrl, {
        method: "POST",
        session: proxySession,
        headers: {
          "Content-Type": "application/json",
          Origin: targetOrigin,
          Referer: decodedWatchUrl,
          "User-Agent": UA,
          Accept: "*/*",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify(payload),
        timeout: 6000,
      }).catch(() => null);

      let pingResData;
      try {
        pingResData = await upstreamRes.json();
      } catch (e) {
        pingResData = null;
      }

      if (
        pingResData &&
        typeof pingResData === "object" &&
        (pingResData.token || !isInit)
      ) {
        if (pingResData.stop) pingResData.stop = false;
        if (pingResData.hlsUrl) {
          pingResData.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(pingResData.hlsUrl)}`;
        }
        if (isInit) {
          if (!pingResData.streamId && fallbackStreamId)
            pingResData.streamId = fallbackStreamId;
          pingResData.wsUrl = getProxiedWsUrl(pingResData.wsUrl);
          if (pingResData.token) {
            const expMs = resolveTokenExpiry(pingResData.token);
            const tokenPayload = {
              token: pingResData.token,
              wsUrl: pingResData.wsUrl,
              streamId: pingResData.streamId,
              expiresAt: expMs,
            };
            tableTokenCache.set(eventId, tokenPayload);
            const tokenTtlSec = Math.max(30, Math.floor((expMs - Date.now()) / 1000));
            redisClient
              .set(`table_token:${eventId}`, tokenPayload, tokenTtlSec)
              .catch(() => {});
            pingCache.set(targetUrl, {
              data: pingResData,
              timestamp: Date.now(),
            });
          }
        }
        return pingResData;
      }
      return null;
    })();

    inFlightPings.set(flightKey, pingTask);
    let data;
    try {
      data = await pingTask;
    } finally {
      inFlightPings.delete(flightKey);
    }

    if (data) {
      return res.status(200).json(data);
    }

    // Upstream returned non-JSON, 403, or missing token: Auto-heal on the fly with fresh fetch!
    if (eventId) {
      console.log(
        `[Proxy-Ping] Stale session or missing token for table ${eventId}. Force-refreshing fresh token on the fly...`,
      );
      await warmCasinoTable(eventId, true);
      const freshToken = tableTokenCache.get(eventId);
      if (isTokenValid(freshToken)) {
        return res.status(200).json({
          ok: true,
          state: "live",
          streamId: freshToken.streamId || fallbackStreamId,
          wsUrl: getProxiedWsUrl(freshToken.wsUrl || fallbackWsUrl),
          token: freshToken.token,
          maintenance: null,
          stop: false,
        });
      }
    }

    // Fallback if warmCasinoTable couldn't get fresh token - preserve known token
    const cachedObj = eventId ? (tableTokenCache.get(eventId) || (await redisClient.get(`table_token:${eventId}`).catch(() => null))) : null;
    const cachedToken = cachedObj?.token || "";
    const cachedWs = (cachedObj && cachedObj.wsUrl) || fallbackWsUrl;
    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: fallbackStreamId,
      wsUrl: getProxiedWsUrl(cachedWs),
      token: cachedToken,
      maintenance: null,
      stop: false,
    });
  } catch (err) {
    const cachedObj = eventId ? tableTokenCache.get(eventId) : null;
    const cachedToken = cachedObj?.token || "";
    const cachedWs = (cachedObj && cachedObj.wsUrl) || fallbackWsUrl;
    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: fallbackStreamId,
      wsUrl: getProxiedWsUrl(cachedWs),
      token: cachedToken,
      maintenance: null,
      stop: false,
    });
  }
});

// 10. Sports HLS Playlist Proxy
router.get("/sports/hls/live.m3u8", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing url param");
    const upstreamUrl = decodeURIComponent(url);

    const m3u8Res = await fetch(upstreamUrl, {
      headers: { "User-Agent": UA },
    });
    if (!m3u8Res.ok)
      return res.status(m3u8Res.status).send("M3U8 upstream error");

    const text = await m3u8Res.text();
    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.endsWith(".ts") || trimmed.includes(".ts?")) {
          const fullSegUrl = new URL(trimmed, upstreamUrl).href;
          return `/api/stream/sports/hls/chunk.ts?url=${encodeURIComponent(fullSegUrl)}`;
        }
        return line;
      })
      .join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(rewritten);
  } catch (err) {
    console.error("[HLS Playlist Error]:", err.message);
    res.status(500).send("Error proxying HLS playlist");
  }
});

// 11. Sports HLS Chunk Proxy (Zero-Drop Parallel Assembler)
router.get("/sports/hls/chunk.ts", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing url param");
    const targetUrl = decodeURIComponent(url);

    const buf = await fetchFullTsSegment(targetUrl);
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : buf.length - 1;
      const chunk = buf.slice(start, end + 1);

      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", chunk.length);
      res.setHeader("Content-Type", "video/MP2T");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(chunk);
    }

    res.setHeader("Content-Type", "video/MP2T");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(buf);
  } catch (err) {
    console.error("[HLS Chunk Error]:", err.message);
    res.status(500).send("Error fetching HLS chunk");
  }
});

module.exports = router;
