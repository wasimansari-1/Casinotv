---
name: casinotv-stream-master-guard
description: "Production guide and reference for CSTV Live Stream Proxy & Anti-Theft Guard Engine. Covers zero-latency Casino TV (17 tables) and Sports TV (Cricket, Soccer, Tennis) streaming, Betfair ID resolution, upstream session stickiness and proxy rotation, Master Guard anti-theft domain & IP whitelisting (/master dashboard, ID: Igwasim, Pass: Asdf123#), blocking new-tab/Postman bypass, and emergency admin contact routing (+63 945 146 9623, +63 915 922 4695)."
license: MIT
metadata:
  author: Antigravity
  version: "2.0.0"
---

# CSTV Live Stream Engine & Master Guard Anti-Theft System

Comprehensive reference and operational runbook for the zero-latency Casino TV & Sports TV streaming proxy platform, integrated with the enterprise **CSTV Master Guard** security system.

---

## 1. System Architecture Overview

```
+--------------------------------------------------------------------------+
|                        Authorized Partner Clients                        |
|   (e.g., http://aura.igambli.com/, Whitelisted Partner Domains & IPs)    |
+--------------------------------------------------------------------------+
                                    |
            1. Iframe Embed Request (Referer: aura.igambli.com)
                                    v
+--------------------------------------------------------------------------+
|                  Nginx Reverse Proxy (SSL / HTTPS)                       |
|           Host: 72.61.172.110 | Domain: cstv.chimneysolutions.info       |
|   - Strips X-Frame-Options | Injects Permissions-Policy: unload=*        |
|   - WebSocket upgrade handling | Zero-delay SSL termination              |
+--------------------------------------------------------------------------+
                                    |
            2. Reverse Proxied to Local Node Port 5050
                                    v
+--------------------------------------------------------------------------+
|                   CSTV Master Security Engine (Guard)                     |
|                   (/master Dashboard & Access Gate)                      |
|                                                                          |
|  [Anti-Theft Checks]:                                                    |
|  * Block Postman / Curl / Automated Scraping Tools                       |
|  * Block Direct URL Hits in New Browser Tabs (allowDirectAccess=false)   |
|  * Verify Referer/Origin Domain against Whitelist (exact & wildcard)     |
|  * Verify Client IP against Whitelisted Server IPs                       |
|  * Separate Granular Permission: Casino TV vs. Sports TV                 |
|                                                                          |
|  Unauthorized Attempt? -> HTTP 403 Forbidden Screen                      |
|  Displays "DOMAIN NOT WHITELISTED" + Admin Contacts:                     |
|    +63 945 146 9623 / +63 915 922 4695 (WhatsApp & Call)               |
+--------------------------------------------------------------------------+
                                    |
                                    | Access Granted (0ms)
                                    v
          +-------------------------+-------------------------+
          |                                                   |
          v                                                   v
+-----------------------------+             +-----------------------------+
|    Casino TV Stream Engine  |             |   Sports TV Stream Engine   |
|     (backend/streamProxy)   |             | (backend/sportsStreamEngine)|
|                             |             |                             |
| * 17 Live Tables            |             | * Cricket, Soccer, Tennis   |
| * Teen Patti, Dragon Tiger, |             | * Betfair ID Auto-Resolver  |
|   Lucky 7, Andar Bahar, etc.|             | * Pre-patched Local Player  |
| * Sticky Upstream Sessions  |             | * Buffer Spinner Injection  |
| * Multi-Provider Failover   |             | * 0ms RAM & Redis Caching   |
| * Ping Session Continuity   |             | * Instant Video Playback    |
+-----------------------------+             +-----------------------------+
          |                                                   |
          +-------------------------+-------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------+
|                       Upstream Video Relay & CDNs                        |
|       (Nanocosmos H5Live WebSocket / Platin WebRTC / TV.LTVE.LIVE)       |
+--------------------------------------------------------------------------+
```

---

## 2. Master Guard Anti-Theft Security Specifications

### Master Admin Dashboard
- **Route:** `https://cstv.chimneysolutions.info/master` (or click `🛡️ Master Guard` in top navbar)
- **Master ID:** `Igwasim`
- **Master Password:** `Asdf123#`
- **Authentication:** HMAC SHA-256 session token stored in `localStorage` (`cstv_master_token`).

### Anti-Theft Rules & Bypass Protection
1. **URL Copy / New Tab Inspection Bypass Blocked:**
   - When an unauthorized person inspects the iframe on an authorized site, copies `https://cstv.chimneysolutions.info/api/stream/player/99.0030`, and pastes it into a **New Tab**:
     - Modern browsers do not send a parent Referer in a new tab (`Referer: undefined`).
     - `allowDirectAccess = false` enforces strict anti-theft: non-whitelisted direct hits are **immediately blocked with HTTP 403**.
2. **Postman / Curl / Automated Tool Scraping Blocked:**
   - Any client with User-Agents matching `PostmanRuntime`, `curl/`, `python-requests`, `insomnia`, `aiohttp`, or `Go-http-client` is strictly rejected before any stream initialization.
