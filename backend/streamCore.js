const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

let _cachedAgent = null;
let _cachedProxyUrl = null;
let _currentStickySession = Math.floor(Math.random() * 10) + 1; // Strict 1 to 10 pool of Webshare Indian Residential sessions

function getEffectiveProxyUrl(proxyUrlStr, sessionOverride = null) {
  if (!proxyUrlStr) return null;
  const rawSession = sessionOverride || _currentStickySession;
  const session = ((Math.abs(Number(rawSession) || 1) - 1) % 10) + 1; // Strict 1 to 10 pool
  if (proxyUrlStr.includes('webshare.io') && proxyUrlStr.includes('-rotate')) {
    return proxyUrlStr.replace('-rotate', `-${session}`);
  }
  return proxyUrlStr;
}

function resetProxyAgent() {
  if (_cachedAgent) {
    try {
      _cachedAgent.destroy();
    } catch (_) {}
    _cachedAgent = null;
    _cachedProxyUrl = null;
  }
}

let _lastRotateTime = 0;
function rotateStickySession(reason = '') {
  const now = Date.now();
  // Cooldown: at least 10 seconds between rotations
  if (now - _lastRotateTime < 10000) {
    return _currentStickySession;
  }
  _lastRotateTime = now;
  const oldSession = _currentStickySession;
  _currentStickySession = (_currentStickySession % 10) + 1;
  resetProxyAgent();
  console.log(`[StreamCore] Rotated sticky residential proxy session from #${oldSession} -> #${_currentStickySession} (Reason: ${reason || 'unspecified'})`);
  return _currentStickySession;
}

function getProxyAgent(proxyUrlStr, sessionOverride = null) {
  const effectiveProxyUrl = getEffectiveProxyUrl(proxyUrlStr, sessionOverride);
  if (!sessionOverride && _cachedAgent && _cachedProxyUrl === effectiveProxyUrl) {
    return _cachedAgent;
  }
  const pUrl = new URL(effectiveProxyUrl);
  const proxyAuth = pUrl.username 
    ? 'Basic ' + Buffer.from(decodeURIComponent(pUrl.username) + ':' + decodeURIComponent(pUrl.password)).toString('base64') 
    : null;

  const agent = new https.Agent({
    keepAlive: false,
    timeout: 20000
  });

  agent.createConnection = function(options, callback) {
    const targetHost = options.host || options.hostname;
    const targetPort = options.port || 443;
    const connectReq = http.request({
      host: pUrl.hostname,
      port: pUrl.port || 80,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: {
        'Host': targetHost + ':' + targetPort,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {})
      }
    });

    connectReq.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        if (res.statusCode === 502 || res.statusCode === 503) {
          rotateStickySession('Proxy CONNECT status ' + res.statusCode);
        }
        return callback(new Error('Proxy CONNECT rejected with status ' + res.statusCode));
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }
      const tlsSocket = tls.connect({
        socket: socket,
        servername: options.servername || targetHost,
        rejectUnauthorized: false
      }, () => {
        callback(null, tlsSocket);
      });
      tlsSocket.on('error', (err) => {
        socket.destroy();
        callback(err);
      });
    });

    connectReq.on('error', (err) => {
      callback(err);
    });
    connectReq.end();
  };

  if (!sessionOverride) {
    _cachedAgent = agent;
    _cachedProxyUrl = effectiveProxyUrl;
  }
  return agent;
}

