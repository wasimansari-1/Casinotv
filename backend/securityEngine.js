/**
 * CSTV Master Security Engine
 * Professional Anti-Theft Domain & IP Whitelisting, Access Control, and Real-Time Audit Monitoring
 * Dedicated & Isolated Module
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { redisClient } = require('./streamCore');

// Admin Credentials
const ADMIN_ID = 'Igwasim';
const ADMIN_PASS = 'Asdf123#';
const JWT_SECRET = 'cstv_master_secret_key_889922_guard';

// Default Pre-Seeded Whitelist Entries
const DEFAULT_DOMAINS = [
  { domain: 'chimneysolutions.info', casino: true, sports: true, status: 'active', note: 'Primary Domain' },
  { domain: 'cstv.chimneysolutions.info', casino: true, sports: true, status: 'active', note: 'Streaming Subdomain' },
  { domain: '72.61.172.110', casino: true, sports: true, status: 'active', note: 'VPS Host IP' },
  { domain: 'localhost', casino: true, sports: true, status: 'active', note: 'Local Testing' },
  { domain: '127.0.0.1', casino: true, sports: true, status: 'active', note: 'Loopback IP' },
  { domain: 'aura.igambli.com', casino: true, sports: true, status: 'active', note: 'Client: Aura Igambli' }
];

// In-Memory Fallback Cache (Synchronously seeded, then updated with Redis)
const whitelistMap = new Map();
for (const item of DEFAULT_DOMAINS) {
  whitelistMap.set(item.domain.toLowerCase(), {
    ...item,
    hitCount: 0,
    lastAccess: null,
    createdAt: new Date().toISOString()
  });
}

const auditLogs = [];
let enforceWhitelist = true;
let allowDirectAccess = true; // Allows testing directly via browser address bar / curl if true

// Initialize Whitelist from Redis or Defaults
async function initWhitelist() {
  try {
    const rawSettings = await redisClient.get('cstv:security:settings');
    if (rawSettings) {
      const parsed = typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings;
      if (parsed.enforceWhitelist !== undefined) enforceWhitelist = Boolean(parsed.enforceWhitelist);
      if (parsed.allowDirectAccess !== undefined) allowDirectAccess = Boolean(parsed.allowDirectAccess);
    }

    const redisDomains = await redisClient.get('cstv:security:domains');
    if (redisDomains) {
      const list = typeof redisDomains === 'string' ? JSON.parse(redisDomains) : redisDomains;
      if (Array.isArray(list) && list.length > 0) {
        for (const item of list) {
          whitelistMap.set(item.domain.toLowerCase(), item);
        }
        console.log(`[SecurityEngine] Loaded ${whitelistMap.size} whitelisted domains from Redis`);
        return;
      }
    }

    await syncToRedis();
    console.log(`[SecurityEngine] Seeded ${whitelistMap.size} default whitelisted domains in Redis`);
  } catch (err) {
    console.warn('[SecurityEngine] Initialization warning:', err.message);
  }
}

// Synchronize Whitelist to Redis
async function syncToRedis() {
  try {
    const list = Array.from(whitelistMap.values());
    await redisClient.set('cstv:security:domains', JSON.stringify(list), 3600 * 24 * 30);
    await redisClient.set('cstv:security:settings', JSON.stringify({ enforceWhitelist, allowDirectAccess }), 3600 * 24 * 30);
  } catch (e) {
    console.warn('[SecurityEngine] Redis sync error:', e.message);
  }
}

// Record Audit / Attempt Log
function logAttempt(domain, ip, type, streamId, action, reason) {
  const entry = {
    id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    timestamp: new Date().toISOString(),
    domain: domain || 'Direct / Unknown',
    ip: ip || 'Unknown IP',
    type: type || 'stream',
    streamId: streamId || '-',
    action, // 'ALLOWED' or 'BLOCKED'
    reason: reason || ''
  };

  auditLogs.unshift(entry);
  if (auditLogs.length > 200) auditLogs.pop();

  // Async Redis store
  redisClient.get('cstv:security:logs').then(res => {
    let list = [];
    if (res) {
      try { list = typeof res === 'string' ? JSON.parse(res) : res; } catch (_) {}
    }
    if (!Array.isArray(list)) list = [];
    list.unshift(entry);
    if (list.length > 200) list = list.slice(0, 200);
    return redisClient.set('cstv:security:logs', JSON.stringify(list), 3600 * 24 * 7);
  }).catch(() => {});
}

// Clean & Normalize Domain from Header / Referer
function extractDomain(req) {
  const referer = req.headers.referer || req.headers.referrer;
  const origin = req.headers.origin;
  const rawTarget = referer || origin || req.query.domain || req.query.ref;

  if (rawTarget && typeof rawTarget === 'string') {
    try {
      let hostname = rawTarget.trim();
      if (hostname.includes('://')) {
        hostname = new URL(hostname).hostname;
      } else {
        hostname = hostname.split('/')[0].split(':')[0];
      }
      return hostname.toLowerCase().trim();
    } catch (_) {}
  }

  // If no referer/origin, check query or client IP
  if (req.query.origin) {
    return String(req.query.origin).replace(/^https?:\/\//, '').split('/')[0].split(':')[0].toLowerCase();
  }

  return '';
}

// Match Domain with Wildcard support (*.example.com)
function findMatchedEntry(domain) {
  if (!domain) return null;
  const clean = domain.toLowerCase().trim();

  // 1. Exact match
  if (whitelistMap.has(clean)) {
    return whitelistMap.get(clean);
  }

  // 2. Wildcard & subdomain match (e.g. *.igambli.com or igambli.com matches aura.igambli.com)
  for (const [key, entry] of whitelistMap.entries()) {
    if (key.startsWith('*.')) {
      const root = key.slice(2);
      if (clean === root || clean.endsWith('.' + root)) {
        return entry;
      }
    }
    if (clean.endsWith('.' + key)) {
      return entry;
    }
  }

  return null;
}

// -------------------------------------------------------------
// CORE ACCESS VERIFICATION METHOD (Zero Regression for Streams)
// -------------------------------------------------------------
async function verifyAccess(req, streamType = 'casino') {
  if (!enforceWhitelist) {
    return { allowed: true, domain: 'whitelist_disabled' };
  }

  const domain = extractDomain(req);
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || req.ip;
  const streamId = req.params.eventId || req.query.streamId || '';

  // Direct Address Bar Visit (Empty Referer & Origin)
  if (!domain) {
    if (allowDirectAccess) {
      logAttempt('Direct Browser Access', clientIp, streamType, streamId, 'ALLOWED', 'Direct testing permitted');
      return { allowed: true, domain: 'direct_visit' };
    }
    logAttempt('Direct / No-Referer', clientIp, streamType, streamId, 'BLOCKED', 'Direct iframe embedding prohibited without Referer');
    return {
      allowed: false,
      domain: 'Direct Access',
      heading: 'Domain Not Whitelisted',
      reason: 'Direct access blocked. Stream must be embedded within an authorized whitelisted domain.'
    };
  }

  const matched = findMatchedEntry(domain);

  if (!matched) {
    logAttempt(domain, clientIp, streamType, streamId, 'BLOCKED', 'Domain not whitelisted');
    return {
      allowed: false,
      domain,
      heading: 'Domain Not Whitelisted',
      reason: `The domain "${domain}" is not whitelisted by the administrator. Stream embedding is restricted.`
    };
  }

  // Check if domain is blocked
  if (matched.status === 'blocked') {
    logAttempt(domain, clientIp, streamType, streamId, 'BLOCKED', 'Domain access blocked');
    return {
      allowed: false,
      domain,
      heading: 'Domain Access Blocked',
      reason: `Access for domain "${domain}" has been suspended by the administrator.`
    };
  }

  // Check specific permission (Casino vs Sports)
  if (streamType === 'casino' && !matched.casino) {
    logAttempt(domain, clientIp, 'casino', streamId, 'BLOCKED', 'Domain not whitelisted for Casino TV');
    return {
      allowed: false,
      domain,
      heading: 'Domain Not Whitelisted for Casino TV',
      reason: `Domain "${domain}" is whitelisted for Sports TV only. Casino TV access is disabled.`
    };
  }

  if (streamType === 'sports' && !matched.sports) {
    logAttempt(domain, clientIp, 'sports', streamId, 'BLOCKED', 'Domain not whitelisted for Sports TV');
    return {
      allowed: false,
      domain,
      heading: 'Domain Not Whitelisted for Sports TV',
      reason: `Domain "${domain}" is whitelisted for Casino TV only. Sports TV access is disabled.`
    };
  }

  // Access Granted! Update hits & last access timestamp
  matched.hitCount = (matched.hitCount || 0) + 1;
  matched.lastAccess = new Date().toISOString();
  logAttempt(domain, clientIp, streamType, streamId, 'ALLOWED', 'Access authorized');

  return { allowed: true, domain };
}

// -------------------------------------------------------------
// PROFESSIONAL ACCESS DENIED HTML SCREEN (No AI patterns, real icons)
// -------------------------------------------------------------
function renderUnauthorizedScreen(domain, streamType, reason, customHeading) {
  const heading = customHeading || `Domain Not Whitelisted for ${streamType} TV`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${heading} | CSTV Guard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #cbd5e1;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 32px 28px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, #ef4444, #f59e0b, #ef4444);
    }
    .icon-box {
      width: 64px;
      height: 64px;
      margin: 0 auto 20px;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ef4444;
    }
    .icon-box svg { width: 32px; height: 32px; }
    h1 {
      font-size: 18px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: -0.3px;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #ef4444;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 3px 10px;
      border-radius: 20px;
      margin-bottom: 16px;
    }
    .domain-pill {
      background: #1e293b;
      border: 1px solid #334155;
      padding: 10px 14px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      word-break: break-all;
      margin-bottom: 16px;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: #94a3b8;
      margin-bottom: 24px;
    }
    .footer-note {
      font-size: 11px;
      color: #475569;
      border-top: 1px solid #1e293b;
      padding-top: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .footer-note svg { width: 14px; height: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-box">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
    </div>
    <div class="badge">${streamType} TV Restricted</div>
    <h1>${String(heading).toUpperCase()}</h1>
    <div class="domain-pill">${domain || 'Unknown Domain'}</div>
    <p>${reason || 'This domain is not whitelisted by the stream administrator.'}</p>
    <div class="footer-note">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
      <span>Protected by CSTV Master Guard Engine</span>
    </div>
  </div>
</body>
</html>`;
}

// -------------------------------------------------------------
// AUTH TOKEN HELPER FOR /master ROUTE
// -------------------------------------------------------------
function generateToken(user) {
  const payload = `${user}:${Date.now()}:${JWT_SECRET}`;
  const hmac = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return Buffer.from(`${user}:${Date.now()}:${hmac}`).toString('base64');
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [user, ts, hmac] = decoded.split(':');
    if (user !== ADMIN_ID) return false;
    const elapsed = Date.now() - parseInt(ts, 10);
    if (elapsed > 24 * 3600 * 1000) return false; // 24 hours expiry
    const payload = `${user}:${ts}:${JWT_SECRET}`;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
    return hmac === expected;
  } catch (_) {
    return false;
  }
}

// Admin Auth Middleware
function requireMasterAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;
  if (!verifyToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or expired master token' });
  }
  next();
}

// -------------------------------------------------------------
// MASTER API ROUTES
// -------------------------------------------------------------

// 1. Admin Login
router.post('/api/master/login', (req, res) => {
  const { id, pass } = req.body;
  if (id === ADMIN_ID && pass === ADMIN_PASS) {
    const token = generateToken(id);
    return res.json({ success: true, token, user: ADMIN_ID });
  }
  return res.status(401).json({ success: false, error: 'Invalid ID or Password' });
});

// 2. Metrics & Status
router.get('/api/master/status', requireMasterAuth, (req, res) => {
  const list = Array.from(whitelistMap.values());
  const total = list.length;
  const active = list.filter(e => e.status === 'active').length;
  const blocked = list.filter(e => e.status === 'blocked').length;
  const casinoCount = list.filter(e => e.status === 'active' && e.casino).length;
  const sportsCount = list.filter(e => e.status === 'active' && e.sports).length;
  const totalHits = list.reduce((acc, e) => acc + (e.hitCount || 0), 0);
  const blockedAttempts = auditLogs.filter(l => l.action === 'BLOCKED').length;

  res.json({
    success: true,
    stats: {
      total,
      active,
      blocked,
      casinoCount,
      sportsCount,
      totalHits,
      blockedAttempts,
      enforceWhitelist,
      allowDirectAccess
    }
  });
});

// 3. Get Whitelisted Domains
router.get('/api/master/domains', requireMasterAuth, (req, res) => {
  const list = Array.from(whitelistMap.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, count: list.length, domains: list });
});

// 4. Add Whitelist Domain
router.post('/api/master/domains', requireMasterAuth, async (req, res) => {
  let { domain, casino, sports, note } = req.body;
  if (!domain) return res.status(400).json({ success: false, error: 'Domain is required' });

  let clean = domain.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

  const entry = {
    domain: clean,
    casino: casino !== undefined ? Boolean(casino) : true,
    sports: sports !== undefined ? Boolean(sports) : true,
    status: 'active',
    note: note || '',
    hitCount: 0,
    lastAccess: null,
    createdAt: new Date().toISOString()
  };

  whitelistMap.set(clean, entry);
  await syncToRedis();
  res.json({ success: true, domain: entry });
});

// 5. Update / Toggle Domain Permissions
router.patch('/api/master/domains/:domain', requireMasterAuth, async (req, res) => {
  const clean = req.params.domain.toLowerCase().trim();
  const entry = whitelistMap.get(clean);
  if (!entry) return res.status(404).json({ success: false, error: 'Domain not found' });

  if (req.body.casino !== undefined) entry.casino = Boolean(req.body.casino);
  if (req.body.sports !== undefined) entry.sports = Boolean(req.body.sports);
  if (req.body.status !== undefined) entry.status = req.body.status === 'blocked' ? 'blocked' : 'active';
  if (req.body.note !== undefined) entry.note = req.body.note;

  await syncToRedis();
  res.json({ success: true, domain: entry });
});

// 6. Delete Whitelist Domain
router.delete('/api/master/domains/:domain', requireMasterAuth, async (req, res) => {
  const clean = req.params.domain.toLowerCase().trim();
  const deleted = whitelistMap.delete(clean);
  await syncToRedis();
  res.json({ success: true, deleted });
});

// 7. Get Recent Security & Audit Logs
router.get('/api/master/logs', requireMasterAuth, (req, res) => {
  res.json({ success: true, count: auditLogs.length, logs: auditLogs });
});

// 8. Toggle Settings (Strict Enforce / Direct Access)
router.post('/api/master/settings', requireMasterAuth, async (req, res) => {
  if (req.body.enforceWhitelist !== undefined) enforceWhitelist = Boolean(req.body.enforceWhitelist);
  if (req.body.allowDirectAccess !== undefined) allowDirectAccess = Boolean(req.body.allowDirectAccess);
  await syncToRedis();
  res.json({ success: true, enforceWhitelist, allowDirectAccess });
});

// -------------------------------------------------------------
// SERVE THE MASTER ADMIN DASHBOARD HTML UI (/master)
// -------------------------------------------------------------
router.get('/master', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CSTV Master Guard | Domain Access Control</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #07090e; }
    .font-mono { font-family: 'JetBrains Mono', monospace; }
    .glass-card { background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); }
    .custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
    .custom-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    .custom-scroll::-webkit-scrollbar-track { background: #0f172a; }
  </style>
</head>
<body class="text-slate-200 min-h-screen flex flex-col antialiased">

  <!-- LOGIN MODAL (Visible if not authenticated) -->
  <div id="loginView" class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-md">
    <div class="glass-card w-full max-w-md p-8 rounded-2xl shadow-2xl relative border border-slate-800">
      <div class="flex items-center justify-center gap-3 mb-6">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-rose-600/30">
          <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
        </div>
        <div>
          <h1 class="text-xl font-bold text-white tracking-tight">CSTV Master Guard</h1>
          <p class="text-xs text-slate-400">Stream Security & Whitelist Center</p>
        </div>
      </div>

      <div id="loginError" class="hidden mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs text-center font-medium"></div>

      <form id="loginForm" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Master ID</label>
          <input type="text" id="adminId" required placeholder="Enter ID" class="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition">
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Password</label>
          <input type="password" id="adminPass" required placeholder="••••••••" class="w-full bg-slate-900/90 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition">
        </div>
        <button type="submit" class="w-full bg-gradient-to-r from-rose-600 to-indigo-600 hover:from-rose-500 hover:to-indigo-500 text-white font-semibold py-2.5 rounded-xl shadow-lg shadow-rose-600/25 transition-all text-sm mt-2 flex items-center justify-center gap-2">
          <span>Authenticate Session</span>
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
        </button>
      </form>
    </div>
  </div>

  <!-- DASHBOARD WRAPPER -->
  <div id="dashboardView" class="hidden flex-1 flex flex-col">
    <!-- Navbar -->
    <header class="border-b border-slate-800/80 bg-slate-950/60 sticky top-0 z-40 backdrop-blur-md">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-rose-600 flex items-center justify-center shadow-md shadow-rose-600/30">
            <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-base font-bold text-white tracking-tight">CSTV Master Guard</span>
              <span class="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ACTIVE
              </span>
            </div>
            <p class="text-[11px] text-slate-400">Strict Domain Whitelist & Anti-Theft Protection</p>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button id="refreshBtn" class="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition text-xs flex items-center gap-1.5 px-3">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            <span>Refresh</span>
          </button>
          <button id="logoutBtn" class="p-2 text-rose-400 hover:text-white bg-rose-500/10 hover:bg-rose-500 border border-rose-500/30 rounded-lg transition text-xs flex items-center gap-1.5 px-3">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
            <span>Exit</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Content Area -->
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 space-y-6 w-full">

      <!-- Metrics Row -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="glass-card p-4 rounded-xl border border-slate-800/80">
          <div class="flex items-center justify-between text-slate-400 mb-1">
            <span class="text-xs font-medium">Whitelisted Domains</span>
            <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
          </div>
          <div id="statTotalDomains" class="text-2xl font-bold text-white font-mono">0</div>
        </div>

        <div class="glass-card p-4 rounded-xl border border-slate-800/80">
          <div class="flex items-center justify-between text-slate-400 mb-1">
            <span class="text-xs font-medium">Casino TV Allowed</span>
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">CASINO</span>
          </div>
          <div id="statCasinoCount" class="text-2xl font-bold text-amber-300 font-mono">0</div>
        </div>

        <div class="glass-card p-4 rounded-xl border border-slate-800/80">
          <div class="flex items-center justify-between text-slate-400 mb-1">
            <span class="text-xs font-medium">Sports TV Allowed</span>
            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/30">SPORTS</span>
          </div>
          <div id="statSportsCount" class="text-2xl font-bold text-sky-300 font-mono">0</div>
        </div>

        <div class="glass-card p-4 rounded-xl border border-slate-800/80">
          <div class="flex items-center justify-between text-slate-400 mb-1">
            <span class="text-xs font-medium">Blocked Attacks Caught</span>
            <svg class="w-4 h-4 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
          </div>
          <div id="statBlockedHits" class="text-2xl font-bold text-rose-400 font-mono">0</div>
        </div>
      </div>

      <!-- Action & Filter Bar -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 glass-card p-4 rounded-xl border border-slate-800">
        <div class="flex items-center gap-3">
          <button id="openAddModalBtn" class="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs py-2.5 px-4 rounded-lg shadow-md shadow-emerald-600/20 flex items-center gap-2 transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            <span>+ Add Authorized Domain / IP</span>
          </button>

          <div class="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg">
            <span class="text-xs text-slate-400">Strict Enforcement:</span>
            <button id="toggleEnforceBtn" class="text-xs font-semibold px-2 py-0.5 rounded transition bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ON</button>
          </div>

          <div class="flex items-center gap-2 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg">
            <span class="text-xs text-slate-400">Direct Browser Test:</span>
            <button id="toggleDirectBtn" class="text-xs font-semibold px-2 py-0.5 rounded transition bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">ON</button>
          </div>
        </div>

        <div class="relative">
          <input type="text" id="domainSearch" placeholder="Filter domains..." class="w-full sm:w-64 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500">
        </div>
      </div>

      <!-- Whitelisted Domains Table -->
      <div class="glass-card rounded-xl border border-slate-800 overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-bold text-white uppercase tracking-wider">Authorized Whitelist Registry</h2>
            <span id="domainCountBadge" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">0</span>
          </div>
          <span class="text-xs text-slate-400">Only authorized domains can embed streams</span>
        </div>

        <div class="overflow-x-auto custom-scroll">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
              <tr>
                <th class="py-3 px-5">Domain / Hostname</th>
                <th class="py-3 px-4 text-center">Casino TV</th>
                <th class="py-3 px-4 text-center">Sports TV</th>
                <th class="py-3 px-4 text-center">Status</th>
                <th class="py-3 px-4 text-center">Total Requests</th>
                <th class="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody id="domainsTableBody" class="divide-y divide-slate-800/60">
              <tr>
                <td colspan="6" class="py-8 text-center text-slate-500">Loading whitelist registry...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Real-Time Access & Blocked Attempts Log -->
      <div class="glass-card rounded-xl border border-slate-800 overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-bold text-white uppercase tracking-wider">Live Security Access Logs</h2>
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
          </div>
          <span class="text-xs text-slate-400">Real-time attempt interception</span>
        </div>

        <div class="overflow-x-auto custom-scroll max-h-80">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800 sticky top-0">
              <tr>
                <th class="py-2.5 px-5">Timestamp</th>
                <th class="py-2.5 px-4">Feed Type</th>
                <th class="py-2.5 px-4">Origin Domain / Referer</th>
                <th class="py-2.5 px-4">Client IP</th>
                <th class="py-2.5 px-4 text-center">Verdict</th>
                <th class="py-2.5 px-5">Security Note</th>
              </tr>
            </thead>
            <tbody id="logsTableBody" class="divide-y divide-slate-800/60 font-mono">
              <tr>
                <td colspan="6" class="py-8 text-center text-slate-500 font-sans">Listening for real-time stream requests...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </main>
  </div>

  <!-- ADD DOMAIN MODAL -->
  <div id="addModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
    <div class="glass-card w-full max-w-md p-6 rounded-2xl border border-slate-700 shadow-2xl relative">
      <div class="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
        <h3 class="text-base font-bold text-white flex items-center gap-2">
          <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          <span>Whitelist New Domain / Partner</span>
        </h3>
        <button id="closeAddModalBtn" class="text-slate-400 hover:text-white text-lg">&times;</button>
      </div>

      <form id="addDomainForm" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-300 mb-1">Domain or Subdomain</label>
          <input type="text" id="newDomainInput" required placeholder="e.g. aura.igambli.com or *.igambli.com" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500">
          <p class="text-[11px] text-slate-500 mt-1">Wildcard format supported (*.domain.com)</p>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-300 mb-1">Partner Note / Label</label>
          <input type="text" id="newDomainNote" placeholder="e.g. Client Aura Production" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500">
        </div>

        <div class="pt-2">
          <label class="block text-xs font-semibold text-slate-300 mb-2">Stream Feed Authorization</label>
          <div class="grid grid-cols-2 gap-3">
            <label class="flex items-center gap-2 p-3 bg-slate-900/80 border border-slate-800 rounded-lg cursor-pointer hover:border-amber-500/50 transition">
              <input type="checkbox" id="allowCasinoCheckbox" checked class="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700">
              <div>
                <span class="text-xs font-bold text-amber-400 block">Casino TV</span>
                <span class="text-[10px] text-slate-400">All 17 live tables</span>
              </div>
            </label>

            <label class="flex items-center gap-2 p-3 bg-slate-900/80 border border-slate-800 rounded-lg cursor-pointer hover:border-sky-500/50 transition">
              <input type="checkbox" id="allowSportsCheckbox" checked class="w-4 h-4 rounded text-sky-500 focus:ring-sky-500 bg-slate-800 border-slate-700">
              <div>
                <span class="text-xs font-bold text-sky-400 block">Sports TV</span>
                <span class="text-[10px] text-slate-400">Cricket, Soccer, etc.</span>
              </div>
            </label>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-4">
          <button type="button" id="cancelAddBtn" class="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-900 rounded-lg border border-slate-800 transition">Cancel</button>
          <button type="submit" class="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-md shadow-emerald-600/30 transition flex items-center gap-1.5">
            <span>Authorize & Save</span>
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- SCRIPT LOGIC -->
  <script>
    let masterToken = localStorage.getItem('cstv_master_token') || '';
    let domainsCache = [];

    // Elements
    const loginView = document.getElementById('loginView');
    const dashboardView = document.getElementById('dashboardView');
    const loginForm = document.getElementById('loginForm');
    const loginError = document.getElementById('loginError');
    const logoutBtn = document.getElementById('logoutBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const addModal = document.getElementById('addModal');
    const openAddModalBtn = document.getElementById('openAddModalBtn');
    const closeAddModalBtn = document.getElementById('closeAddModalBtn');
    const cancelAddBtn = document.getElementById('cancelAddBtn');
    const addDomainForm = document.getElementById('addDomainForm');
    const toggleEnforceBtn = document.getElementById('toggleEnforceBtn');
    const toggleDirectBtn = document.getElementById('toggleDirectBtn');

    // Init Session
    if (masterToken) {
      loadDashboard();
    } else {
      loginView.classList.remove('hidden');
    }

    // Login Form Submit
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.classList.add('hidden');
      const id = document.getElementById('adminId').value;
      const pass = document.getElementById('adminPass').value;

      try {
        const res = await fetch('/api/master/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, pass })
        });
        const d = await res.json();
        if (d.success && d.token) {
          masterToken = d.token;
          localStorage.setItem('cstv_master_token', masterToken);
          loadDashboard();
        } else {
          loginError.textContent = d.error || 'Authentication failed';
          loginError.classList.remove('hidden');
        }
      } catch (err) {
        loginError.textContent = 'Network or server error';
        loginError.classList.remove('hidden');
      }
    });

    // Logout
    logoutBtn.addEventListener('click', () => {
      masterToken = '';
      localStorage.removeItem('cstv_master_token');
      dashboardView.classList.add('hidden');
      loginView.classList.remove('hidden');
    });

    // Refresh
    refreshBtn.addEventListener('click', () => {
      loadDashboard();
    });

    // Load Dashboard Data
    async function loadDashboard() {
      try {
        const headers = { 'Authorization': 'Bearer ' + masterToken };
        
        // Status & Stats
        const statusRes = await fetch('/api/master/status', { headers });
        if (statusRes.status === 401) {
          localStorage.removeItem('cstv_master_token');
          loginView.classList.remove('hidden');
          dashboardView.classList.add('hidden');
          return;
        }
        const statusData = await statusRes.json();

        loginView.classList.add('hidden');
        dashboardView.classList.remove('hidden');

        if (statusData.success) {
          const s = statusData.stats;
          document.getElementById('statTotalDomains').textContent = s.total;
          document.getElementById('statCasinoCount').textContent = s.casinoCount;
          document.getElementById('statSportsCount').textContent = s.sportsCount;
          document.getElementById('statBlockedHits').textContent = s.blockedAttempts;

          toggleEnforceBtn.textContent = s.enforceWhitelist ? 'ON' : 'OFF';
          toggleEnforceBtn.className = s.enforceWhitelist 
            ? 'text-xs font-semibold px-2 py-0.5 rounded transition bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            : 'text-xs font-semibold px-2 py-0.5 rounded transition bg-rose-500/20 text-rose-400 border border-rose-500/30';

          toggleDirectBtn.textContent = s.allowDirectAccess ? 'ON' : 'OFF';
          toggleDirectBtn.className = s.allowDirectAccess 
            ? 'text-xs font-semibold px-2 py-0.5 rounded transition bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            : 'text-xs font-semibold px-2 py-0.5 rounded transition bg-rose-500/20 text-rose-400 border border-rose-500/30';
        }

        // Domains
        const domainsRes = await fetch('/api/master/domains', { headers });
        const domainsData = await domainsRes.json();
        if (domainsData.success) {
          domainsCache = domainsData.domains;
          renderDomainsTable(domainsCache);
        }

        // Logs
        const logsRes = await fetch('/api/master/logs', { headers });
        const logsData = await logsRes.json();
        if (logsData.success) {
          renderLogsTable(logsData.logs);
        }

      } catch (err) {
        console.error('Error loading dashboard:', err);
      }
    }

    // Render Domains Table
    function renderDomainsTable(list) {
      const tbody = document.getElementById('domainsTableBody');
      document.getElementById('domainCountBadge').textContent = list.length;

      if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500">No whitelisted domains configured yet.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map(item => {
        const isBlocked = item.status === 'blocked';
        return \`
          <tr class="hover:bg-slate-900/60 transition">
            <td class="py-3.5 px-5">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
                </div>
                <div>
                  <div class="font-mono text-white text-xs font-semibold">\${item.domain}</div>
                  <div class="text-[11px] text-slate-400">\${item.note || 'Partner client'}</div>
                </div>
              </div>
            </td>

            <td class="py-3.5 px-4 text-center">
              <button onclick="togglePermission('\${item.domain}', 'casino', \${!item.casino})" class="px-2.5 py-1 rounded text-[10px] font-bold uppercase transition \${item.casino ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25' : 'bg-slate-800 text-slate-500 hover:text-slate-300'}">
                \${item.casino ? '✓ Authorized' : '✕ Disabled'}
              </button>
            </td>

            <td class="py-3.5 px-4 text-center">
              <button onclick="togglePermission('\${item.domain}', 'sports', \${!item.sports})" class="px-2.5 py-1 rounded text-[10px] font-bold uppercase transition \${item.sports ? 'bg-sky-500/15 text-sky-300 border border-sky-500/40 hover:bg-sky-500/25' : 'bg-slate-800 text-slate-500 hover:text-slate-300'}">
                \${item.sports ? '✓ Authorized' : '✕ Disabled'}
              </button>
            </td>

            <td class="py-3.5 px-4 text-center">
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase \${isBlocked ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'}">
                <span class="w-1.5 h-1.5 rounded-full \${isBlocked ? 'bg-rose-400' : 'bg-emerald-400'}"></span>
                \${isBlocked ? 'BLOCKED' : 'ACTIVE'}
              </span>
            </td>

            <td class="py-3.5 px-4 text-center font-mono text-slate-300">
              \${item.hitCount || 0}
            </td>

            <td class="py-3.5 px-5 text-right">
              <div class="flex items-center justify-end gap-2">
                <button onclick="toggleStatus('\${item.domain}', '\${isBlocked ? 'active' : 'blocked'}')" class="p-1.5 text-xs rounded hover:bg-slate-800 transition \${isBlocked ? 'text-emerald-400 hover:text-emerald-300' : 'text-amber-400 hover:text-amber-300'}" title="\${isBlocked ? 'Unblock domain' : 'Block domain'}">
                  \${isBlocked ? 'Unblock' : 'Block'}
                </button>
                <button onclick="deleteDomain('\${item.domain}')" class="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition" title="Delete from whitelist">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                </button>
              </div>
            </td>
          </tr>
        \`;
      }).join('');
    }

    // Render Logs Table
    function renderLogsTable(logs) {
      const tbody = document.getElementById('logsTableBody');
      if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans">No recent access events recorded.</td></tr>';
        return;
      }

      tbody.innerHTML = logs.slice(0, 100).map(l => {
        const isAllowed = l.action === 'ALLOWED';
        const dateStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return \`
          <tr class="hover:bg-slate-900/60 transition">
            <td class="py-2.5 px-5 text-slate-400 text-[11px] whitespace-nowrap">\${dateStr}</td>
            <td class="py-2.5 px-4 font-sans">
              <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase \${l.type === 'casino' ? 'bg-amber-500/15 text-amber-300' : 'bg-sky-500/15 text-sky-300'}">\${l.type}</span>
            </td>
            <td class="py-2.5 px-4 text-white font-medium text-xs">\${l.domain}</td>
            <td class="py-2.5 px-4 text-slate-400 text-[11px]">\${l.ip}</td>
            <td class="py-2.5 px-4 text-center">
              <span class="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase \${isAllowed ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'}">
                \${l.action}
              </span>
            </td>
            <td class="py-2.5 px-5 text-slate-400 text-[11px] font-sans">
              \${l.reason}
              \${!isAllowed && l.domain !== 'Direct Access' && l.domain !== 'Direct / No-Referer' ? \`<button onclick="quickWhitelist('\${l.domain}')" class="ml-2 text-emerald-400 hover:underline text-[10px]">+ Whitelist</button>\` : ''}
            </td>
          </tr>
        \`;
      }).join('');
    }

    // Modal Handlers
    openAddModalBtn.onclick = () => addModal.classList.remove('hidden');
    closeAddModalBtn.onclick = () => addModal.classList.add('hidden');
    cancelAddBtn.onclick = () => addModal.classList.add('hidden');

    // Add Domain Form
    addDomainForm.onsubmit = async (e) => {
      e.preventDefault();
      const domain = document.getElementById('newDomainInput').value;
      const note = document.getElementById('newDomainNote').value;
      const casino = document.getElementById('allowCasinoCheckbox').checked;
      const sports = document.getElementById('allowSportsCheckbox').checked;

      const res = await fetch('/api/master/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + masterToken },
        body: JSON.stringify({ domain, note, casino, sports })
      });
      const d = await res.json();
      if (d.success) {
        addModal.classList.add('hidden');
        addDomainForm.reset();
        loadDashboard();
      } else {
        alert(d.error || 'Failed to add domain');
      }
    };

    // Toggle Permission
    window.togglePermission = async function(domain, type, val) {
      await fetch('/api/master/domains/' + encodeURIComponent(domain), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + masterToken },
        body: JSON.stringify({ [type]: val })
      });
      loadDashboard();
    };

    // Toggle Status (Block / Unblock)
    window.toggleStatus = async function(domain, status) {
      await fetch('/api/master/domains/' + encodeURIComponent(domain), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + masterToken },
        body: JSON.stringify({ status })
      });
      loadDashboard();
    };

    // Delete Domain
    window.deleteDomain = async function(domain) {
      if (!confirm('Remove "' + domain + '" from whitelist registry?')) return;
      await fetch('/api/master/domains/' + encodeURIComponent(domain), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + masterToken }
      });
      loadDashboard();
    };

    // Quick Whitelist from Logs
    window.quickWhitelist = function(domain) {
      document.getElementById('newDomainInput').value = domain;
      document.getElementById('newDomainNote').value = 'Quick added from security log';
      addModal.classList.remove('hidden');
    };

    // Toggle Enforce
    toggleEnforceBtn.onclick = async () => {
      const current = toggleEnforceBtn.textContent.trim() === 'ON';
      await fetch('/api/master/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + masterToken },
        body: JSON.stringify({ enforceWhitelist: !current })
      });
      loadDashboard();
    };

    // Toggle Direct Access
    toggleDirectBtn.onclick = async () => {
      const current = toggleDirectBtn.textContent.trim() === 'ON';
      await fetch('/api/master/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + masterToken },
        body: JSON.stringify({ allowDirectAccess: !current })
      });
      loadDashboard();
    };

    // Search filter
    document.getElementById('domainSearch').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const filtered = domainsCache.filter(item => item.domain.toLowerCase().includes(q) || (item.note && item.note.toLowerCase().includes(q)));
      renderDomainsTable(filtered);
    });

    // Auto-refresh every 10 seconds
    setInterval(() => {
      if (masterToken && !dashboardView.classList.contains('hidden')) {
        loadDashboard();
      }
    }, 10000);
  </script>
</body>
</html>`);
});

// Initialize on boot
initWhitelist();

module.exports = {
  router,
  verifyAccess,
  renderUnauthorizedScreen,
  initWhitelist
};
