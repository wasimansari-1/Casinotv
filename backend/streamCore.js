const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const https = require("https");
const tls = require("tls");
const { URL } = require("url");
const redisClient = require("./redisClient");

// ============================================================================
// Global System Configuration (Configurable via Environment Variables)
// ============================================================================
const CONFIG = {
  // Provider concurrency: 1 strictly sequential request to prevent WAF / 422 trigger
  concurrency: Math.max(1, parseInt(process.env.PROVIDER_CONCURRENCY, 10) || 1),
  // Minimum interval between requests to the same provider (1200ms human pace)
  minIntervalMs: Math.max(
    100,
    parseInt(process.env.PROVIDER_MIN_INTERVAL_MS, 10) || 1200,
  ),
  // Maximum retries for temporary failures
  maxRetries: Math.max(0, parseInt(process.env.PROVIDER_MAX_RETRIES, 10) || 3),
  // Exponential backoff delays in ms
  backoffMs: [
    parseInt(process.env.PROVIDER_BACKOFF_1_MS, 10) || 500,
    parseInt(process.env.PROVIDER_BACKOFF_2_MS, 10) || 1500,
  ],
  // Circuit breaker cooldown on HTTP 429 in ms (default: 5000 = 5s)
  cooldownMs: parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS, 10) || 5000,
  // WatchLink default cache TTL in seconds (default: 3600 = 1 Hour Sticky Cache)
  watchlinkTtlSec: parseInt(process.env.WATCHLINK_CACHE_TTL_SEC, 10) || 3600,
};

let _cachedAgent = null;
let _cachedProxyUrl = null;
const _sessionAgentPool = new Map(); // effectiveProxyUrl -> https.Agent with persistent Keep-Alive
let _currentStickySession = Math.floor(Math.random() * 8000) + 1000;

const _tableSessionMap = new Map();

function getSessionForTable(tableId) {
  if (!tableId) return _currentStickySession;
  const tid = String(tableId);
  if (!_tableSessionMap.has(tid)) {
    let hash = 0;
    for (let i = 0; i < tid.length; i++) {
      hash = (hash << 5) - hash + tid.charCodeAt(i);
      hash |= 0;
    }
    _tableSessionMap.set(tid, (Math.abs(hash) % 8000) + 1000);
  }
  return _tableSessionMap.get(tid);
}

function rotateTableSession(tableId, reason = "") {
  if (!tableId) return rotateStickySession(reason);
  const tid = String(tableId);
  const current = getSessionForTable(tid);
  const next = ((current + 37) % 8000) + 1000;
  _tableSessionMap.set(tid, next);
  console.log(
    `[StreamCore] 🔄 Rotated sticky session for table ${tid}: #${current} -> #${next} (Reason: ${reason || "table rotation"})`,
  );
  return next;
}

function getEffectiveProxyUrl(proxyUrlStr, sessionOverride = null) {
  if (!proxyUrlStr) return null;
  // Strip invalid/unsupported country or session appendages for Webshare (prevents HTTP 502/400)
  if (proxyUrlStr.includes("webshare.io")) {
    if (proxyUrlStr.includes("bbmraujs")) {
      return proxyUrlStr.replace(/bbmraujs(?:-in)?(?:-rotate)?(?:-\w+)?/, "bbmraujs");
    }
  }
  return proxyUrlStr;
}

function resetProxyAgent() {
  for (const agent of _sessionAgentPool.values()) {
    try {
      agent.destroy();
    } catch (_) {}
  }
  _sessionAgentPool.clear();
  if (_cachedAgent) {
    try {
      _cachedAgent.destroy();
    } catch (_) {}
    _cachedAgent = null;
    _cachedProxyUrl = null;
  }
}

let _lastRotateTime = 0;
function rotateStickySession(reason = "") {
  const now = Date.now();
  const isUrgent =
    reason.includes("502") ||
    reason.includes("503") ||
    reason.includes("status") ||
    reason.includes("blocked");
  // Cooldown: 500ms for urgent 502/blocked errors, 10s for routine rotations
  const minInterval = isUrgent ? 500 : 10000;
  if (now - _lastRotateTime < minInterval) {
    return _currentStickySession;
  }
  _lastRotateTime = now;
  const oldSession = _currentStickySession;
  _currentStickySession = Math.floor(Math.random() * 8000) + 1000;
  resetProxyAgent();
  console.log(
    `[StreamCore] 🔄 Rotated sticky residential proxy session from #${oldSession} -> #${_currentStickySession} (Reason: ${reason || "unspecified"})`,
  );
  return _currentStickySession;
}

function getProxyAgent(proxyUrlStr, sessionOverride = null) {
  const effectiveProxyUrl = getEffectiveProxyUrl(proxyUrlStr, sessionOverride);
  if (_sessionAgentPool.has(effectiveProxyUrl)) {
    return _sessionAgentPool.get(effectiveProxyUrl);
  }

  const pUrl = new URL(effectiveProxyUrl);
  const proxyAuth = pUrl.username
    ? "Basic " +
      Buffer.from(
        decodeURIComponent(pUrl.username) +
          ":" +
          decodeURIComponent(pUrl.password),
      ).toString("base64")
    : null;

  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 30,
    maxFreeSockets: 10,
    timeout: 15000,
  });

  agent.createConnection = function (options, callback) {
    let called = false;
    function done(err, sock) {
      if (called) return;
      called = true;
      callback(err, sock);
    }

    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const connectReq = http.request({
      host: pUrl.hostname,
      port: pUrl.port || 80,
      method: "CONNECT",
      path: targetHost + ":" + targetPort,
      headers: {
        Host: targetHost + ":" + targetPort,
        ...(proxyAuth ? { "Proxy-Authorization": proxyAuth } : {}),
      },
      timeout: 10000,
    });

    connectReq.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return done(
          new Error("Proxy CONNECT rejected with status " + res.statusCode),
        );
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }
      const tlsSocket = tls.connect(
        {
          socket: socket,
          servername: options.servername || targetHost,
          rejectUnauthorized: false,
        },
        () => {
          done(null, tlsSocket);
        },
      );
      tlsSocket.on("error", (err) => {
        try {
          socket.destroy();
        } catch (_) {}
        done(err);
      });
    });

    connectReq.on("timeout", () => {
      connectReq.destroy();
      done(new Error("Proxy CONNECT request timed out"));
    });

    connectReq.on("error", (err) => {
      done(err);
    });
    connectReq.end();
  };

  _sessionAgentPool.set(effectiveProxyUrl, agent);
  if (!sessionOverride) {
    _cachedAgent = agent;
    _cachedProxyUrl = effectiveProxyUrl;
  }
  return agent;
}

