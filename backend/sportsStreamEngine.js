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
  invalidateAuthToken,
  proxyFetch,
  directFetch,
  UA,
  MOBILE_HEADERS,
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
const sportsTokenCache = new Map(); // eventId/streamId -> { streamId, token, wsUrl, hlsUrl, expiresAt }
const inFlightSportsPlayers = new Map(); // deduplicate concurrent requests for same match

const SPORTS_HTML_TTL = 30000; // 30 seconds fresh HTML cache in RAM & Redis for live sports feeds

// --- Raw Upstream Live TV Engine (Aura / Trubets RTS WebRTC Relay) ---
const AURA_XOR_KEY = "damru-taala-2026";

function decryptAuraPayload(t) {
  if (!t || t.e !== 1 || typeof t.d !== "string") return t;
  try {
    const s = Uint8Array.from(Buffer.from(t.d, "base64"));
    const a = Buffer.from(AURA_XOR_KEY, "utf8");
    for (let n = 0; n < s.length; n += 1) s[n] ^= a[n % a.length];
    return JSON.parse(Buffer.from(s).toString("utf8"));
  } catch (err) {
    console.warn("[SportsEngine] Failed to decrypt Aura payload:", err.message);
    return t;
  }
}

function getAuraFormattedId(eventId) {
  let s = String(eventId || "").trim();
  const digits = s.replace(/\D/g, "");
  if (!digits) return s;
  if (digits.length >= 13 && digits.startsWith("8")) return digits;
  // Pad to 12 digits and prefix with 8 (Standard Aura 13-digit format: 8 + 12-digit padded Betfair ID)
  return "8" + digits.padStart(12, "0");
}

async function getAuraTvStream(eventId) {
  const fid = getAuraFormattedId(eventId);
  const cacheKey = `aura_tv_${fid}`;
  const cached = sportsWatchLinkCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt && cached.url) {
    return cached.url;
  }

  try {
    const res = await directFetch(`https://api.baji8dot.live/api/public/aura-tv/${fid}`, {
      method: "POST",
      headers: {
        Origin: "https://api.baji8dot.live",
        Referer: "https://api.baji8dot.live/",
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
      },
      timeout: 4500,
    });

    if (!res || !res.ok) return null;
    const encrypted = await res.json().catch(() => null);
    if (!encrypted) return null;
    const decrypted = decryptAuraPayload(encrypted);
    if (decrypted && decrypted.success && decrypted.url) {
      sportsWatchLinkCache.set(cacheKey, {
        url: decrypted.url,
        expiresAt: Date.now() + 180000, // 3 minutes cache
      });
      return decrypted.url;
    }
  } catch (err) {
    console.warn(`[SportsEngine] Aura TV stream lookup failed for ${fid}:`, err.message);
  }
  return null;
}

