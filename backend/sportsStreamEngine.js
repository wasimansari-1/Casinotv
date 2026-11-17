/**
 * Dedicated Sports TV Stream Engine
 * High-performance, low-latency streaming for live Cricket, Soccer, Tennis & other sports.
 * Completely isolated from Casino TV to ensure zero interference.
 */

const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const securityEngine = require('./securityEngine');
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
  rotateTableSession
} = require('./streamCore');

// In-memory caches for sub-millisecond response & bandwidth preservation
const sportsEventsCache = { data: null, expiresAt: 0 };
let inFlightSportsEvents = null;
const sportsPlayerCache = new Map(); // cacheKey -> { html, expiresAt }
const betfairIdCache = new Map();    // rawEventId -> betfairId
const sportsWatchLinkCache = new Map(); // streamId -> { url, origin, provider, session, expiresAt }
const sportsPingCache = new Map();   // targetUrl -> { data, timestamp }
const inFlightSportsPlayers = new Map(); // deduplicate concurrent requests for same match

const SPORTS_HTML_TTL = 300000; // 5 minutes (300s) HTML cache in RAM & Redis (reduces proxy calls by 85%)

// 1. Pre-patch and cache the raw LTVE sports player JavaScript in RAM memory
let _cachedSportsPlayerJs = null;

function getPatchedSportsPlayerJs() {
  if (_cachedSportsPlayerJs) return _cachedSportsPlayerJs;

  const rawPath = path.join(__dirname, 'sports_player_raw.js');
  let js = '';
  if (fs.existsSync(rawPath)) {
    js = fs.readFileSync(rawPath, 'utf8');
  } else {
    js = fs.readFileSync(path.join(__dirname, 'player.js'), 'utf8');
  }

  // High-performance stream optimizations
  // 1. Buffer tuning: increase HLS buffer length to eliminate stutter and buffering
  js = js.replace(/maxBufferLength:20/g, 'maxBufferLength:60,maxMaxBufferLength:120,fragLoadingTimeOut:30000,fragLoadingMaxRetry:10');
  
  // 2. Freeze detector: increase freeze threshold to 120s (stops false reload loops)
  js = js.replace(/Q\.freezeSeconds/g, '120');

  // 3. Devtools detector: neutralize debugger loops and docking traps
  js = js.replace(/Q\.devtoolsGuard/g, 'false');
  js = js.replace(/devtoolsGuard:!0/g, 'devtoolsGuard:!1');

  // 4. Suppress window redirect traps cleanly with void 0 (keeps valid JS syntax - no SyntaxError!)
  js = js.replace(/location\.replace\(window\.top===window\?Q\.devtoolsRedirect:Q\.blockedUrl\)/g, 'void 0');

  _cachedSportsPlayerJs = js;
  console.log(`[SportsEngine] Loaded & optimized sports_player.js (${(js.length / 1024).toFixed(1)} KB) into RAM`);
  return _cachedSportsPlayerJs;
}

// 2. Resolve 20-digit internal exchange event ID to real Betfair event ID
async function resolveBetfairEventId(rawId, sportId = '4') {
  const streamId = String(rawId || '').trim();
  
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
  const providerList = ['nice444', 'startexch', 'asstarplay'];
  const session = getSessionForTable(streamId);

  for (const provKey of providerList) {
    const prov = PROVIDERS[provKey];
    if (!prov) continue;
    try {
      const token = await getAuthToken(provKey);
      const res = await proxyFetch(`${prov.base}/api/exchange/markets/getMarketsEventList`, {
        method: 'POST',
        session,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Origin': prov.base,
          'Referer': `${prov.base}/`,
          'User-Agent': UA
        },
        body: JSON.stringify({ eventId: streamId, sportId: String(sportId) }),
        timeout: 6000
      });

      const d = await res.json();
      const rawData = d?.data?.data || d?.data || {};
      const matchOdds = Array.isArray(rawData.matchOddsData) ? rawData.matchOddsData[0] : null;
      const bookmaker = Array.isArray(rawData.bookmakersData) ? rawData.bookmakersData[0] : null;
      const resolved = matchOdds?.eventId || bookmaker?.eventId || rawData.streamId;

      if (resolved && /^\d{7,9}$/.test(String(resolved))) {
        const betfairId = String(resolved);
        betfairIdCache.set(streamId, betfairId);
        await redisClient.set(`sports:betfair_id:${streamId}`, betfairId, 3600 * 4);
        console.log(`[SportsEngine] Resolved internal match ID ${streamId} -> Betfair ID ${betfairId}`);
        return betfairId;
      }
    } catch (e) {
      console.warn(`[SportsEngine] Provider ${prov.name} market resolution error for ${streamId}:`, e.message);
    }
  }

  // Fallback to original streamId
  return streamId;
}

