# ANTIGRAVITY AGENT RULES & TOKEN CONSERVATION PROTOCOL

## 1. MANDATORY TOKEN MINIMIZATION RULES (CRITICAL)
- **Zero Unbounded Background Tasks:** Never leave commands running in the background indefinitely. Any background task must terminate within seconds or be explicitly killed. Never accumulate multiple running tasks.
- **Zero Massive File Dumps:** NEVER print, echo, or dump large raw files (such as `sports_player_raw.js`, large bundles, or full HTML pages) into shell stdout or logs. Always use targeted line reads, `grep`, `head`, `tail`, or small `.slice(0, 100)` inspections.
- **Strictly Minimize Subagents:** Do NOT spawn browser subagents or parallel worker swarms unless explicitly instructed. Prefer direct, targeted API and syntax checks.
- **Ultra-Concise Communication:** Responses must be direct, sharp, and concise in Hindi/Hinglish. Avoid repeating full conversation history, massive code snippets, or verbose summaries.
- **Context Preservation:** Never ask the user to re-explain previously solved architecture, account credentials, or design decisions.

## 2. STRICT BUSINESS & SECURITY CONSTRAINTS
- **COMPETITOR BAN (ZERO TOLERANCE):**
  - Absolutely NO traffic, referers, origins, scripts, or APIs to `series444.com`, `baji8dot`, or `oddsdata.org`. They are hostile direct competitors who will inject origin blocks or fake news.
- **ZERO PROXY BANDWIDTH FOR VIDEO:**
  - Video streams (HLS/WebRTC) must flow directly between the user's browser and the upstream media server. The 1GB Webshare proxy data plan must NEVER be used for video media packets.
- **MASTER GUARD ANTI-THEFT:**
  - Client domain whitelist enforced (`aura.igambli.com`, `cstv.chimneysolutions.info`).
  - Block direct browser address bar hits, Postman, curl, and unauthorized iframe embedding.
  - Master Dashboard: `/master` (User: `Igwasim`, Pass: `Asdf123#`).

## 3. ENGINE SPECIFICATIONS
- **Casino TV Engine (17 Live Dealer Tables):**
  - Upstream Provider: Platin (`live.livecdnplatin.com`).
  - Sticky Webshare residential sessions mapped per game.
  - Token Pre-Warming: Pre-fetch play token using `/ping` with `{ mode: "connecting", init: true, token: true }` and cache in Redis/RAM using JWT `exp`.
  - Account Pool: `pridev`, `khans12`, `warsa12`. NEVER use `8292463648` (permanently blocked).
- **Sports TV Engine (Cricket, Soccer, Tennis):**
  - Match list fetched ultra-fast via direct exchange APIs with 0 proxy overhead.
  - High-performance, zero-latency WebRTC/HLS playback.
  - Must start playing within 3-4 seconds with original loader, without black screen, and without 50-second reconnecting loops.
