/**
 * Dedicated Sports TV Stream Engine
 * High-performance, low-latency streaming for live Cricket, Soccer, Tennis & other sports.
 * Completely isolated from Casino TV to ensure zero interference.
 */

const express = require("express");
const router = express.Router();
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const securityEngine = require("./securityEngine");
const {
  getAuthToken,
  proxyFetch,
  directFetch,
  UA,
  PROVIDERS,
  redisClient,
  providerManager,
  resolveWatchLinkTtl,
  getSessionForTable,
  rotateTableSession,
} = require("./streamCore");

// High-performance Persistent HTTP/HTTPS Agents for Ultra-Fast HLS Chunk Streaming
const sportsHlsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
});
const sportsHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 30000,
});

// LRU Video Chunk Memory Cache (Stores recent video segments in RAM: 0ms serving, 0 bandwidth)
const sportsChunkCache = new Map(); // url -> { buffer, contentType, expiresAt }
const inFlightSportsChunks = new Map(); // url -> Promise

// In-memory caches for sub-millisecond response & bandwidth preservation
const sportsEventsCache = { data: null, expiresAt: 0 };
let inFlightSportsEvents = null;
const sportsPlayerCache = new Map(); // cacheKey -> { html, expiresAt }
const betfairIdCache = new Map(); // rawEventId -> betfairId
const sportsWatchLinkCache = new Map(); // streamId -> { url, origin, provider, session, expiresAt }
const sportsPingCache = new Map(); // targetUrl -> { data, timestamp }
const inFlightSportsPlayers = new Map(); // deduplicate concurrent requests for same match

const SPORTS_HTML_TTL = 30000; // 30 seconds fresh HTML cache in RAM & Redis for live sports feeds

// 1. Pre-patch and cache the raw LTVE sports player JavaScript in RAM memory
let _cachedSportsPlayerJs = null;