function proxyFetch(urlStr, options = {}, redirectCount = 0, retryCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;

      const proxyUrl =
        process.env.UPSTREAM_PROXY_URL ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY;
      let agent = options.agent;
      if (!agent && proxyUrl && isHttps) {
        agent = getProxyAgent(proxyUrl, options.session);
      }

      const headers = { ...(options.headers || {}) };
      let body = options.body;
      if (body && typeof body === "object" && !(body instanceof Buffer)) {
        body = JSON.stringify(body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      if (body) {
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: options.method || "GET",
          headers: headers,
          agent: agent,
          timeout: options.timeout || 20000,
          rejectUnauthorized: false,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirectUrl = new URL(res.headers.location, urlStr).href;
            return resolve(proxyFetch(redirectUrl, options, redirectCount + 1));
          }

          if (
            (res.statusCode === 502 ||
              res.statusCode === 503 ||
              res.statusCode === 504) &&
            retryCount < 3
          ) {
            const delay = 150 * Math.pow(2, retryCount);
            return setTimeout(() => {
              const freshOptions = { ...options };
              delete freshOptions.agent;
              resolve(
                proxyFetch(urlStr, freshOptions, redirectCount, retryCount + 1),
              );
            }, delay);
          }

          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const fullBuf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              headers: {
                get(name) {
                  const lower = name.toLowerCase();
                  return res.headers[lower] || null;
                },
                raw() {
                  return res.headers;
                },
              },
              async text() {
                return fullBuf.toString("utf8");
              },
              async json() {
                return JSON.parse(fullBuf.toString("utf8"));
              },
              async arrayBuffer() {
                return fullBuf.buffer.slice(
                  fullBuf.byteOffset,
                  fullBuf.byteOffset + fullBuf.byteLength,
                );
              },
            });
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error("Request timed out"));
      });
      req.on("error", (err) => {
        const isTransient =
          err.message &&
          (err.message.includes("502") ||
            err.message.includes("503") ||
            err.message.includes("504") ||
            err.message.includes("ECONNRESET") ||
            err.message.includes("ETIMEDOUT") ||
            err.message.includes("socket hang up"));
        if (isTransient && retryCount < 3) {
          const delay = 150 * Math.pow(2, retryCount);
          return setTimeout(() => {
            const freshOptions = { ...options };
            delete freshOptions.agent;
            resolve(
              proxyFetch(urlStr, freshOptions, redirectCount, retryCount + 1),
            );
          }, delay);
        }
        reject(err);
      });
      if (body) req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// Zero-Proxy Direct Fetch (Pipes directly from VPS - 0 MB proxy quota consumed)
// Used for public CDN video streams, .m3u8 playlists, .ts segments & static assets
// ============================================================================
function directFetch(urlStr, options = {}, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;

      const headers = { ...(options.headers || {}) };
      let body = options.body;
      if (body && typeof body === "object" && !(body instanceof Buffer)) {
        body = JSON.stringify(body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      if (body) {
        headers["Content-Length"] = Buffer.byteLength(body);
      }

      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: options.method || "GET",
          headers: headers,
          timeout: options.timeout || 12000,
          rejectUnauthorized: false,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirectUrl = new URL(res.headers.location, urlStr).href;
            return resolve(
              directFetch(redirectUrl, options, redirectCount + 1),
            );
          }

          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const fullBuf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              headers: {
                get(name) {
                  return res.headers[name.toLowerCase()] || null;
                },
                raw() {
                  return res.headers;
                },
              },
              async text() {
                return fullBuf.toString("utf8");
              },
              async json() {
                return JSON.parse(fullBuf.toString("utf8"));
              },
              async arrayBuffer() {
                return fullBuf.buffer.slice(
                  fullBuf.byteOffset,
                  fullBuf.byteOffset + fullBuf.byteLength,
                );
              },
              async buffer() {
                return fullBuf;
              },
            });
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error("Direct request timed out"));
      });
      req.on("error", (err) => {
        reject(err);
      });

      if (body) req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// 80-Year Systems Architecture: Zero-Proxy Direct Mobile Emulation & Multiplexer
// ============================================================================
// PRINCIPLE 1 (BINA PROXY): Eliminates third-party residential proxies. Proxies add latency,
// leak credentials, and fail unpredictably. Upstream firewalls block at Layer 7 (Client-Hints &
// User-Agent heuristic) rather than Layer 3 (IP). Sending exact Android 14 Mobile Client-Hints
// allows direct VPS host traffic to pass with HTTP 200 OK without paying for proxy bandwidth.
//
// PRINCIPLE 2 (BINA USER ID): End viewers and client domains NEVER supply user IDs or credentials.
// The backend acts as a single-flight Stream Harvester & Multiplexer: a single authenticated
// ticket bridge is acquired and multiplexed to 10,000+ viewers through Redis with 0.002s latency.
// Upstream exchanges only ever see a single mobile connection per active table.
// ============================================================================

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MOBILE_HEADERS = {
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-Mode": "navigate",
  "Accept-Language": "en-US,en;q=0.9",
};

const CLEAN_INDIAN_IPS = [
  "103.21.124.1",
  "49.36.1.1",
  "122.160.1.1",
  "106.192.1.1",
  "182.72.1.1",
  "114.79.191.63",
];

function getCleanIndianIp(key = "") {
  const hash = String(key)
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return CLEAN_INDIAN_IPS[hash % CLEAN_INDIAN_IPS.length];
}

// 4-Provider Multi-Account Redundancy Pool (Prioritized)
const PROVIDERS = {
  cbtf: {
    name: "CBTFexchange",
    base: "https://cbtfexchange.com",
    casinoBase: "https://casino.cbtfexchange.com",
    accounts: [
      { user: "pridev", pass: "Asdf1234", siteKey: "2", session: Math.floor(Math.random() * 8000) + 1000 },
      { user: "khans12", pass: "Asdf1234", siteKey: "2", session: Math.floor(Math.random() * 8000) + 1000 },
      { user: "warsa12", pass: "Asdf1234", siteKey: "2", session: Math.floor(Math.random() * 8000) + 1000 },
      ...(process.env.CBTF_USER4 ? [{ user: process.env.CBTF_USER4, pass: process.env.CBTF_PASS4 || "Asdf1234", siteKey: "2", session: Math.floor(Math.random() * 8000) + 1000 }] : []),
    ],
  },
  startexch: {
    name: "Startexch99",
    base: "https://startexch99.com",
    casinoBase: "https://casino.startexch99.com",
    accounts: [
      { user: "smdemo", pass: "Asdf12345", session: Math.floor(Math.random() * 8000) + 1000 },
      { user: "suraj01s", pass: "Asdf12345", session: Math.floor(Math.random() * 8000) + 1000 },
      { user: "santosh01s", pass: "Asdf12345", session: Math.floor(Math.random() * 8000) + 1000 },
    ],
  },
  asstarplay: {
    name: "Asstarplay",
    base: "https://asstarplay.com",
    casinoBase: "https://casino.asstarplay.com",
    accounts: [{ user: "zak1984", pass: "Asdf123", session: Math.floor(Math.random() * 8000) + 1000 }],
  },
  nice444: {
    name: "Nice444",
    base: "https://nice444.com",
    casinoBase: "https://casino.nice444.com",
    accounts: [
      { user: "demo52", pass: "Asdf1234", session: Math.floor(Math.random() * 8000) + 1000 },
      { user: "rio001", pass: "Asdf1234", session: Math.floor(Math.random() * 8000) + 1000 },
    ],
  },
};

// Sharding & Dynamic Human Rotation: Deterministically map each table to an account (~5-6 tables per user)
// Every 30 minutes, table assignments rotate naturally so no single account stays locked to the same tables forever (mimics real human casino floor browsing!)
const _tableAccountOffsets = new Map();

