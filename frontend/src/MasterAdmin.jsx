import React, { useState, useEffect } from 'react';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Lock,
  Globe,
  Server,
  Plus,
  Trash2,
  RefreshCw,
  LogOut,
  Search,
  Tv,
  Trophy,
  Eye,
  EyeOff,
  Check,
  X,
  AlertCircle,
  ArrowLeft,
  Activity,
  CheckCircle2,
  XCircle,
  Sliders
} from 'lucide-react';

export default function MasterAdmin({ onBack, onNavigateStatus }) {
  const [token, setToken] = useState(() => localStorage.getItem('cstv_master_token') || '');
  const [loginId, setLoginId] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Dashboard Data
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    blocked: 0,
    casinoCount: 0,
    sportsCount: 0,
    totalHits: 0,
    blockedAttempts: 0,
    enforceWhitelist: true,
    allowDirectAccess: true
  });
  const [domains, setDomains] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTabFilter, setActiveTabFilter] = useState('ALL'); // 'ALL' | 'CASINO' | 'SPORTS' | 'IP' | 'DOMAIN' | 'BLOCKED'

  // Inline Quick-Add Whitelist Form State
  const [entryMode, setEntryMode] = useState('domain'); // 'domain' | 'ip'
  const [targetInput, setTargetInput] = useState('');
  const [partnerNote, setPartnerNote] = useState('');
  const [allowCasino, setAllowCasino] = useState(true);
  const [allowSports, setAllowSports] = useState(true);
  const [actionMsg, setActionMsg] = useState({ type: '', text: '' });
  const [addingLoading, setAddingLoading] = useState(false);

  // Helper to determine if a string looks like an IP
  const isIpAddress = (val) => /^(\d{1,3}\.){3}\d{1,3}$/.test(val.trim()) || val.includes(':');

  // Authenticate Session
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
      setLoginError('Server connection error. Please verify backend is running.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    setToken('');
    localStorage.removeItem('cstv_master_token');
  };

  // Fetch Dashboard Data
  const loadDashboardData = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const headers = { 'Authorization': `Bearer ${token}` };

      // Stats
      const statsRes = await fetch('/api/master/status', { headers });
      if (statsRes.status === 401) {
        handleLogout();
        return;
      }
      const statsData = await statsRes.json();
      if (statsData.success) {
        setStats(statsData.stats);
      }

      // Domains
      const domRes = await fetch('/api/master/domains', { headers });
      const domData = await domRes.json();
      if (domData.success) {
        setDomains(domData.domains);
      }

      // Logs
      const logsRes = await fetch('/api/master/logs', { headers });
      const logsData = await logsRes.json();
      if (logsData.success) {
        setLogs(logsData.logs);
      }
    } catch (err) {
      console.error('Error fetching master data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      loadDashboardData();
      const interval = setInterval(loadDashboardData, 5000);
      return () => clearInterval(interval);
    }
  }, [token]);

  // Add Domain / IP to Whitelist
  const handleAddWhitelist = async (e) => {
    e.preventDefault();
    if (!targetInput.trim()) return;

    setActionMsg({ type: '', text: '' });
    setAddingLoading(true);

    try {
      const res = await fetch('/api/master/domains', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          domain: targetInput.trim(),
          note: partnerNote.trim(),
          casino: allowCasino,
          sports: allowSports
        })
      });
      const data = await res.json();
      if (data.success) {
        const itemType = isIpAddress(targetInput) ? 'IP Address' : 'Domain';
        setActionMsg({
          type: 'success',
          text: `✓ Successfully whitelisted ${itemType}: "${targetInput.trim()}" (Casino: ${allowCasino ? 'ON' : 'OFF'}, Sports: ${allowSports ? 'ON' : 'OFF'})`
        });
        setTargetInput('');
        setPartnerNote('');
        loadDashboardData();
        setTimeout(() => setActionMsg({ type: '', text: '' }), 6000);
      } else {
        setActionMsg({ type: 'error', text: data.error || 'Failed to whitelist entry' });
      }
    } catch (err) {
      setActionMsg({ type: 'error', text: 'Network or server error while whitelisting' });
    } finally {
      setAddingLoading(false);
    }
  };

  // Toggle Global Setting (Enforce / Direct Access)
  const handleToggleSetting = async (key, currentValue) => {
    try {
      const res = await fetch('/api/master/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ [key]: !currentValue })
      });
      const data = await res.json();
      if (data.success) {
        setStats(prev => ({ ...prev, [key]: !currentValue }));
      }
    } catch (err) {
      console.error('Error updating setting:', err);
    }
  };

  // Toggle Domain Permission (Casino / Sports)
  const handleTogglePermission = async (domain, type, currentVal) => {
    try {
      const res = await fetch(`/api/master/domains/${encodeURIComponent(domain)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ [type]: !currentVal })
      });
      const data = await res.json();
      if (data.success) {
        setDomains(prev => prev.map(d => d.domain === domain ? data.domain : d));
        loadDashboardData();
      }
    } catch (err) {
      console.error('Error updating domain permission:', err);
    }
  };

  // Toggle Domain Status (Active / Blocked)
  const handleToggleStatus = async (domain, currentStatus) => {
    const nextStatus = currentStatus === 'blocked' ? 'active' : 'blocked';
    try {
      const res = await fetch(`/api/master/domains/${encodeURIComponent(domain)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: nextStatus })
      });
      const data = await res.json();
      if (data.success) {
        setDomains(prev => prev.map(d => d.domain === domain ? data.domain : d));
        loadDashboardData();
      }
    } catch (err) {
      console.error('Error updating status:', err);
    }
  };

  // Delete Domain
  const handleDeleteDomain = async (domain) => {
    if (!window.confirm(`Are you sure you want to permanently remove "${domain}" from the whitelist?`)) return;
    try {
      const res = await fetch(`/api/master/domains/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setDomains(prev => prev.filter(d => d.domain !== domain));
        loadDashboardData();
      }
    } catch (err) {
      console.error('Error deleting domain:', err);
    }
  };

  // Quick Whitelist helper from Logs or Table
  const quickFillWhitelist = (target, forCasino = true, forSports = true) => {
    setTargetInput(target);
    setPartnerNote(`Whitelisted from live stream access log`);
    setAllowCasino(forCasino);
    setAllowSports(forSports);
    if (isIpAddress(target)) setEntryMode('ip');
    else setEntryMode('domain');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Filtered Domains based on Tabs & Search
  const filteredDomains = domains.filter(d => {
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch = d.domain.toLowerCase().includes(q) || (d.note && d.note.toLowerCase().includes(q));
    if (!matchesSearch) return false;

    const isIp = isIpAddress(d.domain);
    if (activeTabFilter === 'CASINO') return d.casino && d.status === 'active';
    if (activeTabFilter === 'SPORTS') return d.sports && d.status === 'active';
    if (activeTabFilter === 'IP') return isIp;
    if (activeTabFilter === 'DOMAIN') return !isIp;
    if (activeTabFilter === 'BLOCKED') return d.status === 'blocked';
    return true;
  });

  // Counts for tabs
  const countAll = domains.length;
  const countCasino = domains.filter(d => d.casino && d.status === 'active').length;
  const countSports = domains.filter(d => d.sports && d.status === 'active').length;
  const countIp = domains.filter(d => isIpAddress(d.domain)).length;
  const countDomain = domains.filter(d => !isIpAddress(d.domain)).length;
  const countBlocked = domains.filter(d => d.status === 'blocked').length;

  // -------------------------------------------------------------
  // LOGIN SCREEN (If not authenticated)
  // -------------------------------------------------------------
  if (!token) {
    return (
      <div className="min-h-screen bg-[#07090e] text-slate-200 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-xl relative">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-rose-600/30 mb-4">
              <Shield className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">CSTV Master Guard</h1>
            <p className="text-xs text-slate-400 mt-1">Domain & IP Whitelisting • Anti-Theft Access Control</p>
          </div>

          {loginError && (
            <div className="mb-5 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-400 text-xs font-medium flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Master ID</label>
              <input
                type="text"
                required
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="Enter Master ID"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Master Password</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full mt-2 bg-gradient-to-r from-rose-600 to-indigo-600 hover:from-rose-500 hover:to-indigo-500 text-white font-semibold py-2.5 rounded-xl shadow-lg shadow-rose-600/25 transition text-sm flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Lock className="w-4 h-4" />
              <span>{loginLoading ? 'Authenticating...' : 'Sign In to Master Guard'}</span>
            </button>
          </form>

          {onBack && (
            <button
              onClick={onBack}
              className="w-full mt-4 py-2 text-xs text-slate-500 hover:text-slate-300 transition flex items-center justify-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Player Hub</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // MASTER DASHBOARD UI
  // -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#07090e] text-slate-200 flex flex-col font-sans antialiased">
      {/* Top Navbar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 sticky top-0 z-40 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-md shadow-rose-600/30">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-white tracking-tight">CSTV Master Guard</span>
                <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  PROTECTED
                </span>
              </div>
              <p className="text-[11px] text-slate-400">Strict Domain & IP Whitelisting Console</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {onNavigateStatus && (
              <button
                onClick={onNavigateStatus}
                className="p-2 text-emerald-300 hover:text-white bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg transition text-xs flex items-center gap-1.5 px-3 font-semibold shadow-sm"
              >
                <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                <span>Live Status (/status)</span>
              </button>
            )}

            {onBack && (
              <button
                onClick={onBack}
                className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition text-xs flex items-center gap-1.5 px-3"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Casino TV</span>
              </button>
            )}

            <button
              onClick={loadDashboardData}
              className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 transition text-xs flex items-center gap-1.5 px-3"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-indigo-400' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <button
              onClick={handleLogout}
              className="p-2 text-rose-400 hover:text-white bg-rose-500/10 hover:bg-rose-500 border border-rose-500/30 rounded-lg transition text-xs flex items-center gap-1.5 px-3"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex-1 space-y-6 w-full">
        {/* Metrics Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium">Whitelisted Domains & IPs</span>
              <Globe className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-bold text-white font-mono">{stats.total}</div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium">Casino TV Allowed</span>
              <Tv className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-bold text-amber-300 font-mono">{stats.casinoCount}</div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium">Sports TV Allowed</span>
              <Trophy className="w-4 h-4 text-sky-400" />
            </div>
            <div className="text-2xl font-bold text-sky-300 font-mono">{stats.sportsCount}</div>
          </div>

          <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 mb-1">
              <span className="text-xs font-medium">Blocked Attacks Caught</span>
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <div className="text-2xl font-bold text-rose-400 font-mono">{stats.blockedAttempts}</div>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* PROMINENT DIRECT WHITELIST CONSOLE (Domain & IP with Separate Controls) */}
        {/* ------------------------------------------------------------- */}
        <div className="bg-slate-900/90 border-2 border-emerald-500/30 rounded-2xl p-5 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"></div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                <Plus className="w-4 h-4" />
              </div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Whitelist New Partner (Domain or Server IP)
              </h2>
            </div>
            <span className="text-xs text-slate-400">
              Authorize specific feeds (Casino TV only, Sports TV only, or Both)
            </span>
          </div>

          {actionMsg.text && (
            <div
              className={`mb-4 p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
                actionMsg.type === 'success'
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300'
                  : 'bg-rose-500/15 border border-rose-500/30 text-rose-300'
              }`}
            >
              {actionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
              <span>{actionMsg.text}</span>
            </div>
          )}

          <form onSubmit={handleAddWhitelist} className="space-y-4">
            {/* Row 1: Target Type Switcher + Target Input + Note Input */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              {/* Type Switcher */}
              <div className="md:col-span-3 flex bg-slate-950 border border-slate-800 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => setEntryMode('domain')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition ${
                    entryMode === 'domain'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>Domain</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEntryMode('ip')}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-lg transition ${
                    entryMode === 'ip'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Server className="w-3.5 h-3.5" />
                  <span>Server IP</span>
                </button>
              </div>

              {/* Target Input */}
              <div className="md:col-span-5">
                <input
                  type="text"
                  required
                  placeholder={
                    entryMode === 'domain'
                      ? 'e.g. aura.igambli.com or *.igambli.com'
                      : 'e.g. 103.21.244.2 or 72.61.172.110'
                  }
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono transition"
                />
              </div>

              {/* Partner Note */}
              <div className="md:col-span-4">
                <input
                  type="text"
                  placeholder="Partner Note (e.g. Client Aura Live)"
                  value={partnerNote}
                  onChange={(e) => setPartnerNote(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition"
                />
              </div>
            </div>

            {/* Row 2: Feed Selection Checkboxes + Quick Preset Buttons + Submit Button */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-center pt-1">
              {/* Casino Permission Card */}
              <div className="md:col-span-4">
                <label
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition select-none ${
                    allowCasino
                      ? 'bg-amber-500/10 border-amber-500/50 text-amber-300'
                      : 'bg-slate-950 border-slate-800 text-slate-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={allowCasino}
                    onChange={(e) => setAllowCasino(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-900 border-slate-700"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold flex items-center gap-1.5">
                        <Tv className="w-3.5 h-3.5 text-amber-400" />
                        <span>Casino TV Feed</span>
                      </span>
                      <span
                        className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                          allowCasino
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {allowCasino ? '✓ ENABLED' : '✕ DISABLED'}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 block mt-0.5">
                      All 17 tables (Teen Patti, Dragon Tiger, etc.)
                    </span>
                  </div>
                </label>
              </div>

              {/* Sports Permission Card */}
              <div className="md:col-span-4">
                <label
                  className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition select-none ${
                    allowSports
                      ? 'bg-sky-500/10 border-sky-500/50 text-sky-300'
                      : 'bg-slate-950 border-slate-800 text-slate-500'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={allowSports}
                    onChange={(e) => setAllowSports(e.target.checked)}
                    className="w-4 h-4 rounded text-sky-500 focus:ring-sky-500 bg-slate-900 border-slate-700"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold flex items-center gap-1.5">
                        <Trophy className="w-3.5 h-3.5 text-sky-400" />
                        <span>Sports TV Feed</span>
                      </span>
                      <span
                        className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded ${
                          allowSports
                            ? 'bg-sky-500/20 text-sky-300'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {allowSports ? '✓ ENABLED' : '✕ DISABLED'}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 block mt-0.5">
                      Live Cricket, Soccer, Tennis streams
                    </span>
                  </div>
                </label>
              </div>

              {/* Submit Action Button */}
              <div className="md:col-span-4 flex items-center gap-2">
                <button
                  type="submit"
                  disabled={addingLoading || (!allowCasino && !allowSports)}
                  className="w-full bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 hover:from-emerald-500 hover:to-teal-400 text-white font-bold py-3 px-5 rounded-xl shadow-lg shadow-emerald-600/30 transition text-xs flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <Check className="w-4 h-4" />
                  <span>{addingLoading ? 'Whitelisting...' : '+ Add to Whitelist Now'}</span>
                </button>
              </div>
            </div>

            {/* Quick Presets */}
            <div className="flex items-center gap-2 text-[11px] text-slate-400 pt-1">
              <span>Quick Permission Presets:</span>
              <button
                type="button"
                onClick={() => { setAllowCasino(true); setAllowSports(true); }}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
              >
                Both Active
              </button>
              <button
                type="button"
                onClick={() => { setAllowCasino(true); setAllowSports(false); }}
                className="px-2 py-0.5 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-medium transition"
              >
                Casino Only
              </button>
              <button
                type="button"
                onClick={() => { setAllowCasino(false); setAllowSports(true); }}
                className="px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 font-medium transition"
              >
                Sports Only
              </button>
            </div>
          </form>
        </div>

        {/* Global Security Controls Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
          <div className="flex flex-wrap items-center gap-3">
            {/* Strict Enforcement Toggle */}
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-lg">
              <span className="text-xs text-slate-400">Strict Enforcement:</span>
              <button
                onClick={() => handleToggleSetting('enforceWhitelist', stats.enforceWhitelist)}
                className={`text-xs font-bold px-2 py-0.5 rounded transition ${
                  stats.enforceWhitelist
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                }`}
              >
                {stats.enforceWhitelist ? 'ON' : 'OFF'}
              </button>
            </div>

            {/* Direct Browser Access Toggle */}
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-3 py-1.5 rounded-lg">
              <span className="text-xs text-slate-400">Direct Browser Test (No Referer):</span>
              <button
                onClick={() => handleToggleSetting('allowDirectAccess', stats.allowDirectAccess)}
                className={`text-xs font-bold px-2 py-0.5 rounded transition ${
                  stats.allowDirectAccess
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                }`}
              >
                {stats.allowDirectAccess ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search domains & IPs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-64 bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>

        {/* Filter Tabs Bar (What is Active) */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <button
            onClick={() => setActiveTabFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'ALL'
                ? 'bg-white text-black shadow-md'
                : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <span>All Entities</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono">
              {countAll}
            </span>
          </button>

          <button
            onClick={() => setActiveTabFilter('CASINO')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'CASINO'
                ? 'bg-amber-500 text-black shadow-md'
                : 'bg-slate-900 border border-slate-800 text-amber-300 hover:text-white'
            }`}
          >
            <Tv className="w-3 h-3" />
            <span>🎰 Casino Active</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/20 font-mono">
              {countCasino}
            </span>
          </button>

          <button
            onClick={() => setActiveTabFilter('SPORTS')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'SPORTS'
                ? 'bg-sky-500 text-black shadow-md'
                : 'bg-slate-900 border border-slate-800 text-sky-300 hover:text-white'
            }`}
          >
            <Trophy className="w-3 h-3" />
            <span>🏏 Sports Active</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/20 font-mono">
              {countSports}
            </span>
          </button>

          <button
            onClick={() => setActiveTabFilter('DOMAIN')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'DOMAIN'
                ? 'bg-emerald-500 text-black shadow-md'
                : 'bg-slate-900 border border-slate-800 text-emerald-300 hover:text-white'
            }`}
          >
            <Globe className="w-3 h-3" />
            <span>🌐 Domains Only</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono">
              {countDomain}
            </span>
          </button>

          <button
            onClick={() => setActiveTabFilter('IP')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'IP'
                ? 'bg-indigo-500 text-white shadow-md'
                : 'bg-slate-900 border border-slate-800 text-indigo-300 hover:text-white'
            }`}
          >
            <Server className="w-3 h-3" />
            <span>🖥️ Server IPs Only</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono">
              {countIp}
            </span>
          </button>

          <button
            onClick={() => setActiveTabFilter('BLOCKED')}
            className={`px-3 py-1.5 rounded-lg font-semibold transition flex items-center gap-1.5 ${
              activeTabFilter === 'BLOCKED'
                ? 'bg-rose-600 text-white shadow-md'
                : 'bg-slate-900 border border-slate-800 text-rose-400 hover:text-white'
            }`}
          >
            <XCircle className="w-3 h-3" />
            <span>🚫 Blocked</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono">
              {countBlocked}
            </span>
          </button>
        </div>

        {/* Authorized Domains & IPs Table */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                Whitelisted Entities (Domains & IPs)
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                {filteredDomains.length} Active in view
              </span>
            </div>
            <span className="text-xs text-slate-400 hidden sm:inline">
              Click on Casino or Sports badge to toggle authorization immediately
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-5">Target (Domain / IP)</th>
                  <th className="py-3 px-4 text-center">🎰 Casino TV Status</th>
                  <th className="py-3 px-4 text-center">🏏 Sports TV Status</th>
                  <th className="py-3 px-4 text-center">Overall State</th>
                  <th className="py-3 px-4 text-center">Hits</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredDomains.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No matching whitelisted entries found in this category.
                    </td>
                  </tr>
                ) : (
                  filteredDomains.map(item => {
                    const isBlocked = item.status === 'blocked';
                    const isIp = isIpAddress(item.domain);
                    return (
                      <tr key={item.domain} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 shrink-0">
                              {isIp ? <Server className="w-4 h-4 text-indigo-400" /> : <Globe className="w-4 h-4 text-emerald-400" />}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-white text-xs font-bold">{item.domain}</span>
                                <span
                                  className={`text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded border ${
                                    isIp
                                      ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30'
                                      : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                                  }`}
                                >
                                  {isIp ? 'SERVER IP' : 'DOMAIN'}
                                </span>
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5">{item.note || 'Authorized Entity'}</div>
                            </div>
                          </div>
                        </td>

                        {/* Casino TV Interactive Pill */}
                        <td className="py-3.5 px-4 text-center">
                          <button
                            onClick={() => handleTogglePermission(item.domain, 'casino', item.casino)}
                            title="Click to toggle Casino TV access"
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase transition flex items-center justify-center gap-1.5 mx-auto ${
                              item.casino
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30 shadow-sm'
                                : 'bg-slate-800/80 text-slate-500 hover:text-slate-300 border border-slate-700/50'
                            }`}
                          >
                            <Tv className="w-3 h-3" />
                            <span>{item.casino ? '✓ ACTIVE' : '✕ DISABLED'}</span>
                          </button>
                        </td>

                        {/* Sports TV Interactive Pill */}
                        <td className="py-3.5 px-4 text-center">
                          <button
                            onClick={() => handleTogglePermission(item.domain, 'sports', item.sports)}
                            title="Click to toggle Sports TV access"
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-extrabold uppercase transition flex items-center justify-center gap-1.5 mx-auto ${
                              item.sports
                                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50 hover:bg-sky-500/30 shadow-sm'
                                : 'bg-slate-800/80 text-slate-500 hover:text-slate-300 border border-slate-700/50'
                            }`}
                          >
                            <Trophy className="w-3 h-3" />
                            <span>{item.sports ? '✓ ACTIVE' : '✕ DISABLED'}</span>
                          </button>
                        </td>

                        {/* Status */}
                        <td className="py-3.5 px-4 text-center">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-extrabold uppercase ${
                              isBlocked
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${isBlocked ? 'bg-rose-400' : 'bg-emerald-400 animate-pulse'}`}></span>
                            {isBlocked ? 'BLOCKED' : 'LIVE'}
                          </span>
                        </td>

                        {/* Hits Counter */}
                        <td className="py-3.5 px-4 text-center font-mono text-slate-300 font-semibold">
                          {item.hitCount || 0}
                        </td>

                        {/* Actions */}
                        <td className="py-3.5 px-5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleToggleStatus(item.domain, item.status)}
                              className={`px-2.5 py-1 text-xs rounded-lg transition font-medium border ${
                                isBlocked
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                                  : 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
                              }`}
                            >
                              {isBlocked ? 'Unblock' : 'Block'}
                            </button>
                            <button
                              onClick={() => handleDeleteDomain(item.domain)}
                              className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition"
                              title="Delete from whitelist"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Security Interception Log */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Live Security Access Logs</h2>
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
            </div>
            <span className="text-xs text-slate-400">Real-time incoming connection attempt interception</span>
          </div>

          <div className="overflow-x-auto max-h-80">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-950/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800 sticky top-0 font-sans">
                <tr>
                  <th className="py-2.5 px-5">Time</th>
                  <th className="py-2.5 px-4">Feed</th>
                  <th className="py-2.5 px-4">Origin Domain / Referer</th>
                  <th className="py-2.5 px-4">Client IP</th>
                  <th className="py-2.5 px-4 text-center">Verdict</th>
                  <th className="py-2.5 px-5">Security Verdict & 1-Click Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500 font-sans">
                      Listening for incoming stream requests...
                    </td>
                  </tr>
                ) : (
                  logs.slice(0, 50).map(l => {
                    const isAllowed = l.action === 'ALLOWED';
                    const timeStr = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    return (
                      <tr key={l.id} className="hover:bg-slate-800/30 transition">
                        <td className="py-2.5 px-5 text-slate-400 text-[11px] whitespace-nowrap">{timeStr}</td>
                        <td className="py-2.5 px-4 font-sans">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                              l.type === 'casino'
                                ? 'bg-amber-500/15 text-amber-300'
                                : 'bg-sky-500/15 text-sky-300'
                            }`}
                          >
                            {l.type}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-white font-medium text-xs">{l.domain}</td>
                        <td className="py-2.5 px-4 text-slate-400 text-[11px]">{l.ip}</td>
                        <td className="py-2.5 px-4 text-center">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${
                              isAllowed
                                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                                : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                            }`}
                          >
                            {l.action}
                          </span>
                        </td>
                        <td className="py-2.5 px-5 text-slate-400 text-[11px] font-sans">
                          <div className="flex items-center gap-2">
                            <span>{l.reason}</span>
                            {!isAllowed && l.domain !== 'Direct Access' && l.domain !== 'Direct / No-Referer' && (
                              <button
                                onClick={() => quickFillWhitelist(l.domain, l.type === 'casino', l.type === 'sports')}
                                className="text-emerald-400 hover:text-emerald-300 underline font-semibold text-[10px]"
                              >
                                + Whitelist {l.domain}
                              </button>
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
        </div>
      </main>
    </div>
  );
}