// 3. Multi-Provider Sports WatchLink Resolver
async function getSportsWatchUrl(rawEventId, sportId = '4', forceFresh = false) {
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
    if (redisCached && redisCached.url && Date.now() < (redisCached.expiresAt || 0)) {
      sportsWatchLinkCache.set(cacheKey, redisCached);
      return redisCached;
    }
  }

  const session = getSessionForTable(betfairId);
  const providerList = ['nice444', 'startexch'];

  for (const provKey of providerList) {
    const provider = PROVIDERS[provKey];
    if (!provider || !providerManager.isAvailable(provKey)) continue;

    try {
      const result = await providerManager.schedule(provKey, betfairId, async () => {
        const token = await getAuthToken(provKey);
        const res = await proxyFetch(`${provider.base}/api/exchange/streaming/exchEventsWatchLink`, {
          method: 'POST',
          session,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': provider.base,
            'Referer': `${provider.base}/`,
            'User-Agent': UA
          },
          body: JSON.stringify({ streamId: betfairId, timestamp: Date.now() }),
          timeout: 7000
        });

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
            expiresAt: Date.now() + (ttlSec * 1000)
          };

          await redisClient.set(cacheKey, sportsData, ttlSec);
          sportsWatchLinkCache.set(cacheKey, sportsData);
          console.log(`[SportsEngine] Acquired sports watch link from ${provider.name} for ${betfairId} (Session #${session}): ${data.data.url}`);
          return sportsData;
        }

        if (res.status === 429) {
          providerManager.tripCooldown(provKey, 30000, 'HTTP 429 on sports watch link');
        }
        throw new Error(data?.meta?.message || `No stream URL in ${provider.name} response`);
      });

      if (result && result.url) {
        return result;
      }
    } catch (err) {
      console.warn(`[SportsEngine] Watchlink error on ${provider.name} for ${betfairId}:`, err.message);
    }
  }

  throw new Error(`No live TV coverage currently available for sports event ${rawEventId}`);
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
      #status {
        display: none !important; /* Replaced by sleek YouTube-style spinner */
      }
      /* YouTube-style buffer / loading spinner */
      .yt-loader-container {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        pointer-events: none;
        transition: opacity 0.4s ease, visibility 0.4s ease;
      }
      .yt-spinner-ring {
        width: 54px;
        height: 54px;
        border: 4px solid rgba(255, 255, 255, 0.15);
        border-top: 4px solid #ef4444; /* YouTube red */
        border-right: 4px solid rgba(239, 68, 68, 0.5);
        border-radius: 50%;
        animation: yt-spin 0.75s linear infinite;
        box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);
      }
      @keyframes yt-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .yt-connecting-text {
        margin-top: 14px;
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.5px;
        background: rgba(15, 23, 42, 0.85);
        padding: 5px 14px;
        border-radius: 8px;
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }
    </style>
  `;
  html = html.replace('</head>', `${sportsStyle}</head>`);

  // Extract and tune cfg JSON specifically for Sports
  const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
  if (cfgMatch) {
    try {
      const originalCfg = JSON.parse(cfgMatch[1]);
      
      const fullPingUrl = originalCfg.pingUrl.startsWith('http')
        ? originalCfg.pingUrl
        : new URL(originalCfg.pingUrl, watchUrl).href;

      const proxiedPingUrl = `/api/stream/sports/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=${encodeURIComponent(eventId)}&origin=${encodeURIComponent(providerOrigin || 'https://nice444.com')}&session=${encodeURIComponent(session || '')}`;

      const modifiedCfg = {
        ...originalCfg,
        pingUrl: proxiedPingUrl,
        flagUrl: "/api/stream/sports/dummy-flag",
        byeUrl: "/api/stream/sports/dummy-bye",
        devtoolsGuard: false,
        devtoolsRedirect: "",
        blockedUrl: "",
        home: "",
        startMode: "hls", // Satellite TV feeds use HLS (starts playing in 1-2s directly!)
        forceHls: true,   // Bypasses 20s WebRTC timeout and perpetual loading spinner
        webrtcTimeout: 5,
        freezeSeconds: 120, // Prevents false freeze reloads
        offlineRetry: 3,
        frameAllow: {
          enforce: false,
          outer: { apps: false, hosts: [], sites: [] },
          parent: { apps: false, hosts: [], sites: [] }
        }
      };

      html = html.replace(
        /<script type="application\/json" id="cfg">[^<]+<\/script>/,
        `<script type="application/json" id="cfg">${JSON.stringify(modifiedCfg)}</script>`
      );
    } catch (e) {
      console.error('[SportsEngine] Error transforming sports cfg:', e.message);
    }
  }

  // Rewrite script source to instant local RAM asset
  const ts = Date.now();
  html = html.replace(
    /src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g,
    `src="/api/stream/sports/player-assets/sports-player.js?v=${ts}"`
  );

  // Insert YouTube spinner DOM element
  const spinnerDom = `
    <div id="yt-spinner" class="yt-loader-container">
      <div class="yt-spinner-ring"></div>
      <div class="yt-connecting-text">Connecting to Live Feed...</div>
    </div>
  `;
  if (html.includes('<body')) {
    html = html.replace(/<body[^>]*>/, `$&${spinnerDom}`);
  } else {
    html = `${spinnerDom}${html}`;
  }

  // Client runtime patch
  const clientPatch = `
    <script>
      (function() {
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

        // YouTube Spinner Controller
        var spinner = document.getElementById('yt-spinner');
        var textEl = spinner ? spinner.querySelector('.yt-connecting-text') : null;
        var video = document.getElementById('video') || document.querySelector('video');

        function hideSpinner() {
          if (spinner && spinner.style.display !== 'none') {
            spinner.style.opacity = '0';
            spinner.style.visibility = 'hidden';
            setTimeout(function() { if (spinner) spinner.style.display = 'none'; }, 400);
          }
        }

        function showSpinner(msg) {
          if (spinner) {
            if (msg && textEl) textEl.textContent = msg;
            spinner.style.display = 'flex';
            spinner.style.visibility = 'visible';
            setTimeout(function() { if (spinner) spinner.style.opacity = '1'; }, 10);
          }
        }

        if (video) {
          video.addEventListener('playing', hideSpinner);
          video.addEventListener('canplay', hideSpinner);
          video.addEventListener('timeupdate', function() {
            if (video.currentTime > 0) hideSpinner();
          });
          video.addEventListener('waiting', function() { showSpinner('Buffering...'); });
        }

        // Auto-hide fallback after video starts receiving frames
        var checkVideoPlaying = setInterval(function() {
          if (video && (video.currentTime > 0 || video.readyState >= 3)) {
            hideSpinner();
            clearInterval(checkVideoPlaying);
          }
        }, 300);
      })();
    </script>
  `;
  html = html.replace('</body>', `${clientPatch}</body>`);

  return html;
}

// 5. Friendly Unavailable Screen for matches without active TV feeds
function renderNoTvHtml(matchName = '') {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Live TV Feed Unavailable</title>
      <style>
        body {
          margin: 0;
          background: #07090e;
          color: #94a3b8;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          text-align: center;
          padding: 20px;
          box-sizing: border-box;
        }
        .icon-box {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.05);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 26px;
          margin-bottom: 16px;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        h2 {
          font-size: 16px;
          font-weight: 600;
          color: #f1f5f9;
          margin: 0 0 8px;
        }
        p {
          font-size: 13px;
          color: #64748b;
          margin: 0 0 16px;
          max-width: 320px;
          line-height: 1.4;
        }
        .match-badge {
          display: inline-block;
          font-size: 11px;
          color: #38bdf8;
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.2);
          padding: 4px 10px;
          border-radius: 9999px;
          margin-bottom: 12px;
          max-width: 280px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .reload-btn {
          background: #1e293b;
          color: #e2e8f0;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          padding: 8px 18px;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        .reload-btn:hover {
          background: #334155;
          color: #fff;
        }
      </style>
    </head>
    <body>
      <div class="icon-box">📡</div>
      ${matchName ? `<div class="match-badge">${matchName}</div>` : ''}
      <h2>Live TV Feed Not Available</h2>
      <p>This match does not have an active live satellite TV broadcast from the provider right now, or the match has concluded.</p>
      <button class="reload-btn" onclick="window.location.reload()">Check Feed Again</button>
    </body>
    </html>
  `;
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// 1. Telemetry sinks
router.all('/dummy-flag', (req, res) => res.status(200).json({ ok: true }));
router.all('/dummy-bye', (req, res) => res.status(200).json({ ok: true }));

