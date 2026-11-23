/**
 * Deep VPS & Stream Diagnostics Script
 * Run on VPS: node scripts/diagnose_vps.js
 * Checks: Proxy health, Provider accounts, WatchLinks, Sports Events, Redis & Whitelist
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// Load environment variables from .env
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envRaw = fs.readFileSync(envPath, 'utf8');
  envRaw.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      process.env[key] = val;
    }
  });
}

const {
  proxyFetch,
  directFetch,
  PROVIDERS,
  UA,
  getAuthToken,
  getWatchUrl,
  getSessionForTable,
  redisClient
} = require('../backend/streamCore');

async function runDiagnostics() {
  console.log('====================================================');
  console.log('🔍 CASINOTV & SPORTSTV DEEP VPS HEALTH DIAGNOSTICS');
  console.log('====================================================');

  const proxyUrl = process.env.UPSTREAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  console.log(`\n[1/6] OUTBOUND PROXY CONFIGURATION`);
  if (!proxyUrl) {
    console.log('⚠️ No UPSTREAM_PROXY_URL configured in .env! Requests go directly from VPS IP.');
  } else {
    console.log(`✅ Proxy Configured: ${proxyUrl.replace(/:\/\/.*@/, '://***:***@')}`);
    try {
      const pRes = await proxyFetch('https://ipinfo.io/json', { timeout: 8000 });
      const pData = await pRes.json();
      console.log(`✅ Proxy Connection OK! Outbound IP: ${pData.ip}, Country: ${pData.country}, ISP: ${pData.org}`);
    } catch (err) {
      console.error(`❌ PROXY FAILED: ${err.message}`);
      console.error(`👉 Cause: Residential proxy credentials wrong, bandwidth quota exhausted (0 GB left), or proxy server unreachable!`);
    }
  }

  console.log(`\n[2/6] PROVIDER DNS & CONNECTIVITY`);
  for (const [key, prov] of Object.entries(PROVIDERS)) {
    try {
      const u = new URL(prov.base);
      const addresses = await new Promise((resolve, reject) => {
        dns.resolve4(u.hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
      });
      console.log(`✅ ${prov.name} (${u.hostname}) resolved to: ${addresses.join(', ')}`);
    } catch (e) {
      console.error(`❌ ${prov.name} DNS resolution failed: ${e.message}`);
    }
  }

  console.log(`\n[3/6] PROVIDER LOGIN & AUTHENTICATION AUDIT`);
  for (const [provKey, prov] of Object.entries(PROVIDERS)) {
    console.log(`\n--- Testing Provider: ${prov.name} (${prov.base}) ---`);
    for (const acc of prov.accounts) {
      try {
        const bodyPayload = { userName: acc.user, password: acc.pass };
        if (acc.siteKey) bodyPayload.siteKey = acc.siteKey;

        const res = await proxyFetch(`${prov.base}/app/users/userLogin`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Origin': prov.base,
            'Referer': `${prov.base}/`,
            'User-Agent': UA
          },
          body: JSON.stringify(bodyPayload),
          timeout: 10000
        });

        const data = await res.json().catch(() => null);
        if (data?.data?.accessToken) {
          console.log(`  ✅ Account ${acc.user}: LOGIN SUCCESS! Token: ${data.data.accessToken.substring(0, 20)}...`);
        } else {
          console.error(`  ❌ Account ${acc.user}: LOGIN REJECTED! HTTP ${res.status}:`, data?.meta?.message || JSON.stringify(data));
        }
      } catch (err) {
        console.error(`  ❌ Account ${acc.user}: CONNECTION ERROR ->`, err.message);
      }
    }
  }

  console.log(`\n[4/6] CASINO STREAM TICKET GENERATION TEST`);
  try {
    const watchData = await getWatchUrl('99.0010', { forceFresh: true });
    console.log(`✅ 20-20 Teen Patti WatchLink generated successfully! URL: ${watchData?.url || watchData}`);
  } catch (err) {
    console.error(`❌ Casino WatchLink Failed: ${err.message}`);
  }

  console.log(`\n[5/6] SPORTS EVENTS LIST UPSTREAM TEST`);
  try {
    const token = await getAuthToken('nice444');
    const sportsRes = await proxyFetch(`https://nice444.com/api/exchange/market/matchodds/allEventsList`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://nice444.com',
        Referer: 'https://nice444.com/',
        'User-Agent': UA
      },
      body: JSON.stringify({}),
      timeout: 10000
    });
    const sData = await sportsRes.json();
    let count = 0;
    if (sData?.data) {
      for (const list of Object.values(sData.data)) {
        if (Array.isArray(list)) count += list.length;
      }
    }
    console.log(`✅ Sports Events Upstream OK! Found ${count} live/upcoming sports matches.`);
  } catch (err) {
    console.error(`❌ Sports Events Failed: ${err.message}`);
  }

  console.log(`\n[6/6] SECURITY & WHITELIST STATUS`);
  const dbFile = path.join(__dirname, '../backend/whitelist_database.json');
  if (fs.existsSync(dbFile)) {
    try {
      const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      console.log(`✅ Whitelist Database intact. Enforce: ${db.settings?.enforceWhitelist}, Total entities: ${db.domains?.length || 0}`);
    } catch (e) {
      console.error(`❌ Whitelist Database corrupted: ${e.message}`);
    }
  } else {
    console.error(`⚠️ Whitelist Database file not found at ${dbFile}`);
  }

  console.log('\n====================================================');
  console.log('🏁 DIAGNOSTICS COMPLETED');
  console.log('====================================================\n');
  process.exit(0);
}

runDiagnostics().catch(err => {
  console.error('Fatal diagnostics error:', err);
  process.exit(1);
});
