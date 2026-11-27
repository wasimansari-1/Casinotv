const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

// Auto-load .env file if present (Universal parser compatible with all Node versions)
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  try {
    const envRaw = fs.readFileSync(envPath, 'utf8');
    envRaw.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        val = val.replace(/^['"](.*)['"]$/, '$1');
        process.env[key] = val;
      }
    });
    console.log('[Env] Successfully loaded environment variables from .env');
  } catch (e) {
    console.warn('[Env] Could not load .env file:', e.message);
  }
}

// Check Outbound Proxy for VPS deployment (Residential / SOCKS5 / HTTP Proxy)
const proxyUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  console.log(`[Proxy] Upstream proxy configured: ${proxyUrl.replace(/:\/\/.*@/, '://***:***@')}`);
  setTimeout(() => {
    try {
      const { proxyFetch } = require('./streamCore');
      proxyFetch('https://ipinfo.io/json', { timeout: 8000 })
        .then(r => r.json())
        .then(info => {
          console.log(`[Proxy Geo Verified] Outbound IP: ${info.ip}, Country: ${info.country}, Region: ${info.region}, City: ${info.city}, ISP: ${info.org}`);
        })
        .catch(err => {
          console.warn(`[Proxy Geo Alert] Verification request:`, err.message);
        });
    } catch (_) {}
  }, 100);
} else {
  console.log(`[Proxy] No UPSTREAM_PROXY_URL configured. Running on direct host IP.`);
}

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const securityEngine = require('./securityEngine');
const streamProxy = require('./streamProxy');
const sportsStreamEngine = require('./sportsStreamEngine');

const app = express();
const PORT = process.env.PORT || 5050;

// Enable CORS for all domains
app.use(cors());
app.use(express.json());

// Mount the Master Security & Whitelist Engine (/master dashboard & /api/master/*)
app.use(securityEngine.router);

// Mount the dedicated sports stream engine first (Completely isolated from Casino TV)
app.use('/api/stream/sports', sportsStreamEngine);

// Mount the stream proxy engine (Casino TV logic remains 100% untouched)
app.use('/api/stream', streamProxy);

// Serve frontend assets (React build if available, else public fallback)
const distPath = path.join(__dirname, '../frontend/dist');
const publicPath = path.join(__dirname, '../public');
const staticPath = fs.existsSync(distPath) ? distPath : publicPath;

