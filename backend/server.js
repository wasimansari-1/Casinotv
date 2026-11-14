const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

// Auto-load .env file if present
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
    console.log('[Env] Loaded environment variables from .env');
  } catch (e) {
    console.warn('[Env] Could not load .env file:', e.message);
  }
}

// Support Outbound Proxy for VPS deployment (Residential / SOCKS5 / HTTP Proxy)
const proxyUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);
    console.log(`[Proxy] Upstream proxy active: ${proxyUrl.replace(/:\/\/.*@/, '://***:***@')}`);
  } catch (err) {
    console.error(`[Proxy] Failed to initialize ProxyAgent:`, err.message);
  }
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
app.use(express.static(staticPath));

// Fallback route for SPA
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
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