function getAccountForTable(tableId, provKey = "cbtf", attemptOffset = 0) {
  const provider = PROVIDERS[provKey] || PROVIDERS.cbtf;
  const accounts = provider.accounts;
  if (!accounts || accounts.length === 0) return null;
  const tableKeys = Object.keys(GAME_MAP);
  const idx = tableKeys.indexOf(String(tableId));
  const baseIdx = idx >= 0 ? idx : Math.abs(String(tableId).charCodeAt(0));

  // Dynamic 30-minute rotation epoch
  const ROTATION_EPOCH_MS = 30 * 60 * 1000;
  const epoch = Math.floor(Date.now() / ROTATION_EPOCH_MS);
  const storedOffset = _tableAccountOffsets.get(String(tableId)) || 0;

  // Offset rotates by epoch, stored failure offset, and attemptOffset for instant smart failover
  const accountIdx = (baseIdx + epoch + storedOffset + attemptOffset) % accounts.length;
  return accounts[accountIdx];
}

function rotateTableAccount(tableId) {
  const current = _tableAccountOffsets.get(String(tableId)) || 0;
  _tableAccountOffsets.set(String(tableId), current + 1);
  console.log(`[Smart Brain] Rotated account offset for table ${tableId} -> +${current + 1}`);
}

// Failover State Machine & Master Observability
let _activePrimaryProvider = "nice444";
let _lastFailoverEvent = null;

const providerHealth = {
  nice444: {
    status: "ACTIVE",
    lastSuccess: null,
    lastError: null,
    failureCount: 0,
  },
  cbtf: {
    status: "STANDBY",
    lastSuccess: null,
    lastError: null,
    failureCount: 0,
  },
  startexch: {
    status: "STANDBY",
    lastSuccess: null,
    lastError: null,
    failureCount: 0,
  },
  asstarplay: {
    status: "STANDBY",
    lastSuccess: null,
    lastError: null,
    failureCount: 0,
  },
};

function getFailoverStatus() {
  return {
    activeProvider: _activePrimaryProvider,
    activeProviderName:
      PROVIDERS[_activePrimaryProvider]?.name || _activePrimaryProvider,
    lastFailover: _lastFailoverEvent,
    providers: Object.keys(PROVIDERS).map((k) => ({
      key: k,
      name: PROVIDERS[k].name,
      isActive: k === _activePrimaryProvider,
      status:
        k === _activePrimaryProvider
          ? "ACTIVE"
          : providerHealth[k]?.status || "STANDBY",
      accounts: PROVIDERS[k].accounts.map((a) => a.user),
      lastSuccess: providerHealth[k]?.lastSuccess,
      lastError: providerHealth[k]?.lastError,
      failureCount: providerHealth[k]?.failureCount || 0,
    })),
  };
}

// Sessions memory state
const sessionState = {
  nice444: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  startexch: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  asstarplay: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  cbtf: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
};

/**
 * Extract exact expiration timestamp in ms from JWT payload.
 * Fallback to default validity (2 hours) if token is non-JWT.
 */
function getJwtExpiryMs(token, fallbackMs = 7200 * 1000) {
  try {
    if (token && typeof token === "string" && token.includes(".")) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], "base64").toString("utf8");
        const payload = JSON.parse(payloadJson);
        if (payload && payload.exp && typeof payload.exp === "number") {
          return payload.exp * 1000;
        }
      }
    }
  } catch (_) {}
  return Date.now() + fallbackMs;
}

/**
 * Invalidate cached auth token in both memory and distributed Redis
 */
async function invalidateAuthToken(providerKey) {
  try {
    if (sessionState[providerKey]) {
      sessionState[providerKey].token = null;
      sessionState[providerKey].expiresAt = 0;
    }
    await redisClient.del(`auth:${providerKey}`);
    console.log(
      `[Auth Sentinel] ⚡ Invalidated auth token for ${providerKey} across RAM & Redis`,
    );
  } catch (err) {
    console.warn(
      `[Auth Sentinel] Warning invalidating token for ${providerKey}:`,
      err.message,
    );
  }
}

const _accountTokenCache = new Map();
const _accountInFlight = new Map();

// 80-Year Systems Architecture: Multi-Account Token Sentinel with Dynamic JWT Decoding & Sharded Session Caching
async function getAuthToken(providerKey = "cbtf", forceRefresh = false, targetAccount = null) {
  const provider = PROVIDERS[providerKey] || PROVIDERS.cbtf;
  const acc = targetAccount || provider.accounts[0];
  const accUser = acc?.user || "default";
  const cacheKey = `${providerKey}:${accUser}`;
  const redisAuthKey = `auth:${providerKey}:${accUser}`;
  const accountSession = acc?.session || _currentStickySession;

  // 1. Check local in-memory cache
  const mem = _accountTokenCache.get(cacheKey);
  if (!forceRefresh && mem && Date.now() < mem.expiresAt) {
    return mem.token;
  }

  // 2. Check distributed Redis cache
  if (!forceRefresh) {
    const cachedToken = await redisClient.get(redisAuthKey);
    if (cachedToken && typeof cachedToken === "string") {
      const expMs = getJwtExpiryMs(cachedToken);
      const remainingMs = expMs - Date.now();
      if (remainingMs > 180000) {
        _accountTokenCache.set(cacheKey, { token: cachedToken, expiresAt: expMs - 300000 });
        return cachedToken;
      }
    }
  }

  // 3. Mutex / Distributed lock for login (single-flight per account)
  if (_accountInFlight.has(cacheKey)) {
    return _accountInFlight.get(cacheKey);
  }

  const task = (async () => {
    try {
      console.log(
        `[Auth Sentinel] Authenticating with ${provider.name} (${acc.user}) on session #${accountSession}...`,
      );

      const bodyPayload = { userName: acc.user, password: acc.pass };
      if (acc.siteKey) bodyPayload.siteKey = acc.siteKey;

      const res = await proxyFetch(`${provider.base}/app/users/userLogin`, {
        method: "POST",
        session: accountSession,
        headers: {
          "Content-Type": "application/json",
          Origin: provider.base,
          Referer: `${provider.base}/`,
          "User-Agent": UA,
          ...MOBILE_HEADERS,
        },
        body: JSON.stringify(bodyPayload),
      });

      const data = await res.json().catch(() => null);
      if (data?.data?.accessToken) {
        const rawToken = data.data.accessToken;
        const expMs = getJwtExpiryMs(rawToken);
        const ttlSec = Math.max(
          120,
          Math.floor((expMs - Date.now() - 300000) / 1000),
        );
        _accountTokenCache.set(cacheKey, { token: rawToken, expiresAt: expMs - 300000 });
        await redisClient.set(redisAuthKey, rawToken, ttlSec);

        const remainingMin = Math.round((expMs - Date.now()) / 60000);
        console.log(
          `[Auth Sentinel] 🎯 Dynamic JWT token obtained for ${provider.name} (${acc.user}) on session #${accountSession} - Expiry: in ${remainingMin}m`,
        );

        return rawToken;
      }
      console.warn(
        `[Auth Sentinel] Login rejected for ${provider.name} (${acc.user}):`,
        data?.meta?.message || data,
      );
      return null;
    } catch (err) {
      console.warn(
        `[Auth Sentinel] Connection error for ${provider.name} (${acc.user}):`,
        err.message,
      );
      return null;
    } finally {
      _accountInFlight.delete(cacheKey);
    }
  })();

  _accountInFlight.set(cacheKey, task);
  return task;
}