function getPatchedSportsPlayerJs() {
  if (_cachedSportsPlayerJs) return _cachedSportsPlayerJs;

  const rawPath = path.join(__dirname, "sports_player_raw.js");
  let js = "";
  if (fs.existsSync(rawPath)) {
    js = fs.readFileSync(rawPath, "utf8");
  } else {
    js = fs.readFileSync(path.join(__dirname, "player.js"), "utf8");
  }

  // High-performance stream optimizations
  // 1. HLS Buffer & Gap Bridging: 30s lookahead, 0.5s hole auto-skip, 0.1s instant nudge, multi-threaded worker
  js = js.replace(
    /liveSyncDurationCount:4,liveMaxLatencyDurationCount:10,maxBufferLength:20,backBufferLength:10/g,
    "liveSyncDurationCount:3,liveMaxLatencyDurationCount:8,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:15,maxBufferHole:0.5,nudgeOffset:0.1,nudgeMaxRetry:5,highBufferWatchdogPeriod:1,enableWorker:!0,lowLatencyMode:!0,startFragPrefetch:!0"
  );

  // 2. Debounced Buffering Indicator & Instant 0.1s Auto-Unsticker (Eliminates flashing Buffering... text)
  js = js.replace(
    /var Tp=e=>\{gp\.textContent=e\|\|``,gp\.hidden=!e\}/g,
    "var _bufTimer;var Tp=e=>{clearTimeout(_bufTimer);if(!e){if(gp){gp.textContent='';gp.hidden=!0}return;}if($&&!$.paused&&$.currentTime>0&&$.readyState>=3){if(gp){gp.textContent='';gp.hidden=!0}return;}if(typeof e==='string'&&(e.includes('Buffering')||e.includes('Reconnecting')||e.includes('Connecting'))){_bufTimer=setTimeout(()=>{if($&&!$.paused&&$.currentTime>0&&$.readyState>=3){if(gp){gp.textContent='';gp.hidden=!0}return;}if(gp){gp.textContent=e;gp.hidden=!1}},1500);return;}if(gp){gp.textContent=e;gp.hidden=!1}}"
  );

  js = js.replace(
    /\$\.addEventListener\(`waiting`,\(\)=>\{vp===`hls`&&Tp\(`Buffering…`\)\}\)/g,
    "(()=>{var _b, _l=-1, _s=0; $.addEventListener(`waiting`,()=>{clearTimeout(_b);_b=setTimeout(()=>{if(vp===`hls`&&($.paused||$.readyState<3)){Tp(`Buffering…`)}},1500)}); $.addEventListener(`playing`,()=>{clearTimeout(_b);Tp(``)}); $.addEventListener(`timeupdate`,()=>{if($.currentTime>0&&!$.paused){clearTimeout(_b);if(gp&&gp.textContent&&gp.textContent.includes('Buffering'))Tp(``)}}); setInterval(()=>{if(vp===`hls`&&!$.paused&&!$.ended&&$.readyState>=2){if($.currentTime===_l){_s++;if(_s>=2){try{$.currentTime+=0.08}catch(_){}_s=0}}else{_s=0;_l=$.currentTime}}},400)})()"
  );

  // 3. WebRTC Multi-Cloud STUN Redundancy: Google STUN 1 + 2 + Cloudflare STUN for instant 0ms ICE
  js = js.replace(
    /urls:`stun:stun1\.l\.google\.com:19302`/g,
    "urls:[`stun:stun1.l.google.com:19302`,`stun:stun2.l.google.com:19302`,`stun:stun.cloudflare.com:3478`]",
  );

  // 4. WebRTC Jitter Resilience: Do not terminate peer connection on transient 'disconnected' state
  js = js.replace(
    /\[`failed`,`disconnected`,`closed`\]\.includes\(i\?\.state\)/g,
    "[`failed`,`closed`].includes(i?.state)",
  );

  // 4. Freeze detector: increase freeze threshold to 120s (stops false reload loops)
  js = js.replace(/Q\.freezeSeconds/g, "120");

  // 5. Devtools detector: neutralize debugger loops and docking traps
  js = js.replace(/Q\.devtoolsGuard/g, "false");
  js = js.replace(/devtoolsGuard:!0/g, "devtoolsGuard:!1");

  // 6. Suppress window redirect traps cleanly with void 0 (keeps valid JS syntax - no SyntaxError!)
  js = js.replace(
    /location\.replace\(window\.top===window\?Q\.devtoolsRedirect:Q\.blockedUrl\)/g,
    "void 0",
  );

  // 7. Fix TypeError: Invalid URL in HLS player when Q.hlsUrl is a relative path
  js = js.replace(/new URL\(e,Q\.hlsUrl\)/g, "new URL(e,window.location.href)");

  // 8. Fix WebSocket relative URL resolution for proxied WebRTC tunnels
  js = js.replace(
    /websocket_url:Q\.wsUrl/g,
    'websocket_url:(Q.wsUrl && Q.wsUrl.startsWith("/") ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + Q.wsUrl : Q.wsUrl)',
  );

  _cachedSportsPlayerJs = js;
  console.log(
    `[SportsEngine] Loaded & optimized sports_player.js (${(js.length / 1024).toFixed(1)} KB) into RAM`,
  );
  return _cachedSportsPlayerJs;
}

// 2. Resolve 20-digit internal exchange event ID to real Betfair event ID
async function resolveBetfairEventId(rawId, sportId = "4") {
  const streamId = String(rawId || "").trim();

  // If already an 8-9 digit Betfair ID, return immediately
  if (/^\d{7,9}$/.test(streamId)) {
    return streamId;
  }

  // Check local RAM cache
  if (betfairIdCache.has(streamId)) {
    return betfairIdCache.get(streamId);
  }

  // Check Redis cache
  const redisCached = await redisClient.get(`sports:betfair_id:${streamId}`);
  if (redisCached) {
    betfairIdCache.set(streamId, redisCached);
    return redisCached;
  }

  // Query Nice444 getMarketsEventList without `key: '2'` to extract Betfair ID
  const providerList = ["nice444", "startexch", "asstarplay"];
  const session = getSessionForTable(streamId);

  for (const provKey of providerList) {
    const prov = PROVIDERS[provKey];
    if (!prov) continue;
    try {
      const token = await getAuthToken(provKey);
      const res = await proxyFetch(
        `${prov.base}/api/exchange/markets/getMarketsEventList`,
        {
          method: "POST",
          session,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            Origin: prov.base,
            Referer: `${prov.base}/`,
            "User-Agent": UA,
          },
          body: JSON.stringify({ eventId: streamId, sportId: String(sportId) }),
          timeout: 6000,
        },
      );

      const d = await res.json();
      const rawData = d?.data?.data || d?.data || {};
      const matchOdds = Array.isArray(rawData.matchOddsData)
        ? rawData.matchOddsData[0]
        : null;
      const bookmaker = Array.isArray(rawData.bookmakersData)
        ? rawData.bookmakersData[0]
        : null;
      const resolved =
        matchOdds?.eventId || bookmaker?.eventId || rawData.streamId;

      if (resolved && /^\d{7,9}$/.test(String(resolved))) {
        const betfairId = String(resolved);
        betfairIdCache.set(streamId, betfairId);
        await redisClient.set(
          `sports:betfair_id:${streamId}`,
          betfairId,
          3600 * 4,
        );
        console.log(
          `[SportsEngine] Resolved internal match ID ${streamId} -> Betfair ID ${betfairId}`,
        );
        return betfairId;
      }
    } catch (e) {
      console.warn(
        `[SportsEngine] Provider ${prov.name} market resolution error for ${streamId}:`,
        e.message,
      );
    }
  }

  // Fallback to original streamId
  return streamId;
}

