"use strict";
!(function () {
  function e(e, t, i) {
    const n = (function (e) {
      let t;
      try {
        t = new URL(String(e));
      } catch (i) {
        return "";
      }
      return "https:" !== t.protocol && "http:" !== t.protocol
        ? ""
        : t.hostname
            .toLowerCase()
            .replace(/\.$/, "")
            .replace(/^\[(.*)\]$/, "$1");
    })(e);
    return (
      !(
        !n ||
        !(
          (t.hosts || []).indexOf(n) >= 0 ||
          (t.sites || []).some((e) => n === e || n.endsWith("." + e))
        )
      ) ||
      (!!t.apps &&
        (!n ||
          (!!i &&
            (function (e) {
              return (
                "localhost" === e ||
                e.endsWith(".localhost") ||
                /^127\.\d+\.\d+\.\d+$/.test(e) ||
                "::1" === e
              );
            })(n))))
    );
  }
  var t = JSON.parse(document.getElementById("cfg").textContent),
    i = Object.assign(
      { start: 720, min: 360, downAfter: 3, upAfter: 10, headroom: 1.3 },
      t.abr || {},
    ),
    n = 1e3 * (t.pingEvery || 10),
    s = (e) => document.getElementById(e),
    r = "Network Lost — Reconnecting...",
    o =
      "The dealer hasn't opened this table yet. We'll seat you the moment it goes live.",
    a = "The dealer has closed your session.",
    c = "Shuffling the connection… trying again.",
    d = "The table is very busy right now — holding your seat…",
    h = "Your connection can't keep up with the table right now.",
    l = "The table didn't open. Please refresh the page.",
    u = "Tap to take your seat";
  function m(e, t) {
    try {
      window.parent &&
        window.parent !== window &&
        window.parent.postMessage(
          { type: e, payload: t, at: new Date().toISOString() },
          "*",
        );
    } catch (i) {}
  }
  var g = {
      video: s("videoPlayer"),
      status: s("status"),
      loading: s("loading"),
      message: s("qualityLoader"),
      hint: s("hint"),
      sticky: "",
      tempTimer: null,
      hintTimer: null,
      hideTimer: null,
      showLoading() {
        (clearTimeout(this.hideTimer),
          (this.hideTimer = null),
          (this.loading.style.display = "block"),
          this.loading.classList.remove("fade-out"));
      },
      hideLoading() {
        if (!window.webrtcPlayer || !window.webrtcPlayer.everPlayed) return;
        (this.loading.classList.add("fade-out"),
          clearTimeout(this.hideTimer),
          (this.hideTimer = setTimeout(() => {
            ((this.hideTimer = null),
              (this.loading.style.display = "none"),
              this.loading.classList.remove("fade-out"));
            try {
              window.parent &&
                window.parent !== window &&
                window.parent.postMessage({ hideLoader: !0 }, "*");
            } catch (e) {}
          }, 400)));
      },
      say(e, t) {
        console.log("[Notice]", e);
        if (
          e === l ||
          e === r ||
          e === a ||
          e === d ||
          e === c ||
          e === h ||
          (typeof e === "string" &&
            (e.includes("didn't open") ||
              e.includes("Network Lost") ||
              e.includes("session")))
        ) {
          this.message.style.display = "none";
          this.hideLoading();
          return;
        }
        (clearTimeout(this.tempTimer), t && (this.sticky = e));
        const i = e || this.sticky;
        ((this.message.textContent = i),
          (this.message.style.display = i ? "block" : "none"),
          e && !t && (this.tempTimer = setTimeout(() => this.say(""), 3e3)));
      },
      showBlockImage(e) {
        return;
      },
      clearSticky(e) {
        (e && this.sticky !== e) || ((this.sticky = ""), this.say(""));
      },
      blur(e) {
        return;
      },
      flash(e) {
        this.hint &&
          ((this.hint.textContent = e),
          this.hint.classList.add("on"),
          clearTimeout(this.hintTimer),
          (this.hintTimer = setTimeout(
            () => this.hint.classList.remove("on"),
            900,
          )));
      },
    },
    f = {
      el: s("maint"),
      timer: null,
      until: 0,
      show(e) {
        this.el &&
          ((s("maintIcon").textContent = e.icon || "🎲"),
          (s("maintTitle").textContent = e.title || "Table maintenance"),
          (s("maintText").textContent = e.message || ""),
          (this.until =
            null != e.remaining ? performance.now() + 1e3 * e.remaining : 0),
          this.tick(),
          clearInterval(this.timer),
          (this.timer = setInterval(() => this.tick(), 15e3)),
          (this.el.hidden = !1));
      },
      tick() {
        const e = s("maintEta");
        if (!e) return;
        if (!this.until) return void (e.textContent = "We'll be back shortly");
        const t = Math.ceil((this.until - performance.now()) / 6e4);
        e.textContent = t <= 1 ? "Back in a moment" : `Back in about ${t} min`;
      },
      hide() {
        (this.el && (this.el.hidden = !0),
          clearInterval(this.timer),
          (this.timer = null));
      },
    },
    p = {
      sid: t.sid,
      token: "",
      streamId: "",
      wsUrl: "",
      ready: !1,
      maintenance: null,
      ended: !1,
      mode: null,
      quality: 0,
      diag: [],
      timer: null,
      note(e) {
        (this.diag.push(
          `${Math.round(performance.now() / 1e3)}s ${this.mode || "-"} ${e}`,
        ),
          this.diag.length > 20 && this.diag.shift());
      },
      start() {
        this.timer || (this.timer = setInterval(() => this.ping(), n));
      },
      async playToken(e = () => !0) {
        if (!t.oneTimeToken) return this.token;
        for (let t = 0; t < 3 && !this.token && !this.ended && e(); t++)
          (t && (await new Promise((e) => setTimeout(e, 1100))),
            await this.ping(!1, !0));
        const i = this.token;
        return ((this.token = ""), e() ? i : "");
      },
      state() {
        if (document.hidden) return "hidden";
        if (this.maintenance) return "maint";
        const e = R();
        return e && e.isOffline
          ? "offline"
          : e
            ? "connecting"
            : D
              ? "paused"
              : "connecting";
      },
      async ping(e = !1, i = !1, n = !1) {
        if (this.ended) return !1;
        const s =
            "function" == typeof AbortController ? new AbortController() : null,
          r = s && setTimeout(() => s.abort(), 6e3);
        try {
          const r = {
            sid: this.sid,
            mode: this.mode || this.state(),
            init: e,
            quality: this.quality || null,
            diag: this.diag.splice(0),
          };
          if ((i && (r.token = !0), n && (r.state = !0), e)) {
            try {
              r.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            } catch (o) {}
            r.tzo = -new Date().getTimezoneOffset();
          }
          try {
            const e = window.location.ancestorOrigins;
            r.page = String(
              (e && e.length
                ? e[e.length - 1]
                : document.referrer || location.href) || "",
            ).slice(0, 300);
          } catch (o) {
            r.page = String(document.referrer || location.href || "").slice(
              0,
              300,
            );
          }
          const a = await fetch(t.pingUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(r),
            cache: "no-store",
            signal: s ? s.signal : void 0,
          });
          if (403 === a.status) {
            let e = null;
            try {
              e = await a.json();
            } catch (o) {}
            return e && e.code ? (this.blockedBy(e), !1) : (this.end(), !1);
          }
          if (!a.ok) return !1;
          const c = await a.json();
          return (
            (this.last = c),
            c.token
              ? (this.token = c.token)
              : c.token_error && this.note("play token: " + c.token_error),
            "maintenance" in c &&
              (function (e) {
                if (p.ended) return;
                const t = p.maintenance;
                ((p.maintenance = e),
                  e
                    ? (t ||
                        (p.note("maintenance: " + e.reason),
                        R() && ((P = !1), B("maintenance", !0)),
                        g.hideLoading(),
                        g.blur(!1),
                        g.clearSticky()),
                      f.show(e))
                    : t &&
                      (p.note("maintenance over"),
                      f.hide(),
                      document.hidden
                        ? ((P = !0), (N = "visibility"))
                        : D
                          ? ((P = !0), (N = "parent"))
                          : p.ended || x("maintenance over")));
              })(c.maintenance || null),
            e &&
              c.streamId &&
              c.wsUrl &&
              ((this.streamId = c.streamId),
              (this.wsUrl = c.wsUrl),
              (this.ready = !0)),
            !0
          );
        } catch (o) {
          return !1;
        } finally {
          r && clearTimeout(r);
        }
      },
      blockedBy(e) {
        if (this.ended) return;
        ((this.ended = !0),
          clearInterval(this.timer),
          (this.timer = null),
          B("blocked", !0),
          (this.token = ""),
          (this.wsUrl = ""),
          (this.streamId = ""),
          f.hide(),
          g.hideLoading(),
          g.blur(!1));
        const i = String(e.title || "not allowed").slice(0, 60),
          n = String(e.code || "").slice(0, 4);
        if (
          (g.say(
            `Access blocked: ${i} (${n})` +
              (e.ref ? ` · Ref ${String(e.ref).slice(0, 12)}` : ""),
            !0,
          ),
          e.image)
        )
          try {
            g.showBlockImage(
              new URL(t.pingUrl, location.href).origin +
                "/block-image?t=" +
                Date.now(),
            );
          } catch (s) {}
      },
      end() {
        if (this.ended) return;
        ((this.ended = !0),
          clearInterval(this.timer),
          (this.timer = null),
          B("session_ended", !0),
          f.hide(),
          g.hideLoading(),
          g.blur(!1),
          g.say(a, !0));
        let e = "";
        try {
          e = String(window.name || "");
        } catch (n) {
          return;
        }
        const t = /unv_r=(\d+)/.exec(e);
        if (t && Date.now() - +t[1] < 12e4) return;
        const i = () => {
          try {
            window.name = (
              e.replace(/;?unv_r=\d+/, "") +
              ";unv_r=" +
              Date.now()
            ).replace(/^;/, "");
          } catch (n) {
            return;
          }
          ((q = !0), location.reload());
        };
        document.hidden
          ? document.addEventListener("visibilitychange", function e() {
              document.hidden ||
                (document.removeEventListener("visibilitychange", e), i());
            })
          : i();
      },
    },
    y = !1;
  function w(e) {
    if (!y && t.devtoolsGuard) {
      ((y = !0), (g.video.style.visibility = "hidden"), (g.video.muted = !0));
      try {
        navigator.sendBeacon &&
          navigator.sendBeacon(
            t.flagUrl,
            JSON.stringify({ sid: t.sid, reason: e }),
          );
      } catch (i) {}
      ((p.ended = !0),
        clearInterval(p.timer),
        B("devtools", !0),
        (p.token = ""),
        (p.wsUrl = ""),
        (p.streamId = ""),
        location.replace(
          window.top === window ? t.devtoolsRedirect : t.blockedUrl,
        ));
    }
  }
  var b =
      /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent) &&
      !/CriOS|FxiOS|Firefox\//.test(navigator.userAgent),
    v =
      t.devtoolsGuard && b
        ? Array.from({ length: 50 }, () => {
            const e = {};
            for (let t = 0; t < 500; t++) e["k" + t] = t;
            return e;
          })
        : null,
    k = 0;
  function T() {
    const e = performance.now();
    console.table(v);
    const t = performance.now();
    console.log(v);
    const i = performance.now();
    (console.clear(), (k = Math.max(k, i - t)));
    const n = t - e;
    return n >= 3 && n > 10 * Math.max(k, 0.1);
  }
  async function S() {
    if (y) return !0;
    if (!v || document.hidden) return !1;
    for (let e = 0; e < 3; e++) {
      if (!T()) return !1;
      await new Promise((e) => setTimeout(e, 40));
    }
    return (w("console_before_start"), !0);
  }
  var C = null;
  function E(e) {
    try {
      (navigator.sendBeacon && navigator.sendBeacon(t.flagUrl, e)) ||
        fetch(t.flagUrl, {
          method: "POST",
          body: e,
          keepalive: !0,
          cache: "no-store",
        }).catch(() => {});
    } catch (i) {}
  }
  function I() {
    return (
      (p.ended = !0),
      clearInterval(p.timer),
      (p.timer = null),
      B("framed", !0),
      (p.token = ""),
      (p.wsUrl = ""),
      (p.streamId = ""),
      (p.ready = !1),
      (g.video.srcObject = null),
      f.hide(),
      g.hideLoading(),
      g.blur(!1),
      g.say(a, !0),
      !0
    );
  }
  function L() {
    if (C)
      return "proxied" === C[0] || !(!t.frameAllow || !t.frameAllow.enforce);
    if (
      (function () {
        let e = [];
        try {
          e = atob(t.home || "")
            .split(",")
            .filter(Boolean);
        } catch (n) {}
        if (!e.length || e.some((e) => "[" === e.charAt(0))) return !1;
        const i = String(location.hostname).toLowerCase();
        return !e.some((e) => i === e || i.endsWith("." + e));
      })()
    )
      return (
        (C = ["proxied"]),
        E(
          JSON.stringify({
            sid: t.sid,
            reason: "proxied",
            origin: String(location.origin).slice(0, 200),
          }),
        ),
        I()
      );
    let i = null;
    try {
      i = window.location.ancestorOrigins;
    } catch (s) {}
    if (!t.frameAllow || !i || !i.length) return !1;
    const n = [];
    for (let e = 0; e < i.length; e++) n.push(String(i[e]));
    return (
      !!(function (t, i) {
        const n = [];
        if (!(i && i.parent && i.outer && t)) return n;
        for (let s = 0; s < t.length; s++)
          e(t[s], 0 === s ? i.parent : i.outer, s > 0) || n.push(String(t[s]));
        return n;
      })(n, t.frameAllow).length &&
      ((C = n),
      E(
        JSON.stringify({
          sid: t.sid,
          reason: "framed",
          ancestors: n.slice(0, 10),
        }),
      ),
      !!t.frameAllow.enforce && I())
    );
  }
  if (t.devtoolsGuard) {
    if (v) {
      let e = 0;
      setInterval(() => {
        document.hidden
          ? (e = 0)
          : ((e = T() ? e + 1 : 0), e >= 3 && w("console"));
      }, 300);
    }
    if (window.top === window) {
      let e = 0;
      setInterval(() => {
        if (!Number.isInteger(window.devicePixelRatio)) return void (e = 0);
        const t = window.outerWidth - window.innerWidth,
          i = window.outerHeight - window.innerHeight;
        ((e = t > 200 || i > 250 ? e + 1 : 0), e >= 3 && w("docked"));
      }, 1e3);
    }
    window.addEventListener(
      "keydown",
      (e) => {
        const t = (e.key || "").toLowerCase(),
          i = e.code || "",
          n = (e) => t === e || i === "Key" + e.toUpperCase(),
          s =
            (e.ctrlKey || e.metaKey) &&
            (e.shiftKey || e.altKey) &&
            ["i", "j", "c", "k"].some(n);
        ("f12" === t ||
          "F12" === i ||
          s ||
          ((e.ctrlKey || e.metaKey) && n("u"))) &&
          (e.preventDefault(), e.stopPropagation());
      },
      !0,
    );
  }
  var M = class {
      constructor() {
        ((this.pc = null),
          (this.ws = null),
          (this.video = g.video),
          (this.status = g.status),
          (this.loading = g.loading),
          (this.qualityLoader = g.message),
          (this.isConnected = !1),
          (this.playStarted = !1),
          (this.framesSeen = !1),
          (this.everPlayed = !1),
          (this.iceCandidateQueue = []),
          (this.remoteDescriptionSet = !1),
          (this.pingInterval = null),
          (this.qualityCheckInterval = null),
          (this.connectTimer = null),
          (this.mediaTimer = null),
          (this.reconnectTimer = null),
          (this.pollTimer = null),
          (this.iceTimer = null),
          (this.effectsTimer = null),
          (this.starting = !1),
          (this.pinging = !1),
          (this.failedTries = 0),
          (this.unusedToken = null),
          (this.lastMessageAt = 0),
          (this.isNetworkLost = !1),
          (this.isOffline = !1),
          (this.isDestroyed = !1),
          (this.isStopping = !1),
          (this.abr = {
            ladder: [],
            bitrates: {},
            current: 0,
            badSince: 0,
            goodSince: 0,
            lastSwitch: 0,
            probing: null,
            probeFails: 0,
          }),
          (this.netBad = 0),
          (this.jitterHigh = !1),
          (this.cleanTicks = 0),
          (this.lastStats = null),
          (this.lastBitrateReport = 0),
          (this.estKbps = 0),
          (this.availableKbps = 0),
          this.initializeElements());
      }
      initializeElements() {
        const e = s("playBtn"),
          t = s("stopBtn"),
          i = s("muteBtn");
        (e && e.addEventListener("click", () => this.play()),
          t && t.addEventListener("click", () => this.stop()),
          i && i.addEventListener("click", () => this.toggleMute()),
          (this.onCanPlay = () => {
            this.tryPlay();
          }),
          (this.onPlaying = () => {
            ((this.framesSeen = !0),
              (this.everPlayed = !0),
              (this.failedTries = 0),
              (this.unusedToken = null),
              clearTimeout(this.mediaTimer),
              (p.mode = "webrtc"),
              g.hideLoading(),
              g.clearSticky(c),
              g.clearSticky(d),
              g.clearSticky(u));
          }),
          (this.onWaiting = () => p.note("buffering")),
          (this.onVideoError = () => this.updateStatus("error", "Video Error")),
          (this.onMetadata = () => this.onResize()),
          this.video.addEventListener("canplay", this.onCanPlay),
          this.video.addEventListener("playing", this.onPlaying),
          this.video.addEventListener("waiting", this.onWaiting),
          this.video.addEventListener("error", this.onVideoError),
          this.video.addEventListener("loadedmetadata", this.onMetadata));
      }
      getConfig() {
        return {
          wsUrl: p.wsUrl,
          streamId: p.streamId,
          token: p.token,
          room: "",
          trackList: [],
          subscriberId: "",
          subscriberCode: "",
          viewerInfo: "",
          role: "",
          userPublishId: "",
        };
      }
      async play() {
        if (
          !(
            this.isDestroyed ||
            p.ended ||
            this.starting ||
            this.ws ||
            this.reconnectTimer ||
            L()
          )
        ) {
          this.starting = !0;
          try {
            if (await S()) return;
            if ((p.ready || (await p.ping(!0)), this.isDestroyed || p.ended))
              return;
            if (!p.ready) {
              p.ready = !0;
              if (!p.streamId) p.streamId = (t && t.streamId) || "GAME30";
              if (!p.wsUrl)
                p.wsUrl = "wss://livecdnplatin.com/UNIVERSE-GE/websocket";
            }
            if (t.oneTimeToken) {
              let e = this.unusedToken;
              if (!e) {
                if (
                  ((e = await p.playToken(() => !this.isDestroyed && !p.ended)),
                  this.isDestroyed || p.ended)
                )
                  return;
                if (!e) throw new Error("no play token");
              }
              ((this.unusedToken = e), (p.token = e));
            }
            (this.isOffline || g.showLoading(),
              this.updateStatus("connecting", "Connecting..."),
              await this.initializeWebRTC(),
              await this.connectWebSocket());
          } catch (e) {
            ((this.starting = !1), this.reconnect("retry"));
          } finally {
            this.starting = !1;
          }
        }
      }
      async initializeWebRTC() {
        if (this.pc)
          try {
            this.pc.close();
          } catch (i) {}
        ((this.remoteDescriptionSet = !1),
          (this.iceCandidateQueue = []),
          (this.isConnected = !1),
          (this.playStarted = !1),
          (this.framesSeen = !1),
          (this.lastStats = null));
        const e = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.l.google.com:5349" },
            { urls: "stun:stun1.l.google.com:3478" },
            { urls: "stun:stun1.l.google.com:5349" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:5349" },
            { urls: "stun:stun3.l.google.com:3478" },
            { urls: "stun:stun3.l.google.com:5349" },
            { urls: "stun:stun4.l.google.com:19302" },
            { urls: "stun:stun4.l.google.com:5349" },
          ],
        });
        ((this.pc = e),
          (e.onicecandidate = (i) => {
            if (
              this.pc === e &&
              i.candidate &&
              this.ws &&
              this.ws.readyState === WebSocket.OPEN
            ) {
              const e = {
                command: "takeCandidate",
                streamId: p.streamId,
                label: i.candidate.sdpMLineIndex,
                id: i.candidate.sdpMid,
                candidate: i.candidate.candidate,
              };
              (p.token && !t.oneTimeToken && (e.token = p.token),
                this.sendMessage(e));
            }
          }),
          (e.ontrack = (t) => {
            this.pc === e &&
              (this.video.srcObject !== t.streams[0] &&
                (this.video.srcObject = t.streams[0]),
              this.updateStatus("connected", "Connected"),
              (this.isConnected = !0),
              this.startQualityMonitoring(),
              this.tryPlay());
          }),
          (e.oniceconnectionstatechange = () => {
            if (this.pc !== e) return;
            const t = e.iceConnectionState;
            "failed" === t
              ? (this.showNetworkLostEffects(),
                this.updateStatus("error", "Connection Lost"),
                this.reconnect("ice failed"))
              : "disconnected" === t
                ? (this.showNetworkLostEffects(),
                  this.updateStatus("error", "Connection Lost"),
                  clearTimeout(this.iceTimer),
                  (this.iceTimer = setTimeout(() => {
                    this.pc === e &&
                      "disconnected" === e.iceConnectionState &&
                      this.reconnect("ice disconnected");
                  }, 4e3)))
                : ("connected" !== t && "completed" !== t) ||
                  (clearTimeout(this.iceTimer), this.hideNetworkLostEffects());
          }),
          e.addTransceiver("video", { direction: "recvonly" }),
          e.addTransceiver("audio", { direction: "recvonly" }));
      }
      tryPlay() {
        this.video.muted = !0;
        this.video.defaultMuted = !0;
        this.video.playsInline = !0;
        this.video.setAttribute("playsinline", "");
        this.video.setAttribute("webkit-playsinline", "");
        const e = this.video.play();
        e &&
          e.catch &&
          e.catch(() => {
            this.video.muted = !0;
            const e = this.video.play();
            e && e.catch && e.catch(() => g.say(u, !0));
          });
      }
      connectWebSocket() {
        return new Promise((e, i) => {
          clearTimeout(this.connectTimer);
          const wsTarget = (p.wsUrl && p.wsUrl.startsWith("/"))
            ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + p.wsUrl
            : p.wsUrl;
          const n = new WebSocket(wsTarget);
          this.ws = n;
          let s = !1,
            r = !1;
          const o = () => {
            if (this.ws === n && !this.playStarted && !this.isOffline)
              return this.remoteDescriptionSet && !r
                ? ((r = !0),
                  void (this.connectTimer = setTimeout(
                    o,
                    1e3 * (t.webrtcTimeout || 6),
                  )))
                : void this.reconnect("timeout");
          };
          ((this.connectTimer = setTimeout(o, 1e3 * (t.webrtcTimeout || 6))),
            (n.onopen = () => {
              this.ws === n &&
                ((s = !0),
                (this.lastMessageAt = performance.now()),
                m("SOCKET_OPEN", { streamId: p.streamId }),
                this.sendPlayRequest(),
                this.startPing(),
                e());
            }),
            (n.onmessage = async (e) => {
              if (this.ws === n) {
                this.lastMessageAt = performance.now();
                try {
                  await this.handleMessage(JSON.parse(e.data));
                } catch (t) {}
              }
            }),
            (n.onerror = () => {
              this.ws === n &&
                (m("SOCKET_ERROR", { message: "WebSocket connection failed" }),
                s || ((s = !0), i(new Error("WebSocket connection failed"))));
            }),
            (n.onclose = () => {
              if (this.ws !== n) return;
              const e = this.isConnected;
              if (
                (e && this.updateStatus("error", "Connection Closed"),
                m("SOCKET_CLOSED", { wasConnected: e }),
                (this.isConnected = !1),
                this.stopPing(),
                this.stopQualityMonitoring(),
                !s)
              )
                return ((s = !0), void i(new Error("WebSocket closed")));
              this.isStopping ||
                this.isDestroyed ||
                this.reconnect("socket closed");
            }));
        });
      }
      sendPlayRequest() {
        const e = this.getConfig();
        (this.sendMessage({
          command: "play",
          streamId: e.streamId,
          token: e.token || "",
          room: e.room || "",
          trackList: e.trackList || [],
          subscriberId: e.subscriberId || "",
          subscriberCode: e.subscriberCode || "",
          viewerInfo: e.viewerInfo || "",
          role: e.role || "",
          userPublishId: e.userPublishId || "",
        }),
          t.oneTimeToken && (p.token = ""));
      }
      async handleMessage(e) {
        switch (e.command) {
          case "takeConfiguration": {
            if (!this.pc) return;
            for (
              this.unusedToken = null,
                await this.pc.setRemoteDescription(
                  new RTCSessionDescription({ type: "offer", sdp: e.sdp }),
                ),
                this.remoteDescriptionSet = !0;
              this.iceCandidateQueue.length > 0;
            ) {
              const e = this.iceCandidateQueue.shift();
              try {
                await this.pc.addIceCandidate(e);
              } catch (i) {}
            }
            const n = await this.pc.createAnswer();
            await this.pc.setLocalDescription(n);
            const s = {
              command: "takeConfiguration",
              streamId: p.streamId,
              type: "answer",
              sdp: n.sdp,
            };
            (p.token && !t.oneTimeToken && (s.token = p.token),
              this.sendMessage(s));
            break;
          }
          case "takeCandidate": {
            const t = new RTCIceCandidate({
              candidate: e.candidate,
              sdpMLineIndex: e.label,
              sdpMid: e.id,
            });
            if (this.remoteDescriptionSet && this.pc)
              try {
                await this.pc.addIceCandidate(t);
              } catch (i) {}
            else this.iceCandidateQueue.push(t);
            break;
          }
          case "error":
            this.handleServerError(e);
            break;
          case "notification":
            this.handleNotification(e);
            break;
          case "streamInformation":
            this.onStreamInfo(e);
        }
      }
      handleServerError(e) {
        const t = e.definition || "error";
        if ("no_stream_exist" === t) return this.waitForStream("not live");
        if ("already_playing" !== t) {
          if ("highResourceUsage" === t) return this.handleHighResourceUsage();
          if ("RESOLUTION_CANNOT_BE_SET" === t)
            return (
              p.note("no renditions to choose from"),
              (this.abr.ladder = []),
              void (this.abr.current = 0)
            );
          (p.note("server error: " + t),
            this.playStarted ||
              (this.updateStatus("error", `Error: ${t}`),
              (this.unusedToken = null),
              this.reconnect(t)));
        }
      }
      handleNotification(e) {
        switch (e.definition) {
          case "play_started":
            ((this.playStarted = !0),
              (this.unusedToken = null),
              clearTimeout(this.connectTimer),
              this.stopPolling(),
              (this.isOffline = !1),
              g.clearSticky(o),
              (this.abr.ladder = []),
              (this.abr.current = 0),
              (this.abr.badSince = 0),
              (this.abr.goodSince = 0),
              (this.abr.probing = null),
              (this.abr.probeFails = 0),
              (this.abr.lastSwitch = 0),
              this.sendMessage({
                command: "getStreamInfo",
                streamId: p.streamId,
              }),
              clearTimeout(this.mediaTimer),
              (this.mediaTimer = setTimeout(() => {
                this.playStarted &&
                  !this.framesSeen &&
                  this.reconnect("no media");
              }, 8e3)));
            break;
          case "play_finished":
            this.restart("stream ended");
            break;
          case "bitrateMeasurement":
            this.onBitrate(e);
            break;
          case "resolutionChangeInfo":
            (p.note("resolution " + (e.streamHeight || "?") + "p"),
              (p.quality = +e.streamHeight || p.quality));
        }
      }
      sendMessage(e) {
        this.ws &&
          this.ws.readyState === WebSocket.OPEN &&
          this.ws.send(JSON.stringify(e));
      }
      stop(e = !1, t = !1) {
        if (this.isStopping) return;
        ((this.isStopping = !0),
          clearTimeout(this.connectTimer),
          clearTimeout(this.mediaTimer),
          clearTimeout(this.iceTimer),
          this.stopPolling(),
          this.stopPing(),
          this.stopQualityMonitoring());
        const i = this.ws;
        if (((this.ws = null), i))
          try {
            ((i.onopen = null),
              (i.onmessage = null),
              (i.onerror = null),
              (i.onclose = () => W()),
              i.readyState === WebSocket.OPEN &&
                i.send(
                  JSON.stringify({ command: "stop", streamId: p.streamId }),
                ),
              (i.readyState !== WebSocket.OPEN &&
                i.readyState !== WebSocket.CONNECTING) ||
                i.close(1e3, e ? "force stop" : "stop"),
              setTimeout(() => {
                try {
                  i.readyState !== WebSocket.CLOSED &&
                    i.close(1e3, e ? "force stop" : "stop");
                } catch (t) {}
              }, 200));
          } catch (n) {}
        else W();
        if (this.pc) {
          try {
            this.pc.close();
          } catch (n) {}
          this.pc = null;
        }
        (t || (this.video.srcObject = null),
          (this.isConnected = !1),
          (this.playStarted = !1),
          (this.framesSeen = !1),
          (this.remoteDescriptionSet = !1),
          (this.iceCandidateQueue = []),
          (this.abr.current = 0),
          (p.quality = 0),
          (p.mode = null),
          t || (this.updateStatus("connecting", "Ready"), g.hideLoading()),
          (this.isStopping = !1));
      }
      destroy(e = "manual", t = !1) {
        this.isDestroyed ||
          ((this.isDestroyed = !0),
          clearTimeout(this.reconnectTimer),
          (this.reconnectTimer = null),
          clearTimeout(this.effectsTimer),
          this.hideNetworkLostEffects(),
          g.blur(!1),
          g.clearSticky(c),
          g.clearSticky(d),
          g.clearSticky(u),
          this.stop(t),
          this.cleanupEventListeners(),
          p.note("player destroyed: " + e));
      }
      cleanupEventListeners() {
        (this.video.removeEventListener("canplay", this.onCanPlay),
          this.video.removeEventListener("playing", this.onPlaying),
          this.video.removeEventListener("waiting", this.onWaiting),
          this.video.removeEventListener("error", this.onVideoError),
          this.video.removeEventListener("loadedmetadata", this.onMetadata));
      }
      startPing() {
        (this.stopPing(),
          (this.pingInterval = setInterval(() => {
            this.ws &&
              this.ws.readyState === WebSocket.OPEN &&
              this.sendMessage({ command: "ping" });
          }, 1e4)));
      }
      stopPing() {
        this.pingInterval &&
          (clearInterval(this.pingInterval), (this.pingInterval = null));
      }
      reconnect(e, i = !1) {
        if (this.isDestroyed || p.ended) return;
        if (this.reconnectTimer) {
          if (!i) return;
          (clearTimeout(this.reconnectTimer), (this.reconnectTimer = null));
        } else if (this.pinging && !i) return;
        p.note("webrtc problem: " + e);
        const n = "server busy" === e;
        ((this.failedTries = i ? 0 : this.failedTries + 1),
          (this.everPlayed = !1),
          (this.framesSeen = !1),
          this.stop(!0, !0),
          (this.isOffline = !1),
          g.clearSticky(o),
          g.showLoading());
        const s = this.failedTries > (t.webrtcRetries || 3);
        let r;
        (n
          ? g.say(d, !0)
          : s
            ? g.say(c, !0)
            : (g.clearSticky(c), g.clearSticky(d)),
          (r = i
            ? 0
            : n
              ? Math.min(
                  1e3 *
                    (t.busyRetry || 12) *
                    Math.pow(1.5, Math.min(this.failedTries - 1, 5)),
                  3e4,
                )
              : s
                ? 1e3 * (t.offlineRetry || 15)
                : Math.min(1e3 * Math.pow(1.7, this.failedTries - 1), 6e3)),
          r && (r = Math.round(r * (0.7 + 0.6 * Math.random()))),
          (this.reconnectTimer = setTimeout(() => this.retryNow(), r)));
      }
      retryNow() {
        ((this.reconnectTimer = null),
          this.isDestroyed ||
            p.ended ||
            ((this.pinging = !0),
            p.ping().then(() => {
              ((this.pinging = !1),
                this.isDestroyed ||
                  p.ended ||
                  this.reconnectTimer ||
                  this.play());
            })));
      }
      waitForStream(e) {
        this.isDestroyed ||
          p.ended ||
          (this.isOffline || p.note("offline: " + e),
          (this.isOffline = !0),
          (this.playStarted = !1),
          (this.failedTries = 0),
          (p.mode = null),
          clearTimeout(this.connectTimer),
          clearTimeout(this.mediaTimer),
          g.hideLoading(),
          g.blur(!1),
          g.say(o, !0),
          this.pollTimer ||
            (this.pollTimer = setInterval(
              () => {
                if (this.isDestroyed || p.ended) return this.stopPolling();
                const e = performance.now() - this.lastMessageAt;
                if (
                  !this.ws ||
                  this.ws.readyState !== WebSocket.OPEN ||
                  e > 3e4
                )
                  return (
                    this.stopPolling(),
                    void this.reconnect(
                      e > 3e4 ? "server silent" : "socket gone while waiting",
                      !0,
                    )
                  );
                t.oneTimeToken
                  ? p.ping(!1, !1, !0).then(() => {
                      !this.pollTimer ||
                        this.isDestroyed ||
                        p.ended ||
                        "live" !== (p.last || {}).state ||
                        p
                          .playToken(
                            () => !!this.pollTimer && !this.isDestroyed,
                          )
                          .then((e) => {
                            e &&
                              this.pollTimer &&
                              this.ws &&
                              this.ws.readyState === WebSocket.OPEN &&
                              ((p.token = e), this.sendPlayRequest());
                          });
                    })
                  : this.sendPlayRequest();
              },
              1e3 * (t.offlinePoll || 3),
            )));
      }
      stopPolling() {
        this.pollTimer &&
          (clearInterval(this.pollTimer), (this.pollTimer = null));
      }
      restart(e) {
        this.isDestroyed ||
          p.ended ||
          this.reconnectTimer ||
          (p.note(e),
          this.stop(!0, !0),
          (this.video.srcObject = null),
          (this.failedTries = 0),
          (this.isOffline = !0),
          g.hideLoading(),
          g.blur(!1),
          g.say(o, !0),
          (this.reconnectTimer = setTimeout(() => this.retryNow(), 1e3)));
      }
      handleHighResourceUsage() {
        this.reconnect("server busy");
      }
      startQualityMonitoring() {
        (this.stopQualityMonitoring(),
          (this.qualityCheckInterval = setInterval(
            () => this.checkNetworkQuality(),
            5e3,
          )),
          setTimeout(() => this.checkNetworkQuality(), 2e3));
      }
      stopQualityMonitoring() {
        this.qualityCheckInterval &&
          (clearInterval(this.qualityCheckInterval),
          (this.qualityCheckInterval = null));
      }
      allowedRungs() {
        const e = this.abr.ladder;
        if (!e.length) return [];
        const t = this.video.getBoundingClientRect(),
          i =
            this.video.videoWidth && this.video.videoHeight
              ? this.video.videoWidth / this.video.videoHeight
              : 16 / 9,
          n = Math.round(
            Math.min(t.height, t.width / i) * (window.devicePixelRatio || 1),
          );
        let s = e[0];
        for (const o of e) o >= n && (s = o);
        s = Math.min(s, 1080);
        const r = e.filter((e) => e <= s);
        return r.length ? r : e.slice(-1);
      }
      upNeeded() {
        return i.upAfter * Math.pow(2, this.abr.probeFails);
      }
      probeTick(e) {
        this.abr.probing &&
          e - this.abr.probing.at > 3e4 &&
          ((this.abr.probing = null), (this.abr.probeFails = 0));
      }
      onStreamInfo(e) {
        const t = e.streamInfo || [];
        let n = [
          ...new Set(t.map((e) => +e.streamHeight).filter(Boolean)),
        ].sort((e, t) => t - e);
        const s = n.filter((e) => e >= i.min);
        s.length && (n = s);
        for (const i of t) {
          if (!i.streamHeight) continue;
          const e = +i.videoBitrate || 0,
            t = +i.audioBitrate || 0,
            n = Math.max(e, t) > 5e4 ? 0.001 : 1;
          this.abr.bitrates[i.streamHeight] =
            Math.round((e + t) * n) || this.abr.bitrates[i.streamHeight] || 0;
        }
        if (n.length < 2)
          return ((this.abr.ladder = []), void (p.quality = n[0] || 0));
        this.abr.ladder = n;
        const r = this.allowedRungs(),
          o = r.reduce(
            (e, t) => (Math.abs(t - i.start) < Math.abs(e - i.start) ? t : e),
            r[0],
          );
        this.forceStreamQuality(o, "start", !0);
      }
      onBitrate(e) {
        const t = performance.now();
        if (
          ((this.lastBitrateReport = t),
          !this.abr.ladder.length || !this.abr.current)
        )
          return;
        if (t - this.abr.lastSwitch < 3e3) return;
        const n = +e.targetBitrate || 0,
          s = +e.videoBitrate || 0,
          r = +e.audioBitrate || 0,
          o = Math.max(n, s, r) > 5e4 ? 0.001 : 1,
          a = (s + r) * o || this.abr.bitrates[this.abr.current] || 0,
          c = n * o;
        if (!c || !a) return;
        ((this.estKbps = c), this.probeTick(t));
        const d = this.allowedRungs(),
          l = d.indexOf(this.abr.current),
          u = d[l + 1],
          m = d[l - 1],
          f = c / a;
        if (f < 1) {
          (this.abr.badSince || (this.abr.badSince = t),
            (this.abr.goodSince = 0));
          const e = t - this.abr.badSince >= 1e3 * i.downAfter;
          if (!u) return void (e && ((this.abr.badSince = 0), g.say(h)));
          if (f < 0.6 || e) {
            const e =
              d
                .slice(l + 1)
                .find((e) => 1.1 * (this.abr.bitrates[e] || 0) <= c) ||
              d[d.length - 1];
            this.stepDown(
              e,
              `bandwidth ${Math.round(c)} kbps for a ${Math.round(a)} kbps rendition`,
            );
          }
          return;
        }
        this.abr.badSince = 0;
        const p = (this.abr.bitrates[m] || 1.8 * a) * i.headroom;
        m && 0 === this.netBad && !this.jitterHigh && c >= p
          ? (this.abr.goodSince || (this.abr.goodSince = t),
            t - this.abr.goodSince >= 1e3 * this.upNeeded() &&
              this.stepUp(m, `bandwidth ${Math.round(c)} kbps`))
          : (this.abr.goodSince = 0);
      }
      stepDown(e, t) {
        (this.abr.probing &&
          performance.now() - this.abr.probing.at < 3e4 &&
          (this.abr.probeFails = Math.min(this.abr.probeFails + 1, 4)),
          (this.abr.probing = null),
          this.forceStreamQuality(e, t));
      }
      stepUp(e, t) {
        ((this.abr.probing = { from: this.abr.current, at: performance.now() }),
          this.forceStreamQuality(e, t));
      }
      async checkNetworkQuality() {
        if (this.pc && this.isConnected)
          try {
            const e = await this.pc.getStats();
            let t = 0,
              n = 0,
              s = 0,
              r = null,
              o = 0;
            const a = {};
            (e.forEach((e) => {
              "inbound-rtp" === e.type && "video" === (e.kind || e.mediaType)
                ? ((t = e.packetsLost || 0),
                  (n = e.packetsReceived || 0),
                  (s = e.jitter || 0))
                : "transport" === e.type && e.selectedCandidatePairId
                  ? (r = e.selectedCandidatePairId)
                  : "candidate-pair" === e.type &&
                    ((a[e.id] = e),
                    (e.selected || e.nominated) &&
                      (o = o || e.availableIncomingBitrate || 0));
            }),
              r && a[r] && (o = a[r].availableIncomingBitrate || o),
              (this.availableKbps = o ? o / 1e3 : 0));
            const c = this.lastStats || { lost: t, received: n };
            this.lastStats = { lost: t, received: n };
            const d = Math.max(0, t - c.lost),
              h = Math.max(0, n - c.received),
              l = d + h > 0 ? (d / (d + h)) * 100 : 0;
            if (
              ((this.netBad = l > 5 ? 2 : l > 2 ? 1 : 0),
              (this.jitterHigh = s > 0.08),
              (this.cleanTicks =
                0 !== this.netBad || this.jitterHigh ? 0 : this.cleanTicks + 1),
              !this.abr.ladder.length || !this.abr.current)
            )
              return;
            const u = performance.now();
            this.probeTick(u);
            const m = this.allowedRungs(),
              g = m.indexOf(this.abr.current),
              f = m[m.length - 1],
              p = m[g + 1],
              y = m[g - 1],
              w = u - this.abr.lastSwitch,
              b = `loss ${l.toFixed(1)}% jitter ${Math.round(1e3 * s)} ms`;
            if (2 === this.netBad && p && w > 3e3) return this.stepDown(f, b);
            if (1 === this.netBad && p && w > 8e3) return this.stepDown(p, b);
            if (
              u - this.lastBitrateReport > 15e3 &&
              y &&
              this.cleanTicks >= Math.max(2, Math.round(this.upNeeded() / 5))
            ) {
              this.cleanTicks = 0;
              const e = (this.abr.bitrates[y] || 0) * i.headroom;
              (this.availableKbps && e && this.availableKbps < e) ||
                this.stepUp(y, "network clean");
            }
          } catch (e) {}
      }
      forceStreamQuality(e, t, i) {
        if (
          !this.ws ||
          this.ws.readyState !== WebSocket.OPEN ||
          !e ||
          e === this.abr.current
        )
          return;
        const n = e > this.abr.current;
        (p.note(`quality -> ${e}p (${t})`),
          (this.abr.current = e),
          (p.quality = e),
          (this.abr.badSince = 0),
          (this.abr.goodSince = 0),
          (this.cleanTicks = 0),
          (this.abr.lastSwitch = performance.now()),
          this.sendMessage({
            command: "forceStreamQuality",
            streamId: p.streamId,
            streamHeight: e,
          }),
          i || this.showQualityChangeEffects(e, n));
      }
      showQualityChangeEffects(e, t) {
        let i;
        (g.blur(!0),
          (i = t
            ? e >= 1080
              ? "Excellent network — best quality"
              : "Stable connection — higher quality"
            : "Weak connection — quality reduced"),
          g.say(i),
          clearTimeout(this.effectsTimer),
          (this.effectsTimer = setTimeout(
            () => this.hideQualityChangeEffects(),
            3e3,
          )));
      }
      hideQualityChangeEffects() {
        this.isNetworkLost || g.blur(!1);
      }
      onResize() {
        if (!this.abr.ladder.length || !this.abr.current) return;
        const e = this.allowedRungs();
        e.includes(this.abr.current) ||
          this.forceStreamQuality(e[0], "screen size", !0);
      }
      updateStatus(e, t) {
        ((this.status.className = `status ${e}`),
          (this.status.textContent = t));
      }
      showNetworkLostEffects() {
        return;
      }
      hideNetworkLostEffects() {
        this.isNetworkLost &&
          ((this.isNetworkLost = !1), g.blur(!1), g.clearSticky(r));
      }
      toggleMute() {
        const e = this.video;
        ((e.muted = !e.muted),
          e.muted || 0 !== e.volume || (e.volume = 1),
          e.muted || e.play().catch(() => {}));
        const t = s("muteBtn");
        if (t) {
          const i = t.querySelector(".mute-icon"),
            n = t.querySelector(".unmute-icon");
          (i && (i.style.display = e.muted ? "none" : "block"),
            n && (n.style.display = e.muted ? "block" : "none"));
        }
        g.flash(e.muted ? "Muted" : "Sound on");
      }
    },
    O = null,
    P = !1,
    N = "",
    D = !1;
  function R() {
    const e = window.webrtcPlayer;
    return e && !e.isDestroyed ? e : null;
  }
  function B(e, t) {
    const i = R();
    i && i.destroy(e, t);
  }
  function x(e) {
    if (p.ended || R() || L()) return;
    if (((D = !1), p.maintenance)) return void f.show(p.maintenance);
    (g.blur(!1), g.clearSticky());
    const t = new M();
    ((window.webrtcPlayer = t),
      p.note("resume: " + e),
      p.ping().then(() => {
        t.isDestroyed || p.ended || t.play();
      }));
  }
  function W() {
    const e = O;
    if (!e) return;
    O = null;
    const { message: t, event: i } = e;
    if (i && i.source && "function" == typeof i.source.postMessage)
      try {
        i.source.postMessage(
          {
            type: "DESTROY_ACK",
            id: t && t.id,
            at: new Date().toISOString(),
            status: "stopped",
          },
          i.origin || "*",
        );
      } catch (n) {}
  }
  (window.addEventListener("message", (e) => {
    const t = e && e.data;
    if (t && "object" == typeof t)
      if ("DESTROY" === t.type) {
        if (e.source && "function" == typeof e.source.postMessage)
          try {
            e.source.postMessage(
              {
                type: "DESTROY_ACK",
                id: t.id,
                at: new Date().toISOString(),
                status: "received",
              },
              e.origin || "*",
            );
          } catch (i) {}
        ((O = { message: t, event: e }),
          (P = !0),
          (N = "parent"),
          (D = !0),
          R() ? B("parent_destroy", !0) : W());
      } else
        "CLOSE_SOCKET" === t.type &&
          ((P = !0), (N = "parent"), (D = !0), B("close_socket", !0));
  }),
    m("IFRAME_READY"));
  var q = !1,
    U = !1;
  var A = (e) => {
    (R() && ((P = !0), (N = "pagehide")),
      B(e && e.type ? e.type : "pagehide", !0),
      e &&
        "pagehide" === e.type &&
        !e.persisted &&
        (function () {
          if (!(U || q || p.ended) && t.byeUrl && navigator.sendBeacon) {
            U = !0;
            try {
              navigator.sendBeacon(t.byeUrl, JSON.stringify({ sid: p.sid }));
            } catch (e) {}
          }
        })());
  };
  (window.addEventListener("pagehide", A),
    window.addEventListener("beforeunload", A),
    window.addEventListener("pageshow", (e) => {
      e && e.persisted && P && !document.hidden && ((P = !1), x("pageshow"));
    }),
    document.addEventListener("visibilitychange", () => {
      document.hidden
        ? R() && ((P = !0), (N = "visibility"), B("visibility_hidden", !0))
        : P && ((P = !1), x("visible"));
    }),
    window.addEventListener("offline", () => {
      const e = R();
      e && e.showNetworkLostEffects();
    }),
    window.addEventListener("online", () => {
      const e = R();
      e
        ? (e.hideNetworkLostEffects(),
          (e.ws && e.ws.readyState === WebSocket.OPEN) ||
            e.reconnect("network back", !0))
        : P && "parent" !== N && !document.hidden && ((P = !1), x("online"));
    }));
  var _ = 0;
  if (g.video.requestVideoFrameCallback) {
    const e = () => {
      (_++, g.video.requestVideoFrameCallback(e));
    };
    g.video.requestVideoFrameCallback(e);
  }
  var Q,
    j = "",
    $ = 0,
    K = !1;
  (setInterval(async () => {
    if (K) return;
    const e = R();
    if (
      !e ||
      !e.playStarted ||
      e.reconnectTimer ||
      !g.video.srcObject ||
      g.video.paused ||
      document.hidden ||
      p.ended
    )
      return (($ = 0), void (j = ""));
    K = !0;
    const i = await (async function (e) {
      if (!e || !e.pc) return -1;
      try {
        let t = -1;
        return (
          (await e.pc.getStats()).forEach((e) => {
            "inbound-rtp" === e.type &&
              "video" === (e.kind || e.mediaType) &&
              (t = e.framesDecoded || 0);
          }),
          t
        );
      } catch (t) {
        return -1;
      }
    })(e);
    if (((K = !1), e !== R() || e.reconnectTimer)) return;
    const n = _ + "|" + g.video.currentTime.toFixed(2) + "|" + i;
    (($ = n === j ? $ + 1 : 0),
      (j = n),
      $ >= (t.freezeSeconds || 5) &&
        (($ = 0),
        (j = ""),
        (function () {
          console.warn("[Stream Jitter Handled]");
        })()));
  }, 1e3),
    window.addEventListener("resize", () => {
      (clearTimeout(Q),
        (Q = setTimeout(() => {
          const e = R();
          e && e.onResize();
        }, 800)));
    }),
    t.tapToUnmute &&
      document.addEventListener("pointerup", (e) => {
        if (e.button && 0 !== e.button) return;
        const t = R();
        t &&
          (g.video.paused && g.video.srcObject
            ? g.video
                .play()
                .then(() => g.clearSticky(u))
                .catch(() => {})
            : t.toggleMute());
      }));
  for (const F of [g.video, document.body])
    F.addEventListener("contextmenu", (e) => e.preventDefault());
  ((g.video.disablePictureInPicture = !0),
    document.addEventListener("gesturestart", (e) => e.preventDefault(), {
      passive: !1,
    }),
    (async () => {
      if (L()) return;
      if ((g.showLoading(), await S())) return;
      p.start();
      for (let t = 0; !p.ready && !p.ended; t++) {
        if (t > 0) await new Promise((e) => setTimeout(e, 2000));
        try {
          await p.ping(!0);
        } catch (e) {}
      }
      if (p.ended) return;
      if (D) return void g.hideLoading();
      if (p.maintenance) return void g.hideLoading();
      if (R()) return;
      const e = new M();
      ((window.webrtcPlayer = e), e.play());
    })());
})();
