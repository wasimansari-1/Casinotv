const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const https = require('https');
const express = require('express');
const cors = require('cors');
const { 
  getAuthToken, 
  getWatchUrl, 
  getSportsWatchUrl, 
  getLiveSportsEvents, 
  GAME_MAP, 
  PROVIDERS, 
  UA,
  proxyFetch
} = require('./streamCore');

const router = express.Router();

// High-speed persistent HTTP agent & chunk cache for zero-drop HLS proxying
const hlsAgent = new https.Agent({ keepAlive: true, maxSockets: 35, timeout: 15000 });
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
      const headRes = await fetch(targetUrl, { method: 'HEAD', headers: { 'User-Agent': UA } });
      const totalLength = parseInt(headRes.headers.get('content-length') || '0', 10);
      
      if (!totalLength) {
        const r = await fetch(targetUrl, { headers: { 'User-Agent': UA } });
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
        promises.push(new Promise((resolve, reject) => {
          const u = new URL(targetUrl);
          const req = https.request({
            hostname: u.hostname,
            port: 443,
            path: u.pathname + u.search,
            method: 'GET',
            agent: hlsAgent,
            headers: {
              'User-Agent': UA,
              'Range': `bytes=${start}-${end}`,
              'Connection': 'keep-alive'
            }
          }, res => {
            const bufs = [];
            res.on('data', c => bufs.push(c));
            res.on('end', () => resolve(Buffer.concat(bufs)));
          });
          req.on('error', reject);
          req.end();
        }));
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

// Memory cache for modified player HTML (TTL 30 Minutes) to eliminate redundant roundtrips & serve 1cr users from RAM
const CASINO_CACHE_TTL = 30 * 60 * 1000;
const playerCache = new Map();
const inFlightPlayers = new Map();
const pingCache = new Map();

// Helper: Pre-warm a single casino table in memory
async function warmCasinoTable(eventId) {
  try {
    const watchData = await getWatchUrl(eventId);
    const watchUrl = typeof watchData === 'string' ? watchData : watchData.url;
    const referer = watchData.origin ? (watchData.origin.endsWith('/') ? watchData.origin : `${watchData.origin}/`) : 'https://nice444.com/';

    const pageRes = await proxyFetch(watchUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site'
      }
    });

    if (pageRes.ok) {
      let html = await pageRes.text();
      html = transformPlayerHtml(html, watchUrl, false, eventId);
      playerCache.set(`casino_${eventId}`, { html, expiresAt: Date.now() + CASINO_CACHE_TTL });
      console.log(`[Stream Warmer] Pre-warmed & cached table ${eventId} in memory`);

      // Pre-warm ping handshake for instant 0ms start
      const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
      if (cfgMatch) {
        try {
          const cfg = JSON.parse(cfgMatch[1]);
          const targetUrl = cfg.pingUrl.includes('target=') 
            ? decodeURIComponent(new URL(cfg.pingUrl, 'http://localhost').searchParams.get('target'))
            : cfg.pingUrl;
          if (targetUrl) {
            proxyFetch(targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
              body: JSON.stringify({ sid: cfg.sid, mode: 'connecting', init: true, tz: 'Asia/Kolkata', tzo: 330 })
            }).then(r => r.json()).then(data => {
              if (data && data.wsUrl && data.streamId) {
                pingCache.set(targetUrl, { data, timestamp: Date.now() });
                console.log(`[Stream Warmer] Pre-warmed ping handshake for table ${eventId} (${data.streamId})`);
              }
            }).catch(() => {});
          }
        } catch (_) {}
      }

      return true;
    }
  } catch (err) {
    console.warn(`[Stream Warmer] Notice for table ${eventId}:`, err.message);
  }
  return false;
}

let _isWarming = false;
async function warmAllCasinoTables() {
  if (_isWarming) return;
  _isWarming = true;
  try {
    const tableIds = Object.keys(GAME_MAP);
    for (const id of tableIds) {
      const cached = playerCache.get(`casino_${id}`);
      if (!cached || Date.now() > (cached.expiresAt - 120000)) {
        await warmCasinoTable(id);
        // Stagger by 1200ms to eliminate Nice444 rate limits & proxy drops
        await new Promise(r => setTimeout(r, 1200));
      }
    }
  } finally {
    _isWarming = false;
  }
}