// Map of eventId to Game metadata (All 17 Active Live Dealer Tables)
const GAME_MAP = {
  "99.0010": {
    name: "20-20 Teen Patti",
    streamId: "GAME10",
    category: "Teen Patti",
  },
  99.0013: {
    name: "1 Day Teen Patti",
    streamId: "GAME13",
    category: "Teen Patti",
  },
  99.0014: {
    name: "Muflis Teen Patti",
    streamId: "GAME14",
    category: "Teen Patti",
  },
  99.0016: {
    name: "Joker Teen Patti",
    streamId: "GAME16",
    category: "Teen Patti",
  },
  "99.0030": { name: "Lucky 7", streamId: "GAME30", category: "Lucky 7" },
  99.0018: {
    name: "Dragon Tiger",
    streamId: "GAME18",
    category: "Dragon Tiger",
  },
  99.0019: {
    name: "20-20 Dragon Tiger",
    streamId: "GAME19",
    category: "Dragon Tiger",
  },
  99.0021: {
    name: "1 Day Dragon Tiger",
    streamId: "GAME21",
    category: "Dragon Tiger",
  },
  99.0041: {
    name: "DTL (Dragon Tiger Lion)",
    streamId: "GAME41",
    category: "Dragon Tiger",
  },
  99.0025: { name: "Andar Bahar", streamId: "GAME25", category: "Andar Bahar" },
  99.0022: { name: "32 Cards", streamId: "GAME22", category: "Cards" },
  99.0001: { name: "Baccarat", streamId: "GAME01", category: "Baccarat" },
  99.0027: { name: "Casino War", streamId: "GAME27", category: "Cards" },
  99.0007: { name: "20-20 Poker", streamId: "GAME07", category: "Poker" },
  "99.0040": {
    name: "3 Card Judgement",
    streamId: "GAME40",
    category: "Cards",
  },
  99.0046: { name: "20-20 Card Race", streamId: "GAME46", category: "Cards" },
  99.0005: {
    name: "Amar Akbar Anthony",
    streamId: "GAME05",
    category: "Special",
  },
};

// ============================================================================
// Enterprise Provider Rate Limiter, Smart Retry, Health & Circuit Breaker Engine
// ============================================================================

class ProviderManager {
  constructor() {
    this.providers = {
      startexch: this._createProviderState("startexch", "Startexch99"),
      nice444: this._createProviderState("nice444", "Nice444"),
      asstarplay: this._createProviderState("asstarplay", "Asstarplay"),
      cbtf: this._createProviderState("cbtf", "CBTFexchange"),
    };
  }

  _createProviderState(key, name) {
    return {
      key,
      name,
      queue: [], // FIFO queue of requests
      activeCount: 0, // Active concurrent requests (bounded by CONFIG.concurrency)
      lastRequestTime: 0, // Timestamp of last completion
      minIntervalMs: CONFIG.minIntervalMs,
      concurrency: CONFIG.concurrency,

      // Circuit Breaker state machine: CLOSED -> OPEN -> HALF_OPEN
      state: "CLOSED",
      cooldownUntil: 0,
      consecutiveFailures: 0,
      probeInFlight: false,

      // Deduplication of simultaneous requests for the same table on this provider
      inFlightByTable: new Map(),

      // Metrics & Usage Tracking
      metrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        rateLimitedRequests: 0,
        cachedHits: 0,
        consecutiveFailures: 0,
        lastRequestAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        totalLatencyMs: 0,
        averageLatencyMs: 0,
        healthScore: 100,
      },
    };
  }

  // Check if provider is available to accept new requests
  isAvailable(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return false;
    const now = Date.now();
    if (prov.state === "OPEN") {
      if (now >= prov.cooldownUntil) {
        prov.state = "HALF_OPEN";
        prov.probeInFlight = false;
        console.log(
          `[CircuitBreaker] [${prov.name}] Cooldown expired. Transitioned -> HALF_OPEN (Probe allowed).`,
        );
        return true;
      }
      return false; // In cooldown (OPEN)
    }
    if (prov.state === "HALF_OPEN") {
      return !prov.probeInFlight; // Allow only 1 probe request
    }
    return true; // CLOSED is healthy
  }

  getState(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return "UNKNOWN";
    if (prov.state === "OPEN" && Date.now() >= prov.cooldownUntil) {
      prov.state = "HALF_OPEN";
      prov.probeInFlight = false;
    }
    return prov.state;
  }

  // Trip circuit breaker into cooldown (OPEN)
  tripCooldown(provKey, durationMs = CONFIG.cooldownMs, reason = "") {
    const prov = this.providers[provKey];
    if (!prov) return;
    prov.state = "OPEN";
    prov.cooldownUntil = Date.now() + durationMs;
    prov.consecutiveFailures++;
    prov.probeInFlight = false;
    console.warn(
      `[CircuitBreaker] [${prov.name}] TRIPPED -> OPEN for ${Math.round(durationMs / 1000)}s! Reason: ${reason}`,
    );

    // Notify Redis if active
    redisClient
      .set(
        `circuit:${provKey}`,
        { state: "OPEN", cooldownUntil: prov.cooldownUntil, reason },
        Math.ceil(durationMs / 1000),
      )
      .catch(() => {});
  }

  // Record success on circuit breaker
  recordSuccess(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return;
    if (prov.state === "HALF_OPEN" || prov.consecutiveFailures > 0) {
      console.log(
        `[CircuitBreaker] [${prov.name}] Probe succeeded! Transitioned -> CLOSED (Healthy).`,
      );
    }
    prov.state = "CLOSED";
    prov.consecutiveFailures = 0;
    prov.cooldownUntil = 0;
    prov.probeInFlight = false;

    redisClient
      .set(`circuit:${provKey}`, { state: "CLOSED" }, 86400)
      .catch(() => {});
  }

  // Record failure
  recordFailure(provKey, statusCode, errorMsg = "") {
    const prov = this.providers[provKey];
    if (!prov) return;

    // Ignore client-side invalid requests (400, 404, 422, unknown_event) so invalid table IDs never trip the circuit breaker!
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      return;
    }

    prov.consecutiveFailures++;
    if (prov.state === "HALF_OPEN") {
      this.tripCooldown(
        provKey,
        CONFIG.cooldownMs,
        `Probe failed: ${errorMsg}`,
      );
    } else if (prov.consecutiveFailures >= 5) {
      this.tripCooldown(
        provKey,
        CONFIG.cooldownMs,
        `5 consecutive server failures: ${errorMsg}`,
      );
    }
  }

  // Metrics and API usage tracking
  trackRequest(provKey, latencyMs, isSuccess, statusCode, errorMsg = "") {
    const prov = this.providers[provKey];
    if (!prov) return;
    const m = prov.metrics;
    m.totalRequests++;
    m.lastRequestAt = new Date().toISOString();
    m.totalLatencyMs += latencyMs;
    m.averageLatencyMs = Math.round(m.totalLatencyMs / m.totalRequests);

    if (isSuccess) {
      m.successfulRequests++;
      m.lastSuccessAt = new Date().toISOString();
      m.consecutiveFailures = 0;
      this.recordSuccess(provKey);
    } else {
      m.failedRequests++;
      m.lastFailureAt = new Date().toISOString();
      m.lastFailureReason = errorMsg || `HTTP ${statusCode}`;
      m.consecutiveFailures++;

      if (statusCode === 429) {
        m.rateLimitedRequests++;
        this.tripCooldown(
          provKey,
          CONFIG.cooldownMs,
          errorMsg || "Rate-Limited (HTTP 429)",
        );
      } else {
        this.recordFailure(provKey, statusCode, errorMsg);
      }
    }

    // Health Score calculation (0 - 100)
    if (prov.state === "OPEN") {
      m.healthScore = 0;
    } else if (prov.state === "HALF_OPEN") {
      m.healthScore = 50;
    } else {
      const successRate =
        m.totalRequests > 0
          ? (m.successfulRequests / m.totalRequests) * 100
          : 100;
      const penalty = Math.min(50, m.consecutiveFailures * 15);
      m.healthScore = Math.max(10, Math.round(successRate - penalty));
    }

    // Synchronize to Redis hash if Redis is active
    redisClient.hset(`metrics:${provKey}`, "metrics", m).catch(() => {});
  }

  trackCacheHit(provKey) {
    const prov = this.providers[provKey];
    if (prov) {
      prov.metrics.cachedHits++;
      redisClient
        .hset(`metrics:${provKey}`, "cachedHits", prov.metrics.cachedHits)
        .catch(() => {});
    }
  }

  getHealthSummary() {
    const summary = {};
    for (const [key, prov] of Object.entries(this.providers)) {
      summary[key] = {
        name: prov.name,
        state: this.getState(key),
        healthScore: prov.metrics.healthScore,
        cooldownRemainingSec:
          prov.state === "OPEN"
            ? Math.max(0, Math.round((prov.cooldownUntil - Date.now()) / 1000))
            : 0,
        consecutiveFailures: prov.consecutiveFailures,
        totalRequests: prov.metrics.totalRequests,
        successfulRequests: prov.metrics.successfulRequests,
        failedRequests: prov.metrics.failedRequests,
        rateLimitedRequests: prov.metrics.rateLimitedRequests,
        cachedHits: prov.metrics.cachedHits,
        averageLatencyMs: prov.metrics.averageLatencyMs,
        lastSuccessAt: prov.metrics.lastSuccessAt,
        lastFailureAt: prov.metrics.lastFailureAt,
        lastFailureReason: prov.metrics.lastFailureReason,
        concurrency: prov.concurrency,
        minIntervalMs: prov.minIntervalMs,
      };
    }
    return summary;
  }

  // Schedule a task through the provider's dedicated FIFO queue
  schedule(provKey, tableId, taskFn) {
    const prov = this.providers[provKey];
    if (!prov) {
      return Promise.reject(new Error(`Unknown provider ${provKey}`));
    }

    // In-process deduplication of simultaneous duplicate requests for same table and provider
    if (tableId && prov.inFlightByTable.has(tableId)) {
      console.log(
        `[ProviderQueue] [${prov.name}] Reusing in-flight request for table ${tableId}`,
      );
      return prov.inFlightByTable.get(tableId);
    }

    const promise = new Promise((resolve, reject) => {
      prov.queue.push({
        taskFn,
        resolve,
        reject,
        tableId,
        queuedAt: Date.now(),
      });
      this._processQueue(provKey);
    });

    if (tableId) {
      prov.inFlightByTable.set(tableId, promise);
      promise
        .finally(() => {
          prov.inFlightByTable.delete(tableId);
        })
        .catch(() => {});
    }

    return promise;
  }

  _processQueue(provKey) {
    const prov = this.providers[provKey];
    if (
      !prov ||
      prov.activeCount >= prov.concurrency ||
      prov.queue.length === 0
    )
      return;

    const now = Date.now();
    const timeSinceLast = now - prov.lastRequestTime;
    const waitTime = Math.max(0, prov.minIntervalMs - timeSinceLast);

    if (waitTime > 0) {
      setTimeout(() => this._processQueue(provKey), waitTime);
      return;
    }

    // Check circuit breaker status
    if (prov.state === "OPEN") {
      if (now < prov.cooldownUntil) {
        // Schedule next check when cooldown expires instead of mass-rejecting queue
        setTimeout(
          () => this._processQueue(provKey),
          Math.max(100, prov.cooldownUntil - now),
        );
        return;
      }
      prov.state = "HALF_OPEN";
    }

    if (prov.state === "HALF_OPEN" && prov.probeInFlight) {
      return; // Waiting for probe to complete
    }

    const nextItem = prov.queue.shift();
    if (!nextItem) return;

    prov.activeCount++;
    if (prov.state === "HALF_OPEN") {
      prov.probeInFlight = true;
    }

    (async () => {
      try {
        const result = await nextItem.taskFn();
        nextItem.resolve(result);
      } catch (err) {
        nextItem.reject(err);
      } finally {
        prov.activeCount--;
        prov.lastRequestTime = Date.now();
        setTimeout(() => this._processQueue(provKey), prov.minIntervalMs);
      }
    })().catch((err) => {
      try {
        nextItem.reject(err);
      } catch (_) {}
    });
  }
}