// 2. High-speed local sports player script (Serves in 0ms directly from RAM)
router.get('/player-assets/sports-player.js', (req, res) => {
  try {
    const script = getPatchedSportsPlayerJs();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(script);
  } catch (err) {
    console.error('[SportsEngine] Error serving sports player script:', err.message);
    res.status(500).send('/* Error loading sports player script */');
  }
});

// 3. Live Sports Events List (Cricket, Football, Tennis) - 60s Cache & In-Flight Deduplication
router.get('/events', async (req, res) => {
  // Check RAM Cache (60s TTL)
  if (sportsEventsCache.data && Date.now() < sportsEventsCache.expiresAt) {
    return res.json({ success: true, count: sportsEventsCache.data.length, events: sportsEventsCache.data });
  }

  // Deduplicate in-flight upstream fetches across all concurrent clients
  if (inFlightSportsEvents) {
    try {
      const data = await inFlightSportsEvents;
      return res.json({ success: true, count: data?.length || 0, events: data || [] });
    } catch (_) {}
  }

  inFlightSportsEvents = (async () => {
    // Check Redis distributed cache
    try {
      const redisEvents = await redisClient.get('sports:events_list');
      if (redisEvents && Array.isArray(redisEvents) && redisEvents.length > 0) {
        sportsEventsCache.data = redisEvents;
        sportsEventsCache.expiresAt = Date.now() + 60000;
        return redisEvents;
      }
    } catch (_) {}

    const providerList = ['nice444', 'startexch', 'asstarplay'];
    const sportNames = { '1': 'Soccer', '2': 'Tennis', '4': 'Cricket', '7': 'Horse Racing' };

    for (const provKey of providerList) {
      try {
        const provider = PROVIDERS[provKey];
        const token = await getAuthToken(provKey);
        const upstreamRes = await proxyFetch(`${provider.base}/api/exchange/market/matchodds/allEventsList`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json', 
            'Authorization': `Bearer ${token}`,
            'Origin': provider.base,
            'Referer': `${provider.base}/`,
            'User-Agent': UA
          },
          body: JSON.stringify({}),
          timeout: 7000
        });

        const d = await upstreamRes.json();
        const result = [];

        if (d?.data) {
          for (const [sId, list] of Object.entries(d.data)) {
            if (Array.isArray(list)) {
              for (const ev of list) {
                const isInPlay = Boolean(ev?.oddsData?.inPlay ?? ev?.inPlay ?? false);
                const isStreaming = Boolean(ev?.isStreaming ?? false);
                result.push({
                  id: String(ev.exEventId || ev._id || ''),
                  name: ev.eventName || 'Unnamed Match',
                  sportId: String(sId),
                  sportName: sportNames[sId] || 'Other Sport',
                  tournament: ev.tournamentName || '',
                  inPlay: isInPlay,
                  isStreaming: isStreaming,
                  eventTime: ev.eventTime || '',
                  tv: true
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
          await redisClient.set('sports:events_list', result, 60).catch(() => {});
          return result;
        }
      } catch (err) {
        console.warn(`[SportsEngine] Failed to fetch events from ${provKey}:`, err.message);
      }
    }
    return sportsEventsCache.data || [];
  })();

  try {
    const data = await inFlightSportsEvents;
    return res.json({ success: true, count: data?.length || 0, events: data || [] });
  } finally {
    inFlightSportsEvents = null;
  }
});

// 4. Dedicated Sports TV Player Iframe
router.get('/player/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const sportId = req.query.sportId || '4';

  // Master Security Whitelist Guard
  const access = await securityEngine.verifyAccess(req, 'sports');
  if (!access.allowed) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(403).send(securityEngine.renderUnauthorizedScreen(access.domain, 'Sports', access.reason, access.heading));
  }

  const cacheKey = `sports_player_${eventId}`;

  // 1. Check local RAM cache (serves in 0ms)
  const cached = sportsPlayerCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt && cached.html && !cached.html.includes('Live TV Feed Not Available')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    return res.send(cached.html);
  }

  // 2. Check distributed Redis cache
  const redisHtml = await redisClient.get(`html:sports:${eventId}`);
  if (redisHtml && typeof redisHtml === 'string' && redisHtml.includes('cfg')) {
    sportsPlayerCache.set(cacheKey, { html: redisHtml, expiresAt: Date.now() + SPORTS_HTML_TTL });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    return res.send(redisHtml);
  }

  // 3. In-flight single-flight deduplication
  if (inFlightSportsPlayers.has(eventId)) {
    try {
      const html = await inFlightSportsPlayers.get(eventId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Permissions-Policy', 'unload=*');
      return res.send(html);
    } catch (_) {}
  }

  const task = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[SportsEngine] Fetching sports player for match ${eventId} (attempt ${attempt})`);
        
        // Use forceFresh on attempt 2
        const watchData = await getSportsWatchUrl(eventId, sportId, attempt > 1);
        const watchUrl = watchData.url;
        const referer = watchData.origin ? `${watchData.origin}/` : 'https://nice444.com/';
        const session = watchData.session || getSessionForTable(eventId);

        const pageRes = await proxyFetch(watchUrl, {
          session,
          headers: {
            'User-Agent': UA,
            'Referer': referer,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 8000
        });

        if (pageRes.status === 403 || pageRes.status === 404 || !pageRes.ok) {
          console.warn(`[SportsEngine] Upstream watchUrl returned status ${pageRes.status} on session #${session}. Rotating session...`);
          rotateTableSession(eventId, `WatchUrl HTTP ${pageRes.status}`);
          // Clear cached watchlink so attempt 2 generates a fresh one
          sportsWatchLinkCache.delete(`sports_watchlink:${watchData.streamId || eventId}`);
          await redisClient.del(`sports_watchlink:${watchData.streamId || eventId}`).catch(() => {});
          
          if (attempt === 1) {
            await new Promise(r => setTimeout(r, 400));
            continue;
          }
          return renderNoTvHtml();
        }

        const rawHtml = await pageRes.text();
        if (rawHtml.includes('Stream unavailable') || rawHtml.includes('Access blocked')) {
          console.warn(`[SportsEngine] Upstream indicated stream unavailable or blocked`);
          if (attempt === 1) {
            rotateTableSession(eventId, 'Stream unavailable');
            continue;
          }
          return renderNoTvHtml();
        }

        const transformedHtml = transformSportsHtml(rawHtml, watchUrl, eventId, watchData.origin, session);

        // Fast pre-warm initial sports ping token so it is ready in RAM when player loads
        const cfgMatch = transformedHtml.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
        if (cfgMatch) {
          try {
            const cfg = JSON.parse(cfgMatch[1]);
            const targetUrl = cfg.pingUrl.includes('target=') 
              ? decodeURIComponent(new URL(cfg.pingUrl, 'http://localhost').searchParams.get('target'))
              : cfg.pingUrl;
            if (targetUrl) {
              const pingPromise = proxyFetch(targetUrl, {
                method: 'POST',
                session,
                headers: { 
                  'Content-Type': 'application/json', 
                  'Origin': new URL(targetUrl).origin,
                  'Referer': watchUrl,
                  'User-Agent': UA,
                  'Accept': '*/*',
                  'Sec-Fetch-Dest': 'empty',
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'same-origin'
                },
                body: JSON.stringify({ 
                  sid: cfg.sid, 
                  mode: 'connecting', 
                  init: true, 
                  page: watchData.origin || 'https://nice444.com',
                  tz: 'Asia/Kolkata', 
                  tzo: 330 
                }),
                timeout: 2500
              }).then(r => r.json()).then(data => {
                if (data && typeof data === 'object') {
                  if (data.stop) data.stop = false;
                  if (data.hlsUrl) {
                    data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
                  }
                  sportsPingCache.set(targetUrl, { data, timestamp: Date.now() });
                }
                return data;
              }).catch(() => null);

              // Race with max 1000ms so we don't delay HTML delivery
              await Promise.race([pingPromise, new Promise(r => setTimeout(r, 1000))]);
            }
          } catch (_) {}
        }

        // Cache player HTML for 45s in RAM and Redis
        sportsPlayerCache.set(cacheKey, { html: transformedHtml, expiresAt: Date.now() + SPORTS_HTML_TTL });
        await redisClient.set(`html:sports:${eventId}`, transformedHtml, Math.round(SPORTS_HTML_TTL / 1000));
        return transformedHtml;
      } catch (err) {
        const isNoTv = err.message && (err.message.includes('No live TV') || err.message.includes('Stream not found'));
        if (isNoTv) {
          console.log(`[SportsEngine] Match ${eventId} has no active satellite broadcast feed upstream.`);
          return renderNoTvHtml();
        }

        console.error(`[SportsEngine Error] Attempt ${attempt} for ${eventId}:`, err.message);
        if (attempt === 1) {
          rotateTableSession(eventId, 'Exception retry');
          await new Promise(r => setTimeout(r, 400));
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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    return res.send(finalHtml);
  } finally {
    inFlightSportsPlayers.delete(eventId);
  }
});