// 3. Multi-Provider Sports WatchLink Resolver
async function getSportsWatchUrl(
  rawEventId,
  sportId = "4",
  forceFresh = false,
) {
  const betfairId = await resolveBetfairEventId(rawEventId, sportId);
  const cacheKey = `sports_watchlink:${betfairId}`;

  if (!forceFresh) {
    // 1. Check RAM Cache
    const ramCached = sportsWatchLinkCache.get(cacheKey);
    if (ramCached && Date.now() < ramCached.expiresAt) {
      return ramCached;
    }

    // 2. Check Redis Cache
    const redisCached = await redisClient.get(cacheKey);
    if (
      redisCached &&
      redisCached.url &&
      Date.now() < (redisCached.expiresAt || 0)
    ) {
      sportsWatchLinkCache.set(cacheKey, redisCached);
      return redisCached;
    }
  }

  const session = getSessionForTable(betfairId);
  const providerList = ["nice444", "startexch"];

  for (const provKey of providerList) {
    const provider = PROVIDERS[provKey];
    if (!provider || !providerManager.isAvailable(provKey)) continue;

    try {
      const result = await providerManager.schedule(
        provKey,
        betfairId,
        async () => {
          const token = await getAuthToken(provKey);
          const res = await proxyFetch(
            `${provider.base}/api/exchange/streaming/exchEventsWatchLink`,
            {
              method: "POST",
              session,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                Origin: provider.base,
                Referer: `${provider.base}/`,
                "User-Agent": UA,
              },
              body: JSON.stringify({
                streamId: betfairId,
                timestamp: Date.now(),
              }),
              timeout: 7000,
            },
          );

          const data = await res.json();
          if (data?.data?.url) {
            providerManager.recordSuccess(provKey);
            const ttlSec = resolveWatchLinkTtl(data.data.url, 600); // 10 minutes cache
            const sportsData = {
              url: data.data.url,
              provider: provider.name,
              provKey: provKey,
              origin: provider.base,
              streamId: betfairId,
              session,
              expiresAt: Date.now() + ttlSec * 1000,
            };

            await redisClient.set(cacheKey, sportsData, ttlSec);
            sportsWatchLinkCache.set(cacheKey, sportsData);
            console.log(
              `[SportsEngine] Acquired sports watch link from ${provider.name} for ${betfairId} (Session #${session}): ${data.data.url}`,
            );
            return sportsData;
          }

          if (res.status === 429) {
            providerManager.tripCooldown(
              provKey,
              30000,
              "HTTP 429 on sports watch link",
            );
          }
          throw new Error(
            data?.meta?.message || `No stream URL in ${provider.name} response`,
          );
        },
      );

      if (result && result.url) {
        return result;
      }
    } catch (err) {
      console.warn(
        `[SportsEngine] Watchlink error on ${provider.name} for ${betfairId}:`,
        err.message,
      );
    }
  }

  throw new Error(
    `No live TV coverage currently available for sports event ${rawEventId}`,
  );
}

