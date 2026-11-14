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

// Memory cache for modified player HTML (TTL 25s) to eliminate redundant roundtrips
const playerCache = new Map();

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
function transformPlayerHtml(html, watchUrl, isSports = false) {
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

      // Construct proxied ping URL that routes through our backend
      const proxiedPingUrl = `/api/stream/proxy-ping?target=${encodeURIComponent(fullPingUrl)}&watchUrl=${encodeURIComponent(watchUrl)}`;
      
      const modifiedCfg = {
        ...originalCfg,
        pingUrl: proxiedPingUrl,
        flagUrl: "/api/stream/dummy-flag",
        byeUrl: "/api/stream/dummy-bye",
        devtoolsGuard: false,
        devtoolsRedirect: "",
        blockedUrl: "",
        home: "", // Neutralize home domain validation
        webrtcTimeout: 20,
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
  html = html.replace('</head>', `${runtimePatch}</head>`);
  return html;
}

// 4. Transparent Casino TV Iframe Player (Full Proxy & Bypass Engine)
router.get('/player/:eventId', async (req, res) => {
  const { eventId } = req.params;

  // Check cache first
  const cached = playerCache.get(`casino_${eventId}`);
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Permissions-Policy', 'unload=*');
    return res.send(cached.html);
  }
  
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[Casino Player] Fetching player for ${eventId} (attempt ${attempt})`);
      
      const watchData = await getWatchUrl(eventId);
      const watchUrl = typeof watchData === 'string' ? watchData : watchData.url;
      const referer = watchData.origin ? `${watchData.origin}/` : 'https://casino.nice444.com/';

      const pageRes = await proxyFetch(watchUrl, {
        headers: {
          'User-Agent': UA,
          'Referer': referer
        }
      });

      if (!pageRes.ok) {
        console.warn(`[Casino Player] Upstream returned status ${pageRes.status} for ${eventId}`);
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        return res.status(pageRes.status).send(`Upstream stream service returned ${pageRes.status}`);
      }

      let html = await pageRes.text();
      html = transformPlayerHtml(html, watchUrl, false);

      // Cache player HTML for 25 seconds
      playerCache.set(`casino_${eventId}`, { html, expiresAt: Date.now() + 25000 });

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
      console.error(`[Casino Player Error] Attempt ${attempt}:`, err.message);
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      return res.status(500).send(`Stream Proxy Error: ${err.message}`);
    }
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
      html = transformPlayerHtml(html, watchUrl, true);

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
      console.error(`[Sports Player Error] Attempt ${attempt}:`, err.message);
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 400));
        continue;
      }
      return res.status(500).send(`Sports TV Error: ${err.message}`);
    }
  }
});

// 6. Casino Static Assets Proxy (/api/stream/player-assets/player.js)
router.get('/player-assets/player.js', async (req, res) => {
  try {
    const upstreamAssetUrl = `https://live.livecdnplatin.com/player/player.js`;
    
    const upstreamRes = await proxyFetch(upstreamAssetUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://live.livecdnplatin.com/'
      }
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).send('Asset not found');
    }

    let contentType = upstreamRes.headers.get('content-type') || 'application/javascript';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let text = await upstreamRes.text();
    
    // Patch out domain checks & devtools detector
    text = text.replace(/function L\(\)\{/g, 'function L(){return!1;');
    text = text.replace(/function S\(\)\{/g, 'function S(){return!1;');
    text = text.replace(/function I\(\)\{/g, 'function I(){return!1;');
    text = text.replace(/t\.devtoolsGuard/g, 'false');
    text = text.replace(/devtoolsGuard:!0/g, 'devtoolsGuard:!1');

    // Neutralize session killer ("The dealer has closed your session")
    text = text.replace(/403===a\.status/g, 'false');
    text = text.replace(/this\.end\(\)/g, '(function(){console.warn("[Session Protected]");return false;})()');
    text = text.replace(/g\.say\(a,!0\)/g, '(function(){console.warn("[Session Suppressed]");return false;})()');

    return res.send(text);
  } catch (err) {
    console.error('[Asset Proxy Error]:', err.message);
    res.status(500).send('Error proxying asset');
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
  try {
    const { target, watchUrl } = req.query;
    if (!target) {
      return res.status(400).json({ error: 'Missing target ping URL' });
    }

    const targetUrl = decodeURIComponent(target);
    const decodedWatchUrl = watchUrl ? decodeURIComponent(watchUrl) : targetUrl;
    const targetOrigin = new URL(targetUrl).origin;

    const payload = {
      ...req.body,
      page: targetOrigin.includes('ltve') ? 'https://nice444.com/' : 'https://nice444.com/'
    };

    const upstreamRes = await proxyFetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': targetOrigin,
        'Referer': decodedWatchUrl,
        'User-Agent': UA
      },
      body: JSON.stringify(payload)
    });

    let data;
    try {
      data = await upstreamRes.json();
    } catch (e) {
      data = { ok: true, state: "live" };
    }

    // Suppress upstream stop/kill directives so player never shows "The dealer has closed your session"
    if (upstreamRes.status === 403 || data?.stop === true || !data?.ok) {
      console.warn('[Proxy Ping] Upstream returned session termination, suppressing and returning active state');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ ok: true, state: "live" });
    }

    if (data && typeof data === 'object' && data.hlsUrl) {
      data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
    }
    if (data && typeof data === 'object' && data.hlsUrl) {
      data.hlsUrl = `/api/stream/sports/hls/live.m3u8?url=${encodeURIComponent(data.hlsUrl)}`;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[Ping Proxy Error]:', err.message);
    res.status(500).json({ error: err.message });
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
