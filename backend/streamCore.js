// Polyfill for Node.js versions lacking zstd in zlib (Fixes Undici 8+ bind crash)
const zlib = require('node:zlib');
if (!zlib.createZstdDecompress) {
  zlib.createZstdDecompress = function() {};
}
if (!zlib.constants) zlib.constants = {};
if (!zlib.constants.ZSTD_d_windowLogMax) zlib.constants.ZSTD_d_windowLogMax = 23;

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { ProxyAgent } = require('undici');

let _proxyDispatcher = undefined;
function getProxyDispatcher() {
  if (_proxyDispatcher !== undefined) return _proxyDispatcher;
  let pUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (pUrl) {
    if (pUrl.startsWith('socks5://127.0.0.1:40000') || pUrl.startsWith('socks5://localhost:40000')) {
      pUrl = 'http://127.0.0.1:40000';
    }
    try {
      _proxyDispatcher = new ProxyAgent(pUrl);
      console.log(`[StreamCore] Outbound ProxyAgent initialized: ${pUrl.replace(/:\/\/.*@/, '://***:***@')}`);
    } catch (e) {
      try { 
        _proxyDispatcher = new ProxyAgent({ uri: pUrl }); 
      } catch (_) { 
        _proxyDispatcher = null; 
      }
    }
  } else {
    _proxyDispatcher = null;
  }
  return _proxyDispatcher;
}

function proxyFetch(url, options = {}) {
  const d = getProxyDispatcher();
  const opts = { ...options };
  if (d && !opts.dispatcher) {
    opts.dispatcher = d;
  }
  return fetch(url, opts);
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
              return { url: data.data.url, provider: provider.name, origin: provider.casinoBase };
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
  getProxyDispatcher
};