// Start warmer 4s after boot, recurring every 12 minutes
setTimeout(() => {
  warmAllCasinoTables().catch(() => {});
  setInterval(() => {
    warmAllCasinoTables().catch(() => {});
  }, 12 * 60 * 1000);
}, 4000);

// 1. Get all supported Casino tables
router.get('/tables', (req, res) => {
  const list = Object.entries(GAME_MAP).map(([id, meta]) => ({
    id,
    name: meta.name,
    streamId: meta.streamId,
    category: meta.category,
    playerUrl: `/api/stream/player/${id}`
  }));
  res.json({ success: true, count: list.length, tables: list });
});

// 2. Dummy flag and telemetry sinks (Neutralizes anti-devtools & session killer calls)
router.all('/dummy-flag', (req, res) => res.status(200).json({ ok: true }));
router.all('/dummy-bye', (req, res) => res.status(200).json({ ok: true }));

// 3. Get all active Sports Events (Cricket, Soccer, Tennis)
router.get('/sports/events', async (req, res) => {
  try {
    const events = await getLiveSportsEvents();
    res.json({ success: true, count: events.length, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, events: [] });
  }
});

// Helper: Transform upstream player HTML with full bypass patches & watermark removal
function transformPlayerHtml(html, watchUrl, isSports = false, eventId = '') {
  // 1. Completely remove watermark elements and foreign domain strings
  html = html.replace(/<div id="wm">[\s\S]*?<\/div>/gi, '');
  html = html.replace(/#wm\{[^}]*\}/gi, '#wm{display:none!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;height:0!important;width:0!important;}');
  html = html.replace(/www\.nice444\.com/gi, '');
  html = html.replace(/nice444\.com/gi, '');
  html = html.replace(/startexch99\.com/gi, '');
  html = html.replace(/asstarplay\.com/gi, '');
  html = html.replace(/cbtfexchange\.com/gi, '');

  // Universal style injection to ensure watermark and foreign domains are 100% hidden
  const cleanWatermarkStyle = `
    <style>
      #wm, [id="wm"], .watermark, #watermark {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        height: 0 !important;
        width: 0 !important;
      }
    </style>
  `;
  html = html.replace('</head>', `${cleanWatermarkStyle}</head>`);

  // 2. Extract and modify the embedded JSON config
  const cfgMatch = html.match(/<script type="application\/json" id="cfg">([^<]+)<\/script>/);
  if (cfgMatch) {
    try {
      const originalCfg = JSON.parse(cfgMatch[1]);
      
      // Resolve ping URL (whether absolute or relative)
      const fullPingUrl = originalCfg.pingUrl.startsWith('http')
        ? originalCfg.pingUrl
        : new URL(originalCfg.pingUrl, watchUrl).href;

      // Construct proxied ping URL that routes through our backend with eventId context
      const proxiedPingUrl = `/api/stream/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}&eventId=${encodeURIComponent(eventId)}`;
      
      const modifiedCfg = {
        ...originalCfg,
        streamId: (eventId && GAME_MAP[eventId]) ? GAME_MAP[eventId].streamId : (originalCfg.streamId || 'GAME30'),
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
          parent: { apps: false, hosts: [], sites: [] }
        }
      };

      html = html.replace(
        /<script type="application\/json" id="cfg">[^<]+<\/script>/,
        `<script type="application/json" id="cfg">${JSON.stringify(modifiedCfg)}</script>`
      );
    } catch (e) {
      console.error('[Transform] Error modifying cfg JSON:', e);
    }
  }

  // 3. Rewrite static asset paths with specific script matching
  const ts = Date.now();
  if (isSports) {
    html = html.replace(/src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g, `src="/api/stream/player-assets/sports-player.js?ts=${ts}"`);
  } else {
    html = html.replace(/href=["']\/player\/loader\.gif[^"']*["']/g, 'href="/api/stream/player-assets/loader.gif"');
    html = html.replace(/src=["'](?:https?:\/\/[^/]+)?\/player\/player\.js[^"']*["']/g, `src="/api/stream/player-assets/player.js?ts=${ts}"`);
    html = html.replace(/background:\s*url\(['"]?\/player\/loader\.gif[^'"]*['"]?\)/g, 'background:url("/api/stream/player-assets/loader.gif")');
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
  const spinnerCss = `
    <style>
      .loading {
        position: absolute !important;
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%) !important;
        z-index: 15 !important;
        width: 56px !important;
        height: 56px !important;
        border: 4px solid rgba(255, 255, 255, 0.12) !important;
        border-top-color: #d4228a !important;
        border-radius: 50% !important;
        animation: streamSpinner 0.8s linear infinite !important;
        background: transparent !important;
        pointer-events: none !important;
      }
      .loading.fade-out {
        opacity: 0 !important;
        transition: opacity 0.5s ease-out !important;
      }
      @keyframes streamSpinner {
        to { transform: translate(-50%, -50%) rotate(360deg); }
      }
    </style>
  `;
  html = html.replace('</head>', `${runtimePatch}${spinnerCss}</head>`);
  return html;
}

// 4. Transparent Casino TV Iframe Player (Full Proxy & Bypass Engine)
router.get('/player/:eventId', async (req, res) => {
  const { eventId } = req.params;

  // Check cache first (serves 1cr users directly from RAM in 1ms)
  const cached = playerCache.get(`casino_${eventId}`);
  if (cached && Date.now() < cached.expiresAt) {
    if (Date.now() > (cached.expiresAt - 60000)) {
      warmCasinoTable(eventId).catch(() => {});
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    return res.send(cached.html);
  }

  // Deduplicate in-flight requests for the same table
  if (inFlightPlayers.has(eventId)) {
    try {
      const html = await inFlightPlayers.get(eventId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Permissions-Policy', 'unload=*');
      return res.send(html);
    } catch (_) {}
  }

  const fetchTask = (async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[Casino Player] Fetching player for ${eventId} (attempt ${attempt})`);
        
        const watchData = await getWatchUrl(eventId);
        const watchUrl = typeof watchData === 'string' ? watchData : watchData.url;
        const referer = watchData.origin ? (watchData.origin.endsWith('/') ? watchData.origin : `${watchData.origin}/`) : 'https://nice444.com/';

        const pageRes = await proxyFetch(watchUrl, {
          headers: {
            'User-Agent': UA,
            'Referer': referer,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site'
          }
        });

        if (!pageRes.ok) {
          console.warn(`[Casino Player] Upstream returned status ${pageRes.status} for ${eventId}`);
          if (attempt === 1) {
            await new Promise(r => setTimeout(r, 400));
            continue;
          }
          throw new Error(`Upstream stream service returned ${pageRes.status}`);
        }

        let html = await pageRes.text();
        html = transformPlayerHtml(html, watchUrl, false, eventId);

        // Cache player HTML for 6 minutes (serves millions of users directly from RAM in 1ms)
        playerCache.set(`casino_${eventId}`, { html, expiresAt: Date.now() + CASINO_CACHE_TTL });
        return html;
      } catch (err) {
        console.error(`[Casino Player Error] Attempt ${attempt}:`, err.message);
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        throw err;
      }
    }
  })();

  inFlightPlayers.set(eventId, fetchTask);
  try {
    const html = await fetchTask;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    return res.send(html);
  } catch (err) {
    // Resilient fallback: If upstream failed, serve previously cached HTML if available
    const stale = playerCache.get(`casino_${eventId}`);
    if (stale && stale.html) {
      console.log(`[Casino Player] Serving stale cache fallback for table ${eventId}`);
      stale.expiresAt = Date.now() + 120000;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Permissions-Policy', 'unload=*');
      return res.send(stale.html);
    }
    return res.status(500).send(`Stream Proxy Error: ${err.message}`);
  } finally {
    inFlightPlayers.delete(eventId);
  }
});

// 5. Transparent Sports TV Iframe Player (Cricket, Soccer, Tennis Live Streams)
router.get('/sports/player/:eventId', async (req, res) => {
  const { eventId } = req.params;
  const sportId = req.query.sportId || '4';

  const cacheKey = `sports_${eventId}`;
  const cached = playerCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    return res.send(cached.html);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[Sports Player] Fetching sports stream for match ${eventId} (attempt ${attempt})`);
      
      const watchData = await getSportsWatchUrl(eventId, sportId);
      const watchUrl = watchData.url;
      const referer = watchData.origin ? `${watchData.origin}/` : 'https://nice444.com/';

      const pageRes = await proxyFetch(watchUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': referer
        }
      });

      if (!pageRes.ok) {
        console.warn(`[Sports Player] Upstream returned status ${pageRes.status} for ${eventId}`);
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        return res.status(pageRes.status).send(`Sports stream service returned ${pageRes.status}`);
      }

      let html = await pageRes.text();
      html = transformPlayerHtml(html, watchUrl, true, eventId);

      // Cache player HTML for 25 seconds
      playerCache.set(cacheKey, { html, expiresAt: Date.now() + 25000 });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Permissions-Policy', 'unload=*');
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');

      return res.send(html);
    } catch (err) {
      const isNoTv = err.message && err.message.includes('No live TV coverage');
      if (isNoTv) {
        console.log(`[Sports Player] Notice for match ${eventId}: No TV broadcast feed currently available upstream`);
      } else {
        console.error(`[Sports Player Error] Attempt ${attempt}:`, err.message);
      }

      if (attempt === 1 && !isNoTv) {
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Permissions-Policy', 'unload=*');
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');

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

const fs = require('fs');
const path = require('path');

let _cachedPatchedPlayerJs = null;
function getPatchedPlayerJs() {
  if (_cachedPatchedPlayerJs) return _cachedPatchedPlayerJs;
  const filePath = path.join(__dirname, 'player.js');
  let text = fs.readFileSync(filePath, 'utf8');

  // Patch out domain checks & devtools detector
  text = text.replace(/function L\(\)\{/g, 'function L(){return!1;');
  text = text.replace(/function S\(\)\{/g, 'function S(){return!1;');
  text = text.replace(/function I\(\)\{/g, 'function I(){return!1;');
  text = text.replace(/function w\(e\)\{/g, 'function w(e){return;');
  text = text.replace(/t\.devtoolsGuard/g, 'false');
  text = text.replace(/devtoolsGuard:!0/g, 'devtoolsGuard:!1');

  // 1. Neutralize Network Lost screen blur
  text = text.replace(/showNetworkLostEffects\(\)\{/g, 'showNetworkLostEffects(){return;');

  // 2. Infinite retry on table startup instead of giving up after 5 tries
  text = text.replace(
    /for\(let t=0;t<5&&!p\.ready&&!p\.ended;t\+\+\)t&&await new Promise\(e=>setTimeout\(e,3e3\)\),await p\.ping\(!0\);/g,
    'for(let t=0;!p.ready&&!p.ended;t++){if(t>0)await new Promise(e=>setTimeout(e,2000));try{await p.ping(!0)}catch(e){}}'
  );

  // 3. Neutralize 'The table didn\'t open. Please refresh the page.' (variable l) and premature black screen
  text = text.replace(/if\(!p\.ready\)throw new Error\(l\);/g, 'if(!p.ready){p.ready=!0;if(!p.streamId)p.streamId=(t&&t.streamId)||"GAME30";if(!p.wsUrl)p.wsUrl="wss://livecdnplatin.com/UNIVERSE-GE/websocket";}');
  text = text.replace(/g\.say\(l,!0\)/g, '(function(){console.warn("[Auto-Retrying Stream]");return false;})()');
  text = text.replace(/if\(p\.ended\)return;g\.hideLoading\(\);/g, 'if(p.ended)return;');

  // 4. Neutralize session killer ("The dealer has closed your session")
  text = text.replace(/403===a\.status/g, 'false');
  text = text.replace(/g\.say\(a,!0\)/g, '(function(){console.warn("[Session Suppressed]");return false;})()');

  // 5. Neutralize visibility killswitch
  text = text.replace(/"visibilitychange"/g, '"disabled_visibility"');

  // 6. Neutralize aggressive 5-second freeze detector (eliminates stutter, buffering, and loops)
  text = text.replace(/e\.reconnect\("frozen"\)/g, '(function(){console.warn("[Stream Jitter Handled]");})()');

  // 7. Guaranteed mobile autoplay (muted + playsinline before play())
  text = text.replace(
    /tryPlay\(\)\{const e=this\.video\.play\(\);/g,
    'tryPlay(){this.video.muted=!0;this.video.defaultMuted=!0;this.video.playsInline=!0;this.video.setAttribute("playsinline","");this.video.setAttribute("webkit-playsinline","");const e=this.video.play();'
  );

  _cachedPatchedPlayerJs = text;
  return text;
}

// 6. Casino Static Assets Proxy (/api/stream/player-assets/player.js)
router.get('/player-assets/player.js', (req, res) => {
  try {
    const text = getPatchedPlayerJs();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(text);
  } catch (err) {
    console.error('[Asset Proxy Error]:', err.message);
    res.status(500).send('Error loading player script');
  }
});

// 7. Sports Static Assets Proxy (/api/stream/player-assets/sports-player.js)
router.get('/player-assets/sports-player.js', async (req, res) => {
  try {
    const upstreamAssetUrl = `https://tv.ltve.live/player/player.js`;
    
    const upstreamRes = await proxyFetch(upstreamAssetUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://tv.ltve.live/'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Sports player asset error');
    }

    let contentType = upstreamRes.headers.get('content-type') || 'application/javascript';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let text = await upstreamRes.text();
    
    // Disable devtools killswitch
    text = text.replace(/function wp\(e\)\{/g, 'function wp(e){return;');
    text = text.replace(/Q\.devtoolsGuard/g, 'false');
    text = text.replace(/devtoolsGuard:!0/g, 'devtoolsGuard:!1');
    text = text.replace(/devtoolsGuard/g, 'false');

    // Supercharge WebRTC connection timeout to 20s
    text = text.replace(/Q\.webrtcTimeout\*1e3/g, '20000');

    // Deep HLS buffer (60s instead of 20s) so HLS matches never buffer or stutter
    text = text.replace(/maxBufferLength:20/g, 'maxBufferLength:60,maxMaxBufferLength:120,fragLoadingTimeOut:30000,fragLoadingMaxRetry:10');

    return res.send(text);
  } catch (err) {
    console.error('[Sports Asset Error]:', err.message);
    res.status(500).send('Error proxying sports asset');
  }
});

// 8. Other player static assets (loader.gif, etc.)
router.get('/player-assets/:asset', async (req, res) => {
  try {
    const { asset } = req.params;
    if (asset === 'loader.gif') {
      const gifPath = path.join(__dirname, 'loader.gif');
      if (fs.existsSync(gifPath)) {
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.sendFile(gifPath);
      }
    }

    const upstreamAssetUrl = `https://live.livecdnplatin.com/player/${asset}`;
    
    const upstreamRes = await proxyFetch(upstreamAssetUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://live.livecdnplatin.com/'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Asset not found');
    }

    let contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    res.status(500).send('Error proxying asset');
  }
});

// 9. Upstream Ping Proxy (/api/stream/proxy-ping)
router.post('/proxy-ping', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  try {
    const { target, watchUrl } = req.query;
    if (!target) {
      return res.status(200).json({ ok: true, state: "live" });
    }

    const targetUrl = decodeURIComponent(target);
    const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
    const targetOrigin = new URL(targetUrl).origin;
    const isInit = Boolean(req.body?.init);
    const eventId = req.query.eventId || '';
    const fallbackStreamId = (eventId && GAME_MAP[eventId]) ? GAME_MAP[eventId].streamId : '';
    const fallbackWsUrl = 'wss://livecdnplatin.com/UNIVERSE-GE/websocket';

    // Instant RAM delivery for init pings (eliminates 1.5-3s loader wait time!)
    if (isInit && pingCache.has(targetUrl)) {
      const cachedPing = pingCache.get(targetUrl);
      if (cachedPing && (Date.now() - cachedPing.timestamp < 180000)) {
        return res.status(200).json(cachedPing.data);
      }
    }

    const payload = {
      ...req.body,
      page: decodedWatchUrl,
      tz: req.body?.tz || 'Asia/Kolkata',
      tzo: req.body?.tzo !== undefined ? req.body.tzo : 330
    };

    const upstreamRes = await proxyFetch(targetUrl, {
      method: 'POST',
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
      body: JSON.stringify(payload)
    });

    if (upstreamRes.status === 403) {
      console.warn(`[Proxy Ping] Upstream ping 403 on session. Rotating proxy immediately...`);
      const { rotateStickySession } = require('./streamCore');
      rotateStickySession('ping 403', true);
    }

    let data;
    try {
      data = await upstreamRes.json();
    } catch (e) {
      data = { ok: true, state: "live" };
    }

    // Suppress upstream session termination or false maintenance stops
    if (data && typeof data === 'object') {
      if (data.stop) data.stop = false;
      if (data.hlsUrl) {
        data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
      }
      if (isInit) {
        if (!data.streamId && fallbackStreamId) data.streamId = fallbackStreamId;
        if (!data.wsUrl) data.wsUrl = fallbackWsUrl;
        if (data.wsUrl && data.streamId) {
          pingCache.set(targetUrl, { data, timestamp: Date.now() });
        }
      }
    }

    // Always return HTTP 200 so the client player never aborts the stream
    const finalStatus = (upstreamRes.status >= 200 && upstreamRes.status < 300) ? upstreamRes.status : 200;
    return res.status(finalStatus).json(data || { ok: true, state: "live", streamId: fallbackStreamId || "GAME30", wsUrl: fallbackWsUrl });
  } catch (err) {
    const { target, eventId } = req.query;
    const fallbackStreamId = (eventId && GAME_MAP[eventId]) ? GAME_MAP[eventId].streamId : '';
    const fallbackWsUrl = 'wss://livecdnplatin.com/UNIVERSE-GE/websocket';
    if (target) {
      const targetUrl = decodeURIComponent(target);
      const cachedPing = pingCache.get(targetUrl);
      if (cachedPing && cachedPing.data) {
        return res.status(200).json(cachedPing.data);
      }
    }
    // Ultra-resilient ping fallback: ALWAYS supply streamId & wsUrl so player.ready is true!
    return res.status(200).json({ 
      ok: true, 
      state: "live", 
      streamId: fallbackStreamId || "GAME30", 
      wsUrl: fallbackWsUrl, 
      maintenance: null, 
      stop: false 
    });
  }
});

// 10. Sports HLS Playlist Proxy
router.get('/sports/hls/live.m3u8', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url param');
    const upstreamUrl = decodeURIComponent(url);

    const m3u8Res = await fetch(upstreamUrl, {
      headers: { 'User-Agent': UA }
    });
    if (!m3u8Res.ok) return res.status(m3u8Res.status).send('M3U8 upstream error');

    const text = await m3u8Res.text();
    const rewritten = text.split('\n').map(line => {
      const trimmed = line.trim();
      if (trimmed.endsWith('.ts') || trimmed.includes('.ts?')) {
        const fullSegUrl = new URL(trimmed, upstreamUrl).href;
        return `/api/stream/sports/hls/chunk.ts?url=${encodeURIComponent(fullSegUrl)}`;
      }
      return line;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(rewritten);
  } catch (err) {
    console.error('[HLS Playlist Error]:', err.message);
    res.status(500).send('Error proxying HLS playlist');
  }
});

// 11. Sports HLS Chunk Proxy (Zero-Drop Parallel Assembler)
router.get('/sports/hls/chunk.ts', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url param');
    const targetUrl = decodeURIComponent(url);

    const buf = await fetchFullTsSegment(targetUrl);
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : buf.length - 1;
      const chunk = buf.slice(start, end + 1);

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunk.length);
      res.setHeader('Content-Type', 'video/MP2T');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(chunk);
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buf);
  } catch (err) {
    console.error('[HLS Chunk Error]:', err.message);
    res.status(500).send('Error fetching HLS chunk');
  }
});

module.exports = router;