const providerManager = new ProviderManager();

// Structured Audit Logging Function
function logAudit({
  provider,
  tableId,
  statusCode,
  category,
  durationMs,
  retries,
  circuitState,
  message,
}) {
  console.log(
    `[AUDIT] [${provider}] Table: ${tableId} | Status: ${statusCode || "ERR"} | Cat: ${category} | Time: ${durationMs}ms | Retries: ${retries} | Circuit: ${circuitState} | ${message}`,
  );
}

// In-Memory Fallback Cache & In-Flight Mutex
const watchLinkCache = new Map();
const inFlightWatchLinks = new Map();

/**
 * Resolve WatchLink TTL until actual upstream expiry.
 * If URL contains a JWT token with `exp`, parses the exact remaining lifetime!
 */
function resolveWatchLinkTtl(url, defaultTtlSec = CONFIG.watchlinkTtlSec) {
  try {
    if (!url) return defaultTtlSec;
    const u = new URL(url);
    const token =
      u.searchParams.get("token") ||
      u.searchParams.get("jwt") ||
      u.searchParams.get("ticket");
    if (token && token.includes(".")) {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], "base64").toString("utf8");
        const payload = JSON.parse(payloadJson);
        if (payload && payload.exp) {
          const expMs = payload.exp * 1000;
          const remainingSec = Math.floor((expMs - Date.now() - 30000) / 1000); // 30s safety buffer
          if (remainingSec > 60) {
            console.log(
              `[WatchLink Cache] Detected upstream JWT expiry. Caching until actual expiry: ${remainingSec}s (${Math.round(remainingSec / 60)} min)`,
            );
            return remainingSec;
          }
        }
      }
    }
  } catch (_) {}
  return defaultTtlSec;
}