// 5. Dedicated Sports Proxy-Ping
router.post('/proxy-ping', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const { target, watchUrl, origin, eventId } = req.query;
  const isInit = Boolean(req.body && req.body.init);

  if (!target) {
    return res.status(400).json({ error: 'Missing target parameter' });
  }

  const targetUrl = decodeURIComponent(target);
  const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
  const targetOrigin = new URL(targetUrl).origin;
  const pageOrigin = origin ? decodeURIComponent(origin) : 'https://nice444.com/';
  const session = req.query.session ? parseInt(req.query.session, 10) : getSessionForTable(eventId || targetUrl);

  // Serve fast cached ping from RAM for BOTH init and routine heartbeats (Zero proxy quota!)
  if (sportsPingCache.has(targetUrl)) {
    const cachedPing = sportsPingCache.get(targetUrl);
    if (cachedPing && cachedPing.data && (Date.now() - cachedPing.timestamp < 180000) && cachedPing.data.token) {
      return res.status(200).json(cachedPing.data);
    }
  }

  try {
    const payload = {
      ...req.body,
      page: pageOrigin,
      tz: req.body?.tz || 'Asia/Kolkata',
      tzo: req.body?.tzo !== undefined ? req.body.tzo : 330
    };

    const upstreamRes = await proxyFetch(targetUrl, {
      method: 'POST',
      session,
      headers: {
        'Content-Type': 'application/json',
        'Origin': targetOrigin,
        'Referer': decodedWatchUrl,
        'User-Agent': UA,
        'Accept': '*/*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      },
      body: JSON.stringify(payload),
      timeout: 8000
    });

    const data = await upstreamRes.json().catch(() => null);

    if (data && typeof data === 'object') {
      if (data.stop) data.stop = false;

      // Rewrite HLS URL if present to dedicated sports HLS proxy with clean relative URL (zero mixed content HTTP/HTTPS block)
      if (data.hlsUrl) {
        data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
      }

      if (isInit && data.token) {
        sportsPingCache.set(targetUrl, { data, timestamp: Date.now() });
      }

      return res.status(200).json(data);
    }

    return res.status(upstreamRes.status || 500).json({ error: 'Invalid response from sports ping upstream' });
  } catch (err) {
    console.error('[SportsEngine] Proxy ping error:', err.message);
    res.status(500).json({ error: 'Proxy ping failed', details: err.message });
  }
});