console.log(`[Static] Serving frontend from: ${staticPath}`);
app.use(express.static(staticPath, {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Fallback route for SPA
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(staticPath, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Global Error]:', err.stack);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// Zero-Latency WebSocket Tunnel Proxy (Bypasses Upstream Origin 403 Forbidden Locks)
function handleWebSocketProxy(clientReq, clientSocket, clientHead) {
  try {
    const reqUrl = new URL(clientReq.url, 'http://localhost');
    const rawTarget = reqUrl.searchParams.get('upstream') || reqUrl.searchParams.get('target');
    let targetWsUrl = rawTarget ? decodeURIComponent(rawTarget) : 'wss://livecdnplatin.com/UNIVERSE-GE/websocket';

    // Normalize targetWsUrl: Handle relative paths and protocol-less URLs safely
    targetWsUrl = String(targetWsUrl).trim();
    if (targetWsUrl === 'edge' || targetWsUrl.startsWith('edge/') || targetWsUrl.startsWith('/edge/')) {
      targetWsUrl = 'wss://livecdnplatin.com/UNIVERSE-GE/websocket';
    } else if (targetWsUrl.startsWith('//')) {
      targetWsUrl = 'wss:' + targetWsUrl;
    } else if (targetWsUrl.startsWith('/')) {
      targetWsUrl = 'wss://livecdnplatin.com' + targetWsUrl;
    } else if (!targetWsUrl.startsWith('ws://') && !targetWsUrl.startsWith('wss://')) {
      targetWsUrl = 'wss://' + targetWsUrl;
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetWsUrl);
      if (!parsedTarget.hostname.includes('.') || parsedTarget.hostname === 'edge') {
        parsedTarget = new URL('wss://livecdnplatin.com/UNIVERSE-GE/websocket');
      }
    } catch (_) {
      parsedTarget = new URL('wss://livecdnplatin.com/UNIVERSE-GE/websocket');
    }

    const isSecure = parsedTarget.protocol === 'wss:' || parsedTarget.protocol === 'https:';
    const port = parsedTarget.port || (isSecure ? 443 : 80);
    const client = isSecure ? https : http;

    // Spoof origin so upstream never rejects client connection
    let spoofedOrigin = 'https://live.livecdnplatin.com';
    if (parsedTarget.hostname.includes('ltve.live')) {
      spoofedOrigin = 'https://tv.ltve.live';
    } else if (parsedTarget.hostname.includes('livecdnplatin.com')) {
      spoofedOrigin = 'https://live.livecdnplatin.com';
    }

    const wsHeaders = {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': clientReq.headers['sec-websocket-version'] || '13',
      'Sec-WebSocket-Key': clientReq.headers['sec-websocket-key'],
      'Origin': spoofedOrigin,
      'User-Agent': clientReq.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };
    if (clientReq.headers['sec-websocket-protocol']) {
      wsHeaders['Sec-WebSocket-Protocol'] = clientReq.headers['sec-websocket-protocol'];
    }

    const upstreamReq = client.request({
      hostname: parsedTarget.hostname,
      port: port,
      path: parsedTarget.pathname + parsedTarget.search,
      method: 'GET',
      headers: wsHeaders,
      timeout: 15000,
      rejectUnauthorized: false,
      servername: parsedTarget.hostname
    });

    upstreamReq.on('response', (res) => {
      console.warn(`[WS Tunnel Upstream Rejection]: Status ${res.statusCode} ${res.statusMessage} from ${parsedTarget.hostname}`);
      clientSocket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\nConnection: close\r\n\r\n`);
      clientSocket.destroy();
    });

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      // Clear HTTP request timeouts once upgraded to persistent WebSocket tunnel
      upstreamReq.setTimeout(0);
      upstreamSocket.setTimeout(0);
      clientSocket.setTimeout(0);
      clientSocket.setNoDelay(true);
      upstreamSocket.setNoDelay(true);
      clientSocket.setKeepAlive(true, 30000);
      upstreamSocket.setKeepAlive(true, 30000);

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${upstreamRes.headers['sec-websocket-accept']}`
      ];
      if (upstreamRes.headers['sec-websocket-protocol']) {
        headers.push(`Sec-WebSocket-Protocol: ${upstreamRes.headers['sec-websocket-protocol']}`);
      }
      clientSocket.write(headers.join('\r\n') + '\r\n\r\n');

      if (upstreamHead && upstreamHead.length > 0) clientSocket.write(upstreamHead);
      if (clientHead && clientHead.length > 0) upstreamSocket.write(clientHead);

      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);

      clientSocket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => clientSocket.destroy());
    });

    upstreamReq.on('error', (err) => {
      if (err.message && !err.message.includes('ECONNRESET')) {
        console.warn('[WS Tunnel Notice]:', err.message);
      }
      clientSocket.destroy();
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      clientSocket.destroy();
    });

    upstreamReq.end();
  } catch (err) {
    console.error('[WS Proxy Error]:', err.message);
    clientSocket.destroy();
  }
}

const server = http.createServer(app);

// Handle WebSocket upgrade requests with Master Guard Whitelist Enforcement
server.on('upgrade', (req, socket, head) => {
  if (req.url && (req.url.startsWith('/api/stream/ws') || req.url.startsWith('/ws'))) {
    if (!securityEngine.verifyWebSocketAccess(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    handleWebSocketProxy(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`🚀 Casino TV Stream Proxy Server is LIVE!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📺 React + Tailwind Dashboard: http://localhost:${PORT}`);
  console.log(`🎯 API Tables List: http://localhost:${PORT}/api/stream/tables`);
  console.log(`🔌 WebRTC WebSocket Tunnel: http://localhost:${PORT}/api/stream/ws`);
  console.log(`=================================================`);
});