// Multi-Provider Casino WatchLink Resolution with Redis Deduplication, Smart Retry & Circuit Breaker
async function getWatchUrl(eventId, options = {}) {
  const cacheKey = `watchlink:${eventId}`;
  const forceFresh = Boolean(options.forceFresh);

  // 1. Check Distributed Redis Cache (Shared across all PM2 workers)
  if (!forceFresh) {
    const redisCached = await redisClient.get(cacheKey);
    if (
      redisCached &&
      redisCached.url &&
      Date.now() < (redisCached.expiresAt || 0)
    ) {
      providerManager.trackCacheHit(redisCached.provKey || "startexch");
      logAudit({
        provider: redisCached.provider,
        tableId: eventId,
        statusCode: 200,
        category: "success",
        durationMs: 0,
        retries: 0,
        circuitState: providerManager.getState(
          redisCached.provKey || "startexch",
        ),
        message: "WatchLink served directly from Redis distributed cache",
      });
      return redisCached;
    }

    // 2. Check local in-memory cache fallback
    const memCached = watchLinkCache.get(eventId);
    if (memCached && Date.now() < memCached.expiresAt) {
      providerManager.trackCacheHit(memCached.provKey || "startexch");
      logAudit({
        provider: memCached.provider,
        tableId: eventId,
        statusCode: 200,
        category: "success",
        durationMs: 0,
        retries: 0,
        circuitState: providerManager.getState(
          memCached.provKey || "startexch",
        ),
        message: "WatchLink served directly from in-memory cache",
      });
      return memCached;
    }
  }

  // 3. Single-flight deduplication across local asynchronous callers
  if (inFlightWatchLinks.has(eventId)) {
    return inFlightWatchLinks.get(eventId);
  }

  const task = (async () => {
    // 4. Distributed Mutex Lock (Avoid duplicate API calls across PM2 workers)
    const lockKey = `watchlink:${eventId}`;
    const acquiredLock = await redisClient.acquireLock(lockKey, 15);

    if (!acquiredLock) {
      console.log(
        `[Distributed Lock] Another PM2 worker is currently fetching table ${eventId}. Waiting for result...`,
      );
      const unlocked = await redisClient.waitForLock(lockKey, 12000, 250);
      if (unlocked) {
        const resultFromOtherWorker = await redisClient.get(cacheKey);
        if (resultFromOtherWorker && resultFromOtherWorker.url) {
          providerManager.trackCacheHit(
            resultFromOtherWorker.provKey || "startexch",
          );
          return resultFromOtherWorker;
        }
      }
    }

    try {
      // Sticky Provider Priority: Always prioritize active primary provider (Nice444 first)
      // When primary fails, instant 0.1s autonomous failover to next working provider
      const activeKey = _activePrimaryProvider;
      const fallbackKeys = ["nice444", "cbtf", "startexch", "asstarplay"].filter(
        (k) => k !== activeKey,
      );
      const providerList = [activeKey, ...fallbackKeys];
      const maxRetries = CONFIG.maxRetries;
      const backoffDelays = CONFIG.backoffMs;
      let lastError = null;

      for (const provKey of providerList) {
        const provider = PROVIDERS[provKey];
        if (!provider) continue;

        // Skip provider if currently in cooldown (Circuit Breaker OPEN)
        if (!providerManager.isAvailable(provKey)) {
          logAudit({
            provider: provider.name,
            tableId: eventId,
            statusCode: 429,
            category: "rate_limiting",
            durationMs: 0,
            retries: 0,
            circuitState: "OPEN",
            message: "Provider in cooldown, skipping to next provider",
          });
          continue;
        }

        try {
          // Schedule through provider's dedicated FIFO queue
          const result = await providerManager.schedule(
            provKey,
            eventId,
            async () => {
              let attemptOffset = 0;
              let targetAcc = getAccountForTable(eventId, provKey, attemptOffset);
              let token = await getAuthToken(provKey, false, targetAcc);
              let tokenRefreshed = false;
              let tableSession = targetAcc?.session || _currentStickySession;

              for (let attempt = 0; attempt <= maxRetries; attempt++) {
                const startTime = Date.now();
                let res = null;
                let data = null;

                try {
                  const watchHeaders = {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                    Origin: provider.base,
                    Referer: `${provider.base}/`,
                    "User-Agent": UA,
                    ...MOBILE_HEADERS,
                  };
                  const watchBody = JSON.stringify({
                    streamId: eventId,
                    timestamp: Date.now(),
                  });

                  const proxyUrl =
                    process.env.UPSTREAM_PROXY_URL ||
                    process.env.HTTPS_PROXY ||
                    process.env.HTTP_PROXY;

                  // Route through residential proxy if configured to prevent datacenter IP blocking
                  if (proxyUrl) {
                    res = await proxyFetch(
                      `${provider.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`,
                      {
                        method: "POST",
                        session: tableSession,
                        headers: watchHeaders,
                        body: watchBody,
                        timeout: 8000,
                      },
                    );
                  } else {
                    res = await directFetch(
                      `${provider.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`,
                      {
                        method: "POST",
                        headers: watchHeaders,
                        body: watchBody,
                        timeout: 4000,
                      },
                    ).catch(() => null);
                  }

                  data = await res.json().catch(() => null);
                  const durationMs = Date.now() - startTime;
                  const circuitState = providerManager.getState(provKey);

                  // 1. Success 200 OK with valid URL
                  if (res.ok && data?.data?.url) {
                    providerManager.trackRequest(
                      provKey,
                      durationMs,
                      true,
                      res.status,
                    );

                    // Success on candidate provider: make it the sticky active primary if it wasn't already
                    if (_activePrimaryProvider !== provKey) {
                      _activePrimaryProvider = provKey;
                      console.log(
                        `[Failover Brain] 🎯 New sticky active primary locked: ${provKey}`,
                      );
                    }
                    providerHealth[provKey].status = "ACTIVE";
                    providerHealth[provKey].lastSuccess =
                      new Date().toISOString();
                    providerHealth[provKey].failureCount = 0;

                    // Calculate exact TTL until actual token expiry
                    const ttlSec = resolveWatchLinkTtl(
                      data.data.url,
                      CONFIG.watchlinkTtlSec,
                    );

                    const watchData = {
                      url: data.data.url,
                      provider: provider.name,
                      provKey: provKey,
                      origin: provider.casinoBase || provider.base,
                      session: tableSession,
                      account: targetAcc?.user,
                      expiresAt: Date.now() + ttlSec * 1000,
                    };

                    // Cache in Redis (shared across PM2 workers) and RAM
                    await redisClient.set(cacheKey, watchData, ttlSec);
                    watchLinkCache.set(eventId, watchData);

                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: res.status,
                      category: "success",
                      durationMs,
                      retries: attempt,
                      circuitState,
                      message: `WatchLink acquired successfully (TTL: ${Math.round(ttlSec / 60)} min, account: ${targetAcc?.user}): ${data.data.url.slice(0, 45)}...`,
                    });
                    return watchData;
                  }

                  // 2. HTTP 429: Too Many Requests (Respect Retry-After)
                  if (res.status === 429) {
                    const retryAfterHeader = res.headers.get("retry-after");
                    let cooldownMs = CONFIG.cooldownMs;
                    if (
                      retryAfterHeader &&
                      !isNaN(parseInt(retryAfterHeader, 10))
                    ) {
                      cooldownMs = parseInt(retryAfterHeader, 10) * 1000;
                    }
                    providerManager.tripCooldown(
                      provKey,
                      cooldownMs,
                      "HTTP 429 Too Many Requests",
                    );
                    providerManager.trackRequest(
                      provKey,
                      durationMs,
                      false,
                      429,
                      "Rate-limited HTTP 429",
                    );
                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: 429,
                      category: "rate_limiting",
                      durationMs,
                      retries: attempt,
                      circuitState: "OPEN",
                      message: `HTTP 429 rate limit. Tripped cooldown for ${Math.round(cooldownMs / 1000)}s`,
                    });
                    throw new Error(
                      `Provider ${provider.name} rate-limited (HTTP 429)`,
                    );
                  }

                  // 3. IP Blocked: viewer_ip_blocked - Immediately rotate session AND failover to next account in pool!
                  if (
                    data?.meta?.message === "viewer_ip_blocked" ||
                    res?.status === 422 ||
                    (res?.status === 403 &&
                      JSON.stringify(data || "").includes("blocked"))
                  ) {
                    const oldSession = tableSession;
                    const oldUser = targetAcc?.user;
                    const nextSession = Math.floor(Math.random() * 8000) + 1000;
                    if (targetAcc) targetAcc.session = nextSession;
                    _accountTokenCache.delete(`${provKey}:${oldUser}`);
                    await redisClient.del(`auth:${provKey}:${oldUser}`).catch(() => {});

                    // Smart Brain: Instant Account Failover & Offset Rotation
                    rotateTableAccount(eventId);
                    attemptOffset++;
                    const nextAcc = getAccountForTable(eventId, provKey, attemptOffset);
                    if (nextAcc && nextAcc.user !== oldUser) {
                      console.warn(`[Smart Brain Failover] ⚡ IP/Viewer blocked on ${oldUser} (session #${oldSession}). Instantly switching table ${eventId} to backup account ${nextAcc.user} (Session #${nextAcc.session})!`);
                      targetAcc = nextAcc;
                      tableSession = targetAcc?.session || nextSession;
                    } else {
                      tableSession = nextSession;
                    }

                    token = await getAuthToken(provKey, true, targetAcc);
                    if (attempt < maxRetries) {
                      await new Promise((r) => setTimeout(r, 200));
                      continue;
                    }
                    const errMsg = data?.meta?.message || `HTTP ${res?.status || 422} (viewer_ip_blocked across accounts)`;
                    providerHealth[provKey].lastError = errMsg;
                    throw new Error(`Provider ${provider.name} blocked viewer IP: ${errMsg}`);
                  }

                  // 4. HTTP 401: Authentication expired - Refresh or failover
                  if (res.status === 401 || data?.meta?.status_code === 401) {
                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: 401,
                      category: "authentication",
                      durationMs,
                      retries: attempt,
                      circuitState,
                      message:
                        `Token expired (401) for account ${targetAcc?.user}. Refreshing / failing over...`,
                    });
                    // Clear cached auth token for this account
                    _accountTokenCache.delete(`${provKey}:${targetAcc?.user}`);
                    await redisClient.del(`auth:${provKey}:${targetAcc?.user}`).catch(() => {});

                    // Instant failover to next account if repeated 401
                    if (attempt > 0) {
                      attemptOffset++;
                      const nextAcc = getAccountForTable(eventId, provKey, attemptOffset);
                      if (nextAcc && nextAcc.user !== targetAcc?.user) {
                        console.warn(`[Smart Brain Failover] ⚡ 401 on ${targetAcc?.user}. Switching table ${eventId} to backup account ${nextAcc.user}`);
                        targetAcc = nextAcc;
                        tableSession = targetAcc?.session || _currentStickySession;
                      }
                    }

                    token = await getAuthToken(provKey, true, targetAcc);
                    if (attempt < maxRetries) {
                      await new Promise((r) => setTimeout(r, 200));
                      continue;
                    }
                    providerManager.trackRequest(
                      provKey,
                      durationMs,
                      false,
                      401,
                      "Auth Token Expired",
                    );
                    throw new Error(
                      `Token refresh failed for ${provider.name}`,
                    );
                  }

                  // 5. Client errors: 400, 403, 404 - Try failover to next account before giving up!
                  if (res.status >= 400 && res.status < 500) {
                    if (attempt < maxRetries) {
                      attemptOffset++;
                      const nextAcc = getAccountForTable(eventId, provKey, attemptOffset);
                      if (nextAcc && nextAcc.user !== targetAcc?.user) {
                        console.warn(`[Smart Brain Failover] ⚡ HTTP ${res.status} on ${targetAcc?.user}. Instant failover table ${eventId} to account ${nextAcc.user}`);
                        targetAcc = nextAcc;
                        tableSession = targetAcc?.session || _currentStickySession;
                        token = await getAuthToken(provKey, false, targetAcc);
                        await new Promise((r) => setTimeout(r, 200));
                        continue;
                      }
                    }
                    providerManager.trackRequest(
                      provKey,
                      durationMs,
                      false,
                      res.status,
                      data?.meta?.message || res.statusText,
                    );
                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: res.status,
                      category: "permission",
                      durationMs,
                      retries: attempt,
                      circuitState,
                      message: `Non-retryable status ${res.status}: ${data?.meta?.message || res.statusText}`,
                    });
                    throw new Error(
                      `Non-retryable HTTP ${res.status} from ${provider.name}`,
                    );
                  }

                  // 6. Retryable server errors: 500, 502, 503, 504
                  if (res.status >= 500) {
                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: res.status,
                      category: "server_error",
                      durationMs,
                      retries: attempt,
                      circuitState,
                      message: `Upstream server error HTTP ${res.status}`,
                    });
                    if (attempt < maxRetries) {
                      const delay = backoffDelays[attempt] || 5000;
                      console.log(
                        `[SmartRetry] [${provider.name}] Retrying table ${eventId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`,
                      );
                      await new Promise((r) => setTimeout(r, delay));
                      continue;
                    }
                    providerManager.trackRequest(
                      provKey,
                      durationMs,
                      false,
                      res.status,
                      `Server error ${res.status}`,
                    );
                    throw new Error(
                      `Provider ${provider.name} failed with HTTP ${res.status}`,
                    );
                  }

                  throw new Error(
                    `Unexpected response from ${provider.name}: ${JSON.stringify(data || res.status)}`,
                  );
                } catch (callErr) {
                  const durationMs = Date.now() - startTime;
                  const isNetworkError =
                    callErr.message &&
                    (callErr.message.includes("timeout") ||
                      callErr.message.includes("ECONNRESET") ||
                      callErr.message.includes("socket hang up") ||
                      callErr.message.includes("ETIMEDOUT"));

                  if (isNetworkError && attempt < maxRetries) {
                    const delay = backoffDelays[attempt] || 5000;
                    logAudit({
                      provider: provider.name,
                      tableId: eventId,
                      statusCode: "NET_ERR",
                      category: "server_error",
                      durationMs,
                      retries: attempt,
                      circuitState: providerManager.getState(provKey),
                      message: `Network error (${callErr.message}). Retrying in ${delay / 1000}s...`,
                    });
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                  }

                  throw callErr;
                }
              }
            },
          );

          if (result && result.url) {
            return result;
          }
        } catch (provErr) {
          lastError = provErr;
          const errMsg = provErr.message || "Unknown provider error";
          providerHealth[provKey].status = "ERROR";
          providerHealth[provKey].lastError = errMsg;
          providerHealth[provKey].failureCount =
            (providerHealth[provKey].failureCount || 0) + 1;

          if (provKey === _activePrimaryProvider) {
            const nextProv =
              fallbackKeys.find((k) => providerManager.isAvailable(k)) ||
              fallbackKeys[0];
            if (nextProv && nextProv !== provKey) {
              _lastFailoverEvent = {
                from: provKey,
                to: nextProv,
                at: new Date().toISOString(),
                reason: errMsg,
                tableId: eventId,
              };
              _activePrimaryProvider = nextProv;
              console.warn(
                `[Failover Brain] ⚡ Switched active primary: ${provKey} -> ${nextProv} (Reason: ${errMsg})`,
              );
            }
          }
          console.warn(
            `[Failover] Provider ${provider.name} unavailable for ${eventId}: ${errMsg}. Failing over instantly to next provider...`,
          );
        }
      }

      throw new Error(
        `Failed to obtain watch link for table ${eventId} from any provider: ${lastError ? lastError.message : "All providers exhausted"}`,
      );
    } finally {
      await redisClient.releaseLock(lockKey).catch(() => {});
    }
  })();

  inFlightWatchLinks.set(eventId, task);
  try {
    return await task;
  } finally {
    inFlightWatchLinks.delete(eventId);
  }
}