function proxyFetch(urlStr, options = {}, redirectCount = 0, retryCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;

      const proxyUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      let agent = options.agent;
      if (!agent && proxyUrl && isHttps) {
        agent = getProxyAgent(proxyUrl, options.session);
      }

      const headers = { ...(options.headers || {}) };
      let body = options.body;
      if (body && typeof body === 'object' && !(body instanceof Buffer)) {
        body = JSON.stringify(body);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
      if (body) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers: headers,
        agent: agent,
        timeout: options.timeout || 20000,
        rejectUnauthorized: false
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, urlStr).href;
          return resolve(proxyFetch(redirectUrl, options, redirectCount + 1));
        }

        if ((res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) && retryCount < 3) {
          rotateStickySession();
          const delay = 150 * Math.pow(2, retryCount);
          return setTimeout(() => {
            const freshOptions = { ...options };
            delete freshOptions.agent;
            resolve(proxyFetch(urlStr, freshOptions, redirectCount, retryCount + 1));
          }, delay);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
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
              raw() { return res.headers; }
            },
            async text() {
              return fullBuf.toString('utf8');
            },
            async json() {
              return JSON.parse(fullBuf.toString('utf8'));
            },
            async arrayBuffer() {
              return fullBuf.buffer.slice(fullBuf.byteOffset, fullBuf.byteOffset + fullBuf.byteLength);
            }
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
      });
      req.on('error', (err) => {
        const isTransient = err.message && (
          err.message.includes('502') || 
          err.message.includes('503') || 
          err.message.includes('504') || 
          err.message.includes('ECONNRESET') || 
          err.message.includes('ETIMEDOUT') || 
          err.message.includes('socket hang up')
        );
        if (isTransient && retryCount < 3) {
          rotateStickySession();
          const delay = 150 * Math.pow(2, retryCount);
          return setTimeout(() => {
            const freshOptions = { ...options };
            delete freshOptions.agent;
            resolve(proxyFetch(urlStr, freshOptions, redirectCount, retryCount + 1));
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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 4-Provider Multi-Account Redundancy Pool (from Internatniol)
const PROVIDERS = {
  nice444: {
    name: 'Nice444',
    base: 'https://nice444.com',
    casinoBase: 'https://casino.nice444.com',
    accounts: [
      { user: 'demo52', pass: 'Asdf1234' },
      { user: 'rio001', pass: 'Asdf1234' }
    ]
  },
  startexch: {
    name: 'Startexch99',
    base: 'https://startexch99.com',
    casinoBase: 'https://casino.startexch99.com',
    accounts: [
      { user: 'smdemo', pass: 'Asdf12345' },
      { user: 'suraj01s', pass: 'Asdf12345' },
      { user: 'santosh01s', pass: 'Asdf12345' }
    ]
  },
  asstarplay: {
    name: 'Asstarplay',
    base: 'https://asstarplay.com',
    casinoBase: 'https://casino.asstarplay.com',
    accounts: [
      { user: 'zak1984', pass: 'Asdf123' }
    ]
  },
  cbtf: {
    name: 'CBTFexchange',
    base: 'https://cbtfexchange.com',
    casinoBase: 'https://casino.cbtfexchange.com',
    accounts: [
      { user: '8292463648', pass: 'Asdf1234', siteKey: '2' }
    ]
  }
};

// Sessions memory state
const sessionState = {
  nice444: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  startexch: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  asstarplay: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null },
  cbtf: { token: null, expiresAt: 0, accountIndex: 0, inFlight: null }
};

// Unified Token Authenticator with Mutex and Account Failover
async function getAuthToken(providerKey = 'nice444', forceRefresh = false) {
  const provider = PROVIDERS[providerKey] || PROVIDERS.nice444;
  const state = sessionState[providerKey] || sessionState.nice444;

  if (!forceRefresh && state.token && Date.now() < state.expiresAt) {
    return state.token;
  }

  if (state.inFlight) {
    return state.inFlight;
  }

  state.inFlight = (async () => {
    try {
      const accounts = provider.accounts;
      for (let i = 0; i < accounts.length; i++) {
        const accIdx = (state.accountIndex + i) % accounts.length;
        const acc = accounts[accIdx];
        try {
          console.log(`[Auth] Authenticating with ${provider.name} (account: ${acc.user})...`);
          
          const bodyPayload = { userName: acc.user, password: acc.pass };
          if (acc.siteKey) bodyPayload.siteKey = acc.siteKey;

          const res = await proxyFetch(`${provider.base}/app/users/userLogin`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': provider.base,
              'Referer': `${provider.base}/`,
              'User-Agent': UA
            },
            body: JSON.stringify(bodyPayload)
          });

          const data = await res.json();
          if (data?.data?.accessToken) {
            state.token = data.data.accessToken;
            state.expiresAt = Date.now() + 3600 * 1000 * 2;
            state.accountIndex = accIdx;
            console.log(`[Auth] Unified token obtained for ${provider.name} (${acc.user})`);
            return state.token;
          }
          console.warn(`[Auth] Login rejected for ${provider.name} (${acc.user}):`, data?.meta?.message || data);
        } catch (err) {
          console.warn(`[Auth] Connection error for ${provider.name} (${acc.user}):`, err.message);
        }
      }
      throw new Error(`All accounts failed for provider ${provider.name}`);
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

// Map of eventId to Game metadata (All 17 Active Live Dealer Tables)
const GAME_MAP = {
  '99.0010': { name: '20-20 Teen Patti', streamId: 'GAME10', category: 'Teen Patti' },
  '99.0013': { name: '1 Day Teen Patti', streamId: 'GAME13', category: 'Teen Patti' },
  '99.0014': { name: 'Muflis Teen Patti', streamId: 'GAME14', category: 'Teen Patti' },
  '99.0016': { name: 'Joker Teen Patti', streamId: 'GAME16', category: 'Teen Patti' },
  '99.0030': { name: 'Lucky 7', streamId: 'GAME30', category: 'Lucky 7' },
  '99.0018': { name: 'Dragon Tiger', streamId: 'GAME18', category: 'Dragon Tiger' },
  '99.0019': { name: '20-20 Dragon Tiger', streamId: 'GAME19', category: 'Dragon Tiger' },
  '99.0021': { name: '1 Day Dragon Tiger', streamId: 'GAME21', category: 'Dragon Tiger' },
  '99.0041': { name: 'DTL (Dragon Tiger Lion)', streamId: 'GAME41', category: 'Dragon Tiger' },
  '99.0025': { name: 'Andar Bahar', streamId: 'GAME25', category: 'Andar Bahar' },
  '99.0022': { name: '32 Cards', streamId: 'GAME22', category: 'Cards' },
  '99.0001': { name: 'Baccarat', streamId: 'GAME01', category: 'Baccarat' },
  '99.0027': { name: 'Casino War', streamId: 'GAME27', category: 'Cards' },
  '99.0007': { name: '20-20 Poker', streamId: 'GAME07', category: 'Poker' },
  '99.0040': { name: '3 Card Judgement', streamId: 'GAME40', category: 'Cards' },
  '99.0046': { name: '20-20 Card Race', streamId: 'GAME46', category: 'Cards' },
  '99.0005': { name: 'Amar Akbar Anthony', streamId: 'GAME05', category: 'Special' },
};

// ============================================================================
// Enterprise Provider Rate Limiter, Smart Retry & Circuit Breaker Engine
// ============================================================================

class ProviderManager {
  constructor() {
    this.providers = {
      startexch: this._createProviderState('startexch', 'Startexch99'),
      nice444: this._createProviderState('nice444', 'Nice444'),
      asstarplay: this._createProviderState('asstarplay', 'Asstarplay'),
      cbtf: this._createProviderState('cbtf', 'CBTFexchange'),
    };
  }

  _createProviderState(key, name) {
    return {
      key,
      name,
      queue: [],             // FIFO queue of requests
      running: false,        // Concurrency = 1
      lastRequestTime: 0,    // Timestamp of last completion
      minIntervalMs: 2000,   // Configurable 2-second minimum interval between requests
      
      // Circuit Breaker state machine: CLOSED -> OPEN -> HALF_OPEN
      state: 'CLOSED',
      cooldownUntil: 0,
      consecutiveFailures: 0,
      probeInFlight: false,

      // Deduplication of simultaneous requests for the same table on this provider
      inFlightByTable: new Map()
    };
  }

  // Check if provider is available to accept new requests
  isAvailable(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return false;
    const now = Date.now();
    if (prov.state === 'OPEN') {
      if (now >= prov.cooldownUntil) {
        prov.state = 'HALF_OPEN';
        prov.probeInFlight = false;
        console.log(`[CircuitBreaker] [${prov.name}] Cooldown expired. Transitioned -> HALF_OPEN (Probe allowed).`);
        return true;
      }
      return false; // In cooldown (OPEN)
    }
    if (prov.state === 'HALF_OPEN') {
      return !prov.probeInFlight; // Allow only 1 probe request
    }
    return true; // CLOSED is healthy
  }

  getState(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return 'UNKNOWN';
    if (prov.state === 'OPEN' && Date.now() >= prov.cooldownUntil) {
      prov.state = 'HALF_OPEN';
      prov.probeInFlight = false;
    }
    return prov.state;
  }

  // Trip circuit breaker into cooldown (OPEN)
  tripCooldown(provKey, durationMs = 60000, reason = '') {
    const prov = this.providers[provKey];
    if (!prov) return;
    prov.state = 'OPEN';
    prov.cooldownUntil = Date.now() + durationMs;
    prov.consecutiveFailures++;
    prov.probeInFlight = false;
    console.warn(`[CircuitBreaker] [${prov.name}] TRIPPED -> OPEN for ${Math.round(durationMs / 1000)}s! Reason: ${reason}`);
  }

  // Record success on circuit breaker
  recordSuccess(provKey) {
    const prov = this.providers[provKey];
    if (!prov) return;
    if (prov.state === 'HALF_OPEN' || prov.consecutiveFailures > 0) {
      console.log(`[CircuitBreaker] [${prov.name}] Probe succeeded! Transitioned -> CLOSED (Healthy).`);
    }
    prov.state = 'CLOSED';
    prov.consecutiveFailures = 0;
    prov.cooldownUntil = 0;
    prov.probeInFlight = false;
  }

  // Record failure
  recordFailure(provKey, statusCode, errorMsg = '') {
    const prov = this.providers[provKey];
    if (!prov) return;
    prov.consecutiveFailures++;
    if (prov.state === 'HALF_OPEN') {
      this.tripCooldown(provKey, 60000, `Probe failed: ${errorMsg}`);
    } else if (prov.consecutiveFailures >= 3) {
      this.tripCooldown(provKey, 60000, `3 consecutive failures: ${errorMsg}`);
    }
  }

  // Schedule a task through the provider's dedicated FIFO queue
  schedule(provKey, tableId, taskFn) {
    const prov = this.providers[provKey];
    if (!prov) {
      return Promise.reject(new Error(`Unknown provider ${provKey}`));
    }

    // Deduplicate simultaneous requests for same table and provider
    if (tableId && prov.inFlightByTable.has(tableId)) {
      console.log(`[ProviderQueue] [${prov.name}] Reusing in-flight request for table ${tableId}`);
      return prov.inFlightByTable.get(tableId);
    }

    const promise = new Promise((resolve, reject) => {
      prov.queue.push({ taskFn, resolve, reject, tableId, queuedAt: Date.now() });
      this._processQueue(provKey);
    });

    if (tableId) {
      prov.inFlightByTable.set(tableId, promise);
      promise.finally(() => {
        prov.inFlightByTable.delete(tableId);
      });
    }

    return promise;
  }

  _processQueue(provKey) {
    const prov = this.providers[provKey];
    if (!prov || prov.running || prov.queue.length === 0) return;

    const now = Date.now();
    const timeSinceLast = now - prov.lastRequestTime;
    const waitTime = Math.max(0, prov.minIntervalMs - timeSinceLast);

    if (waitTime > 0) {
      setTimeout(() => this._processQueue(provKey), waitTime);
      return;
    }

    // Check circuit breaker status
    if (prov.state === 'OPEN') {
      if (now < prov.cooldownUntil) {
        // Provider still in cooldown, reject queued items so caller can fail over
        while (prov.queue.length > 0) {
          const item = prov.queue.shift();
          item.reject(new Error(`Provider ${prov.name} is in cooldown (OPEN)`));
        }
        return;
      }
      prov.state = 'HALF_OPEN';
    }

    if (prov.state === 'HALF_OPEN' && prov.probeInFlight) {
      return; // Waiting for probe to complete
    }

    const nextItem = prov.queue.shift();
    if (!nextItem) return;

    prov.running = true;
    if (prov.state === 'HALF_OPEN') {
      prov.probeInFlight = true;
    }

    (async () => {
      try {
        const result = await nextItem.taskFn();
        nextItem.resolve(result);
      } catch (err) {
        nextItem.reject(err);
      } finally {
        prov.running = false;
        prov.lastRequestTime = Date.now();
        setTimeout(() => this._processQueue(provKey), prov.minIntervalMs);
      }
    })();
  }
}

const providerManager = new ProviderManager();

// Structured Audit Logging Function
function logAudit({ provider, tableId, statusCode, category, durationMs, retries, circuitState, message }) {
  const ts = new Date().toISOString();
  console.log(`[AUDIT] [${provider}] Table: ${tableId} | Status: ${statusCode || 'ERR'} | Cat: ${category} | Time: ${durationMs}ms | Retries: ${retries} | Circuit: ${circuitState} | ${message}`);
}

// 15-Minute In-Memory WatchLink Cache & Global In-Flight Mutex
const WATCHLINK_CACHE_TTL = 15 * 60 * 1000;
const watchLinkCache = new Map();
const inFlightWatchLinks = new Map();

// Multi-Provider Casino WatchLink Resolution with Rate Limiting, Smart Retry & Circuit Breaker
async function getWatchUrl(eventId) {
  // 1. Check 15-Minute RAM Cache (Serves instantly in 0ms)
  const cached = watchLinkCache.get(eventId);
  if (cached && Date.now() < cached.expiresAt) {
    logAudit({
      provider: cached.provider,
      tableId: eventId,
      statusCode: 200,
      category: 'success',
      durationMs: 0,
      retries: 0,
      circuitState: providerManager.getState(cached.provKey || 'startexch'),
      message: 'WatchLink served directly from 15m RAM cache'
    });
    return cached;
  }

  // 2. Global single-flight deduplication across all concurrent callers
  if (inFlightWatchLinks.has(eventId)) {
    return inFlightWatchLinks.get(eventId);
  }

  const task = (async () => {
    const providerList = ['startexch', 'nice444', 'asstarplay', 'cbtf'];
    const maxRetries = 2;
    const backoffDelays = [5000, 15000]; // 5s then 15s exponential backoff
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
          category: 'rate_limiting',
          durationMs: 0,
          retries: 0,
          circuitState: 'OPEN',
          message: 'Provider in cooldown, skipping to next provider'
        });
        continue;
      }

      try {
        // Schedule through provider's independent FIFO queue (concurrency=1, 2s gap)
        const result = await providerManager.schedule(provKey, eventId, async () => {
          let token = await getAuthToken(provKey);
          let tokenRefreshed = false;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const startTime = Date.now();
            let res = null;
            let data = null;

            try {
              res = await proxyFetch(`${provider.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                  'Origin': provider.casinoBase,
                  'Referer': `${provider.casinoBase}/`,
                  'User-Agent': UA
                },
                body: JSON.stringify({
                  streamId: eventId,
                  timestamp: Date.now()
                }),
                timeout: 10000
              });

              data = await res.json().catch(() => null);
              const durationMs = Date.now() - startTime;
              const circuitState = providerManager.getState(provKey);

              // 1. Success 200 OK with valid URL
              if (res.ok && data?.data?.url) {
                providerManager.recordSuccess(provKey);
                const watchData = {
                  url: data.data.url,
                  provider: provider.name,
                  provKey: provKey,
                  origin: provider.base,
                  session: _currentStickySession,
                  expiresAt: Date.now() + WATCHLINK_CACHE_TTL
                };
                watchLinkCache.set(eventId, watchData);
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: res.status,
                  category: 'success',
                  durationMs,
                  retries: attempt,
                  circuitState,
                  message: `WatchLink acquired successfully: ${data.data.url.slice(0, 45)}...`
                });
                return watchData;
              }

              // 2. HTTP 429: Too Many Requests (Respect Retry-After)
              if (res.status === 429) {
                const retryAfterHeader = res.headers.get('retry-after');
                let cooldownMs = 60000;
                if (retryAfterHeader && !isNaN(parseInt(retryAfterHeader, 10))) {
                  cooldownMs = parseInt(retryAfterHeader, 10) * 1000;
                }
                providerManager.tripCooldown(provKey, cooldownMs, 'HTTP 429 Too Many Requests');
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: 429,
                  category: 'rate_limiting',
                  durationMs,
                  retries: attempt,
                  circuitState: 'OPEN',
                  message: `HTTP 429 rate limit. Tripped cooldown for ${Math.round(cooldownMs / 1000)}s`
                });
                throw new Error(`Provider ${provider.name} rate-limited (HTTP 429)`);
              }

              // 3. IP Blocked: viewer_ip_blocked
              if (data?.meta?.message === 'viewer_ip_blocked' || (res.status === 403 && JSON.stringify(data || '').includes('blocked'))) {
                providerManager.tripCooldown(provKey, 60000, `viewer_ip_blocked on session #${_currentStickySession}`);
                rotateStickySession(`IP blocked on ${provider.name}`);
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: res.status,
                  category: 'rate_limiting',
                  durationMs,
                  retries: attempt,
                  circuitState: 'OPEN',
                  message: `viewer_ip_blocked. Tripped cooldown 60s & rotated proxy session to #${_currentStickySession}`
                });
                throw new Error(`Provider ${provider.name} blocked residential IP`);
              }

              // 4. HTTP 401: Authentication expired
              if (res.status === 401 || data?.meta?.status_code === 401) {
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: 401,
                  category: 'authentication',
                  durationMs,
                  retries: attempt,
                  circuitState,
                  message: 'Token expired (401). Refreshing unified token...'
                });
                if (!tokenRefreshed) {
                  tokenRefreshed = true;
                  token = await getAuthToken(provKey, true);
                  continue; // Retry once with fresh token
                }
                throw new Error(`Token refresh failed for ${provider.name}`);
              }

              // 5. Non-retryable client errors: 400, 403, 404
              if (res.status >= 400 && res.status < 500) {
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: res.status,
                  category: 'permission',
                  durationMs,
                  retries: attempt,
                  circuitState,
                  message: `Non-retryable status ${res.status}: ${data?.meta?.message || res.statusText}`
                });
                throw new Error(`Non-retryable HTTP ${res.status} from ${provider.name}`);
              }

              // 6. Retryable server errors: 500, 502, 503, 504
              if (res.status >= 500) {
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: res.status,
                  category: 'server_error',
                  durationMs,
                  retries: attempt,
                  circuitState,
                  message: `Upstream server error HTTP ${res.status}`
                });
                if (attempt < maxRetries) {
                  const delay = backoffDelays[attempt] || 5000;
                  console.log(`[SmartRetry] [${provider.name}] Retrying table ${eventId} in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
                  await new Promise(r => setTimeout(r, delay));
                  continue;
                }
                providerManager.recordFailure(provKey, res.status, `Server error ${res.status}`);
                throw new Error(`Provider ${provider.name} failed with HTTP ${res.status}`);
              }

              throw new Error(`Unexpected response from ${provider.name}: ${JSON.stringify(data || res.status)}`);

            } catch (callErr) {
              const durationMs = Date.now() - startTime;
              const isNetworkError = callErr.message && (
                callErr.message.includes('timeout') ||
                callErr.message.includes('ECONNRESET') ||
                callErr.message.includes('socket hang up') ||
                callErr.message.includes('ETIMEDOUT')
              );

              if (isNetworkError && attempt < maxRetries) {
                const delay = backoffDelays[attempt] || 5000;
                logAudit({
                  provider: provider.name,
                  tableId: eventId,
                  statusCode: 'NET_ERR',
                  category: 'server_error',
                  durationMs,
                  retries: attempt,
                  circuitState: providerManager.getState(provKey),
                  message: `Network error (${callErr.message}). Retrying in ${delay / 1000}s...`
                });
                await new Promise(r => setTimeout(r, delay));
                continue;
              }

              throw callErr;
            }
          }
        });

        if (result && result.url) {
          return result;
        }
      } catch (provErr) {
        lastError = provErr;
        console.warn(`[Failover] Provider ${provider.name} unavailable for ${eventId}: ${provErr.message}. Failing over to next provider...`);
      }
    }

    throw new Error(`Failed to obtain watch link for table ${eventId} from any provider: ${lastError ? lastError.message : 'All providers exhausted'}`);
  })();

  inFlightWatchLinks.set(eventId, task);
  try {
    return await task;
  } finally {
    inFlightWatchLinks.delete(eventId);
  }
}

// Multi-Provider Sports WatchLink Resolution with Queue & Circuit Breaker
async function getSportsWatchUrl(rawEventId, sportId = '4') {
  let streamId = String(rawEventId || '').trim();
  const cacheKey = `sports_${streamId}`;

  // 1. Check RAM Cache
  const cached = watchLinkCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const providerList = ['nice444', 'startexch', 'asstarplay'];

  // 2. If eventId is a long internal ID (e.g. 40020...), resolve its actual Betfair eventId
  if (streamId.length > 9 && (streamId.startsWith('400') || streamId.startsWith('100') || streamId.startsWith('200'))) {
    try {
      const token = await getAuthToken('nice444');
      const marketRes = await proxyFetch(`${PROVIDERS.nice444.base}/api/exchange/markets/getMarketsEventList`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ eventId: streamId, sportId: String(sportId), key: '2' })
      });
      const mData = await marketRes.json();
      const rawData = mData?.data?.data || mData?.data || {};
      const resolved = rawData.matchOddsData?.[0]?.eventId || rawData.bookmakersData?.[0]?.eventId || rawData.streamId;
      if (resolved) {
        console.log(`[Sports] Resolved Betfair streamId: ${rawEventId} -> ${resolved}`);
        streamId = String(resolved);
      }
    } catch (e) {
      console.warn(`[Sports] Error resolving Betfair ID for ${rawEventId}:`, e.message);
    }
  }

  // 3. Query exchEventsWatchLink across providers through Provider Queue
  for (const provKey of providerList) {
    const provider = PROVIDERS[provKey];
    if (!provider || !providerManager.isAvailable(provKey)) continue;

    try {
      const result = await providerManager.schedule(provKey, streamId, async () => {
        const token = await getAuthToken(provKey);
        const res = await proxyFetch(`${provider.base}/api/exchange/streaming/exchEventsWatchLink`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': provider.base,
            'Referer': `${provider.base}/`,
            'User-Agent': UA
          },
          body: JSON.stringify({ streamId, timestamp: Date.now() }),
          timeout: 8000
        });

        const data = await res.json();
        if (data?.data?.url) {
          providerManager.recordSuccess(provKey);
          const sportsData = {
            url: data.data.url,
            provider: provider.name,
            provKey: provKey,
            origin: provider.base,
            streamId,
            expiresAt: Date.now() + WATCHLINK_CACHE_TTL
          };
          watchLinkCache.set(cacheKey, sportsData);
          console.log(`[Sports] Acquired sports stream URL from ${provider.name}: ${data.data.url}`);
          return sportsData;
        }

        if (res.status === 429) {
          providerManager.tripCooldown(provKey, 60000, 'HTTP 429 in sports watch link');
        }
        throw new Error(`No stream URL in ${provider.name} response`);
      });

      if (result && result.url) {
        return result;
      }
    } catch (err) {
      console.warn(`[Sports] Watchlink error on ${provider.name}:`, err.message);
    }
  }

  throw new Error(`No live TV coverage currently available for sports event ${rawEventId}`);
}

let _sportsEventsCache = null;
let _sportsEventsCacheExpires = 0;

// Fetch all active live sports events (Cricket, Football, Tennis) with multi-provider failover & RAM cache
async function getLiveSportsEvents() {
  if (_sportsEventsCache && Date.now() < _sportsEventsCacheExpires) {
    return _sportsEventsCache;
  }

  const providerList = ['nice444', 'startexch', 'asstarplay'];
  const sportNames = { '1': 'Soccer', '2': 'Tennis', '4': 'Cricket', '7': 'Horse Racing' };

  for (const provKey of providerList) {
    try {
      const provider = PROVIDERS[provKey];
      const token = await getAuthToken(provKey);
      const res = await proxyFetch(`${provider.base}/api/exchange/market/matchodds/allEventsList`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${token}`,
          'Origin': provider.base,
          'Referer': `${provider.base}/`,
          'User-Agent': UA
        },
        body: JSON.stringify({}),
        timeout: 8000
      });

      const data = await res.json();
      const result = [];

      if (data?.data) {
        for (const [sId, list] of Object.entries(data.data)) {
          if (Array.isArray(list)) {
            for (const ev of list) {
              const isInPlay = Boolean(ev?.oddsData?.inPlay ?? ev?.inPlay ?? false);
              result.push({
                id: String(ev.exEventId || ev._id || ''),
                name: ev.eventName || 'Unnamed Match',
                sportId: String(sId),
                sportName: sportNames[sId] || 'Other Sport',
                tournament: ev.tournamentName || '',
                inPlay: isInPlay,
                eventTime: ev.eventTime || '',
                tv: true
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
        return result;
      }
    } catch (err) {
      console.warn(`[Sports] Failed to fetch events from ${provKey}:`, err.message);
    }
  }

  return _sportsEventsCache || [];
}

module.exports = {
  getAuthToken,
  getWatchUrl,
  getSportsWatchUrl,
  getLiveSportsEvents,
  GAME_MAP,
  PROVIDERS,
  UA,
  proxyFetch,
  getProxyAgent,
  resetProxyAgent,
  rotateStickySession,
  getEffectiveProxyUrl,
  providerManager,
  watchLinkCache,
  logAudit
};