function transformAuraPlayerHtml(html, streamUrl, eventId) {
  let transformed = html;

  const auraSportsStyle = `
    <style>
      html, body {
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #000 !important;
      }
      #player, .prism-player, video {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        background: #000 !important;
      }
      .watermark, #watermark, #wm {
        display: none !important;
      }
    </style>
  `;

  if (transformed.includes("</head>")) {
    transformed = transformed.replace("</head>", `${auraSportsStyle}\n</head>`);
  }

  // 1. Rewrite WebRTC / RTS source directly to play.trubets365.com
  transformed = transformed.replace(/artc:\/\/\$\{location\.host\}\/relay-tv\//g, "artc://play.trubets365.com/relay-tv/");

  // 2. Rewrite all relative /relay-tv/ paths to full absolute https://play.trubets365.com/relay-tv/
  transformed = transformed.replace(/(["'`])\/relay-tv\//g, "$1https://play.trubets365.com/relay-tv/");

  // 3. Disable competitor debugger & devtools traps
  transformed = transformed.replace(/const guardEnabled = true;/g, "const guardEnabled = false;");
  transformed = transformed.replace(/debugger;/g, "/* disabled */");

  return transformed;
}

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
  // 1. HLS Buffer & Gap Bridging: 40s lookahead, 0.5s hole auto-skip, 0.1s instant nudge, multi-threaded worker
  js = js.replace(
    /liveSyncDurationCount:4,liveMaxLatencyDurationCount:10,maxBufferLength:20,backBufferLength:10/g,
    "liveSyncDurationCount:4,liveMaxLatencyDurationCount:12,maxBufferLength:40,maxMaxBufferLength:80,backBufferLength:20,maxBufferHole:0.5,nudgeOffset:0.1,nudgeMaxRetry:5,highBufferWatchdogPeriod:1,enableWorker:!0,lowLatencyMode:!1",
  );

  // 2. Debounced Buffering Indicator & Instant 0.1s Auto-Unsticker (Eliminates flashing Buffering... text)
  js = js.replace(
    /\$\.addEventListener\(`waiting`,\(\)=>\{vp===`hls`&&Tp\(`Buffering…`\)\}\)/g,
    "(()=>{var _b, _l=-1, _s=0; $.addEventListener(`waiting`,()=>{clearTimeout(_b);_b=setTimeout(()=>{if(vp===`hls`&&($.paused||$.readyState<3)){Tp(`Buffering…`)}},1200)}); $.addEventListener(`playing`,()=>{clearTimeout(_b);Tp(``)}); $.addEventListener(`timeupdate`,()=>{if($.currentTime>0&&!$.paused){clearTimeout(_b);if(gp&&gp.textContent===`Buffering…`)Tp(``)}}); setInterval(()=>{if(vp===`hls`&&!$.paused&&!$.ended&&$.readyState>=2){if($.currentTime===_l){_s++;if(_s>=2){try{$.currentTime+=0.08}catch(_){}_s=0}}else{_s=0;_l=$.currentTime}}},500)})()",
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

  // 5. Freeze detector: increase freeze threshold to 120s (stops false reload loops)
  js = js.replace(/Q\.freezeSeconds/g, "120");
  js = js.replace(/Vp>=Q\.freezeSeconds/g, "Vp>=120");

  // 6. Devtools detector: neutralize debugger loops and docking traps
  js = js.replace(/Q\.devtoolsGuard/g, "false");
  js = js.replace(/devtoolsGuard:!0/g, "devtoolsGuard:!1");

  // 7. Suppress window redirect traps cleanly with void 0 (keeps valid JS syntax - no SyntaxError!)
  js = js.replace(
    /location\.replace\(window\.top===window\?Q\.devtoolsRedirect:Q\.blockedUrl\)/g,
    "void 0",
  );

  // 8. Prevent false session kill on transient ping 403 or error
  js = js.replace(
    /if\(n\.status===403\)return Ap\(`This session has ended\.`\);/g,
    "if(n.status===403){console.warn('Ping 403 ignored');return true;}",
  );

  // 9. Fix TypeError: Invalid URL in HLS player when Q.hlsUrl is a relative path
  js = js.replace(/new URL\(e,Q\.hlsUrl\)/g, "new URL(e,window.location.href)");

  // 10. Fix WebSocket relative URL resolution for proxied WebRTC tunnels
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


// 2. Resolve internal exchange event ID to real Betfair event ID
async function resolveBetfairEventId(rawId, sportId = "4") {
  const streamId = String(rawId || "").trim();

  // If already an 7-10 digit Betfair ID, return immediately
  if (/^\d{7,10}$/.test(streamId)) {
    return streamId;
  }

  // 20wickets match ID mapping: starts with 8000 (e.g. 8000036223050 -> 36223050)
  if (streamId.length >= 12 && streamId.startsWith("8000")) {
    const stripped = String(Number(streamId.slice(4)));
    if (/^\d{6,10}$/.test(stripped)) {
      return stripped;
    }
  }

  // Large numeric 12-14 digit ID starting with 8e12
  const numId = Number(streamId);
  if (!isNaN(numId) && numId >= 8e12 && numId < 9e12) {
    const stripped = String(numId - 8e12);
    if (/^\d{6,10}$/.test(stripped)) {
      return stripped;
    }
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

  // Query CBTF/Startexch getMarketsEventList without `key: '2'` to extract Betfair ID
  const providerList = ["cbtf", "startexch", "asstarplay"];
  const session = getSessionForTable(streamId);

  for (const provKey of providerList) {
    const prov = PROVIDERS[provKey];
    if (!prov) continue;
    try {
      // 1. Direct fetch first without proxy (Zero proxy bandwidth, 200ms resolution!)
      let res = await directFetch(
        `${prov.base}/api/exchange/markets/getMarketsEventList`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: prov.base,
            Referer: `${prov.base}/`,
            "User-Agent": UA,
            ...MOBILE_HEADERS,
          },
          body: JSON.stringify({ eventId: streamId, sportId: String(sportId) }),
          timeout: 3000,
        },
      ).catch(() => null);

      if (!res || !res.ok) {
        const token = await getAuthToken(provKey);
        res = await proxyFetch(
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
              ...MOBILE_HEADERS,
            },
            body: JSON.stringify({ eventId: streamId, sportId: String(sportId) }),
            timeout: 6000,
          },
        );
      }

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

      if (resolved && /^\d{6,10}$/.test(String(resolved))) {
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
  const providerList = ["cbtf", "startexch", "asstarplay"];

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
                ...MOBILE_HEADERS,
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

          if (res.status === 401) {
            await invalidateAuthToken(provKey);
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
function transformSportsHtml(html, watchUrl, eventId, providerOrigin, session, prewarmedData = null) {
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
    </style>
  `;

  // 80-Year Systems Architecture: Client-Side Canary Watchdog for Sports Live Feeds
  // If video buffer stalls, encounters an error, or token expires, signals backend /api/stream/sports/evict
  // to silently rotate tokens across providers without page reload.
  const sportsCanaryScript = `
    <script id="sportsCanary">
      (function() {
        var _eventId = "${eventId}";
        var _stalledTimer = null;
        var _lastTime = -1;
        var _freezeCounter = 0;
        var _isEvicting = false;

        function notifySportsEvict(reason) {
          if (_isEvicting || !window.fetch) return;
          _isEvicting = true;
          console.warn('[Sports Canary] Stalled match stream detected (' + reason + '). Auto-evicting...');
          fetch('/api/stream/sports/evict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventId: _eventId, reason: reason })
          }).then(function(r) { return r.json(); }).then(function(d) {
            if (d && d.ok) {
              console.log('[Sports Canary] Failover primed. Resuming match stream in 300ms...');
              setTimeout(function() { window.location.reload(); }, 300);
            } else { _isEvicting = false; }
          }).catch(function() { _isEvicting = false; });
        }

        function checkSportsHeartbeat() {
          var v = document.querySelector('video');
          if (!v) return;
          if (!v.paused && !v.ended) {
            if (v.currentTime === _lastTime && v.readyState >= 2) {
              _freezeCounter++;
              if (_freezeCounter >= 4) {
                _freezeCounter = 0;
                notifySportsEvict('sports_video_frozen');
              }
            } else {
              _freezeCounter = 0;
              _lastTime = v.currentTime;
            }
          }
        }

        window.addEventListener('load', function() {
          setInterval(checkSportsHeartbeat, 1000);
          var v = document.querySelector('video');
          if (v) {
            v.addEventListener('error', function() { notifySportsEvict('sports_video_error'); });
            v.addEventListener('stalled', function() {
              clearTimeout(_stalledTimer);
              _stalledTimer = setTimeout(function() { notifySportsEvict('sports_video_stalled'); }, 4000);
            });
            v.addEventListener('playing', function() {
              clearTimeout(_stalledTimer);
              _freezeCounter = 0;
            });
          }
        });
      })();
    </script>
  `;
  html = html.replace(
    "</head>",
    `${sportsStyle}\n${sportsCanaryScript}\n</head>`,
  );

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

      const proxiedPingUrl = `/api/stream/sports/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=${encodeURIComponent(eventId)}&origin=${encodeURIComponent(providerOrigin || "https://cbtfexchange.com")}&session=${encodeURIComponent(session || "")}`;

      const modifiedCfg = {
        ...originalCfg,
        streamId: originalCfg.streamId || eventId || "SPORTS",
        pingUrl: proxiedPingUrl,
        flagUrl: "/api/stream/sports/dummy-flag",
        byeUrl: "/api/stream/sports/dummy-bye",
        devtoolsGuard: false,
        devtoolsRedirect: "",
        blockedUrl: "",
        home: "",
        freezeSeconds: 120, // 2 minutes freeze tolerance (prevents buffering reload loops)
        oneTimeToken: false, // Keep token alive (prevents loader freeze)
        offlineRetry: 5,
        webrtcTimeout: 30, // Full WebRTC handshake window (Casino TV zero-latency parity)
        frameAllow: {
          enforce: false,
          outer: { apps: false, hosts: [], sites: [] },
          parent: { apps: false, hosts: [], sites: [] },
        },
      };

      if (prewarmedData) {
        if (prewarmedData.token) modifiedCfg.token = prewarmedData.token;
        if (prewarmedData.wsUrl) {
          let cleanWs = String(prewarmedData.wsUrl).trim();
          if (cleanWs.startsWith("//")) cleanWs = `wss:${cleanWs}`;
          else if (cleanWs.startsWith("/")) cleanWs = `wss://${new URL(watchUrl).host}${cleanWs}`;
          else if (!cleanWs.startsWith("ws://") && !cleanWs.startsWith("wss://")) cleanWs = `wss://${cleanWs}`;
          modifiedCfg.wsUrl = cleanWs; // Direct zero-latency WebRTC connection
        }
        if (prewarmedData.hlsUrl) {
          modifiedCfg.hlsUrl = prewarmedData.hlsUrl;
        }
        if (prewarmedData.streamId) {
          modifiedCfg.streamId = prewarmedData.streamId;
        }
      }

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
            get: function() { return ['https://cbtfexchange.com', 'https://startexch99.com', 'https://tv.ltve.live']; },
            configurable: true
          });
        } catch(e) {}
      })();
    </script>
    <script>
      (function() {
        var v = document.getElementById('video') || document.querySelector('video');
        if (!v) return;
        var lastTime = -1;
        var stallCount = 0;
        setInterval(function() {
          if (document.hidden || v.paused || v.ended) return;
          if (v.currentTime > 0 && Math.abs(v.currentTime - lastTime) < 0.05) {
            stallCount++;
            if (stallCount >= 6) {
              console.warn('[Sports Watchdog] Stream frozen for 12s, triggering auto-evict and reload...');
              try {
                fetch('/api/stream/sports/evict?eventId=${encodeURIComponent(eventId)}', { method: 'POST' }).catch(function(){});
              } catch(_) {}
              setTimeout(function() { window.location.reload(); }, 600);
            }
          } else {
            stallCount = 0;
            lastTime = v.currentTime;
          }
        }, 2000);
      })();
    </script>
  `;
  html = html.replace("</body>", `${clientPatch}</body>`);

  return html;
}

// 5. Clean, Ultra-Smooth Zero-Origin-Leak Sports Player Template
// Pristine video broadcast with zero watermark text and native sound toggle controls
function renderProtectedDirectPlayer(betfairId, eventId, sportId = "4") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>Live Sports TV</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      -webkit-user-select: none;
      user-select: none;
    }
    .player-wrap {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
      transform: translateZ(0);
      will-change: transform;
      backface-visibility: hidden;
    }
    #stream-frame {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      background: #000;
      transform: translateZ(0);
      will-change: transform;
    }
    /* Notice & Ticker Shield: Sleek gradient barrier at the bottom to suppress any rogue text/tickers */
    #ticker-shield {
      position: absolute;
      z-index: 9;
      bottom: 0;
      left: 0;
      right: 0;
      height: 32px;
      pointer-events: none;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.95) 0%, rgba(0, 0, 0, 0.5) 60%, rgba(0, 0, 0, 0) 100%);
    }
    /* Status Screen overlay: Clean minimalist fade */
    #status {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      color: #64748b;
      font-size: 14px;
      letter-spacing: 0.3px;
      pointer-events: none;
      background: #000;
      transition: opacity 0.4s ease-out;
    }
    #status.off {
      opacity: 0;
      visibility: hidden;
    }
  </style>
</head>
<body>
  <div class="player-wrap">
    <iframe id="stream-frame" src="/api/stream/sports/hop/${encodeURIComponent(betfairId)}" title="Live Broadcast" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen scrolling="no" referrerpolicy="no-referrer"></iframe>
    <div id="ticker-shield"></div>
    <div id="status">Connecting…</div>
  </div>

  <script>
    (function () {
      var betfairId = ${JSON.stringify(betfairId)};
      var fr = document.getElementById('stream-frame');
      var st = document.getElementById('status');

      // Hide connecting overlay smoothly once player boots
      var done = false;
      function hideStatus() {
        if (!done) {
          done = true;
          st.className = 'off';
          setTimeout(function () { st.hidden = true; }, 450);
        }
      }

      var loadCount = 0;
      fr.onload = function () {
        loadCount++;
        if (loadCount >= 2) {
          setTimeout(hideStatus, 800);
        }
      };
      setTimeout(hideStatus, 4000);
    })();
  </script>
</body>
</html>`;
}