// 6. Sports Dedicated HLS Playlist Proxy (Zero-Proxy Direct First)
router.get('/hls/live.m3u8', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url param');
    const upstreamUrl = decodeURIComponent(url);

    let text = '';
    // 1. Direct fetch first from VPS (Zero proxy bandwidth!)
    try {
      const directRes = await directFetch(upstreamUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://tv.ltve.live/' },
        timeout: 6000
      });
      if (directRes.ok) {
        text = await directRes.text();
      }
    } catch (_) {}

    // 2. Fallback to proxy only if direct fails
    if (!text) {
      const m3u8Res = await proxyFetch(upstreamUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://tv.ltve.live/' },
        timeout: 8000
      });
      text = await m3u8Res.text();
    }

    const rewritten = text.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed.endsWith('.m3u8') || trimmed.includes('.m3u8?')) {
        const fullVariantUrl = new URL(trimmed, upstreamUrl).href;
        return `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(fullVariantUrl)}`;
      }
      if (trimmed.endsWith('.ts') || trimmed.includes('.ts?')) {
        const fullSegUrl = new URL(trimmed, upstreamUrl).href;
        return `/api/stream/sports/hls/chunk.ts?url=${encodeURIComponent(fullSegUrl)}`;
      }
      return line;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(rewritten);
  } catch (err) {
    console.error('[SportsEngine] HLS Playlist Proxy Error:', err.message);
    res.status(500).send('Error proxying sports HLS playlist');
  }
});