3. **Dual Permission System (Casino vs. Sports):**
   - Whitelisted domains or IPs can have Casino enabled, Sports enabled, or both.
   - If a domain is whitelisted for Casino only, accessing Sports returns:
     > **`DOMAIN NOT WHITELISTED FOR SPORTS TV`**
   - If a domain is not in the whitelist at all, it returns:
     > **`DOMAIN NOT WHITELISTED`**
4. **Emergency Admin Contact Routing on Block Screen:**
   The 403 Forbidden screen displays high-contrast, prominent contact cards with direct WhatsApp and Call links:
   - **Admin Contact 1:** `+63 945 146 9623` (`https://wa.me/639451469623` / `tel:+639451469623`)
   - **Admin Contact 2:** `+63 915 922 4695` (`https://wa.me/639159224695` / `tel:+639159224695`)

---

## 3. Casino TV Engine & Zero Black Screen Optimization

### Table Identifier Mapping (17 Core Tables)
| Game Name | Stream ID | Slug / Asset Key | Category |
| :--- | :---: | :---: | :--- |
| **Teen Patti 20-20** | `99.0010` | `teen20` | Teen Patti |
| **1 Day Teen Patti** | `99.0013` | `teen` | Teen Patti |
| **Joker Teen Patti** | `99.0016` | `joker120` | Teen Patti |
| **Dragon Tiger 20-20** | `99.0018` | `dt20` | Dragon Tiger |
| **1 Day Dragon Tiger** | `99.0021` | `dt6` | Dragon Tiger |
| **Dragon Tiger 2** | `99.0031` | `dt202` | Dragon Tiger |
| **Dragon Tiger Lion (DTL)** | `99.0041` | `dtl20` | Dragon Tiger |
| **Lucky 7 EU (Table A)** | `99.0030` | `lucky7eu` | Lucky 7 |
| **Lucky 7 B** | `99.0032` | `lucky7` | Lucky 7 |
| **Andar Bahar** | `99.0025` | `ab20` | Andar Bahar |
| **Andar Bahar 2** | `99.0034` | `abj` | Andar Bahar |
| **32 Cards EU** | `99.0022` | `card32eu` | Cards |
| **32 Cards B** | `99.0023` | `card32` | Cards |
| **Amar Akbar Anthony (AAA)**| `99.0005` | `aaa` | Cards |
| **Baccarat 1** | `99.0001` | `baccarat` | Baccarat |
| **Baccarat 2** | `99.0002` | `baccarat2` | Baccarat |
| **20-20 Poker** | `99.0007` | `poker` | Poker |

### Eliminating the 5-7 Second Black Screen
1. **Pre-warming:** The server pre-fetches and maintains valid watch URLs and ping tokens in local RAM and Redis.
2. **Ping Continuity:** The upstream Platin/Nanocosmos CDN requires ping heartbeats. Instead of waiting for the client player to perform an initial handshake, the backend establishes and proxies the ping token in advance.
3. **RAM Player Serving:** Pre-patched HTML player files are served with `Cache-Control: no-cache, no-store, must-revalidate` directly from RAM cache in `0ms`.

---

## 4. Sports TV Engine (`backend/sportsStreamEngine.js`)

### Architecture & Betfair Resolution
- **Upstream Endpoint:** `/api/exchange/streaming/exchEventsWatchLink`
- **Challenge:** Sports matches often expose a raw internal event ID (e.g. `40020261114...` or `20020261114...`), but the stream provider requires the actual **Betfair Event ID** (e.g. `36319162`).
- **Resolution Pipeline:**
  1. Call `/api/exchange/markets/getMarketsEventList` with the event ID.
  2. Extract `matchOddsData[0].eventId` or `bookmakersData[0].eventId`.
  3. Cache the resolved Betfair ID in memory.
  4. Call `exchEventsWatchLink` with the Betfair ID.
- **Player Optimization:**
  - Upstream asset `https://tv.ltve.live/player/player.js` (698 KB) is saved locally at `backend/sports_player_raw.js`.
  - Injected with a circular SVG YouTube-style buffer spinner that automatically fades as soon as the HTML5 `<video>` emits `playing`.

---

## 5. Production VPS Deployment & Nginx Runbook

### Nginx Server Block (`/etc/nginx/sites-available/cstv`)
```nginx
server {
    server_name cstv.chimneysolutions.info;

    location / {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Allow iframe embedding on whitelisted partner websites
        proxy_hide_header X-Frame-Options;
        add_header Access-Control-Allow-Origin * always;
        add_header Permissions-Policy "unload=*" always;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/cstv.chimneysolutions.info/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cstv.chimneysolutions.info/privkey.pem;
}
```

### VPS Commands
```bash
# Pull latest code and restart server
cd /root/Casinotv
git pull origin main
pm2 restart casinotv-stream --update-env

# Check logs
pm2 logs casinotv-stream --lines 50
```