// 4. Transform Sports Player HTML for Zero-Latency Local Playback
function transformSportsHtml(html, watchUrl, eventId, providerOrigin, session) {
  // YouTube-style buffer spinner & video styling
  const sportsStyle = `
    <style>
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #000 !important;
        position: relative !important;
      }
      #video, video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        background: #000 !important;
      }
      #wm, [id="wm"], .watermark, #watermark, #blockImg, [id="blockImg"] {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        height: 0 !important;
        width: 0 !important;
      }
      #status, .status, #msg, .msg {
        pointer-events: none !important;
        user-select: none !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-weight: 600 !important;
        letter-spacing: 0.5px !important;
        text-shadow: 0 2px 4px rgba(0,0,0,0.9) !important;
        transition: opacity 0.2s ease !important;
      }
    </style>
  `;
  html = html.replace("</head>", `${sportsStyle}</head>`);

  // Extract and tune cfg JSON specifically for Sports
  const cfgMatch = html.match(
    /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
  );
  if (cfgMatch) {
    try {
      const originalCfg = JSON.parse(cfgMatch[1]);

      const fullPingUrl = originalCfg.pingUrl.startsWith("http")
        ? originalCfg.pingUrl
        : new URL(originalCfg.pingUrl, watchUrl).href;

      const proxiedPingUrl = `/api/stream/sports/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=${encodeURIComponent(eventId)}&origin=${encodeURIComponent(providerOrigin || "https://nice444.com")}&session=${encodeURIComponent(session || "")}`;

      let hlsProxyUrl = originalCfg.hlsUrl;
      if (hlsProxyUrl) {
        hlsProxyUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(hlsProxyUrl)}`;
      }

      const modifiedCfg = {
        ...originalCfg,
        hlsUrl: hlsProxyUrl || originalCfg.hlsUrl,
        streamId: originalCfg.streamId || eventId || "SPORTS",
        pingUrl: proxiedPingUrl,
        flagUrl: "/api/stream/sports/dummy-flag",
        byeUrl: "/api/stream/sports/dummy-bye",
        devtoolsGuard: false,
        devtoolsRedirect: "",
        blockedUrl: "",
        home: "",
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
      console.error("[SportsEngine] Error transforming sports cfg:", e.message);
    }
  }

  // Rewrite script source to instant local RAM asset
  const ts = Date.now();
  html = html.replace(
    /src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g,
    `src="/api/stream/sports/player-assets/sports-player.js?v=${ts}"`,
  );

  // Client runtime patch with Master Guard Anti-Theft Protection
  const allowedOriginsJson = JSON.stringify(
    securityEngine.getAllowedDomainsList(),
  );
  const clientPatch = `
    <script>
      (function() {
        var allowed = ${allowedOriginsJson};
        try {
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

        if (navigator.sendBeacon) navigator.sendBeacon = function() { return true; };
        window.location.replace = function() { return false; };
        var _origAddEvent = window.addEventListener;
        window.addEventListener = function(type, listener, options) {
          if (type === 'unload') return _origAddEvent.call(this, 'pagehide', listener, options);
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
  html = html.replace("</body>", `${clientPatch}</body>`);

  return html;
}

// 5. Native Minimalist Unavailable Screen matching original provider
function renderNoTvHtml(matchName = "") {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Sports TV</title>
      <style>
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100%;
          background: #000;
          color: #64748b;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          overflow: hidden;
        }
        .msg {
          font-size: 14px;
          color: #64748b;
          letter-spacing: 0.2px;
        }
      </style>
    </head>
    <body>
      <div class="msg">This stream is not live right now. Waiting…</div>
    </body>
    </html>
  `;
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// 1. Telemetry sinks
router.all("/dummy-flag", (req, res) => res.status(200).json({ ok: true }));
router.all("/dummy-bye", (req, res) => res.status(200).json({ ok: true }));

// 2. High-speed local sports player script (Serves in 0ms directly from RAM)
router.get("/player-assets/sports-player.js", (req, res) => {
  try {
    const script = getPatchedSportsPlayerJs();
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(script);
  } catch (err) {
    console.error(
      "[SportsEngine] Error serving sports player script:",
      err.message,
    );
    res.status(500).send("/* Error loading sports player script */");
  }
});

// 3. Live Sports Events List (Cricket, Football, Tennis) - 60s Cache & In-Flight Deduplication
router.get("/events", async (req, res) => {
  // Check RAM Cache (60s TTL)
  if (sportsEventsCache.data && Date.now() < sportsEventsCache.expiresAt) {
    return res.json({
      success: true,
      count: sportsEventsCache.data.length,
      events: sportsEventsCache.data,
    });
  }

  // Deduplicate in-flight upstream fetches across all concurrent clients
  if (inFlightSportsEvents) {
    try {
      const data = await inFlightSportsEvents;
      return res.json({
        success: true,
        count: data?.length || 0,
        events: data || [],
      });
    } catch (_) {}
  }

  inFlightSportsEvents = (async () => {
    // Check Redis distributed cache
    try {
      const redisEvents = await redisClient.get("sports:events_list");
      if (redisEvents && Array.isArray(redisEvents) && redisEvents.length > 0) {
        sportsEventsCache.data = redisEvents;
        sportsEventsCache.expiresAt = Date.now() + 60000;
        return redisEvents;
      }
    } catch (_) {}

    const providerList = ["nice444", "startexch", "asstarplay"];
    const sportNames = {
      1: "Soccer",
      2: "Tennis",
      4: "Cricket",
      7: "Horse Racing",
    };

    for (const provKey of providerList) {
      try {
        const provider = PROVIDERS[provKey];
        const token = await getAuthToken(provKey);
        const upstreamRes = await proxyFetch(
          `${provider.base}/api/exchange/market/matchodds/allEventsList`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              Origin: provider.base,
              Referer: `${provider.base}/`,
              "User-Agent": UA,
            },
            body: JSON.stringify({}),
            timeout: 7000,
          },
        );

        const d = await upstreamRes.json();
        const result = [];

        if (d?.data) {
          for (const [sId, list] of Object.entries(d.data)) {
            if (Array.isArray(list)) {
              for (const ev of list) {
                const isInPlay = Boolean(
                  ev?.oddsData?.inPlay ?? ev?.inPlay ?? false,
                );
                const isStreaming = Boolean(ev?.isStreaming ?? false);
                result.push({
                  id: String(ev.exEventId || ev._id || ""),
                  name: ev.eventName || "Unnamed Match",
                  sportId: String(sId),
                  sportName: sportNames[sId] || "Other Sport",
                  tournament: ev.tournamentName || "",
                  inPlay: isInPlay,
                  isStreaming: isStreaming,
                  eventTime: ev.eventTime || "",
                  tv: true,
                });
              }
            }
          }
        }

        if (result.length > 0) {
          // Prioritize in-play and streaming matches at the top
          result.sort((a, b) => {
            if (a.inPlay && !b.inPlay) return -1;
            if (!a.inPlay && b.inPlay) return 1;
            if (a.isStreaming && !b.isStreaming) return -1;
            if (!a.isStreaming && b.isStreaming) return 1;
            return 0;
          });

          sportsEventsCache.data = result;
          sportsEventsCache.expiresAt = Date.now() + 60000; // 60s cache
          await redisClient
            .set("sports:events_list", result, 60)
            .catch(() => {});
          return result;
        }
      } catch (err) {
        console.warn(
          `[SportsEngine] Failed to fetch events from ${provKey}:`,
          err.message,
        );
      }
    }
    return sportsEventsCache.data || [];
  })();

  try {
    const data = await inFlightSportsEvents;
    return res.json({
      success: true,
      count: data?.length || 0,
      events: data || [],
    });
  } finally {
    inFlightSportsEvents = null;
  }
});

// 4. Dedicated Sports TV Player Iframe
router.get("/player/:eventId", async (req, res) => {
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

  const cacheKey = `sports_player_${eventId}`;

  // 1. Check local RAM cache (serves in 0ms)
  const cached = sportsPlayerCache.get(cacheKey);
  if (
    cached &&
    Date.now() < cached.expiresAt &&
    cached.html &&
    !cached.html.includes("Live TV Feed Not Available")
  ) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Permissions-Policy", "unload=*");
    return res.send(cached.html);
  }

  // 2. Check distributed Redis cache
  const redisHtml = await redisClient.get(`html:sports:${eventId}`);
  if (redisHtml && typeof redisHtml === "string" && redisHtml.includes("cfg")) {
    sportsPlayerCache.set(cacheKey, {
      html: redisHtml,
      expiresAt: Date.now() + SPORTS_HTML_TTL,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader(
      "Content-Security-Policy",
      securityEngine.getFrameAncestorsCSP(),
    );
    return res.send(redisHtml);
  }

  // 3. In-flight single-flight deduplication
  if (inFlightSportsPlayers.has(eventId)) {
    try {
      const html = await inFlightSportsPlayers.get(eventId);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Permissions-Policy", "unload=*");
      res.setHeader(
        "Content-Security-Policy",
        securityEngine.getFrameAncestorsCSP(),
      );
      return res.send(html);
    } catch (_) {}
  }

  const task = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `[SportsEngine] Fetching sports player for match ${eventId} (attempt ${attempt})`,
        );

        // Use forceFresh on attempt 2
        const watchData = await getSportsWatchUrl(
          eventId,
          sportId,
          attempt > 1,
        );
        const watchUrl = watchData.url;
        const referer = watchData.origin
          ? `${watchData.origin}/`
          : "https://nice444.com/";
        const session = watchData.session || getSessionForTable(eventId);

        const pageRes = await proxyFetch(watchUrl, {
          session,
          headers: {
            "User-Agent": UA,
            Referer: referer,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          timeout: 8000,
        });

        if (pageRes.status === 403 || pageRes.status === 404 || !pageRes.ok) {
          console.warn(
            `[SportsEngine] Upstream watchUrl returned status ${pageRes.status} on session #${session}. Rotating session...`,
          );
          rotateTableSession(eventId, `WatchUrl HTTP ${pageRes.status}`);
          // Clear cached watchlink so attempt 2 generates a fresh one
          sportsWatchLinkCache.delete(
            `sports_watchlink:${watchData.streamId || eventId}`,
          );
          await redisClient
            .del(`sports_watchlink:${watchData.streamId || eventId}`)
            .catch(() => {});

          if (attempt === 1) {
            await new Promise((r) => setTimeout(r, 400));
            continue;
          }
          return renderNoTvHtml();
        }

        const rawHtml = await pageRes.text();
        if (
          rawHtml.includes("Stream unavailable") ||
          rawHtml.includes("Access blocked")
        ) {
          console.warn(
            `[SportsEngine] Upstream indicated stream unavailable or blocked`,
          );
          if (attempt === 1) {
            rotateTableSession(eventId, "Stream unavailable");
            continue;
          }
          return renderNoTvHtml();
        }

        const transformedHtml = transformSportsHtml(
          rawHtml,
          watchUrl,
          eventId,
          watchData.origin,
          session,
        );

        // Cache player HTML for 30s in RAM and Redis
        sportsPlayerCache.set(cacheKey, {
          html: transformedHtml,
          expiresAt: Date.now() + SPORTS_HTML_TTL,
        });
        await redisClient.set(
          `html:sports:${eventId}`,
          transformedHtml,
          Math.round(SPORTS_HTML_TTL / 1000),
        );
        return transformedHtml;
      } catch (err) {
        const isNoTv =
          err.message &&
          (err.message.includes("No live TV") ||
            err.message.includes("Stream not found"));
        if (isNoTv) {
          console.log(
            `[SportsEngine] Match ${eventId} has no active satellite broadcast feed upstream.`,
          );
          return renderNoTvHtml();
        }

        console.error(
          `[SportsEngine Error] Attempt ${attempt} for ${eventId}:`,
          err.message,
        );
        if (attempt === 1) {
          rotateTableSession(eventId, "Exception retry");
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        return renderNoTvHtml();
      }
    }
    return renderNoTvHtml();
  })();

  inFlightSportsPlayers.set(eventId, task);
  try {
    const finalHtml = await task;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Permissions-Policy", "unload=*");
    res.setHeader(
      "Content-Security-Policy",
      securityEngine.getFrameAncestorsCSP(),
    );
    return res.send(finalHtml);
  } finally {
    inFlightSportsPlayers.delete(eventId);
  }
});

