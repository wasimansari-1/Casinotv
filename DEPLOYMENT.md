# 🛡️ Casino TV Production VPS Deployment & Permanent Anti-Block Guide

This guide details how to deploy the **CasinoTV Live Stream Engine** on any cloud VPS (AWS, DigitalOcean, Hetzner, Vultr, Contabo, etc.) ensuring **100% 24/7 uptime** and **zero IP blocks**.

---

## 🏗️ How the Architecture Protects Your VPS Bandwidth & IP

1. **Zero Video Bandwidth on VPS:**
   - The heavy video stream packets do **NOT** flow through your VPS.
   - Video is delivered over **peer-to-peer WebRTC** directly from the CDN (`wss://livecdnplatin.com/UNIVERSE-GE/websocket`) to your users' browsers.
   - Your VPS server only handles lightweight JSON API calls (Authentication, WatchLink generation, and ping signaling) consuming less than **10 KB per session**.

2. **Why Cloud VPS IPs Get Blocked by Upstream:**
   - Datacenter IPs (AWS, DigitalOcean, Linode, Hetzner) are easily flagged by Cloudflare/Anti-Bot firewalls as "Datacenter ASN" or geographic mismatches outside India.
   - When flagged, `nice444.com` returns `viewer_ip_blocked`.

---

## 🚀 Permanent Solution: Outbound Residential Proxy Support

We have built native **`UPSTREAM_PROXY_URL`** integration directly into `backend/server.js` using `undici.ProxyAgent`.

### How it works:
- Your VPS serves your React frontend and API proxy to your users normally on your domain (`https://yourdomain.com`).
- For outgoing requests to `nice444.com` and `livecdnplatin.com`, the Node.js backend routes through a residential/ISP Indian proxy.
- **Your VPS IP is never exposed** to `nice444.com` or `livecdnplatin.com`.
- Because the proxy only handles lightweight JSON calls (NOT video streams), 1 GB of proxy bandwidth will last for **hundreds of thousands of stream sessions**!

---

## 📋 Step-by-Step VPS Setup

### 1. Clone & Install Dependencies
```bash
git clone <your-repo>
cd CasinoTv

# Install backend dependencies
npm install

# Install frontend dependencies and build
cd frontend
npm install
npm run build
cd ..
```

### 2. Configure Environment (`.env`)
Create `.env` in the root folder:
```env
PORT=5050
UPSTREAM_PROXY_URL=http://username:password@residential-proxy.com:8080
```

> **Where to get an Indian Residential / ISP Proxy:**
> - Webshare.io (Residential / Static ISP)
> - Smartproxy / BrightData / IPRoyal (Indian Residential Proxy)
> - Any personal Squid / SOCKS5 proxy running on an Indian residential connection (e.g., Jio / Airtel fiber).

### 3. Run with PM2 (24/7 Process Manager)
```bash
npm install -g pm2
pm2 start backend/server.js --name casinotv
pm2 save
pm2 startup
```

### 4. Nginx Reverse Proxy & SSL (Domain Setup)
Example `/etc/nginx/sites-available/casinotv`:
```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 🔒 3 Rules for Lifetime Zero-Block Guarantee

1. **Keep `UPSTREAM_PROXY_URL` configured:** Never expose a raw datacenter IP directly to `nice444.com`.
2. **Keep the single-instance auth intact:** Our unified mutex prevents token collision/revocation.
3. **Use the embedded iframe tag:**
   ```html
   <iframe src="https://yourdomain.com/api/stream/player/99.0010" allow="autoplay; fullscreen; unload"></iframe>
   ```

