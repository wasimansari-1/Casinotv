# ♠️ CasinoTV — Live Dealer Stream Proxy & MERN Dashboard

Zero-latency live casino TV stream proxy and multi-table monitoring engine extracted and reverse-engineered from `nice444.com`.

---

## 🎯 Features

- **100% Domain & Iframe Bypass:** Eliminates `frame-ancestors` and `X-Frame-Options` restrictions, enabling smooth embedding on **any domain or localhost**.
- **Anti-Scraping Defeated:** Bypasses `devtoolsGuard` (which redirects on F12) and `frameAllow` domain enforcement.
- **Zero VPS Bandwidth Cost:** Video streams over native WebRTC directly from upstream CDN clusters (`wss://livecdnplatin.com/UNIVERSE-GE/websocket`) to user browsers. Your server only proxies lightweight auth & ping requests.
- **Auto Session Management:** Auto-authenticates and auto-refreshes JWT access tokens without session expiry.
- **All Tables Included:** Pre-configured mappings for 15+ live tables (Teen Patti, Dragon Tiger, Lucky 7, Andar Bahar, 32 Cards, Baccarat, etc.).
- **Multi-TV Grid Dashboard:** View single tables in theater 16:9 mode or multi-table 2x2/3x3 grids simultaneously.

---

## 📋 Table Slugs & Stream Mapping

| Game Name | Event ID | Upstream Stream ID | Signaling WebSocket |
| :--- | :---: | :---: | :--- |
| **20-20 Teen Patti** | `99.0010` | `GAME10` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **1 Day Teen Patti** | `99.0013` | `GAME13` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Joker Teen Patti** | `99.0016` | `GAME16` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Muflis Teen Patti** | `99.0014` | `GAME14` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Lucky 7** | `99.0030` | `GAME30` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **20-20 Dragon Tiger** | `99.0019` | `GAME19` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **1 Day Dragon Tiger** | `99.0021` | `GAME21` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **DTL (Dragon Tiger Lion)** | `99.0041` | `GAME41` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Andar Bahar** | `99.0025` | `GAME25` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **32 Cards** | `99.0022` | `GAME22` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Baccarat** | `99.0001` | `GAME01` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Casino War** | `99.0027` | `GAME27` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Poker** | `99.0007` | `GAME07` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Card Race** | `99.0046` | `GAME46` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |
| **Amar Akbar Anthony** | `99.0005` | `GAME05` | `wss://livecdnplatin.com/UNIVERSE-GE/websocket` |

---

## 🚀 Quick Start

### 1. Install & Run
```bash
npm install
npm start
```

### 2. Access the TV Dashboard
Open your browser to:
```
http://localhost:5050
```

---

## 🔌 API Endpoints

### 1. Embed Player in Any Iframe
```html
<iframe 
  src="http://your-domain.com/api/stream/player/99.0010" 
  width="100%" 
  height="100%" 
  frameborder="0" 
  allow="autoplay; fullscreen; unload">
</iframe>
```

### 2. Get All Live Tables
```http
GET /api/stream/tables
```

**Response:**
```json
{
  "success": true,
  "count": 15,
  "tables": [
    {
      "id": "99.0010",
      "name": "20-20 Teen Patti",
      "streamId": "GAME10",
      "category": "Teen Patti",
      "playerUrl": "/api/stream/player/99.0010"
    }
  ]
}
```

### 3. Direct WebRTC Stream Info (Optional)
If you want to render your own custom player without using iframes:
```http
GET /api/stream/direct-info/99.0010
```

**Response:**
```json
{
  "success": true,
  "eventId": "99.0010",
  "stream": {
    "state": "live",
    "streamId": "GAME10",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "wsUrl": "wss://livecdnplatin.com/UNIVERSE-GE/websocket"
  }
}
```

---

## 🛠️ Production Deployment (VPS)

```bash
# Install PM2 globally if not already installed
npm install -g pm2

# Start daemon
pm2 start backend/server.js --name "casinotv-proxy"

# Save PM2 process list across reboots
pm2 save
pm2 startup
```