// 5. Dedicated Sports Proxy-Ping
router.post("/proxy-ping", async (req, res) => {
  const access = await securityEngine.verifyAccess(req, "sports");
  if (!access.allowed) {
    return res.status(403).json({
      error: "Unauthorized: Domain or IP not whitelisted",
      reason: access.reason,
    });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const { target, watchUrl, origin, eventId } = req.query;
  const isInit = Boolean(req.body && req.body.init);
  const isTokenRequest = Boolean(req.body && req.body.token);

  if (!target) {
    return res.status(400).json({ error: "Missing target parameter" });
  }

  const targetUrl = decodeURIComponent(target);
  const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
  const targetOrigin = new URL(targetUrl).origin;
  const pageOrigin = origin
    ? decodeURIComponent(origin)
    : "https://nice444.com/";
  const session = req.query.session
    ? parseInt(req.query.session, 10)
    : getSessionForTable(eventId || targetUrl);

  // Throttling: If an identical ping was forwarded less than 2.5 seconds ago, return cached response
  const lastCached = sportsPingCache.get(targetUrl);
  if (
    lastCached &&
    lastCached.data &&
    !isInit &&
    !isTokenRequest &&
    Date.now() - lastCached.timestamp < 2500
  ) {
    return res.status(200).json(lastCached.data);
  }

  try {
    const payload = {
      ...req.body,
      page: pageOrigin,
      tz: req.body?.tz || "Asia/Kolkata",
      tzo: req.body?.tzo !== undefined ? req.body.tzo : 330,
    };

    const upstreamRes = await proxyFetch(targetUrl, {
      method: "POST",
      session,
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
      timeout: 8000,
    });

    const data = await upstreamRes.json().catch(() => null);

    if (data && typeof data === "object") {
      if (data.stop) data.stop = false;

      // Rewrite HLS URL if present to dedicated sports HLS proxy with clean relative URL (zero mixed content HTTP/HTTPS block)
      if (data.hlsUrl && !data.hlsUrl.startsWith("/api/stream/sports/hls/")) {
        data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
      }

      // Rewrite wsUrl to WebSocket tunnel proxy to bypass Origin 403 blocks
      if (data.wsUrl && !data.wsUrl.startsWith("/api/stream/ws")) {
        let cleanWs = String(data.wsUrl).trim();
        if (cleanWs.startsWith("//")) {
          cleanWs = `wss:${cleanWs}`;
        } else if (cleanWs.startsWith("/")) {
          const wsHost = targetOrigin.replace(/^https?:\/\//, "");
          cleanWs = `wss://${wsHost}${cleanWs}`;
        } else if (
          !cleanWs.startsWith("ws://") &&
          !cleanWs.startsWith("wss://")
        ) {
          cleanWs = `wss://${cleanWs}`;
        }
        data.wsUrl = `/api/stream/ws?target=${encodeURIComponent(cleanWs)}`;
      }

      if (!data.streamId) {
        data.streamId = eventId || lastCached?.data?.streamId || "SPORTS";
      }

      // Save fresh data & timestamp in memory cache
      sportsPingCache.set(targetUrl, { data, timestamp: Date.now() });

      return res.status(200).json(data);
    }

    // Resilient fallback: For routine heartbeats, NEVER fail or return 403!
    // Return { ok: true } so the playing video continues uninterrupted!
    if (!isInit && !isTokenRequest) {
      return res.status(200).json(lastCached?.data || { ok: true });
    }

    return res
      .status(upstreamRes.status || 500)
      .json({ error: "Invalid response from sports ping upstream" });
  } catch (err) {
    console.error("[SportsEngine] Proxy ping error:", err.message);
    if (!isInit && !isTokenRequest) {
      return res.status(200).json(lastCached?.data || { ok: true });
    }
    res.status(500).json({ error: "Proxy ping failed", details: err.message });
  }
});

// 6. Sports Dedicated HLS Playlist Proxy (Zero-Proxy Direct First with Token Propagation)
router.get("/hls/live.m3u8", async (req, res) => {
  try {
    const { url, token } = req.query;
    if (!url) return res.status(400).send("Missing url param");
    let upstreamUrl = decodeURIComponent(url);

    // Propagate authentication token if provided
    if (token) {
      try {
        const u = new URL(upstreamUrl);
        if (!u.searchParams.has("token")) {
          u.searchParams.set("token", token);
          upstreamUrl = u.toString();
        }
      } catch (_) {}
    }

    let text = "";
    // 1. Direct fetch first from VPS (Zero proxy bandwidth!)
    try {
      const directRes = await directFetch(upstreamUrl, {
        headers: { "User-Agent": UA, Referer: "https://tv.ltve.live/" },
        timeout: 6000,
      });
      if (directRes.ok) {
        text = await directRes.text();
      }
    } catch (_) {}

    // 2. Fallback to proxy only if direct fails or was blocked
    if (
      !text ||
      text.includes("403 Forbidden") ||
      text.includes("Access Denied")
    ) {
      const m3u8Res = await proxyFetch(upstreamUrl, {
        headers: { "User-Agent": UA, Referer: "https://tv.ltve.live/" },
        timeout: 8000,
      });
      text = await m3u8Res.text();
    }

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.endsWith(".m3u8") || trimmed.includes(".m3u8?")) {
          const fullVariantUrl = new URL(trimmed, upstreamUrl).href;
          return `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(fullVariantUrl)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
        }
        if (trimmed.endsWith(".ts") || trimmed.includes(".ts?")) {
          const fullSegUrl = new URL(trimmed, upstreamUrl).href;
          return `/api/stream/sports/hls/chunk.ts?url=${encodeURIComponent(fullSegUrl)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
        }
        return line;
      })
      .join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(rewritten);
  } catch (err) {
    console.error("[SportsEngine] HLS Playlist Proxy Error:", err.message);
    res.status(500).send("Error proxying sports HLS playlist");
  }
});