// 6. Native Minimalist Unavailable Screen matching original provider
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

    const providerList = ["cbtf", "startexch", "asstarplay"];
    const sportNames = {
      1: "Soccer",
      2: "Tennis",
      4: "Cricket",
      7: "Horse Racing",
    };

    const result = [];
    const seenEventNames = new Set();
    const seenEventIds = new Set();

    // 1. Ultra-fast direct fetch from Aura Sports Engine (250ms latency, zero proxy bandwidth)
    try {
      const auraRes = await directFetch(
        "https://api.baji8dot.live/api/public/sports?x=1",
        {
          headers: {
            Origin: "https://api.baji8dot.live",
            Referer: "https://api.baji8dot.live/",
            "User-Agent": UA,
          },
          timeout: 3500,
        },
      ).catch(() => null);

      if (auraRes && auraRes.ok) {
        const auraEnc = await auraRes.json().catch(() => null);
        const auraDec = decryptAuraPayload(auraEnc);
        if (auraDec && Array.isArray(auraDec.data)) {
          for (const sp of auraDec.data) {
            const sId = String(sp.eventTypeId || "4");
            const sName = sp.eventTypeName || sportNames[sId] || "Other Sport";
            if (Array.isArray(sp.events)) {
              for (const ev of sp.events) {
                const eid = String(ev.eventId || "");
                const name = (ev.eventName || "").trim();
                if (!eid || !name) continue;

                seenEventIds.add(eid);
                seenEventNames.add(name.toLowerCase());

                const digits = eid.replace(/\D/g, "");
                if (digits) {
                  const bId = digits.startsWith("8") && digits.length >= 13 ? digits.slice(5) : digits;
                  betfairIdCache.set(eid, bId);
                }

                result.push({
                  id: eid,
                  name: name,
                  sportId: sId,
                  sportName: sName,
                  tournament: ev.competitionName || "",
                  inPlay: Boolean(ev.inplay),
                  isStreaming: true,
                  eventTime: ev.openDate || "",
                  tv: true,
                });
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[SportsEngine] Notice fetching Aura sports list:", e.message);
    }

    // 2. Secondary fetch: Merge additional matches from CBTF / Startexch
    for (const provKey of providerList) {
      try {
        const provider = PROVIDERS[provKey];
        let upstreamRes = await directFetch(
          `${provider.base}/api/exchange/market/matchodds/allEventsList`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: provider.base,
              Referer: `${provider.base}/`,
              "User-Agent": UA,
              ...MOBILE_HEADERS,
            },
            body: JSON.stringify({}),
            timeout: 3000,
          },
        ).catch(() => null);

        if (!upstreamRes || !upstreamRes.ok) {
          const token = await getAuthToken(provKey);
          upstreamRes = await proxyFetch(
            `${provider.base}/api/exchange/market/matchodds/allEventsList`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                Origin: provider.base,
                Referer: `${provider.base}/`,
                "User-Agent": UA,
                ...MOBILE_HEADERS,
              },
              body: JSON.stringify({}),
              timeout: 4000,
            },
          );
        }

        const d = await upstreamRes.json();
        if (d?.data) {
          for (const [sId, list] of Object.entries(d.data)) {
            if (Array.isArray(list)) {
              for (const ev of list) {
                const eid = String(ev.exEventId || ev._id || "");
                const name = (ev.eventName || "").trim();
                if (!eid || !name) continue;

                // Deduplicate with matches already present from Aura
                if (seenEventIds.has(eid) || seenEventNames.has(name.toLowerCase())) {
                  continue;
                }
                seenEventIds.add(eid);
                seenEventNames.add(name.toLowerCase());

                const isInPlay = Boolean(
                  ev?.oddsData?.inPlay ?? ev?.inPlay ?? false,
                );
                const isStreaming = Boolean(ev?.isStreaming ?? false);
                result.push({
                  id: eid,
                  name: name,
                  sportId: String(sId),
                  sportName: sportNames[sId] || "Other Sport",
                  tournament: ev.tournamentName || "",
                  inPlay: isInPlay,
                  isStreaming: isStreaming,
                  eventTime: ev.eventTime || "",
                  tv: isStreaming,
                });
              }
            }
          }
        }

        if (result.length > 0) break;
      } catch (err) {
        console.warn(
          `[SportsEngine] Failed to fetch events from ${provKey}:`,
          err.message,
        );
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

// 3b. Dedicated Clean Hop Gateway (Direct to Sports Player - Zero Third-Party Leak)
router.get("/hop/:betfairId", (req, res) => {
  let id = String(req.params.betfairId || "").replace(/\D/g, "");
  if (id.length >= 12 && id.startsWith("8000")) {
    id = String(Number(id.slice(4)));
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Permissions-Policy", "unload=*");

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <style>html,body{margin:0;height:100%;background:#000;overflow:hidden;}</style>
</head>
<body>
<script>
var id = ${JSON.stringify(id)};
if (id) {
  location.replace('/api/stream/sports/player/' + id);
}
</script>
</body>
</html>`);
});

// 4. Dedicated Sports TV Player Iframe
router.get("/player/:eventId", async (req, res) => {
  const { eventId } = req.params;
  const sportId = req.query.sportId || "4";
  const engine = String(req.query.engine || "direct").toLowerCase();

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

  // Dedicated Multi-Provider Sports TV Stream Relay Engine
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
    // === TIER 1: Raw Ultra-Fast WebRTC Stream (Aura / Trubets RTS Relay) ===
    try {
      console.log(`[SportsEngine] Resolving Tier 1 Aura raw stream for ${eventId}...`);
      const auraStreamUrl = await getAuraTvStream(eventId);
      if (auraStreamUrl) {
        console.log(`[SportsEngine] Tier 1 Aura stream found: ${auraStreamUrl}. Fetching player HTML...`);
        const playerRes = await directFetch(auraStreamUrl, {
          headers: {
            "User-Agent": UA,
            Referer: "https://play.trubets365.com/",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          timeout: 4500,
        }).catch(() => null);

        if (playerRes && playerRes.ok) {
          const rawAuraHtml = await playerRes.text();
          if (
            rawAuraHtml &&
            (rawAuraHtml.includes("Aliplayer") ||
              rawAuraHtml.includes("artc://") ||
              rawAuraHtml.includes("aliyun-rts-sdk"))
          ) {
            const transformedAuraHtml = transformAuraPlayerHtml(
              rawAuraHtml,
              auraStreamUrl,
              eventId,
            );
            sportsPlayerCache.set(cacheKey, {
              html: transformedAuraHtml,
              expiresAt: Date.now() + SPORTS_HTML_TTL,
            });
            await redisClient
              .set(
                `html:sports:${eventId}`,
                transformedAuraHtml,
                Math.round(SPORTS_HTML_TTL / 1000),
              )
              .catch(() => {});
            console.log(
              `[SportsEngine] ⚡ Serving Tier 1 Aura raw WebRTC player for ${eventId}`,
            );
            return transformedAuraHtml;
          }
        }
      }
    } catch (auraErr) {
      console.warn(
        `[SportsEngine] Tier 1 Aura stream lookup failed for ${eventId}:`,
        auraErr.message,
      );
    }

    // === TIER 2: Betfair LTVE Satellite Broadcast (Fallback via CBTF/Startexch) ===
    // === TIER 1: Raw Ultra-Fast WebRTC Stream (Aura / Trubets RTS Relay) ===
    try {
      console.log(`[SportsEngine] Resolving Tier 1 Aura raw stream for ${eventId}...`);
      const auraStreamUrl = await getAuraTvStream(eventId);
      if (auraStreamUrl) {
        console.log(`[SportsEngine] Tier 1 Aura stream found: ${auraStreamUrl}. Fetching player HTML...`);
        const playerRes = await directFetch(auraStreamUrl, {
          headers: {
            "User-Agent": UA,
            Referer: "https://play.trubets365.com/",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          timeout: 4500,
        }).catch(() => null);

        if (playerRes && playerRes.ok) {
          const rawAuraHtml = await playerRes.text();
          if (
            rawAuraHtml &&
            (rawAuraHtml.includes("Aliplayer") ||
              rawAuraHtml.includes("artc://") ||
              rawAuraHtml.includes("aliyun-rts-sdk"))
          ) {
            const transformedAuraHtml = transformAuraPlayerHtml(
              rawAuraHtml,
              auraStreamUrl,
              eventId,
            );
            sportsPlayerCache.set(cacheKey, {
              html: transformedAuraHtml,
              expiresAt: Date.now() + SPORTS_HTML_TTL,
            });
            await redisClient
              .set(
                `html:sports:${eventId}`,
                transformedAuraHtml,
                Math.round(SPORTS_HTML_TTL / 1000),
              )
              .catch(() => {});
            console.log(
              `[SportsEngine] ⚡ Serving Tier 1 Aura raw WebRTC player for ${eventId}`,
            );
            return transformedAuraHtml;
          }
        }
      }
    } catch (auraErr) {
      console.warn(
        `[SportsEngine] Tier 1 Aura stream lookup failed for ${eventId}:`,
        auraErr.message,
      );
    }

    // === TIER 2: Betfair LTVE Satellite Broadcast (Fallback via CBTF/Startexch) ===
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `[SportsEngine] Tier 2 Fallback: Fetching sports player for match ${eventId} (attempt ${attempt})`,
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

        // Instant Pre-Warm Ping Handshake: Acquire JWT token and stream info immediately
        let prewarmedData = null;
        const cfgMatch = rawHtml.match(
          /<script type="application\/json" id="cfg">([^<]+)<\/script>/,
        );
        if (cfgMatch) {
          try {
            const rawCfg = JSON.parse(cfgMatch[1]);
            const targetPingUrl = rawCfg.pingUrl.startsWith("http")
              ? rawCfg.pingUrl
              : new URL(rawCfg.pingUrl, watchUrl).href;

            const pingRes = await proxyFetch(targetPingUrl, {
              method: "POST",
              session,
              headers: {
                "Content-Type": "application/json",
                Origin: new URL(targetPingUrl).origin,
                Referer: watchUrl,
                "User-Agent": UA,
                Accept: "*/*",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
              },
              body: JSON.stringify({
                sid: rawCfg.sid,
                mode: "connecting",
                init: true,
                token: true,
                page: referer,
                tz: "Asia/Kolkata",
                tzo: 330,
              }),
              timeout: 6000,
            }).catch(() => null);

            if (pingRes && pingRes.ok) {
              const pingJson = await pingRes.json().catch(() => null);
              if (pingJson && pingJson.token) {
                prewarmedData = pingJson;
                const tokenEntry = {
                  token: pingJson.token,
                  wsUrl: pingJson.wsUrl,
                  hlsUrl: pingJson.hlsUrl,
                  streamId: pingJson.streamId || eventId,
                  timestamp: Date.now(),
                  expiresAt: Date.now() + 1800000, // 30 mins
                };
                sportsTokenCache.set(eventId, tokenEntry);
                sportsTokenCache.set(targetPingUrl, tokenEntry);
                await redisClient
                  .set(`table_token:sports:${eventId}`, tokenEntry, 1800)
                  .catch(() => {});
                console.log(
                  `[SportsEngine] Pre-warm ping successful! Injected valid token into sports player for ${eventId}`,
                );
              }
            }
          } catch (e) {
            console.warn(
              `[SportsEngine] Pre-warm ping warning for ${eventId}:`,
              e.message,
            );
          }
        }

        const transformedHtml = transformSportsHtml(
          rawHtml,
          watchUrl,
          eventId,
          watchData.origin,
          session,
          prewarmedData,
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

// 4b. Sports Stream Eviction / Self-Healing Trigger
router.all("/evict", async (req, res) => {
  const eventId = req.query.eventId || req.body?.eventId;
  if (!eventId)
    return res.status(400).json({ ok: false, error: "Missing eventId" });

  try {
    sportsWatchLinkCache.delete(`sports_watchlink:${eventId}`);
    sportsPlayerCache.delete(`sports_player_${eventId}`);
    sportsTokenCache.delete(eventId);
    await redisClient.del(`sports_watchlink:${eventId}`).catch(() => {});
    await redisClient.del(`html:sports:${eventId}`).catch(() => {});
    await redisClient.del(`table_token:sports:${eventId}`).catch(() => {});
    console.log(`[SportsEngine] Evicted cache for sports event ${eventId}`);
    return res.json({
      ok: true,
      message: `Sports cache evicted for ${eventId}`,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// 80-Year Systems Architecture: Sports Stream Eviction & Autonomous Re-Harvesting
// ============================================================================
router.post("/evict", express.json(), async (req, res) => {
  const eventId = String(req.body?.eventId || req.query?.eventId || "").trim();
  const reason = String(req.body?.reason || "sports_canary_stalled").trim();
  if (!eventId)
    return res.status(400).json({ ok: false, error: "eventId is required" });

  console.warn(
    `[Sports Evict] ⚡ Match ${eventId} evicted by canary watchdog (Reason: ${reason})`,
  );
  try {
    const betfairId = betfairIdCache.get(eventId) || eventId;
    const cacheKey = `watchlink:${betfairId}`;

    sportsPlayerCache.delete(`sports_${eventId}`);
    sportsWatchLinkCache.delete(cacheKey);
    inFlightSportsPlayers.delete(eventId);

    await redisClient.del(`sports_html:${eventId}`).catch(() => {});
    await redisClient.del(`sports:watchlink:${betfairId}`).catch(() => {});
    await redisClient.del(cacheKey).catch(() => {});

    rotateTableSession(betfairId, `Sports canary eviction: ${reason}`);
    getSportsWatchUrl(eventId, "4", true).catch(() => {});

    return res.status(200).json({
      ok: true,
      eventId,
      betfairId,
      reason,
      evictedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
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

  // 1. FAST ZERO-PROXY RESPONDER FOR ROUTINE HEARTBEATS (!isInit && !isTokenRequest):
  // When stream is running, player pings every 10s. Responding in 0ms locally eliminates 99% of outbound requests and stops disconnects!
  if (!isInit && !isTokenRequest) {
    let cachedToken = sportsTokenCache.get(eventId || target);
    if (!cachedToken && eventId) {
      try {
        const rData = await redisClient.get(`table_token:sports:${eventId}`);
        if (rData && rData.token) cachedToken = rData;
      } catch (_) {}
    }

    return res.status(200).json({
      ok: true,
      state: "live",
      streamId: cachedToken?.streamId || eventId || "SPORTS",
      token: cachedToken?.token || "",
      wsUrl: cachedToken?.wsUrl || "",
      hlsUrl: cachedToken?.hlsUrl || "",
      stop: false,
    });
  }

  if (!target) {
    return res.status(400).json({ error: "Missing target parameter" });
  }

  const targetUrl = decodeURIComponent(target);
  const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
  const targetOrigin = new URL(targetUrl).origin;
  const pageOrigin = origin
    ? decodeURIComponent(origin)
    : "https://cbtfexchange.com/";
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
        ...MOBILE_HEADERS,
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

      // Cache token in memory and Redis for 0ms heartbeats
      if (data.token) {
        const tokenEntry = {
          streamId: data.streamId,
          token: data.token,
          wsUrl: data.wsUrl,
          hlsUrl: data.hlsUrl,
          expiresAt: Date.now() + 3600 * 1000,
        };
        if (eventId) {
          sportsTokenCache.set(eventId, tokenEntry);
          await redisClient
            .set(`table_token:sports:${eventId}`, tokenEntry, 3600)
            .catch(() => {});
        }
        sportsTokenCache.set(targetUrl, tokenEntry);
      }

      // Save fresh data & timestamp in memory cache
      sportsPingCache.set(targetUrl, { data, timestamp: Date.now() });

      return res.status(200).json(data);
    }

    // Resilient fallback: For routine heartbeats, NEVER fail or return 403!
    // Return { ok: true } so the playing video continues uninterrupted!
    if (!isInit && !isTokenRequest) {
      return res
        .status(200)
        .json(lastCached?.data || { ok: true, state: "live", stop: false });
    }

    return res
      .status(upstreamRes.status || 200)
      .json(lastCached?.data || { ok: true, state: "live", stop: false });
  } catch (err) {
    console.error("[SportsEngine] Proxy ping error:", err.message);
    if (!isInit && !isTokenRequest) {
      return res
        .status(200)
        .json(lastCached?.data || { ok: true, state: "live", stop: false });
    }
    return res.status(200).json({ ok: true, state: "live", stop: false });
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

    // Check RAM Chunk Cache (Ultra-fast 0ms playback directly from memory!)
    const cacheKey = targetUrl;
    const cached = sportsChunkCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt && cached.buffer) {
      res.setHeader("Content-Type", cached.contentType || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.send(cached.buffer);
    }

    // Deduplicate in-flight chunk requests across concurrent viewers
    if (inFlightSportsChunks.has(cacheKey)) {
      try {
        const result = await inFlightSportsChunks.get(cacheKey);
        if (result && result.buffer) {
          res.setHeader("Content-Type", result.contentType || "video/mp2t");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "public, max-age=86400, immutable");
          return res.send(result.buffer);
        }
      } catch (_) {}
    }

    const task = (async () => {
      const u = new URL(targetUrl);
      const isHttps = u.protocol === "https:";
      const client = isHttps ? https : http;
      const agent = isHttps ? sportsHlsAgent : sportsHttpAgent;

      return new Promise((resolve, reject) => {
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
              return resolve({ redirect: chunkRes.headers.location });
            }

            const contentType =
              chunkRes.headers["content-type"] || "video/mp2t";
            const chunks = [];
            chunkRes.on("data", (c) => chunks.push(c));
            chunkRes.on("end", () => {
              const fullBuffer = Buffer.concat(chunks);
              // Cache segment for 60 seconds (video segments never change once created)
              if (sportsChunkCache.size > 60) {
                const oldest = sportsChunkCache.keys().next().value;
                sportsChunkCache.delete(oldest);
              }
              const entry = {
                buffer: fullBuffer,
                contentType,
                expiresAt: Date.now() + 60000,
              };
              sportsChunkCache.set(cacheKey, entry);
              resolve(entry);
            });
            chunkRes.on("error", reject);
          },
        );

        chunkReq.on("error", reject);
        chunkReq.on("timeout", () => {
          chunkReq.destroy();
          reject(new Error("Chunk request timed out"));
        });
      });
    })();

    inFlightSportsChunks.set(cacheKey, task);

    try {
      const result = await task;
      if (result.redirect) {
        return res.redirect(result.redirect);
      }
      res.setHeader("Content-Type", result.contentType || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.send(result.buffer);
    } finally {
      inFlightSportsChunks.delete(cacheKey);
    }
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
