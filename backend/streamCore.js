const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const http = require('http');
const https = require('https');
const tls = require('tls');
const { URL } = require('url');

let _cachedAgent = null;
let _cachedProxyUrl = null;
let _currentStickySession = Math.floor(Math.random() * 50) + 1;

function getEffectiveProxyUrl(proxyUrlStr) {
  if (!proxyUrlStr) return null;
  // If user provided a Webshare rotating endpoint (like bbmraujs-in-rotate):
  // Webshare's -rotate switches IP on EVERY single connection. This breaks Universe Studio
  // which requires the ticket to be fetched by the exact same IP that requested it.
  // Converting -rotate to a numeric sticky session (-SESSION_NUM) locks the same Indian residential IP!
  if (proxyUrlStr.includes('webshare.io') && proxyUrlStr.includes('-rotate')) {
    return proxyUrlStr.replace('-rotate', `-${_currentStickySession}`);
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

function rotateStickySession() {
  _currentStickySession = (_currentStickySession % 100) + 1;
  resetProxyAgent();
  console.log(`[StreamCore] Rotated sticky residential proxy session to session #${_currentStickySession}`);
}

function getProxyAgent(proxyUrlStr) {
  const effectiveProxyUrl = getEffectiveProxyUrl(proxyUrlStr);
  if (_cachedAgent && _cachedProxyUrl === effectiveProxyUrl) {
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
        return callback(new Error('Proxy CONNECT rejected with status ' + res.statusCode));
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

  _cachedAgent = agent;
  _cachedProxyUrl = effectiveProxyUrl;
  console.log(`[StreamCore] Outbound HTTPS ProxyAgent active: ${effectiveProxyUrl.replace(/:\/\/.*@/, '://***:***@')}`);
  return agent;
}

function proxyFetch(urlStr, options = {}, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;

      const proxyUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      let agent = options.agent;
      if (!agent && proxyUrl && isHttps) {
        agent = getProxyAgent(proxyUrl);
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
      req.on('error', reject);
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

// Queue to serialize watchLink requests with a gentle 120ms rate-limit spacer
let watchLinkQueue = Promise.resolve();
const inFlightWatchLinks = new Map();

// Multi-Provider Casino WatchLink Resolution
async function getWatchUrl(eventId, retries = 3) {
  if (inFlightWatchLinks.has(eventId)) {
    return inFlightWatchLinks.get(eventId);
  }

  const task = (async () => {
    // Try primary provider (nice444), then fallback to startexch
    const providerList = ['nice444', 'startexch', 'asstarplay'];

    for (const provKey of providerList) {
      const provider = PROVIDERS[provKey];
      try {
        let token = await getAuthToken(provKey);

        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const res = await new Promise((resolve, reject) => {
              watchLinkQueue = watchLinkQueue.then(async () => {
                try {
                  await new Promise(r => setTimeout(r, 120));
                  const r = await proxyFetch(`${provider.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`, {
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
                    })
                  });
                  resolve(r);
                } catch (e) {
                  reject(e);
                }
              });
            });

            const data = await res.json();
            
            if (data?.meta?.status_code === 401 || res.status === 401) {
              console.warn(`[WatchLink] Token expired (401) on ${provider.name}, refreshing...`);
              token = await getAuthToken(provKey, true);
              continue;
            }

            if (data?.data?.url) {
              return { url: data.data.url, provider: provider.name, origin: provider.base };
            }

            if (data?.meta?.message === 'viewer_ip_blocked' || res.status === 403) {
              console.warn(`[WatchLink] IP blocked on ${provider.name}. Rotating sticky residential proxy session...`);
              rotateStickySession();
              await new Promise(r => setTimeout(r, 400));
              continue;
            }

            console.warn(`[WatchLink] ${provider.name} attempt ${attempt} response:`, data?.meta?.message || data);
            await new Promise(r => setTimeout(r, 250));
          } catch (err) {
            console.warn(`[WatchLink] Error on ${provider.name} attempt ${attempt}:`, err.message);
            await new Promise(r => setTimeout(r, 250));
          }
        }
      } catch (provErr) {
        console.warn(`[WatchLink] Provider ${provider.name} exhausted, failing over to next provider...`);
      }
    }

    throw new Error(`Failed to obtain watch link for table ${eventId} from any provider.`);
  })();

  inFlightWatchLinks.set(eventId, task);
  try {
    return await task;
  } finally {
    inFlightWatchLinks.delete(eventId);
  }
}

// Multi-Provider Sports WatchLink Resolution
async function getSportsWatchUrl(rawEventId, sportId = '4') {
  let streamId = String(rawEventId || '').trim();
  const providerList = ['nice444', 'startexch', 'asstarplay'];

  // 1. If eventId is a long internal ID (e.g. 40020...), resolve its actual Betfair eventId
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

  // 2. Query exchEventsWatchLink across providers
  for (const provKey of providerList) {
    const provider = PROVIDERS[provKey];
    try {
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
        body: JSON.stringify({ streamId, timestamp: Date.now() })
      });

      const data = await res.json();
      if (data?.data?.url) {
        console.log(`[Sports] Acquired sports stream URL from ${provider.name}: ${data.data.url}`);
        return { url: data.data.url, provider: provider.name, origin: provider.base, streamId };
      }
    } catch (err) {
      console.warn(`[Sports] Watchlink error on ${provider.name}:`, err.message);
    }
  }

  throw new Error(`No live TV coverage currently available for sports event ${rawEventId}`);
}

// Fetch all active live sports events (Cricket, Football, Tennis)
async function getLiveSportsEvents() {
  try {
    const token = await getAuthToken('nice444');
    const res = await proxyFetch(`${PROVIDERS.nice444.base}/api/exchange/market/matchodds/allEventsList`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({})
    });

    const data = await res.json();
    const result = [];
    const sportNames = { '1': 'Soccer', '2': 'Tennis', '4': 'Cricket', '7': 'Horse Racing' };

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

    // Sort: In-Play matches first, then by eventTime
    result.sort((a, b) => {
      if (a.inPlay && !b.inPlay) return -1;
      if (!a.inPlay && b.inPlay) return 1;
      return 0;
    });

    return result;
  } catch (err) {
    console.error('[Sports] Failed to fetch live sports events:', err.message);
    return [];
  }
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
  resetProxyAgent
};