// 7. Sports Dedicated HLS Video Chunk Proxy (Zero-Proxy Direct Pipe with Token & Keep-Alive Pooling)
router.get("/hls/chunk.ts", async (req, res) => {
  try {
    const { url, token } = req.query;
    if (!url) return res.status(400).send("Missing url param");
    let targetUrl = decodeURIComponent(url);

    if (token) {
      try {
        const u = new URL(targetUrl);
        if (!u.searchParams.has("token")) {
          u.searchParams.set("token", token);
          targetUrl = u.toString();
        }
      } catch (_) {}
    }

    // 1. Check RAM Chunk Cache (Ultra-fast 0ms playback directly from memory!)
    const cacheKey = targetUrl;
    const cached = sportsChunkCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt && cached.buffer) {
      res.setHeader("Content-Type", cached.contentType || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("X-Accel-Buffering", "no");
      return res.send(cached.buffer);
    }

    // 2. Fetch and Stream Progressively in Real-Time (Zero-Buffer progressive playback!)
    const u = new URL(targetUrl);
    const isHttps = u.protocol === "https:";
    const client = isHttps ? https : http;
    const agent = isHttps ? sportsHlsAgent : sportsHttpAgent;

    const chunkReq = client.get(
      targetUrl,
      {
        agent,
        headers: { "User-Agent": UA, Referer: "https://tv.ltve.live/" },
        timeout: 12000,
        rejectUnauthorized: false,
      },
      (chunkRes) => {
        if (
          chunkRes.statusCode >= 300 &&
          chunkRes.statusCode < 400 &&
          chunkRes.headers.location
        ) {
          return res.redirect(chunkRes.headers.location);
        }

        const contentType = chunkRes.headers["content-type"] || "video/mp2t";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.setHeader("X-Accel-Buffering", "no");

        const chunks = [];
        chunkRes.on("data", (c) => {
          if (!res.writableEnded) res.write(c);
          chunks.push(c);
        });

        chunkRes.on("end", () => {
          if (!res.writableEnded) res.end();
          const fullBuffer = Buffer.concat(chunks);
          // Cache segment for 60 seconds (video segments never change once created)
          if (sportsChunkCache.size > 80) {
            const oldest = sportsChunkCache.keys().next().value;
            sportsChunkCache.delete(oldest);
          },
          sportsChunkCache.set(cacheKey, {
            buffer: fullBuffer,
            contentType,
            expiresAt: Date.now() + 60000,
          });
        });

        chunkRes.on("error", (err) => {
          console.warn("[SportsEngine] Chunk stream error:", err.message);
          if (!res.writableEnded) res.end();
        });
      }
    );

    chunkReq.on("error", (err) => {
      console.warn("[SportsEngine] Chunk fetch error:", err.message);
      if (!res.headersSent) {
        res.status(502).send("Upstream chunk error");
      }
    });

    chunkReq.on("timeout", () => {
      chunkReq.destroy();
      if (!res.headersSent) {
        res.status(504).send("Upstream chunk timeout");
      }
    });
  } catch (err) {
    console.error("[SportsEngine] HLS Chunk Error:", err.message);
    if (!res.headersSent) {
      res.status(500).send("Error processing sports video chunk");
    }
  }
});

// Pre-load the script into RAM immediately
try {
  getPatchedSportsPlayerJs();
} catch (e) {
  console.warn("[SportsEngine] Pre-load warning:", e.message);
}

module.exports = router;
