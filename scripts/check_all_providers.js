const https = require('https');

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MOBILE_HEADERS = {
  'Sec-CH-UA': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
  'Sec-CH-UA-Mobile': '?1',
  'Sec-CH-UA-Platform': '"Android"',
  'X-Requested-With': 'XMLHttpRequest'
};

const PROVIDERS = {
  cbtf: {
    name: 'CBTFexchange',
    base: 'https://cbtfexchange.com',
    casinoBase: 'https://casino.cbtfexchange.com',
    accounts: [
      { user: '8292463648', pass: 'Asdf1234', siteKey: '2' }
    ]
  },
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
  }
};

function postJson(urlStr, data, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const body = JSON.stringify(data);
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': UA,
          ...MOBILE_HEADERS,
          ...headers
        },
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, raw });
          }
        });
      });
      req.on('error', err => resolve({ status: 0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 408, error: 'Timeout' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

function getHtml(urlStr, headers = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'iframe',
          'Sec-Fetch-Mode': 'navigate',
          ...headers
        },
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => resolve({ status: res.statusCode, html: raw }));
      });
      req.on('error', err => resolve({ status: 0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 408, error: 'Timeout' }); });
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

(async () => {
  console.log('========================================================================');
  console.log('🔍 AUDITING ALL 4 PROVIDERS & 7 ACCOUNTS FOR LIVE CASINO STREAMING');
  console.log('========================================================================\n');

  const results = [];

  for (const [provKey, prov] of Object.entries(PROVIDERS)) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`📍 PROVIDER: ${prov.name} (${prov.base})`);
    console.log(`------------------------------------------------------------`);

    for (const acc of prov.accounts) {
      process.stdout.write(`Checking Account: [${acc.user}] ... `);
      
      const loginPayload = { userName: acc.user, password: acc.pass };
      if (acc.siteKey) loginPayload.siteKey = acc.siteKey;

      const loginRes = await postJson(`${prov.base}/app/users/userLogin`, loginPayload, {
        'Origin': prov.base,
        'Referer': `${prov.base}/`
      });

      if (loginRes.status !== 200 || !loginRes.data?.data?.accessToken) {
        const msg = loginRes.data?.meta?.message || loginRes.error || `HTTP ${loginRes.status}`;
        console.log(`❌ LOGIN FAILED (${msg})`);
        results.push({ provider: prov.name, user: acc.user, login: 'FAILED', tv: 'NO', details: msg });
        continue;
      }

      const token = loginRes.data.data.accessToken;
      const userDetail = loginRes.data.data.userDetail;
      const isLiveCasino = userDetail?.isLiveCasino;

      // Now test casinoGameWatchLink for Teen Patti 20-20 (99.0010)
      const watchRes = await postJson(`${prov.casinoBase}/casinoapp/exchange/users/streaming/casinoGameWatchLink`, {
        streamId: '99.0010',
        timestamp: Date.now()
      }, {
        'Authorization': `Bearer ${token}`,
        'Origin': prov.base,
        'Referer': `${prov.base}/`
      });

      const watchUrl = watchRes.data?.data?.url;
      const watchMsg = watchRes.data?.meta?.message || watchRes.error || `HTTP ${watchRes.status}`;

      if (watchRes.status === 200 && watchUrl) {
        // Test fetching watchUrl
        const pageRes = await getHtml(watchUrl, {
          'Referer': `${prov.casinoBase}/`,
          'Origin': prov.casinoBase
        });

        const hasCfg = pageRes.html && pageRes.html.includes('cfg');
        if (hasCfg) {
          console.log(`✅ TV WORKING! (WatchLink 200, Player Loaded with CFG)`);
          results.push({ provider: prov.name, user: acc.user, login: 'OK', tv: 'YES (WORKING)', details: 'WatchLink 200 + Player CFG Active' });
        } else {
          const isBlocked = pageRes.html && pageRes.html.includes('Access blocked');
          const blockedReason = isBlocked ? 'Platin CDN P1/B1 Block' : `Page Status ${pageRes.status}`;
          console.log(`⚠️ WATCHLINK OK, BUT PLATIN REJECTED (${blockedReason})`);
          results.push({ provider: prov.name, user: acc.user, login: 'OK', tv: 'PARTIAL', details: `WatchLink 200, Platin: ${blockedReason}` });
        }
      } else {
        console.log(`❌ WATCHLINK FAILED (${watchMsg})`);
        results.push({ provider: prov.name, user: acc.user, login: 'OK', tv: 'NO', details: `isLiveCasino: ${isLiveCasino}, Error: ${watchMsg}` });
      }
    }
  }

  console.log('\n\n========================================================================');
  console.log('📊 FINAL AUDIT SUMMARY TABLE:');
  console.log('========================================================================');
  console.table(results);
})();