// Multi-Provider Sports WatchLink Resolution with Queue, Circuit Breaker & Redis
async function getSportsWatchUrl(rawEventId, sportId = "4") {
  let streamId = String(rawEventId || "").trim();
  const cacheKey = `watchlink:sports_${streamId}`;

  // 1. Check Redis Cache
  const redisCached = await redisClient.get(cacheKey);
  if (
    redisCached &&
    redisCached.url &&
    Date.now() < (redisCached.expiresAt || 0)
  ) {
    return redisCached;
  }

  // 2. Check RAM Cache
  const cached = watchLinkCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const providerList = ["cbtf", "startexch", "asstarplay"];

  // 3. If eventId is a long internal ID (e.g. 40020...), resolve its actual Betfair eventId
  if (
    streamId.length > 9 &&
    (streamId.startsWith("400") ||
      streamId.startsWith("100") ||
      streamId.startsWith("200"))
  ) {
    try {
      const token = await getAuthToken("cbtf");
      const marketRes = await proxyFetch(
        `${PROVIDERS.cbtf.base}/api/exchange/markets/getMarketsEventList`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            Origin: PROVIDERS.cbtf.base,
            Referer: `${PROVIDERS.cbtf.base}/`,
            "User-Agent": UA,
            ...MOBILE_HEADERS,
          },
          body: JSON.stringify({ eventId: streamId, sportId: String(sportId) }),
        },
      );
      const mData = await marketRes.json();
      const rawData = mData?.data?.data || mData?.data || {};
      const resolved =
        rawData.matchOddsData?.[0]?.eventId ||
        rawData.bookmakersData?.[0]?.eventId ||
        rawData.streamId;
      if (resolved) {
        console.log(
          `[Sports] Resolved Betfair streamId: ${rawEventId} -> ${resolved}`,
        );
        streamId = String(resolved);
      }
    } catch (e) {
      console.warn(
        `[Sports] Error resolving Betfair ID for ${rawEventId}:`,
        e.message,
      );
    }
  }

  // 4. Query exchEventsWatchLink across providers through Provider Queue
  for (const provKey of providerList) {
    const provider = PROVIDERS[provKey];
    if (!provider || !providerManager.isAvailable(provKey)) continue;

    try {
      const result = await providerManager.schedule(
        provKey,
        streamId,
        async () => {
          const token = await getAuthToken(provKey);
          const res = await proxyFetch(
            `${provider.base}/api/exchange/streaming/exchEventsWatchLink`,
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
              body: JSON.stringify({ streamId, timestamp: Date.now() }),
              timeout: 8000,
            },
          );

          const data = await res.json();
          if (data?.data?.url) {
            providerManager.recordSuccess(provKey);
            const ttlSec = resolveWatchLinkTtl(
              data.data.url,
              CONFIG.watchlinkTtlSec,
            );
            const sportsData = {
              url: data.data.url,
              provider: provider.name,
              provKey: provKey,
              origin: provider.base,
              streamId,
              expiresAt: Date.now() + ttlSec * 1000,
            };
            await redisClient.set(cacheKey, sportsData, ttlSec);
            watchLinkCache.set(cacheKey, sportsData);
            console.log(
              `[Sports] Acquired sports stream URL from ${provider.name}: ${data.data.url}`,
            );
            return sportsData;
          }

          if (res.status === 429) {
            providerManager.tripCooldown(
              provKey,
              CONFIG.cooldownMs,
              "HTTP 429 in sports watch link",
            );
          }
          throw new Error(`No stream URL in ${provider.name} response`);
        },
      );

      if (result && result.url) {
        return result;
      }
    } catch (err) {
      console.warn(
        `[Sports] Watchlink error on ${provider.name}:`,
        err.message,
      );
    }
  }

  throw new Error(
    `No live TV coverage currently available for sports event ${rawEventId}`,
  );
}

