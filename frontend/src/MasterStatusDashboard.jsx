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
  Sliders
} from 'lucide-react';

export default function MasterStatusDashboard({ onBack, onNavigateWhitelist }) {
  const [token, setToken] = useState(() => localStorage.getItem('cstv_master_token') || '');
  const [loginId, setLoginId] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Live Telemetry Data
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState(3000); // 3s default
  const [lastUpdated, setLastUpdated] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('traffic'); // 'traffic' | 'origins' | 'bypass' | 'countermeasures'
  const [intentFilter, setIntentFilter] = useState('ALL');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [projectFilter, setProjectFilter] = useState('ALL');

  // Custom Message Modal / State
  const [msgModalOpen, setMsgModalOpen] = useState(false);
  const [selectedDomainForMsg, setSelectedDomainForMsg] = useState('');
  const [customHeading, setCustomHeading] = useState('ACCESS VIOLATION: UNAUTHORIZED STREAM DETECTED');
  const [customBody, setCustomBody] = useState(
    'This live broadcast belongs to CSTV Master Guard. Unauthorized broadcasting on this domain is strictly forbidden. Broadcast terminated.\nContact Support WhatsApp: +63 945 146 9623'
  );
  const [savingMsg, setSavingMsg] = useState(false);
  const [actionStatus, setActionStatus] = useState({ type: '', text: '' });

  // Quick Preset Templates for Countermeasure Messages
  const PRESET_MESSAGES = [
    {
      title: 'Copyright & Stolen Stream Warning',
      heading: 'CRITICAL ACCESS TERMINATION: STOLEN STREAM',
      body: 'WARNING: This live feed is proprietary to CSTV Master Guard. Unauthorized proxying or iframe framing has been detected and logged.\nCease and desist immediately.\nWhatsApp Support: +63 945 146 9623 / +63 915 922 4695'
    },
    {
      title: 'Commercial Whitelist Required',
      heading: 'STREAM ACCESS SUSPENDED: COMMERCIAL LICENSE REQUIRED',
      body: 'Notice: This player requires verified domain authorization. Your origin is not enrolled in the authorized network.\nTo whitelist your operator platform, contact our integration desk:\nWhatsApp: +63 945 146 9623'
    },
    {
      title: 'Hostile Competitor Blacklist Takeover',
      heading: 'HOSTILE ACCESS BLOCKED: DOMAIN BLACKLISTED',
      body: 'Access permanently prohibited for this domain under CSTV Anti-Scraping Policy.\nAll media tunnels severed.\nOfficial Admin Desk: +63 945 146 9623'
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
      setLoginError('Connection error: could not connect to server.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('cstv_master_token');
  };

  // Fetch Live Telemetry from /api/master/telemetry
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
    } catch (e) {
      console.warn('[Telemetry] Poll error:', e.message);
    }
  };

  useEffect(() => {
    if (!token) return;
    fetchTelemetry();

    if (autoRefreshInterval > 0) {
      const interval = setInterval(fetchTelemetry, autoRefreshInterval);
      return () => clearInterval(interval);
    }
  }, [token, autoRefreshInterval]);

  // 1-Click Toggle Block / Unlock
  const handleToggleBlock = async (domain) => {
    if (!domain || domain === 'Direct (No Referer)') return;
    try {
      const res = await fetch(`/api/master/domains/${encodeURIComponent(domain)}/toggle-block`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        }
      });
      const data = await res.json();
      if (data.success) {
        const isBlocked = data.domain?.status === 'blocked';
        showActionStatus('success', `Origin "${domain}" is now ${isBlocked ? 'BLOCKED ⛔' : 'ACTIVE & UNLOCKED ✅'}`);
        fetchTelemetry();
      }
    } catch (err) {
      showActionStatus('error', 'Failed to toggle block status');
    }
  };

  // Open Message Modal for Domain
  const openCustomMsgModal = (domain = '') => {
    setSelectedDomainForMsg(domain);
    // If existing message exists, load it
    const existing = telemetry?.customMessages?.find(
      (m) => m.domain.toLowerCase() === domain.toLowerCase()
    );
    if (existing) {
      setCustomHeading(existing.heading || 'ACCESS VIOLATION: UNAUTHORIZED STREAM DETECTED');
      setCustomBody(existing.message || '');
    } else {
      setCustomHeading('ACCESS VIOLATION: UNAUTHORIZED STREAM DETECTED');
      setCustomBody(
        `This live broadcast belongs to CSTV Master Guard. Unauthorized broadcasting on "${domain || 'your domain'}" is strictly forbidden.\nAll media tunnels severed.\nSupport WhatsApp: +63 945 146 9623`
      );
    }
    setMsgModalOpen(true);
  };

  // Save Custom Message
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
          domain: selectedDomainForMsg || '*',
          heading: customHeading,
          message: customBody,
          active: true,
          isGlobal: !selectedDomainForMsg || selectedDomainForMsg === '*'
        })
      });
      const data = await res.json();
      if (data.success) {
        showActionStatus('success', `Custom countermeasure message deployed for "${selectedDomainForMsg || 'ALL UNLISTED THIEVES'}"!`);
        setMsgModalOpen(false);
        fetchTelemetry();
      }
    } catch (err) {
      showActionStatus('error', 'Error deploying countermeasure message');
    } finally {
      setSavingMsg(false);
    }
  };

  // Delete Custom Message
  const handleDeleteCustomMessage = async (domain) => {
    if (!confirm(`Delete custom countermeasure message for "${domain}"?`)) return;
    try {
      await fetch(`/api/master/custom-messages/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      showActionStatus('success', `Message deleted for "${domain}"`);
      fetchTelemetry();
    } catch (err) {
      showActionStatus('error', 'Failed to delete message');
    }
  };

  const showActionStatus = (type, text) => {
    setActionStatus({ type, text });
    setTimeout(() => setActionStatus({ type: '', text: '' }), 4000);
  };

  // Helper formatting
  const formatUptime = (seconds = 0) => {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  // -------------------------------------------------------------
  // LOGIN SCREEN
  // -------------------------------------------------------------
  if (!token) {
    return (
      <div className="min-h-screen bg-[#07090E] text-slate-200 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-[#0F1420] border border-slate-800 rounded-2xl p-8 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-cyan-500 to-emerald-500" />
          
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Activity className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                CSTV STATUS CENTER
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  LIVE SOC
                </span>
              </h1>
              <p className="text-xs text-slate-400">VPS Telemetry & Origin Guard Engine</p>
            </div>
          </div>

          {loginError && (
            <div className="mb-5 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Master Security ID
              </label>
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="Enter Master ID"
                required
                className="w-full px-3.5 py-2.5 bg-[#090C14] border border-slate-700/80 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Master Password
              </label>
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="••••••••••••"
                required
                className="w-full px-3.5 py-2.5 bg-[#090C14] border border-slate-700/80 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg text-sm transition flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/30 disabled:opacity-50 mt-2"
            >
              {loginLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Authenticating...</span>
                </>
              ) : (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Access Live Telemetry Dashboard</span>
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-800 text-center">
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
  const intents = telemetry?.intents || [];
  const vpsProjects = telemetry?.vpsProjects || [];
  const projectDistribution = telemetry?.projectDistribution || [];
  const bypassAlerts = telemetry?.bypassAlerts || [];
  const customMessages = telemetry?.customMessages || [];
  const recentRequests = telemetry?.recentRequests || [];

  // Filtered requests based on UI selections (Universal VPS Filter)
  const filteredRequests = recentRequests.filter((r) => {
    if (projectFilter !== 'ALL' && (!r.project || !r.project.toLowerCase().includes(projectFilter.toLowerCase()))) return false;
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
    <div className="min-h-screen bg-[#07090E] text-slate-200 flex flex-col font-sans selection:bg-emerald-500/30">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 bg-[#0B0F19]/90 backdrop-blur-md border-b border-slate-800/80 px-4 lg:px-8 py-3">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Activity className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-white tracking-tight">
                  CSTV LIVE STATUS & TRAFFIC INSPECTOR
                </h1>
                <span className="inline-flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  LIVE TELEMETRY
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Multi-Project VPS Traffic, Origin Breakdown & Anti-Theft Guard Engine
              </p>
            </div>
          </div>

          {/* Quick Nav & Controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Auto Refresh Selector */}
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
              <button
                onClick={() => setAutoRefreshInterval(10000)}
                className={`px-2 py-1 rounded transition ${autoRefreshInterval === 10000 ? 'bg-emerald-600 text-white font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                10s
              </button>
            </div>

            <button
              onClick={fetchTelemetry}
              className="p-2 rounded-lg bg-[#0F1420] border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white text-xs transition flex items-center gap-1.5"
              title="Refresh Now"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Switch to Domain Whitelist */}
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
              <span>Domain Whitelist</span>
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

      {/* Global Status Alert Banner if Any */}
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
      <main className="max-w-7xl w-full mx-auto p-4 lg:p-8 flex-1 flex flex-col gap-6">
        {/* VPS SITES & PM2 PROJECTS STRIP (ALL SITES MONITORED) */}
        <div className="bg-[#0B0F19] border border-slate-800 rounded-xl p-3.5 flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs">
            <span className="font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <span>ACTIVE SITES & SERVICES ON THIS VPS ({vpsProjects.length} Microservices Detected)</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-slate-400">
                Click any project to filter live traffic stream:
              </span>
              {projectFilter !== 'ALL' && (
                <button
                  onClick={() => setProjectFilter('ALL')}
                  className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-mono font-bold"
                >
                  Clear Filter [Show All]
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {vpsProjects.map((p, idx) => {
              const isSelected = projectFilter === p.name || (p.domain && projectFilter === p.domain);
              return (
                <div
                  key={idx}
                  onClick={() => setProjectFilter(isSelected ? 'ALL' : (p.name || p.domain))}
                  className={`p-2.5 rounded-lg border transition cursor-pointer flex items-center justify-between ${
                    isSelected
                      ? 'bg-cyan-500/15 border-cyan-500 text-white shadow-md'
                      : 'bg-[#07090E] border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                    <div className="truncate">
                      <div className="text-xs font-bold font-mono truncate">{p.name || p.domain}</div>
                      <div className="text-[10px] text-slate-400 truncate">
                        {p.source || 'Active'} {p.memoryMb ? `• ${p.memoryMb}MB RAM` : ''}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                </div>
              );
            })}
          </div>
        </div>

        {/* TOP TELEMETRY 4 CARDS */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* CARD 1: VPS Host Health */}
          <div className="bg-[#0F1420] border border-slate-800 rounded-xl p-4.5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                  <Server className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">VPS Host Health</h3>
                  <p className="text-[10px] text-slate-400">Node.js Stream Daemon</p>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                NORMAL
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between items-center text-slate-400">
                <span>System Uptime:</span>
                <span className="text-white font-semibold">{formatUptime(vps.uptime)}</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>RAM Used:</span>
                <span className="text-cyan-300 font-semibold">
                  {vps.usedMemMb ? `${vps.usedMemMb} MB / ${vps.totalMemMb} MB` : 'Calculating...'}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Node RSS Memory:</span>
                <span className="text-slate-200">{vps.nodeRssMb ? `${vps.nodeRssMb} MB` : '-'}</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>CPU Load (1m/5m):</span>
                <span className="text-slate-200">
                  {vps.loadavg ? vps.loadavg.slice(0, 2).map((l) => l.toFixed(2)).join(', ') : '-'}
                </span>
              </div>
            </div>

            {/* Visual RAM Usage Bar */}
            <div className="mt-3">
              <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, vps.memUsagePercent || 40)}%` }}
                />
              </div>
            </div>
          </div>

          {/* CARD 2: Request Velocity */}
          <div className="bg-[#0F1420] border border-slate-800 rounded-xl p-4.5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
                  <Activity className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">Request Velocity</h3>
                  <p className="text-[10px] text-slate-400">Real-time Traffic Volume</p>
                </div>
              </div>
              <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                {vps.reqPerSec || 0} req/s
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between items-center text-slate-400">
                <span>Total Requests:</span>
                <span className="text-white font-bold text-sm">
                  {summary.totalRequests?.toLocaleString() || 0}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Authorized (200 OK):</span>
                <span className="text-emerald-400 font-semibold">
                  {summary.allowedRequests?.toLocaleString() || 0}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Blocked / Dropped:</span>
                <span className="text-rose-400 font-semibold">
                  {summary.blockedRequests?.toLocaleString() || 0}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Unique Caller Origins:</span>
                <span className="text-cyan-300 font-semibold">{summary.totalOrigins || 0}</span>
              </div>
            </div>
          </div>

          {/* CARD 3: Active Live Broadcasters */}
          <div className="bg-[#0F1420] border border-slate-800 rounded-xl p-4.5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
                  <Radio className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">Broadcast Status</h3>
                  <p className="text-[10px] text-slate-400">Casino TV & Sports TV</p>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 font-semibold">
                ACTIVE
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between items-center text-slate-400">
                <span>Casino Tables:</span>
                <span className="text-white font-semibold">17 Tables Active in RAM</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Sports TV Engine:</span>
                <span className="text-emerald-400 font-semibold">Direct Native Feeds</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Zero Proxy Bandwidth:</span>
                <span className="text-emerald-300 font-semibold">100% Enforced</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Upstream Token Exp:</span>
                <span className="text-slate-300">Auto-Prewarmed</span>
              </div>
            </div>
          </div>

          {/* CARD 4: Theft & Bypass Countermeasures */}
          <div className="bg-[#0F1420] border border-slate-800 rounded-xl p-4.5 relative overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
                  <AlertOctagon className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">Theft Countermeasures</h3>
                  <p className="text-[10px] text-slate-400">Bypass & Hijack Defense</p>
                </div>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30 font-semibold">
                GUARD ON
              </span>
            </div>

            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between items-center text-slate-400">
                <span>Total Intrusions Blocked:</span>
                <span className="text-rose-400 font-bold">
                  {summary.totalBypassAlerts || 0}
                </span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Direct URL Hits:</span>
                <span className="text-amber-400 font-semibold">Blocked by Default</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Postman / Scrapers:</span>
                <span className="text-rose-400 font-semibold">Auto-Killed</span>
              </div>
              <div className="flex justify-between items-center text-slate-400">
                <span>Custom Warning Takeovers:</span>
                <span className="text-cyan-300 font-semibold">
                  {customMessages.length} Active Notice{customMessages.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* WORKSTATION TABS */}
        <section className="bg-[#0F1420] border border-slate-800 rounded-xl overflow-hidden shadow-xl flex-1 flex flex-col">
          {/* Tab Navigation Header */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between border-b border-slate-800 p-2 sm:px-4 bg-[#090C14]">
            <div className="flex items-center gap-1 overflow-x-auto custom-scroll pb-1 sm:pb-0">
              <button
                onClick={() => setActiveTab('traffic')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'traffic'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Real-Time Request Stream ({filteredRequests.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('origins')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'origins'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Origin & Domain Intelligence ({origins.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('bypass')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'bypass'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <AlertOctagon className="w-3.5 h-3.5" />
                <span>Theft & Bypass Alerts ({bypassAlerts.length})</span>
              </button>

              <button
                onClick={() => setActiveTab('countermeasures')}
                className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 transition whitespace-nowrap ${
                  activeTab === 'countermeasures'
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/30'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Custom Hijack Messages ({customMessages.length})</span>
              </button>
            </div>

            {/* Quick Filter & Search Bar */}
            <div className="flex items-center gap-2 mt-2 sm:mt-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter Origin / IP / Path..."
                  className="pl-8 pr-3 py-1.5 bg-[#07090E] border border-slate-700/80 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 w-44 sm:w-56 font-mono"
                />
              </div>

              {activeTab === 'traffic' && (
                <>
                  <select
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-[#07090E] border border-slate-700/80 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500"
                  >
                    <option value="ALL">All VPS Sites</option>
                    {vpsProjects.map((p, idx) => (
                      <option key={idx} value={p.name}>
                        {p.name} {p.domain ? `(${p.domain})` : ''}
                      </option>
                    ))}
                  </select>

                  <select
                    value={intentFilter}
                    onChange={(e) => setIntentFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-[#07090E] border border-slate-700/80 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500"
                  >
                    <option value="ALL">All Intents</option>
                    <option value="Sports TV Stream">Sports TV Stream</option>
                    <option value="Casino TV Stream">Casino TV Stream</option>
                    <option value="Sports Match List">Sports Match List</option>
                    <option value="Casino Tables List">Casino Tables List</option>
                    <option value="Token Pre-Warm & Ping">Token Pre-Warm & Ping</option>
                    <option value="WebSocket Tunnel">WebSocket Tunnel</option>
                    <option value="Master Guard Admin API">Master Admin API</option>
                  </select>

                  <select
                    value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    className="px-2.5 py-1.5 bg-[#07090E] border border-slate-700/80 rounded-lg text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500"
                  >
                    <option value="ALL">All Actions</option>
                    <option value="ALLOWED">Allowed Only</option>
                    <option value="BLOCKED">Blocked Only</option>
                  </select>
                </>
              )}
            </div>
          </div>

          {/* TAB 1: REAL-TIME TRAFFIC INSPECTOR STREAM */}
          {activeTab === 'traffic' && (
            <div className="flex-1 overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#090C14]/70 text-slate-400 font-mono text-[11px] uppercase tracking-wider">
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Target VPS Site</th>
                    <th className="py-2.5 px-3">Caller IP</th>
                    <th className="py-2.5 px-3">Origin / Domain</th>
                    <th className="py-2.5 px-3">Resource Intent</th>
                    <th className="py-2.5 px-3">Method & Path</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Latency</th>
                    <th className="py-2.5 px-3 text-right">Quick Defense</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                  {filteredRequests.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-slate-500 font-sans">
                        No requests matching active filters in memory buffer. Waiting for live traffic...
                      </td>
                    </tr>
                  ) : (
                    filteredRequests.map((req) => {
                      const isBlocked = req.action === 'BLOCKED';
                      return (
                        <tr
                          key={req.id}
                          className={`hover:bg-slate-800/30 transition ${
                            isBlocked ? 'bg-rose-950/10' : ''
                          }`}
                        >
                          <td className="py-2.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                            {req.timestamp.split('T')[1].slice(0, 12)}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-800/90 text-emerald-400 border border-slate-700/60">
                              {req.project || 'CasinoTV'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span className="text-slate-200 font-bold">{req.ip}</span>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold border ${
                                req.origin.includes('Direct')
                                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                                  : isBlocked
                                  ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
                                  : 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                              }`}
                            >
                              {req.origin}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                                req.intent.includes('Sports')
                                  ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
                                  : req.intent.includes('Casino')
                                  ? 'bg-amber-500/10 text-amber-300 border border-amber-500/30'
                                  : req.intent.includes('Token')
                                  ? 'bg-purple-500/10 text-purple-300 border border-purple-500/30'
                                  : 'bg-slate-800 text-slate-300'
                              }`}
                            >
                              {req.intent}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 max-w-xs truncate text-slate-300 text-[11px]">
                            <span className="text-slate-500 font-bold mr-1.5">{req.method}</span>
                            <span title={req.path}>{req.path}</span>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                isBlocked
                                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              }`}
                            >
                              {req.status} {req.action}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                            {req.durationMs}ms
                          </td>
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5 font-sans">
                              {req.origin && !req.origin.includes('Direct') && (
                                <>
                                  <button
                                    onClick={() => handleToggleBlock(req.origin)}
                                    className="px-2 py-1 rounded bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-[11px] font-semibold transition"
                                    title="Block Origin"
                                  >
                                    <Ban className="w-3 h-3 inline mr-1" />
                                    <span>Block</span>
                                  </button>
                                  <button
                                    onClick={() => openCustomMsgModal(req.origin)}
                                    className="px-2 py-1 rounded bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[11px] font-semibold transition"
                                    title="Set Custom Hijack Message"
                                  >
                                    <MessageSquare className="w-3 h-3 inline mr-1" />
                                    <span>Set Msg</span>
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* TAB 2: ORIGIN & DOMAIN INTELLIGENCE */}
          {activeTab === 'origins' && (
            <div className="p-4 flex-1 flex flex-col gap-4">
              <div className="text-xs text-slate-400">
                Summary of all caller domains and origins communicating with this VPS. You can block any unauthorized origin or set a customized takeover warning with 1 click.
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-[#090C14]/70 text-slate-400 font-mono text-[11px] uppercase tracking-wider">
                      <th className="py-2.5 px-3">Origin / Domain</th>
                      <th className="py-2.5 px-3">Guard Status</th>
                      <th className="py-2.5 px-3">Requests Volume</th>
                      <th className="py-2.5 px-3">% of Total Load</th>
                      <th className="py-2.5 px-3">Allowed vs Blocked</th>
                      <th className="py-2.5 px-3">Countermeasure Notice</th>
                      <th className="py-2.5 px-3">Last Seen</th>
                      <th className="py-2.5 px-3 text-right">Countermeasure Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                    {origins.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-500 font-sans">
                          No origin telemetry recorded yet.
                        </td>
                      </tr>
                    ) : (
                      origins.map((o) => (
                        <tr key={o.rawKey} className="hover:bg-slate-800/30 transition">
                          <td className="py-3 px-3">
                            <span className="font-bold text-white text-sm">{o.origin}</span>
                          </td>
                          <td className="py-3 px-3">
                            {o.isBlocked ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
                                ⛔ BLOCKED
                              </span>
                            ) : o.isWhitelisted ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                ✅ WHITELISTED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                ⚠️ UNLISTED
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-bold text-white">{o.count.toLocaleString()}</td>
                          <td className="py-3 px-3 text-cyan-300 font-semibold">{o.percent}%</td>
                          <td className="py-3 px-3">
                            <span className="text-emerald-400 font-semibold">{o.allowed}</span>
                            <span className="text-slate-500 mx-1">/</span>
                            <span className="text-rose-400 font-semibold">{o.blocked}</span>
                          </td>
                          <td className="py-3 px-3">
                            {o.hasCustomMessage ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                💬 ACTIVE NOTICE
                              </span>
                            ) : (
                              <span className="text-slate-500 text-[11px]">Standard Guard</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-slate-400 text-[11px]">
                            {o.lastSeen ? o.lastSeen.split('T')[1].slice(0, 8) : '-'}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex items-center justify-end gap-2 font-sans">
                              {o.origin && !o.origin.includes('Direct') && (
                                <>
                                  <button
                                    onClick={() => handleToggleBlock(o.origin)}
                                    className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                                      o.isBlocked
                                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                                        : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                    }`}
                                  >
                                    {o.isBlocked ? 'Unlock' : 'Block Origin'}
                                  </button>
                                  <button
                                    onClick={() => openCustomMsgModal(o.origin)}
                                    className="px-2.5 py-1 rounded bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-semibold transition"
                                  >
                                    Set Custom Msg
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 3: BYPASS & INTRUSION ALERTS */}
          {activeTab === 'bypass' && (
            <div className="p-4 flex-1 flex flex-col gap-4">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  Log of entities caught attempting to bypass stream security (direct address bar visits, automated scraping tools, or hostile competitor framing).
                </span>
                <span className="font-mono text-rose-400 font-bold">
                  {bypassAlerts.length} Intrusion Attempts Blocked
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {bypassAlerts.length === 0 ? (
                  <div className="col-span-2 py-12 text-center text-slate-500 font-sans">
                    Zero bypass attempts recorded. All traffic is fully authorized.
                  </div>
                ) : (
                  bypassAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="bg-[#090C14] border border-rose-500/30 rounded-xl p-4 flex flex-col justify-between gap-3 relative overflow-hidden"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shrink-0">
                            <AlertTriangle className="w-3.5 h-3.5" />
                          </div>
                          <div>
                            <span className="font-bold text-white text-sm font-mono">{alert.origin}</span>
                            <div className="text-[11px] text-slate-400 font-mono">IP: {alert.ip}</div>
                          </div>
                        </div>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold whitespace-nowrap">
                          {alert.action}
                        </span>
                      </div>

                      <div className="bg-[#06080E] border border-slate-800 rounded-lg p-2.5 text-xs font-mono space-y-1">
                        <div className="text-rose-300 font-semibold">{alert.reason}</div>
                        <div className="text-slate-400 truncate">Target: {alert.path}</div>
                        <div className="text-slate-500 text-[10px] truncate">User-Agent: {alert.ua}</div>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 text-[11px]">
                        <span className="text-slate-400 font-mono">
                          {alert.timestamp.split('T')[1].slice(0, 8)}
                        </span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleToggleBlock(alert.origin)}
                            className="px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 font-semibold border border-rose-500/30 text-[11px]"
                          >
                            Permanent Block
                          </button>
                          <button
                            onClick={() => openCustomMsgModal(alert.origin)}
                            className="px-2 py-0.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 font-semibold border border-cyan-500/30 text-[11px]"
                          >
                            Deploy Message
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB 4: CUSTOM HIJACK MESSAGES CENTER */}
          {activeTab === 'countermeasures' && (
            <div className="p-4 flex-1 flex flex-col gap-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-emerald-400" />
                    <span>Custom Countermeasure & Hijack Takeover Notices</span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    When an unauthorized origin attempts to scrape or embed your live streams, you can inject a custom takeover message that will render across their entire embedded video screen.
                  </p>
                </div>
                <button
                  onClick={() => openCustomMsgModal('')}
                  className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow-lg shadow-emerald-900/30 whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  <span>Create Countermeasure Notice</span>
                </button>
              </div>

              {/* Active Messages List */}
              <div className="space-y-3">
                {customMessages.length === 0 ? (
                  <div className="py-12 bg-[#090C14] border border-slate-800 rounded-xl text-center text-slate-500 text-xs">
                    No custom domain countermeasure notices active yet. Click "Create Countermeasure Notice" above to configure one.
                  </div>
                ) : (
                  customMessages.map((msg) => (
                    <div
                      key={msg.domain}
                      className="bg-[#090C14] border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
                    >
                      <div className="space-y-1.5 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-cyan-300 text-sm">
                            {msg.domain === '*' ? 'GLOBAL NOTICE (ALL UNLISTED THIEVES)' : msg.domain}
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold">
                            ACTIVE TAKEOVER
                          </span>
                        </div>
                        <h4 className="text-xs font-semibold text-white uppercase">{msg.heading}</h4>
                        <p className="text-xs text-slate-300 font-mono whitespace-pre-wrap bg-[#06080E] p-2.5 rounded border border-slate-800">
                          {msg.message}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => openCustomMsgModal(msg.domain)}
                          className="px-3 py-1.5 rounded-lg bg-[#0F1420] hover:bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-300 transition"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteCustomMessage(msg.domain)}
                          className="p-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </section>
      </main>

      {/* MODAL: CREATE / EDIT CUSTOM HIJACK MESSAGE */}
      {msgModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-[#0F1420] border border-slate-700 rounded-2xl p-6 shadow-2xl relative overflow-hidden flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Deploy Custom Countermeasure Takeover</h3>
                  <p className="text-[11px] text-slate-400">
                    This message will replace the live video on the target rogue domain.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setMsgModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 text-xs"
              >
                ✕
              </button>
            </div>

            {/* Quick Template Selector */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Quick Preset Templates
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {PRESET_MESSAGES.map((t, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      setCustomHeading(t.heading);
                      setCustomBody(t.body);
                    }}
                    className="p-2 rounded-lg bg-[#090C14] hover:bg-slate-800 border border-slate-800 text-left text-[11px] text-slate-300 hover:text-white transition"
                  >
                    <div className="font-bold text-cyan-400 truncate">{t.title}</div>
                    <div className="text-slate-500 truncate text-[10px]">{t.heading}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Form Fields */}
            <div className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Target Domain / Origin:
                </label>
                <input
                  type="text"
                  value={selectedDomainForMsg}
                  onChange={(e) => setSelectedDomainForMsg(e.target.value)}
                  placeholder="e.g. series444.com or pirate-stream.net (* for all unlisted)"
                  className="w-full px-3 py-2 bg-[#090C14] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
                <span className="text-[10px] text-slate-500 font-sans">
                  Leave empty or enter * to set this as the default global countermeasure notice for any unauthorized origin.
                </span>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Alert Heading / Banner Title:
                </label>
                <input
                  type="text"
                  value={customHeading}
                  onChange={(e) => setCustomHeading(e.target.value)}
                  placeholder="e.g. CRITICAL SECURITY NOTICE"
                  className="w-full px-3 py-2 bg-[#090C14] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Custom Warning Message Body:
                </label>
                <textarea
                  rows={4}
                  value={customBody}
                  onChange={(e) => setCustomBody(e.target.value)}
                  placeholder="Write your custom countermeasure message here..."
                  className="w-full px-3 py-2 bg-[#090C14] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 custom-scroll font-mono"
                />
              </div>
            </div>

            {/* LIVE PREVIEW BOX */}
            <div>
              <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Live Countermeasure Screen Preview (What the thief sees):
              </label>
              <div className="bg-[#090D16] border border-rose-500/50 rounded-xl p-4 text-center">
                <div className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-400 border border-rose-500/30 mb-2">
                  CASINO / SPORTS TV RESTRICTED
                </div>
                <h4 className="text-sm font-bold text-white uppercase mb-2">{customHeading}</h4>
                <div className="bg-rose-500/15 border border-rose-500/40 rounded-lg p-3 text-left mb-2">
                  <div className="text-[10px] font-bold text-rose-300 uppercase tracking-wider mb-1">
                    🚨 ADMINISTRATOR COUNTERMEASURE NOTICE
                  </div>
                  <div className="text-xs font-semibold text-white whitespace-pre-wrap font-mono">
                    {customBody}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-1">
                    DETECTED ROGUE ORIGIN: <b className="text-cyan-400">{selectedDomainForMsg || 'unauthorized-site.com'}</b>
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setMsgModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-[#090C14] hover:bg-slate-800 text-slate-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingMsg}
                onClick={handleSaveCustomMessage}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition flex items-center gap-2 shadow-lg shadow-emerald-900/30 disabled:opacity-50"
              >
                {savingMsg ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Deploying...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Deploy Countermeasure</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
