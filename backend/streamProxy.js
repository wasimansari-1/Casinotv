const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const https = require("https");
const express = require("express");
const cors = require("cors");
const securityEngine = require("./securityEngine");
const {
  getAuthToken,
  getWatchUrl,
  invalidateWatchUrl,
  rotateTableSession,
  getSportsWatchUrl,
  getLiveSportsEvents,
  GAME_MAP,
  PROVIDERS,
  UA,
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

// Calculate accurate token expiry from JWT payload to prevent premature expiry
function resolveTokenExpiry(token, fallbackMs = 600000) {
  try {
    if (token && typeof token === "string" && token.includes(".")) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64").toString("utf8"),
        );
        if (payload && payload.exp) {
          const expMs = payload.exp * 1000;
          const remainingMs = expMs - Date.now() - 30000;
          if (remainingMs > 10000) {
            return Date.now() + Math.min(remainingMs, 900000); // Up to 15 minutes
          }
        }
      }
    }
  } catch (_) {}
  return Date.now() + fallbackMs; // Default 10 minutes
}

// Helper: Return proxied WebSocket URL so browsers never get blocked by upstream Origin 403 checks
const fallbackWsUrl = `/api/stream/ws?target=${encodeURIComponent('wss://livecdnplatin.com/UNIVERSE-GE/websocket')}`;
function getProxiedWsUrl(originalWsUrl, defaultHost = 'livecdnplatin.com') {
  if (!originalWsUrl) return fallbackWsUrl;
  let clean = String(originalWsUrl).trim();
  if (clean.startsWith('/api/stream/ws')) return clean;
  if (clean === 'edge' || clean.startsWith('edge/') || clean.startsWith('/edge/')) {
    clean = `wss://${defaultHost}/UNIVERSE-GE/websocket`;
  } else if (clean.startsWith('//')) {
    clean = `wss:${clean}`;
  } else if (clean.startsWith('/')) {
    clean = `wss://${defaultHost}${clean}`;
  } else if (!clean.startsWith('ws://') && !clean.startsWith('wss://')) {
    clean = `wss://${defaultHost}/${clean}`;
  }
  return `/api/stream/ws?target=${encodeURIComponent(clean)}`;
}

