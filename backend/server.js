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
const streamProxy = require('./streamProxy');

const app = express();
const PORT = process.env.PORT || 5050;

// Enable CORS for all domains
app.use(cors());
app.use(express.json());

// Mount the stream proxy engine
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`🚀 Casino TV Stream Proxy Server is LIVE!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📺 React + Tailwind Dashboard: http://localhost:${PORT}`);
  console.log(`🎯 API Tables List: http://localhost:${PORT}/api/stream/tables`);
  console.log(`=================================================`);
});