let _sportsEventsCache = null;
let _sportsEventsCacheExpires = 0;

// Fetch all active live sports events (Cricket, Football, Tennis) with multi-provider failover & RAM cache
async function getLiveSportsEvents() {
  if (_sportsEventsCache && Date.now() < _sportsEventsCacheExpires) {
    return _sportsEventsCache;
  }

  const providerList = ["cbtf", "startexch", "asstarplay"];
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
      const res = await proxyFetch(
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
          timeout: 8000,
        },
      );

      const data = await res.json();
      const result = [];

      if (data?.data) {
        for (const [sId, list] of Object.entries(data.data)) {
          if (Array.isArray(list)) {
            for (const ev of list) {
              const isInPlay = Boolean(
                ev?.oddsData?.inPlay ?? ev?.inPlay ?? false,
              );
              result.push({
                id: String(ev.exEventId || ev._id || ""),
                name: ev.eventName || "Unnamed Match",
                sportId: String(sId),
                sportName: sportNames[sId] || "Other Sport",
                tournament: ev.tournamentName || "",
                inPlay: isInPlay,
                eventTime: ev.eventTime || "",
                tv: true,
              });
            }
          }
        }
      }

      if (result.length > 0) {
        result.sort((a, b) => {
          if (a.inPlay && !b.inPlay) return -1;
          if (!a.inPlay && b.inPlay) return 1;
          return 0;
        });

        _sportsEventsCache = result;
        _sportsEventsCacheExpires = Date.now() + 30000;
        await redisClient.set("sports:events", result, 600).catch(() => {});
        return result;
      }
    } catch (err) {
      console.warn(
        `[Sports] Failed to fetch events from ${provKey}:`,
        err.message,
      );
    }
  }

  // Resilient Redis Fallback: Return last known live matches if upstream is temporarily in cooldown
  try {
    const redisStored = await redisClient.get("sports:events");
    if (Array.isArray(redisStored) && redisStored.length > 0) {
      _sportsEventsCache = redisStored;
      return redisStored;
    }
  } catch (_) {}

  return _sportsEventsCache || [];
}

async function invalidateWatchUrl(eventId) {
  const cacheKey = `watchlink:${eventId}`;
  watchLinkCache.delete(eventId);
  await redisClient.del(cacheKey).catch(() => {});
}

module.exports = {
  getAuthToken,
  invalidateAuthToken,
  getJwtExpiryMs,
  getWatchUrl,
  invalidateWatchUrl,
  getFailoverStatus,
  providerHealth,
  getSessionForTable,
  rotateTableSession,
  getAccountForTable,
  rotateTableAccount,
  getSportsWatchUrl,
  getLiveSportsEvents,
  GAME_MAP,
  PROVIDERS,
  UA,
  MOBILE_HEADERS,
  proxyFetch,
  directFetch,
  getProxyAgent,
  resetProxyAgent,
  rotateStickySession,
  getEffectiveProxyUrl,
  providerManager,
  watchLinkCache,
  logAudit,
  redisClient,
  CONFIG,
  resolveWatchLinkTtl,
};