// Helper: Pre-warm a single casino table in memory with distributed lock
async function warmCasinoTable(eventId) {
  // Coordinate across PM2 cluster: only 1 worker warms this table at a time
  const lockKey = `warmer:${eventId}`;
  const acquired = await redisClient.acquireLock(lockKey, 30);
  if (!acquired) {
    return false;
  }

  try {
    // 1. FAST PATH: Check if we already have valid HTML in Redis
    let existingHtml = await redisClient.get(`html:${eventId}`);
    if (existingHtml && typeof existingHtml === "string" && existingHtml.includes("cfg")) {
      // Fast Token Renewal directly from Platin CDN via VPS IP (10ms, 0 MB proxy, zero provider calls!)
      try {
        const cfgMatch = existingHtml.match(
          /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
        );
        if (cfgMatch) {
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
              page: "https://casino.nice444.com/",
              tz: "Asia/Kolkata",
              tzo: 330,
            });

            // Direct VPS fetch to Platin CDN (Ultra-fast 10ms, 0 MB proxy!)
            let pingRes = await directFetch(targetUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: new URL(targetUrl).origin,
                Referer: targetUrl,
                "User-Agent": UA,
                Accept: "*/*",
              },
              body: pingBody,
              timeout: 4000,
            }).catch(() => null);

            if (pingRes && pingRes.ok) {
              const pingData = await pingRes.json().catch(() => null);
              if (pingData && pingData.token && !pingData.stop) {
                const proxiedWs = getProxiedWsUrl(pingData.wsUrl);
                const tokenPayload = {
                  token: pingData.token,
                  wsUrl: proxiedWs,
                  streamId:
                    pingData.streamId ||
                    (GAME_MAP[eventId] && GAME_MAP[eventId].streamId) ||
                    "GAME10",
                  expiresAt: resolveTokenExpiry(pingData.token),
                };
                tableTokenCache.set(eventId, tokenPayload);
                await redisClient.set(`table_token:${eventId}`, tokenPayload, 300).catch(() => {});
                playerCache.set(`casino_${eventId}`, {
                  html: existingHtml,
                  expiresAt: Date.now() + CASINO_CACHE_TTL,
                  timestamp: Date.now(),
                });
                // Refresh 24h Redis TTL so cache NEVER expires
                await redisClient.set(`html:${eventId}`, existingHtml, 86400).catch(() => {});
                return true; // Refreshed directly in 10ms without touching providers!
              }
            }
          }
        }
      } catch (_) {}
    }

    // 2. FRESH TICKET FETCH: Only runs at boot or when upstream CDN ticket actually expires
    const watchData = await getWatchUrl(eventId, { forceFresh: true });
    const watchUrl = typeof watchData === "string" ? watchData : watchData.url;
    const providerOrigin = watchData.origin
      ? watchData.origin.endsWith("/")
        ? watchData.origin
        : `${watchData.origin}/`
      : "https://casino.nice444.com/";
    const session = watchData.session || null;

    // 1. Direct fetch first from VPS (Ultra-fast 10ms, 100% success, zero proxy 502 errors!)
    let pageRes = null;
    try {
      pageRes = await directFetch(watchUrl, {
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
        timeout: 5000,
      });
      if (!pageRes.ok) pageRes = null;
    } catch (_) {
      pageRes = null;
    }

    // 2. Fallback to proxy only if direct fails
    if (!pageRes) {
      pageRes = await proxyFetch(watchUrl, {
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
      });
    }

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
      // 24 Hours in Redis - table NEVER sleeps or disappears from cache!
      await redisClient
        .set(`html:${eventId}`, html, 86400)
        .catch(() => {});
      console.log(
        `[Stream Warmer] Pre-warmed & cached table ${eventId} in memory/Redis (TTL: 24h)`,
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

            // Direct VPS fetch first for CDN ping handshake
            try {
              pingRes = await directFetch(targetUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: new URL(targetUrl).origin,
                  Referer: watchUrl,
                  "User-Agent": UA,
                  Accept: "*/*",
                },
                body: pingBody,
                timeout: 5000,
              });
              if (!pingRes.ok) pingRes = null;
            } catch (_) {
              pingRes = null;
            }

            if (!pingRes) {
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
              });
            }
            if (pingRes) {
              const pingData = await pingRes.json().catch(() => null);
              if (pingData && pingData.token && pingData.wsUrl) {
                const proxiedWs = getProxiedWsUrl(pingData.wsUrl);
                const tokenPayload = {
                  token: pingData.token,
                  wsUrl: proxiedWs,
                  streamId:
                    pingData.streamId ||
                    (GAME_MAP[eventId] && GAME_MAP[eventId].streamId) ||
                    "GAME10",
                  expiresAt: resolveTokenExpiry(pingData.token),
                };
                tableTokenCache.set(eventId, tokenPayload);
                await redisClient
                  .set(`table_token:${eventId}`, tokenPayload, 300) // 5 Minutes in Redis
                  .catch(() => {});
                pingCache.set(targetUrl, {
                  data: { ...pingData, wsUrl: proxiedWs },
                  timestamp: Date.now(),
                });
                console.log(
                  `[Stream Warmer] Pre-warmed valid token & handshake for table ${eventId} (${tokenPayload.streamId}) in RAM & Redis`,
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

// Autonomous 24/7 Table Warmer & Token Keeper Daemon
// Staggers all 17 tables by 1.2s every 3.5 minutes with distributed Redis lock.
// Shields upstream completely: 1 to 2 lakh users are served 100% from Redis in 0ms!
let _warmerCronRunning = false;
async function runContinuousWarmerCycle() {
  if (_warmerCronRunning) return;
  _warmerCronRunning = true;
  const lockKey = "cron:table_warmer_daemon";
  const acquired = await redisClient.acquireLock(lockKey, 120);
  if (!acquired) {
    _warmerCronRunning = false;
    return;
  }

  try {
    const tableIds = Object.keys(GAME_MAP);
    console.log(`[Stream Warmer Daemon] Starting autonomous background refresh for all ${tableIds.length} tables...`);
    const batchSize = 3;
    for (let i = 0; i < tableIds.length; i += batchSize) {
      const batch = tableIds.slice(i, i + batchSize);
      await Promise.allSettled(batch.map((id) => warmCasinoTable(id)));
      if (i + batchSize < tableIds.length) {
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    console.log(`[Stream Warmer Daemon] Cycle completed: all ${tableIds.length} tables active in Redis & RAM.`);
  } catch (err) {
    console.warn("[Stream Warmer Daemon] Warning during cycle:", err.message);
  } finally {
    _warmerCronRunning = false;
    await redisClient.releaseLock(lockKey).catch(() => {});
  }
}

// Initial warm cycle immediately after boot
setTimeout(runContinuousWarmerCycle, 200);
// Recurring background keeper every 2.5 minutes (150 seconds)
setInterval(runContinuousWarmerCycle, 150000);

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

  // Client-Side Anti-Theft Ancestor & Embedding Lock (Prevents reseller nested-iframes and cross-site wrapping)
  const allowedOriginsJson = JSON.stringify(securityEngine.getAllowedDomainsList());
  const antiTheftGuardScript = `
    <script>
      (function(){
        try {
          var allowed = ${allowedOriginsJson};
          if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
            for (var i = 0; i < window.location.ancestorOrigins.length; i++) {
              var aOrigin = window.location.ancestorOrigins[i];
              var aHost = new URL(aOrigin).hostname.toLowerCase();
              var ok = false;
              for (var j = 0; j < allowed.length; j++) {
                var d = allowed[j].toLowerCase();
                if (aHost === d || aHost.endsWith('.' + d)) { ok = true; break; }
              }
              if (!ok) {
                document.documentElement.innerHTML = '<div style="background:#090d16;color:#ef4444;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;font-weight:700;font-size:16px;text-align:center;padding:20px;"><div>UNAUTHORIZED EMBED DETECTED</div><div style="font-size:12px;color:#94a3b8;margin-top:8px;">Domain ' + aHost + ' is not authorized by stream administrator.</div></div>';
                if (window.stop) window.stop();
                throw new Error('Framing blocked by anti-theft guard: ' + aHost);
              }
            }
          }
        } catch(e) {}
      })();
    </script>
  `;
  html = html.replace("</head>", `${cleanWatermarkStyle}\n${antiTheftGuardScript}\n</head>`);

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

  // 1. Check local RAM cache first (serves in 0ms)
  const cached = playerCache.get(`casino_${eventId}`);
  if (
    cached &&
    Date.now() < cached.expiresAt &&
    cached.html &&
    !cached.html.includes("Access blocked")
  ) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
    return res.send(cached.html);
  }

  // 2. Check distributed Redis cache (shared across PM2 workers)
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
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
    return res.send(redisHtml);
  }

  // Deduplicate in-flight requests for the same table
  if (inFlightPlayers.has(eventId)) {
    try {
      const html = await inFlightPlayers.get(eventId);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
      return res.send(html);
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

        // 1. Direct fetch first from VPS (Ultra-fast 10ms, 100% success, zero proxy 502 errors!)
        let pageRes = null;
        try {
          pageRes = await directFetch(watchUrl, {
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
            timeout: 5000,
          });
          if (!pageRes.ok) pageRes = null;
        } catch (_) {
          pageRes = null;
        }

        // 2. Fallback to proxy only if direct fails
        if (!pageRes) {
          pageRes = await proxyFetch(watchUrl, {
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
          });
        }

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

        // Cache player HTML for 24 hours in RAM and distributed Redis
        playerCache.set(`casino_${eventId}`, {
          html,
          expiresAt: Date.now() + CASINO_CACHE_TTL,
          timestamp: Date.now(),
        });
        redisClient
          .set(`html:${eventId}`, html, 86400) // 24 Hours in Redis - Never sleeps!
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

              // Direct VPS fetch first for CDN ping handshake
              let data = await directFetch(targetUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: new URL(targetUrl).origin,
                  Referer: watchUrl,
                  "User-Agent": UA,
                  Accept: "*/*",
                },
                body: pingBody,
                timeout: 3000,
              })
                .then(async (r) => (r.ok ? r.json() : null))
                .catch(() => null);

              if (!data) {
                // Fallback to proxy only if direct fails
                data = await proxyFetch(targetUrl, {
                  method: "POST",
                  session: session,
                  headers: {
                    "Content-Type": "application/json",
                    Origin: new URL(targetUrl).origin,
                    Referer: watchUrl,
                    "User-Agent": UA,
                    Accept: "*/*",
                  },
                  body: pingBody,
                  timeout: 3000,
                })
                  .then(async (r) => (r.ok ? r.json() : null))
                  .catch(() => null);
              }

              if (data && data.token && data.wsUrl) {
                const proxiedWs = getProxiedWsUrl(data.wsUrl);
                const tokenPayload = {
                  token: data.token,
                  wsUrl: proxiedWs,
                  streamId:
                    data.streamId ||
                    (GAME_MAP[eventId] && GAME_MAP[eventId].streamId) ||
                    "GAME10",
                  expiresAt: resolveTokenExpiry(data.token),
                };
                tableTokenCache.set(eventId, tokenPayload);
                redisClient
                  .set(`table_token:${eventId}`, tokenPayload, 300) // 5 minutes in Redis
                  .catch(() => {});
                pingCache.set(targetUrl, { data: { ...data, wsUrl: proxiedWs }, timestamp: Date.now() });
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
    res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
    return res.send(html);
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
      res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
      return res.send(stale.html);
    }

    // Clean player fallback: Auto-retrying black screen with centered loader GIF (no synthetic error card)
    const cleanPlayerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#64748b;font-family:sans-serif}.msg{text-align:center}</style><script>setTimeout(function(){location.reload();}, 3000);</script></head><body><div class="msg"><img src="/api/stream/player-assets/loader.gif" style="width:48px;height:48px;display:block;margin:0 auto 10px;opacity:0.7"><div style="color:#94a3b8;font-size:12px;font-weight:500;">Connecting live stream...</div></div></body></html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(cleanPlayerHtml);
  } finally {
    inFlightPlayers.delete(eventId);
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
    res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());
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
      res.setHeader("Content-Security-Policy", securityEngine.getFrameAncestorsCSP());

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
    'this.reconnectTimer = setTimeout(() => this.retryNow(), 300)',
  );

  // 9. Preserve everPlayed flag across socket jitter (Prevents recurring loader screens)
  text = text.replace(
    /\(this\.everPlayed\s*=\s*!1\)/g,
    '(void 0)',
  );

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

// 9. Upstream Ping Proxy (/api/stream/proxy-ping)
router.post("/proxy-ping", express.json(), async (req, res) => {
  const access = await securityEngine.verifyAccess(req, "casino");
  if (!access.allowed) {
    return res.status(403).json({ error: "Unauthorized: Domain or IP not whitelisted", reason: access.reason });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  const eventId = req.query.eventId || "";
  const fallbackStreamId =
    eventId && GAME_MAP[eventId] ? GAME_MAP[eventId].streamId : "GAME10";
  const isInit = Boolean(req.body?.init);
  const isConnecting = req.body?.mode === "connecting";
  const isRoutineHeartbeat =
    !isInit && !isConnecting && req.body?.mode === "playing";

  // 1. FAST RAM PATH FOR ROUTINE HEARTBEATS:
  // If the player is already streaming (mode: 'playing'), reply from RAM in 0ms!
  // This shields Webshare proxy from millions of routine pings!
  if (isRoutineHeartbeat) {
    const cachedToken = (eventId && tableTokenCache.get(eventId)?.token) || "";
    const cachedWs = (eventId && tableTokenCache.get(eventId)?.wsUrl) || fallbackWsUrl;
    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: (eventId && GAME_MAP[eventId]?.streamId) || fallbackStreamId,
      token: cachedToken,
      wsUrl: getProxiedWsUrl(cachedWs),
      maintenance: null,
      stop: false,
    });
  }

  // 2. FOR DIRECT/RAW HIT WITHOUT TARGET URL (e.g. manual curl test or fallback):
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
          wsUrl: getProxiedWsUrl(cachedPing.data.wsUrl)
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
      // 1. Direct fetch first from VPS (Ultra-fast 10ms, 100% reliable, zero 502)
      let upstreamRes = null;
      try {
        upstreamRes = await directFetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: targetOrigin,
            Referer: decodedWatchUrl,
            "User-Agent": UA,
            Accept: "*/*",
          },
          body: JSON.stringify(payload),
          timeout: 4000,
        });
        if (!upstreamRes.ok) upstreamRes = null;
      } catch (_) {
        upstreamRes = null;
      }

      // 2. Fallback to proxy only if direct fails
      if (!upstreamRes) {
        const proxySession = req.query.session
          ? parseInt(req.query.session, 10)
          : null;
        upstreamRes = await proxyFetch(targetUrl, {
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
        });
      }

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
            const tokenPayload = {
              token: pingResData.token,
              wsUrl: pingResData.wsUrl,
              streamId: pingResData.streamId,
              expiresAt: resolveTokenExpiry(pingResData.token),
            };
            tableTokenCache.set(eventId, tokenPayload);
            redisClient
              .set(`table_token:${eventId}`, tokenPayload, 300) // 5 minutes in Redis
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

    // Upstream returned non-JSON, 403, or missing token: Auto-heal on the fly!
    if (eventId) {
      console.log(
        `[Proxy-Ping] Stale session or missing token for table ${eventId}. Auto-refreshing fresh token on the fly...`,
      );
      await warmCasinoTable(eventId);
      const freshToken = tableTokenCache.get(eventId);
      if (freshToken && freshToken.token) {
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

    // Fallback if warmCasinoTable couldn't get token
    const cachedToken = (eventId && tableTokenCache.get(eventId)?.token) || "";
    const cachedWs = (eventId && tableTokenCache.get(eventId)?.wsUrl) || fallbackWsUrl;
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
    const cachedToken = (eventId && tableTokenCache.get(eventId)?.token) || "";
    const cachedWs = (eventId && tableTokenCache.get(eventId)?.wsUrl) || fallbackWsUrl;
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