// 7. Sports Dedicated HLS Video Chunk Proxy (Zero-Proxy Direct Pipe: 0 MB Proxy Quota)
router.get('/hls/chunk.ts', (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url param');
    const targetUrl = decodeURIComponent(url);

    const u = new URL(targetUrl);
    const client = u.protocol === 'https:' ? https : http;

    const chunkReq = client.get(targetUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://tv.ltve.live/' },
      timeout: 15000,
      rejectUnauthorized: false
    }, (chunkRes) => {
      if (chunkRes.statusCode >= 300 && chunkRes.statusCode < 400 && chunkRes.headers.location) {
        return res.redirect(chunkRes.headers.location);
      }
      res.setHeader('Content-Type', chunkRes.headers['content-type'] || 'video/mp2t');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      chunkRes.pipe(res);
    });

    chunkReq.on('error', (err) => {
      console.warn('[HLS Chunk Direct Warning]:', err.message);
      if (!res.headersSent) res.status(502).send('Error fetching video chunk');
    });

    chunkReq.on('timeout', () => {
      chunkReq.destroy();
      if (!res.headersSent) res.status(504).send('Chunk request timed out');
    });
  } catch (err) {
    console.error('[SportsEngine] HLS Chunk Error:', err.message);
    if (!res.headersSent) res.status(500).send('Error processing sports video chunk');
  }
});

// Pre-load the script into RAM immediately
try {
  getPatchedSportsPlayerJs();
} catch (e) {
  console.warn('[SportsEngine] Pre-load warning:', e.message);
}

module.exports = router;
