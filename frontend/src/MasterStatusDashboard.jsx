import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Activity,
  Globe,
  Server,
  Terminal,
  AlertTriangle,
  AlertOctagon,
  Ban,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Search,
  Filter,
  Lock,
  Unlock,
  MessageSquare,
  Cpu,
  Clock,
  Radio,
  Eye,
  Trash2,
  Plus,
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  Sparkles,
  Sliders,
  Send,
  X
} from 'lucide-react';

export default function MasterStatusDashboard({ onBack, onNavigateWhitelist }) {
  // Auth & Token
  const [token, setToken] = useState(() => localStorage.getItem('cstv_master_token') || '');
  const [loginId, setLoginId] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Live Telemetry Data
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(5000); // 5s smooth non-fluctuating
  const [lastUpdated, setLastUpdated] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Primary Domain Isolation & Tab Selectors
  const [selectedVpsDomain, setSelectedVpsDomain] = useState('ALL'); // 'ALL' | 'diamondapi.cc' | 'cstv.chimneysolutions.info'
  const [activeTab, setActiveTab] = useState('unauthorized'); // 'unauthorized' | 'whitelisted' | 'traffic' | 'countermeasures'

  // Sub-Filters
  const [whitelistFilterType, setWhitelistFilterType] = useState('ALL'); // 'ALL' | 'DOMAIN' | 'IP' | 'ACTIVE'
  const [unauthorizedFilterType, setUnauthorizedFilterType] = useState('ALL'); // 'ALL' | 'BYPASS_ONLY' | 'BLOCKED_ONLY'
  const [intentFilter, setIntentFilter] = useState('ALL');
  const [actionFilter, setActionFilter] = useState('ALL');

  // Quick Inline Whitelist Add State
  const [quickAddInput, setQuickAddInput] = useState('');
  const [quickAddNote, setQuickAddNote] = useState('');
  const [addingWhitelist, setAddingWhitelist] = useState(false);

  // Custom Message Modal / State
  const [msgModalOpen, setMsgModalOpen] = useState(false);
  const [selectedDomainForMsg, setSelectedDomainForMsg] = useState('');
  const [customHeading, setCustomHeading] = useState('ACCESS RESTRICTED: UNAUTHORIZED REQUEST');
  const [customBody, setCustomBody] = useState(
    'This API and live feed is protected by CSTV Master Guard. Unauthorized access or scraping is strictly prohibited.\nContact Integration Support WhatsApp: +63 945 146 9623 / +63 915 922 4695'
  );
  const [savingMsg, setSavingMsg] = useState(false);
  const [actionStatus, setActionStatus] = useState({ type: '', text: '' });

  // Quick Preset Templates for Countermeasure Messages
  const PRESET_MESSAGES = [
    {
      title: 'Copyright & Stolen Feed Warning',
      heading: 'CRITICAL ACCESS TERMINATION: STOLEN FEED',
      body: 'WARNING: This API and live stream is proprietary to CSTV Master Guard. Unauthorized proxying, framing or rate scraping has been detected and logged.\nCease and desist immediately.\nWhatsApp Support: +63 945 146 9623'
    },
    {
      title: 'Commercial Whitelist Required',
      heading: 'STREAM & API ACCESS SUSPENDED: LICENSE REQUIRED',
      body: 'Notice: This operator endpoint requires verified domain authorization. Your origin or IP is not enrolled in the authorized network.\nTo whitelist your operator platform, contact our integration desk:\nWhatsApp: +63 945 146 9623'
    },
    {
      title: 'Competitor Blacklist Takeover',
      heading: 'ACCESS PERMANENTLY BLOCKED',
      body: 'Access permanently prohibited for this caller under CSTV Anti-Theft Security Policy.\nAll media and rate tunnels severed.\nOfficial Admin Desk WhatsApp: +63 945 146 9623'
    }
  ];

  // Auth Handler
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);

    try {
      const res = await fetch('/api/master/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: loginId, pass: loginPass })
      });
      const data = await res.json();
      if (data.success && data.token) {
        setToken(data.token);
        localStorage.setItem('cstv_master_token', data.token);
        setLoginId('');
        setLoginPass('');
      } else {
        setLoginError(data.error || 'Invalid Master ID or Password');
      }
    } catch (err) {
      setLoginError('Authentication service connection failure');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('cstv_master_token');
  };

  // Fetch Live Telemetry from Master Security Engine
  const fetchTelemetry = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/master/telemetry', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) {
        handleLogout();
        return;
      }
      const data = await res.json();
      if (data.success) {
        setTelemetry(data);
        setLastUpdated(new Date());
      }
    } catch (_) {
      // Background retry
    } finally {
      setLoading(false);
    }
  };

  // Auto Refresh Poller
  useEffect(() => {
    if (!token) return;
    fetchTelemetry();
    if (autoRefreshInterval > 0) {
      const interval = setInterval(fetchTelemetry, autoRefreshInterval);
      return () => clearInterval(interval);
    }
  }, [token, autoRefreshInterval]);

  const showActionStatus = (type, text) => {
    setActionStatus({ type, text });
    setTimeout(() => setActionStatus({ type: '', text: '' }), 4000);
  };

  // 1-Click Toggle Block / Unlock
  const handleToggleBlock = async (rawTarget) => {
    if (!rawTarget) return;
    let target = rawTarget;
    if (rawTarget.startsWith('Direct: ')) {
      target = rawTarget.replace('Direct: ', '').trim();
    }
    if (target === 'Direct (No Referer)' || target === 'direct_unknown') return;

    try {
      const res = await fetch(`/api/master/domains/${encodeURIComponent(target)}/toggle-block`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (data.success) {
        const isBlocked = data.domain?.status === 'blocked';
        showActionStatus('success', `Target "${target}" is now ${isBlocked ? 'BLOCKED ⛔' : 'ACTIVE & UNLOCKED ✅'}`);
        fetchTelemetry();
      }
    } catch (err) {
      showActionStatus('error', 'Failed to toggle block status');
    }
  };

  // 1-Click Whitelist Domain or IP
  const handleQuickWhitelist = async (rawTarget) => {
    if (!rawTarget) return;
    let target = rawTarget;
    if (rawTarget.startsWith('Direct: ')) {
      target = rawTarget.replace('Direct: ', '').trim();
    }
    try {
      const res = await fetch('/api/master/whitelist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          domain: target,
          casino: true,
          sports: true,
          note: 'Quick Whitelist from Threat Dashboard'
        })
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `"${target}" whitelisted successfully! ✅`);
        fetchTelemetry();
      }
    } catch (_) {
      showActionStatus('error', 'Failed to whitelist target');
    }
  };

  // 1-Click Delete Origin from Tracking
  const handleDeleteOrigin = async (rawTarget) => {
    if (!rawTarget) return;
    let target = rawTarget;
    if (rawTarget.startsWith('Direct: ')) {
      target = rawTarget.replace('Direct: ', '').trim();
    }
    if (!window.confirm(`Are you sure you want to permanently delete "${target}" from tracking and records?`)) return;

    try {
      const res = await fetch(`/api/master/origins/${encodeURIComponent(target)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `"${target}" deleted successfully! 🗑️`);
        fetchTelemetry();
      } else {
        showActionStatus('error', data.error || 'Failed to delete origin');
      }
    } catch (_) {
      showActionStatus('error', 'Failed to delete origin');
    }
  };

  // Quick Add Whitelist Domain or IP from Inline Bar
  const handleQuickAddWhitelist = async (e) => {
    e?.preventDefault();
    if (!quickAddInput.trim()) return;
    setAddingWhitelist(true);
    try {
      const res = await fetch('/api/master/whitelist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          domain: quickAddInput.trim(),
          casino: true,
          sports: true,
          note: quickAddNote.trim() || 'Whitelisted via Status Dashboard'
        })
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `"${quickAddInput.trim()}" added to Whitelist! ✅`);
        setQuickAddInput('');
        setQuickAddNote('');
        fetchTelemetry();
      } else {
        showActionStatus('error', data.error || 'Failed to add to whitelist');
      }
    } catch (_) {
      showActionStatus('error', 'Error adding to whitelist');
    } finally {
      setAddingWhitelist(false);
    }
  };

  // Open Message Modal for Target (Domain or Direct IP)
  const openCustomMsgModal = (rawDomain = '') => {
    let domain = rawDomain;
    if (rawDomain.startsWith('Direct: ')) {
      domain = rawDomain.replace('Direct: ', '').trim();
    }
    setSelectedDomainForMsg(domain);
    const existing = telemetry?.customMessages?.find(
      (m) => m.domain.toLowerCase() === domain.toLowerCase()
    );
    if (existing) {
      setCustomHeading(existing.heading || 'ACCESS RESTRICTED: UNAUTHORIZED REQUEST');
      setCustomBody(existing.message || '');
    } else {
      setCustomHeading('ACCESS RESTRICTED: UNAUTHORIZED REQUEST');
      setCustomBody(
        `This API and live feed is protected by CSTV Master Guard. Unauthorized broadcasting on "${domain || 'your domain'}" is strictly forbidden.\nAll media and rate tunnels severed.\nSupport WhatsApp: +63 945 146 9623`
      );
    }
    setMsgModalOpen(true);
  };

  // Save Custom Takeover Message
  const handleSaveCustomMessage = async () => {
    setSavingMsg(true);
    try {
      const res = await fetch('/api/master/custom-messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          domain: selectedDomainForMsg,
          heading: customHeading,
          message: customBody,
          active: true
        })
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `Message deployed for "${selectedDomainForMsg}"! 💬`);
        setMsgModalOpen(false);
        fetchTelemetry();
      } else {
        showActionStatus('error', data.error || 'Failed to deploy message');
      }
    } catch (_) {
      showActionStatus('error', 'Error deploying message');
    } finally {
      setSavingMsg(false);
    }
  };

  const handleDeleteCustomMessage = async (domain) => {
    try {
      const res = await fetch(`/api/master/custom-messages/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `Takeover message for "${domain}" removed.`);
        fetchTelemetry();
      }
    } catch (_) {
      showActionStatus('error', 'Failed to remove message');
    }
  };

  const formatUptime = (sec) => {
    if (!sec) return '0s';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d > 0 ? `${d}d ` : ''}${h}h ${m}m`;
  };

  // -------------------------------------------------------------
  // LOGIN SCREEN
  // -------------------------------------------------------------
  if (!token) {
    return (
      <div className="min-h-screen bg-[#07090E] flex items-center justify-center p-4 font-sans text-slate-200">
        <div className="w-full max-w-md bg-[#0F1420] border border-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 relative overflow-hidden">
          <div className="text-center space-y-2 mb-6">
            <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-center mx-auto text-emerald-400">
              <Shield className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">CSTV MASTER GUARD</h1>
            <p className="text-xs text-slate-400 font-mono">
              VPS Live Status, Domain Intelligence & Anti-Theft SOC
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {loginError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-medium text-center">
                {loginError}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase font-mono tracking-wider">
                Master Operator ID
              </label>
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="Enter Master ID"
                className="w-full px-3.5 py-2.5 bg-[#07090E] border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition font-mono"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase font-mono tracking-wider">
                Passphrase
              </label>
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="Enter Passphrase"
                className="w-full px-3.5 py-2.5 bg-[#07090E] border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition font-mono"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/30 disabled:opacity-50"
            >
              {loginLoading ? (
                <span>Authenticating...</span>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Authenticate to Console</span>
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-800/80 text-center">
            <button
              onClick={onBack}
              className="text-xs text-slate-400 hover:text-white flex items-center justify-center gap-1.5 mx-auto transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Casino / Sports TV Player</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // AUTHENTICATED SOC DASHBOARD
  // -------------------------------------------------------------
  const vps = telemetry?.vps || {};
  const summary = telemetry?.summary || {};
  const origins = telemetry?.origins || [];
  const whitelistedList = telemetry?.whitelistedList || [];
  const whitelistedOrigins = telemetry?.whitelistedOrigins || origins.filter((o) => o.isWhitelisted);
  const unauthorizedOrigins =
    telemetry?.unauthorizedOrigins ||
    origins.filter((o) => !o.isWhitelisted || o.bypassAttempts > 0 || o.isBlocked);
  const customMessages = telemetry?.customMessages || [];
  const recentRequests = telemetry?.recentRequests || [];

  // 1. Available Target Domains on VPS (Extracted accurately)
  const targetDomainSet = new Set(['diamondapi.cc', 'cstv.chimneysolutions.info']);
  (telemetry?.projectDistribution || []).forEach((p) => {
    if (p.project && p.project !== 'VPS Web Front' && p.project !== 'access') {
      targetDomainSet.add(p.project);
    }
  });
  origins.forEach((o) => {
    (o.projectsBreakdown || []).forEach((p) => {
      if (p.name && p.name !== 'VPS Web Front' && p.name !== 'access') {
        targetDomainSet.add(p.name);
      }
    });
  });
  const domainTabsList = ['ALL', ...Array.from(targetDomainSet)];

  // 2. Domain-Specific Hit Counts and Totals
  const domainStatsMap = {};
  domainTabsList.forEach((dom) => {
    domainStatsMap[dom] = {
      totalHits: 0,
      whitelistedHits: 0,
      unauthorizedHits: 0,
      unauthorizedCount: 0,
      whitelistedCount: 0
    };
  });

  origins.forEach((o) => {
    const isW = o.isWhitelisted;
    domainStatsMap['ALL'].totalHits += o.count || 0;
    if (isW) {
      domainStatsMap['ALL'].whitelistedHits += o.count || 0;
      domainStatsMap['ALL'].whitelistedCount++;
    } else {
      domainStatsMap['ALL'].unauthorizedHits += o.count || 0;
      domainStatsMap['ALL'].unauthorizedCount++;
    }

    (o.projectsBreakdown || []).forEach((p) => {
      if (domainStatsMap[p.name]) {
        domainStatsMap[p.name].totalHits += p.count || 0;
        if (isW) {
          domainStatsMap[p.name].whitelistedHits += p.count || 0;
          domainStatsMap[p.name].whitelistedCount++;
        } else {
          domainStatsMap[p.name].unauthorizedHits += p.count || 0;
          domainStatsMap[p.name].unauthorizedCount++;
        }
      }
    });
  });

  const curDomainStats = domainStatsMap[selectedVpsDomain] || domainStatsMap['ALL'];

  // 3. Scoped Callers based on selectedVpsDomain
  const scopedOrigins = origins
    .map((o) => {
      if (selectedVpsDomain === 'ALL') {
        return {
          ...o,
          scopedHits: o.count,
          scopedPercent: o.percent,
          scopedIntents: o.intentsBreakdown || []
        };
      }
      const match = (o.projectsBreakdown || []).find((p) => p.name === selectedVpsDomain);
      if (!match || match.count === 0) return null;

      const domTotal = curDomainStats.totalHits || 1;
      const scopedPercent = Math.round((match.count / domTotal) * 1000) / 10;

      let scopedIntents = [];
      if (o.projectIntents && o.projectIntents[selectedVpsDomain]) {
        scopedIntents = Object.entries(o.projectIntents[selectedVpsDomain])
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
      } else {
        scopedIntents = o.intentsBreakdown || [];
      }

      return {
        ...o,
        scopedHits: match.count,
        scopedPercent,
        scopedIntents
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.scopedHits - a.scopedHits);

  const scopedUnauthorized = scopedOrigins.filter(
    (o) => !o.isWhitelisted || o.bypassAttempts > 0 || o.isBlocked
  );
  const scopedWhitelisted = scopedOrigins.filter((o) => o.isWhitelisted);

  // Filtered Unauthorized based on search & subfilter
  const filteredUnauthorized = scopedUnauthorized.filter((u) => {
    if (unauthorizedFilterType === 'BYPASS_ONLY' && !(u.bypassAttempts > 0)) return false;
    if (unauthorizedFilterType === 'BLOCKED_ONLY' && !u.isBlocked) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const originStr = (u.origin || '').toLowerCase();
      const ipStr = (u.primaryIp || '').toLowerCase();
      return originStr.includes(q) || ipStr.includes(q);
    }
    return true;
  });

  // Source list for Whitelisted view
  const sourceWhitelisted = whitelistedList.length > 0 ? whitelistedList : whitelistedOrigins;
  const filteredWhitelisted = (scopedWhitelisted.length > 0 ? scopedWhitelisted : sourceWhitelisted).filter((w) => {
    if (whitelistFilterType === 'DOMAIN' && w.entryType !== 'domain') return false;
    if (whitelistFilterType === 'IP' && w.entryType !== 'ip') return false;
    if (whitelistFilterType === 'ACTIVE' && !(w.scopedHits > 0 || w.liveHits > 0 || w.count > 0)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const name = (w.domain || w.origin || '').toLowerCase();
      const note = (w.note || '').toLowerCase();
      return name.includes(q) || note.includes(q);
    }
    return true;
  });

  // Filtered requests based on UI selections (Universal VPS Filter)
  const filteredRequests = recentRequests.filter((r) => {
    if (selectedVpsDomain !== 'ALL' && (!r.project || !r.project.toLowerCase().includes(selectedVpsDomain.toLowerCase()))) return false;
    if (intentFilter !== 'ALL' && r.intent !== intentFilter) return false;
    if (actionFilter !== 'ALL' && r.action !== actionFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        (r.project && r.project.toLowerCase().includes(q)) ||
        r.origin.toLowerCase().includes(q) ||
        r.ip.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-[#070A12] text-slate-200 flex flex-col font-sans selection:bg-emerald-500/30">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 bg-[#0B0F19]/90 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-8 py-3">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Activity className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-white tracking-tight">
                  CSTV LIVE STATUS & TRAFFIC INSPECTOR
                </h1>
                <span className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  LIVE SOC
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono">
                Multi-Domain VPS Isolation, Anti-Theft Guard & API Interception
              </p>
            </div>
          </div>

          {/* Quick Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center bg-[#0F1420] border border-slate-800 rounded-lg p-0.5 text-xs font-mono">
              <span className="px-2 py-1 text-slate-400 text-[11px]">Interval:</span>
              <button
                onClick={() => setAutoRefreshInterval(0)}
                className={`px-2 py-1 rounded transition ${autoRefreshInterval === 0 ? 'bg-slate-700 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                Pause
              </button>
              <button
                onClick={() => setAutoRefreshInterval(2000)}
                className={`px-2 py-1 rounded transition ${autoRefreshInterval === 2000 ? 'bg-emerald-600 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                2s
              </button>
              <button
                onClick={() => setAutoRefreshInterval(5000)}
                className={`px-2 py-1 rounded transition ${autoRefreshInterval === 5000 ? 'bg-emerald-600 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                5s
              </button>
            </div>

            <button
              onClick={() => {
                if (onNavigateWhitelist) onNavigateWhitelist();
                else {
                  window.history.pushState({}, '', '/master');
                  window.location.reload();
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Whitelist Manager</span>
            </button>

            <button
              onClick={onBack}
              className="px-3 py-1.5 rounded-lg bg-[#0F1420] hover:bg-slate-800 border border-slate-800 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Player UI</span>
            </button>

            <button
              onClick={handleLogout}
              className="p-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-xs transition"
              title="Logout"
            >
              <Unlock className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Global Status Alert Banner */}
      {actionStatus.text && (
        <div
          className={`px-4 py-2 text-center text-xs font-semibold transition ${
            actionStatus.type === 'error'
              ? 'bg-rose-500/20 text-rose-300 border-b border-rose-500/30'
              : 'bg-emerald-500/20 text-emerald-300 border-b border-emerald-500/30'
          }`}
        >
          {actionStatus.text}
        </div>
      )}

      {/* Main Dashboard Container */}
      <main className="max-w-7xl w-full mx-auto p-4 lg:p-8 flex-1 flex flex-col gap-5">
        {/* DOMAIN ISOLATION SELECTOR STRIP (CRITICAL FEATURE) */}
        <div className="bg-[#0A0E18] border border-slate-800 rounded-xl p-3 flex flex-col gap-2.5 shadow-lg">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-white flex items-center gap-2 font-mono">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>TARGET VPS SITES & DOMAINS (Click to Isolate Data):</span>
            </span>
            <span className="text-[11px] font-mono text-slate-400">
              Active Focus: <strong className="text-cyan-300">{selectedVpsDomain === 'ALL' ? 'ALL DOMAINS COMBINED' : selectedVpsDomain}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 custom-scroll">
            {domainTabsList.map((dom) => {
              const isSelected = selectedVpsDomain === dom;
              const stats = domainStatsMap[dom] || { totalHits: 0 };
              return (
                <button
                  key={dom}
                  onClick={() => setSelectedVpsDomain(dom)}
                  className={`px-4 py-2 rounded-lg text-xs font-mono font-bold flex items-center gap-2.5 transition whitespace-nowrap border ${
                    isSelected
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500 shadow-md shadow-cyan-950/40 ring-1 ring-cyan-500/50'
                      : 'bg-[#06080E] text-slate-400 border-slate-800 hover:border-slate-700 hover:text-white'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${isSelected ? 'bg-cyan-400 animate-pulse' : 'bg-slate-600'}`} />
                  <span>{dom === 'ALL' ? '🌐 ALL VPS SITES COMBINED' : dom}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${isSelected ? 'bg-cyan-500/30 text-white' : 'bg-slate-800/80 text-slate-400'}`}>
                    {stats.totalHits.toLocaleString()} hits
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* TOP 4 CLEAN EXECUTIVE METRICS CARDS */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* CARD 1: Selected Domain Profile */}
          <div className="bg-[#0A0E18] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-mono uppercase font-bold tracking-wider text-[11px]">Inspection Target</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
            <div>
              <div className="text-sm font-bold font-mono text-cyan-300 truncate">
                {selectedVpsDomain === 'ALL' ? 'All VPS Domains' : selectedVpsDomain}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                {selectedVpsDomain === 'ALL' ? 'Consolidated VPS Traffic' : 'Isolated Virtual Host'}
              </div>
            </div>
          </div>

          {/* CARD 2: Total Volume on Selected Domain */}
          <div className="bg-[#0A0E18] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-mono uppercase font-bold tracking-wider text-[11px]">Total Requests</span>
              <span className="text-[11px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                {vps.reqPerSec || 0} req/s
              </span>
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-white">
                {curDomainStats.totalHits.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                Live recorded traffic buffer
              </div>
            </div>
          </div>

          {/* CARD 3: Whitelisted Traffic */}
          <div className="bg-[#0A0E18] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-mono uppercase font-bold tracking-wider text-[11px]">Whitelisted Traffic</span>
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-emerald-400">
                {curDomainStats.whitelistedHits.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                {curDomainStats.whitelistedCount} Verified Partners
              </div>
            </div>
          </div>

          {/* CARD 4: Unauthorized / Threats on Selected Domain */}
          <div className="bg-[#0A0E18] border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span className="font-mono uppercase font-bold tracking-wider text-[11px]">Unauthorized Hits</span>
              <AlertOctagon className="w-4 h-4 text-rose-400 animate-pulse" />
            </div>
            <div>
              <div className="text-xl font-bold font-mono text-rose-400">
                {curDomainStats.unauthorizedHits.toLocaleString()}
              </div>
              <div className="text-[11px] text-rose-300/80 mt-0.5 font-mono">
                {curDomainStats.unauthorizedCount} Callers Flagged
              </div>
            </div>
          </div>
        </section>

        {/* WORKSTATION TABS & CONTROLS */}
        <section className="bg-[#0A0E18] border border-slate-800 rounded-xl overflow-hidden shadow-xl flex-1 flex flex-col">
          {/* Tab Navigation Header */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between border-b border-slate-800 p-2 sm:px-4 bg-[#080B14]">
            <div className="flex items-center gap-1 overflow-x-auto custom-scroll pb-1 sm:pb-0">
              {/* Tab 1: UNAUTHORIZED THREATS (DEFAULT) */}
              <button
                onClick={() => setActiveTab('unauthorized')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'unauthorized'
                    ? 'bg-rose-600 text-white shadow-md shadow-rose-950/40'
                    : 'text-rose-400/80 hover:text-white hover:bg-rose-950/30'
                }`}
              >
                <AlertOctagon className="w-3.5 h-3.5" />
                <span>Non-Whitelisted Threats ({scopedUnauthorized.length})</span>
              </button>

              {/* Tab 2: WHITELISTED PARTNERS */}
              <button
                onClick={() => setActiveTab('whitelisted')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'whitelisted'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Whitelisted Partners ({filteredWhitelisted.length})</span>
              </button>

              {/* Tab 3: REAL-TIME TRAFFIC STREAM */}
              <button
                onClick={() => setActiveTab('traffic')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'traffic'
                    ? 'bg-cyan-600 text-white shadow-md shadow-cyan-950/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Real-Time Request Stream ({filteredRequests.length})</span>
              </button>

              {/* Tab 4: SCREEN & API TAKEOVER NOTICES */}
              <button
                onClick={() => setActiveTab('countermeasures')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'countermeasures'
                    ? 'bg-purple-600 text-white shadow-md shadow-purple-950/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>API Takeover Notices ({customMessages.length})</span>
              </button>
            </div>

            {/* Search & Sub-Filter Bar */}
            <div className="flex items-center gap-2 mt-2 sm:mt-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search IP / Origin / Path..."
                  className="pl-8 pr-3 py-1.5 bg-[#06080E] border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-44 sm:w-56 font-mono"
                />
              </div>

              {activeTab === 'unauthorized' && (
                <select
                  value={unauthorizedFilterType}
                  onChange={(e) => setUnauthorizedFilterType(e.target.value)}
                  className="px-2.5 py-1.5 bg-[#06080E] border border-slate-700/80 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-rose-500"
                >
                  <option value="ALL">All Threats</option>
                  <option value="BYPASS_ONLY">Bypass Attempts Only</option>
                  <option value="BLOCKED_ONLY">Blocked Only</option>
                </select>
              )}

              {activeTab === 'whitelisted' && (
                <select
                  value={whitelistFilterType}
                  onChange={(e) => setWhitelistFilterType(e.target.value)}
                  className="px-2.5 py-1.5 bg-[#06080E] border border-slate-700/80 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500"
                >
                  <option value="ALL">All Whitelisted</option>
                  <option value="DOMAIN">Domains Only</option>
                  <option value="IP">IPs Only</option>
                  <option value="ACTIVE">Active Traffic Only</option>
                </select>
              )}
            </div>
          </div>

          {/* TAB 1: NON-WHITELISTED CALLERS & THREATS (CLEAN NOC ARCHITECTURE) */}
          {activeTab === 'unauthorized' && (
            <div className="p-4 flex-1 flex flex-col gap-3.5 overflow-y-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                <div>
                  <div className="text-xs font-bold text-slate-300 font-mono flex items-center gap-2">
                    <span>NON-WHITELISTED CALLERS & DATA SCRAPERS</span>
                    <span className="text-slate-500">•</span>
                    <span className="text-cyan-400 font-normal">
                      Target Domain: <strong>{selectedVpsDomain === 'ALL' ? 'All VPS Sites' : selectedVpsDomain}</strong>
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Callers hitting without whitelist authorization. Use the action bar below to Whitelist, Block, or Inject a custom takeover message into their API feeds.
                  </p>
                </div>
              </div>

              {filteredUnauthorized.length === 0 ? (
                <div className="py-16 text-center text-slate-500 font-mono text-xs">
                  Zero non-whitelisted callers detected for {selectedVpsDomain === 'ALL' ? 'any VPS site' : selectedVpsDomain}!
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {filteredUnauthorized.map((o) => {
                    const hasBypass = o.bypassAttempts > 0;
                    return (
                      <div
                        key={o.rawKey}
                        className={`rounded-xl border p-4 transition ${
                          o.isBlocked
                            ? 'bg-rose-950/20 border-rose-800/60'
                            : hasBypass
                            ? 'bg-rose-950/10 border-rose-700/40'
                            : 'bg-[#080B14] border-slate-800/90 hover:border-slate-700'
                        }`}
                      >
                        {/* Top Line: Caller Identification & Load */}
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="font-bold text-white text-sm font-mono tracking-wide flex items-center gap-1.5">
                              {o.origin.startsWith('Direct') ? (
                                <Server className="w-4 h-4 text-amber-400 shrink-0" />
                              ) : (
                                <Globe className="w-4 h-4 text-rose-400 shrink-0" />
                              )}
                              <span>{o.origin}</span>
                            </span>

                            {/* Status Pills */}
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-500/10 text-rose-300 border border-rose-500/30">
                              Unauthorized
                            </span>

                            {hasBypass && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/50 flex items-center gap-1">
                                <AlertOctagon className="w-3 h-3 text-rose-400" />
                                <span>{o.bypassAttempts} Bypass Blocks</span>
                              </span>
                            )}

                            {o.isBlocked && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-600/30 text-rose-200 border border-rose-500">
                                ⛔ BLOCKED
                              </span>
                            )}

                            {o.hasCustomMessage && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40 flex items-center gap-1">
                                <MessageSquare className="w-3 h-3 text-purple-400" />
                                <span>💬 Custom Message Active</span>
                              </span>
                            )}
                          </div>

                          {/* Hit Volume & Share */}
                          <div className="text-right flex items-center gap-4">
                            <div>
                              <div className="text-base font-bold font-mono text-white">
                                {o.scopedHits.toLocaleString()} <span className="text-xs font-normal text-slate-400">Hits</span>
                              </div>
                              <div className="text-[11px] font-mono text-rose-400">
                                {o.scopedPercent}% of {selectedVpsDomain === 'ALL' ? 'VPS Load' : selectedVpsDomain}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Middle Line: 2 Clean Balanced Columns */}
                        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          {/* Left: APIs & Routes Called */}
                          <div className="bg-[#05070D] p-3 rounded-lg border border-slate-800/80">
                            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 font-mono flex items-center gap-1.5">
                              <Activity className="w-3.5 h-3.5 text-cyan-400" />
                              <span>APIs & Services Requested:</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {o.scopedIntents && o.scopedIntents.length > 0 ? (
                                o.scopedIntents.map((item, idx) => (
                                  <span
                                    key={idx}
                                    className="px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-slate-800/80 text-slate-200 border border-slate-700/60 flex items-center gap-1.5"
                                  >
                                    <span className="text-cyan-400 font-bold">{item.name}:</span>
                                    <span className="text-white font-bold">{item.count}</span>
                                  </span>
                                ))
                              ) : (
                                <span className="text-slate-500 font-mono text-[11px]">General Traffic</span>
                              )}
                            </div>
                          </div>

                          {/* Right: Target Routing & Client Info */}
                          <div className="bg-[#05070D] p-3 rounded-lg border border-slate-800/80 flex flex-col justify-between">
                            <div className="space-y-1.5 font-mono text-xs">
                              <div className="flex items-center justify-between text-slate-400">
                                <span>Target Virtual Host:</span>
                                <span className="text-cyan-300 font-semibold">
                                  {selectedVpsDomain === 'ALL' ? (o.projectsBreakdown?.[0]?.name || 'diamondapi.cc') : selectedVpsDomain}
                                </span>
                              </div>
                              <div className="flex items-center justify-between text-slate-400">
                                <span>Caller IP:</span>
                                <span className="text-slate-200 font-semibold">{o.primaryIp || o.ips?.[0] || 'Direct'}</span>
                              </div>
                              <div className="flex items-center justify-between text-slate-400">
                                <span>Last Activity:</span>
                                <span className="text-white">
                                  {o.lastSeen ? (o.lastSeen.includes('T') ? o.lastSeen.split('T')[1].slice(0, 8) : o.lastSeen) : 'Live Now'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Bottom Line: 4 Distinct Action Buttons (CRITICAL REQUIREMENT) */}
                        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[11px] font-mono text-slate-500">
                            Countermeasures for: <strong className="text-slate-300">{o.origin}</strong>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* 1. Whitelist Button */}
                            <button
                              onClick={() => handleQuickWhitelist(o.origin)}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-xs font-semibold flex items-center gap-1.5 transition"
                              title="Authorize this origin / IP permanently"
                            >
                              <ShieldCheck className="w-3.5 h-3.5" />
                              <span>Whitelist</span>
                            </button>

                            {/* 2. Block / Unlock Button */}
                            <button
                              onClick={() => handleToggleBlock(o.origin)}
                              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                                o.isBlocked
                                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                  : 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/40'
                              }`}
                              title={o.isBlocked ? 'Unlock access' : 'Drop packets and return 403'}
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>{o.isBlocked ? 'Unlock' : 'Block Target'}</span>
                            </button>

                            {/* 3. Send Takeover Message Button */}
                            <button
                              onClick={() => openCustomMsgModal(o.origin)}
                              className="px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 text-xs font-semibold flex items-center gap-1.5 transition"
                              title="Return custom message across their API feeds & player screen"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              <span>Send Message</span>
                            </button>

                            {/* 4. Delete Origin Button */}
                            <button
                              onClick={() => handleDeleteOrigin(o.origin)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 border border-slate-700/60 transition"
                              title="Delete this origin from tracking"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: WHITELISTED PARTNERS */}
          {activeTab === 'whitelisted' && (
            <div className="p-4 flex-1 flex flex-col gap-3.5 overflow-y-auto">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
                <div>
                  <div className="text-xs font-bold text-white font-mono flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                    <span>WHITELISTED PARTNER DOMAINS & CLIENT IPS</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Official verified partners permitted to access live streams and APIs without restriction.
                  </p>
                </div>

                <form onSubmit={handleQuickAddWhitelist} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={quickAddInput}
                    onChange={(e) => setQuickAddInput(e.target.value)}
                    placeholder="Quick Add Domain / IP..."
                    className="px-3 py-1.5 bg-[#06080E] border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:border-emerald-500 w-52"
                  />
                  <button
                    type="submit"
                    disabled={addingWhitelist || !quickAddInput.trim()}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add</span>
                  </button>
                </form>
              </div>

              {filteredWhitelisted.length === 0 ? (
                <div className="py-16 text-center text-slate-500 font-mono text-xs">
                  No whitelisted entities found. Use the quick add box above to whitelist an authorized partner.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {filteredWhitelisted.map((w, idx) => {
                    const isBlocked = w.status === 'blocked';
                    const hits = w.scopedHits || w.liveHits || w.count || 0;
                    const displayKey = w.domain || w.origin;
                    const isIp = w.entryType === 'ip' || /^(\d{1,3}\.){3}\d{1,3}$/.test(displayKey);

                    return (
                      <div
                        key={w.domain || w.rawKey || idx}
                        className={`rounded-xl border p-4 transition ${
                          isBlocked ? 'bg-rose-950/20 border-rose-800/60' : 'bg-[#080B14] border-slate-800'
                        }`}
                      >
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 pb-3 border-b border-slate-800/80">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <span className="font-bold text-white text-sm font-mono tracking-wide flex items-center gap-1.5">
                              {isIp ? (
                                <Server className="w-4 h-4 text-emerald-400" />
                              ) : (
                                <Globe className="w-4 h-4 text-cyan-400" />
                              )}
                              <span>{displayKey}</span>
                            </span>

                            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              {isIp ? 'IP' : 'DOMAIN'}
                            </span>

                            {isBlocked ? (
                              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                                ⛔ SUSPENDED
                              </span>
                            ) : (
                              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                                ✅ WHITELISTED
                              </span>
                            )}

                            {w.note && (
                              <span className="text-xs text-slate-400 font-mono italic">
                                ({w.note})
                              </span>
                            )}
                          </div>

                          <div className="text-right">
                            <div className="text-sm font-bold font-mono text-white">
                              {hits.toLocaleString()} <span className="text-xs font-normal text-slate-400">Hits</span>
                            </div>
                            <div className="text-[11px] font-mono text-emerald-400">
                              {hits > 0 ? `${w.scopedPercent || w.percent || 0}% Share` : 'Standby'}
                            </div>
                          </div>
                        </div>

                        <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between">
                          <div className="text-[11px] font-mono text-slate-500">
                            Last Active: {w.lastSeen ? (w.lastSeen.includes('T') ? w.lastSeen.split('T')[1].slice(0, 8) : w.lastSeen) : 'Standby'}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleToggleBlock(displayKey)}
                              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
                            >
                              {isBlocked ? 'Unlock' : 'Block'}
                            </button>

                            <button
                              onClick={() => openCustomMsgModal(displayKey)}
                              className="px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition"
                            >
                              Send Message
                            </button>

                            <button
                              onClick={() => handleDeleteOrigin(displayKey)}
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 border border-slate-700/60 transition"
                              title="Delete from whitelist"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: REAL-TIME REQUEST STREAM */}
          {activeTab === 'traffic' && (
            <div className="flex-1 overflow-x-auto max-h-[640px] overflow-y-auto custom-scroll">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-[#080B14] z-10 shadow-sm border-b border-slate-800">
                  <tr className="text-slate-400 font-mono text-[11px] uppercase tracking-wider">
                    <th className="py-2.5 px-3">Time</th>
                    <th className="py-2.5 px-3">Target Domain</th>
                    <th className="py-2.5 px-3">Caller IP</th>
                    <th className="py-2.5 px-3">Origin / Domain</th>
                    <th className="py-2.5 px-3">API Intent</th>
                    <th className="py-2.5 px-3">Path</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                  {filteredRequests.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-500 font-sans">
                        No requests matching filter.
                      </td>
                    </tr>
                  ) : (
                    filteredRequests.map((req) => {
                      const isBlocked = req.action === 'BLOCKED';
                      return (
                        <tr key={req.id} className={`hover:bg-slate-800/20 transition ${isBlocked ? 'bg-rose-950/10' : ''}`}>
                          <td className="py-2 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                            {req.timestamp.split('T')[1].slice(0, 8)}
                          </td>
                          <td className="py-2 px-3 text-cyan-300 font-semibold whitespace-nowrap">{req.project}</td>
                          <td className="py-2 px-3 text-slate-300 whitespace-nowrap">{req.ip}</td>
                          <td className="py-2 px-3 text-amber-300 whitespace-nowrap">{req.origin}</td>
                          <td className="py-2 px-3 text-slate-200 whitespace-nowrap">{req.intent}</td>
                          <td className="py-2 px-3 text-slate-400 max-w-xs truncate" title={req.path}>{req.path}</td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isBlocked ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                              {req.status}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right whitespace-nowrap">
                            <button
                              onClick={() => openCustomMsgModal(req.origin)}
                              className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 text-[11px] font-semibold hover:bg-cyan-500/20 transition"
                            >
                              Message
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 4: API & SCREEN TAKEOVER MESSAGES */}
          {activeTab === 'countermeasures' && (
            <div className="p-4 flex-1 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-white font-mono flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-cyan-400" />
                    <span>ACTIVE API & SCREEN TAKEOVER NOTICES</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Any caller listed below will receive this custom message returned in JSON for their API requests, and rendered on full screen if they embed the video player.
                  </p>
                </div>

                <button
                  onClick={() => openCustomMsgModal('')}
                  className="px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Notice</span>
                </button>
              </div>

              {customMessages.length === 0 ? (
                <div className="py-16 text-center text-slate-500 font-mono text-xs">
                  No active takeover messages. Click "Send Message" on any caller to inject one.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {customMessages.map((msg) => (
                    <div key={msg.domain} className="bg-[#080B14] border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                      <div className="space-y-1.5 flex-1 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-cyan-300 text-sm">{msg.domain === '*' ? 'GLOBAL ALL' : msg.domain}</span>
                          <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            Active Interception
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-white">{msg.heading}</div>
                        <div className="text-xs text-slate-300 whitespace-pre-wrap bg-[#05070D] p-2 rounded border border-slate-800">
                          {msg.message}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => openCustomMsgModal(msg.domain)}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold hover:bg-slate-700 transition"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteCustomMessage(msg.domain)}
                          className="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* MODAL: CUSTOM API & SCREEN TAKEOVER MESSAGE (FULLY FUNCTIONAL) */}
      {msgModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#0C101C] border border-slate-700 rounded-2xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wide">
                  Deploy Custom Message & API Takeover
                </h3>
              </div>
              <button
                onClick={() => setMsgModalOpen(false)}
                className="text-slate-400 hover:text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-[#070A12] p-3 rounded-lg border border-slate-800 text-xs font-mono space-y-1">
              <div className="text-slate-400">Target Caller / Origin:</div>
              <div className="text-cyan-300 font-bold text-sm">
                {selectedDomainForMsg || 'Global (All Unlisted)'}
              </div>
              <div className="text-[11px] text-slate-500 pt-1 border-t border-slate-800">
                Notice: Is target ko set kiya hua message har API response (rates, exchange, scores) me JSON format me aur live player screen par turant return hoga.
              </div>
            </div>

            {/* Presets */}
            <div>
              <label className="block text-[11px] font-mono text-slate-400 uppercase mb-1.5 font-bold">
                Quick Template Presets:
              </label>
              <div className="flex flex-wrap gap-2">
                {PRESET_MESSAGES.map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setCustomHeading(preset.heading);
                      setCustomBody(preset.body);
                    }}
                    className="px-2.5 py-1 rounded bg-[#070A12] hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-300 transition"
                  >
                    {preset.title}
                  </button>
                ))}
              </div>
            </div>

            {/* Heading */}
            <div>
              <label className="block text-xs font-mono font-bold text-slate-300 mb-1 uppercase">
                Notice Heading
              </label>
              <input
                type="text"
                value={customHeading}
                onChange={(e) => setCustomHeading(e.target.value)}
                placeholder="ACCESS RESTRICTED"
                className="w-full px-3 py-2 bg-[#070A12] border border-slate-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Body */}
            <div>
              <label className="block text-xs font-mono font-bold text-slate-300 mb-1 uppercase">
                Takeover Message Body (Shown in API response and on screen)
              </label>
              <textarea
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 bg-[#070A12] border border-slate-700 rounded-lg text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Live API Response Preview */}
            <div className="bg-[#05070D] p-3 rounded-lg border border-slate-800 text-[11px] font-mono">
              <span className="text-slate-500 font-bold block mb-1">Live API Response Preview:</span>
              <pre className="text-cyan-300 overflow-x-auto">
{JSON.stringify({
  success: false,
  error: true,
  blocked: true,
  heading: customHeading,
  message: customBody.split('\n')[0],
  contact: 'WhatsApp: +63 945 146 9623'
}, null, 2)}
              </pre>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setMsgModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingMsg}
                onClick={handleSaveCustomMessage}
                className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow-lg shadow-cyan-900/30"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{savingMsg ? 'Deploying...' : 'Deploy Message Takeover'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
