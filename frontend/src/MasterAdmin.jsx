import React, { useState, useEffect } from 'react';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Lock,
  Globe,
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
  Sliders
} from 'lucide-react';

export default function MasterAdmin({ onBack }) {
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

  // Add Domain Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newNote, setNewNote] = useState('');
  const [allowCasino, setAllowCasino] = useState(true);
  const [allowSports, setAllowSports] = useState(true);
  const [modalError, setModalError] = useState('');
  const [modalLoading, setModalLoading] = useState(false);

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
    if (!window.confirm(`Are you sure you want to remove "${domain}" from whitelist registry?`)) return;
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

  // Quick Whitelist from Logs
  const handleQuickWhitelist = (domain) => {
    setNewDomain(domain);
    setNewNote('Authorized from security audit log');
    setAllowCasino(true);
    setAllowSports(true);
    setModalError('');
    setModalOpen(true);
  };

  // Add Domain Submit
  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setModalError('');
    setModalLoading(true);

    try {
      const res = await fetch('/api/master/domains', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          domain: newDomain.trim(),
          note: newNote.trim(),
          casino: allowCasino,
          sports: allowSports
        })
      });
      const data = await res.json();
      if (data.success) {
        setModalOpen(false);
        setNewDomain('');
        setNewNote('');
        loadDashboardData();
      } else {
        setModalError(data.error || 'Failed to add domain');
      }
    } catch (err) {
      setModalError('Server error while saving domain');
    } finally {
      setModalLoading(false);
    }
  };

  // Filtered Domains
  const filteredDomains = domains.filter(d => {
    const q = searchQuery.toLowerCase().trim();
    return d.domain.toLowerCase().includes(q) || (d.note && d.note.toLowerCase().includes(q));
  });

  // -------------------------------------------------------------
  // LOGIN SCREEN (If not authenticated)
  // -------------------------------------------------------------
  if (!token) {
    return (
      <div className="min-h-screen bg-[#07090e] text-slate-200 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900/90 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-xl relative">
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-rose-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-rose-600/30 mb-4">
              <Shield className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">CSTV Master Guard</h1>
            <p className="text-xs text-slate-400 mt-1">Domain Whitelisting & Anti-Theft Protection</p>
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
              <div className="relative">
                <input
                  type="text"
                  required
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="Enter Master ID"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition"
                />
              </div>
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
              <p className="text-[11px] text-slate-400">Strict Domain Whitelist & Anti-Theft Access Control</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
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
              <span className="text-xs font-medium">Whitelisted Domains</span>
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

        {/* Master Control & Action Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 p-4 rounded-xl">
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setNewDomain('');
                setNewNote('');
                setAllowCasino(true);
                setAllowSports(true);
                setModalError('');
                setModalOpen(true);
              }}
              className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs py-2 px-3.5 rounded-lg shadow-md shadow-emerald-600/20 flex items-center gap-2 transition"
            >
              <Plus className="w-4 h-4" />
              <span>+ Whitelist New Domain / IP</span>
            </button>

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
              <span className="text-xs text-slate-400">Direct Browser Test:</span>
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
              placeholder="Search domains..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-64 bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        {/* Authorized Domains Table */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
          <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider">Authorized Whitelist Registry</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
                {filteredDomains.length}
              </span>
            </div>
            <span className="text-xs text-slate-400 hidden sm:inline">Click badges to toggle Casino or Sports permissions</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/90 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
                <tr>
                  <th className="py-3 px-5">Domain / Hostname</th>
                  <th className="py-3 px-4 text-center">Casino TV</th>
                  <th className="py-3 px-4 text-center">Sports TV</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-center">Hits</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredDomains.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      No matching whitelisted domains found.
                    </td>
                  </tr>
                ) : (
                  filteredDomains.map(item => {
                    const isBlocked = item.status === 'blocked';
                    return (
                      <tr key={item.domain} className="hover:bg-slate-800/30 transition">
                        <td className="py-3.5 px-5">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center text-slate-400 shrink-0">
                              <Globe className="w-3.5 h-3.5" />
                            </div>
                            <div>
                              <div className="font-mono text-white text-xs font-semibold">{item.domain}</div>
                              <div className="text-[11px] text-slate-400">{item.note || 'Authorized Client'}</div>
                            </div>
                          </div>
                        </td>

                        <td className="py-3.5 px-4 text-center">
                          <button
                            onClick={() => handleTogglePermission(item.domain, 'casino', item.casino)}
                            className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase transition ${
                              item.casino
                                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25'
                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {item.casino ? '✓ Allowed' : '✕ Disabled'}
                          </button>
                        </td>

                        <td className="py-3.5 px-4 text-center">
                          <button
                            onClick={() => handleTogglePermission(item.domain, 'sports', item.sports)}
                            className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase transition ${
                              item.sports
                                ? 'bg-sky-500/15 text-sky-300 border border-sky-500/40 hover:bg-sky-500/25'
                                : 'bg-slate-800 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {item.sports ? '✓ Allowed' : '✕ Disabled'}
                          </button>
                        </td>

                        <td className="py-3.5 px-4 text-center">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              isBlocked
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${isBlocked ? 'bg-rose-400' : 'bg-emerald-400'}`}></span>
                            {isBlocked ? 'BLOCKED' : 'ACTIVE'}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-center font-mono text-slate-300">
                          {item.hitCount || 0}
                        </td>

                        <td className="py-3.5 px-5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleToggleStatus(item.domain, item.status)}
                              className={`px-2 py-1 text-xs rounded transition font-medium ${
                                isBlocked
                                  ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                                  : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                              }`}
                            >
                              {isBlocked ? 'Unblock' : 'Block'}
                            </button>
                            <button
                              onClick={() => handleDeleteDomain(item.domain)}
                              className="p-1 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition"
                              title="Delete domain"
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
            <span className="text-xs text-slate-400">Real-time attempt interception</span>
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
                  <th className="py-2.5 px-5">Security Note</th>
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
                          {l.reason}
                          {!isAllowed && l.domain !== 'Direct Access' && l.domain !== 'Direct / No-Referer' && (
                            <button
                              onClick={() => handleQuickWhitelist(l.domain)}
                              className="ml-2 text-emerald-400 hover:underline text-[10px] font-semibold"
                            >
                              + Whitelist
                            </button>
                          )}
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

      {/* ADD DOMAIN MODAL */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-md p-6 rounded-2xl shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Globe className="w-4 h-4 text-emerald-400" />
                <span>Whitelist New Domain / Partner</span>
              </h3>
              <button
                onClick={() => setModalOpen(false)}
                className="text-slate-400 hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalError && (
              <div className="mb-4 p-2.5 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleAddDomain} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Domain or Subdomain</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. aura.igambli.com or *.igambli.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 font-mono"
                />
                <p className="text-[11px] text-slate-500 mt-1">Wildcards supported (*.domain.com)</p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Partner Note / Label</label>
                <input
                  type="text"
                  placeholder="e.g. Client Aura Live Production"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="pt-2">
                <label className="block text-xs font-semibold text-slate-300 mb-2">Feed Authorization</label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex items-center gap-2.5 p-3 bg-slate-950 border border-slate-800 rounded-lg cursor-pointer hover:border-amber-500/50 transition">
                    <input
                      type="checkbox"
                      checked={allowCasino}
                      onChange={(e) => setAllowCasino(e.target.checked)}
                      className="w-4 h-4 rounded text-amber-500 focus:ring-amber-500 bg-slate-800 border-slate-700"
                    />
                    <div>
                      <span className="text-xs font-bold text-amber-400 block">Casino TV</span>
                      <span className="text-[10px] text-slate-400">All 17 tables</span>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 p-3 bg-slate-950 border border-slate-800 rounded-lg cursor-pointer hover:border-sky-500/50 transition">
                    <input
                      type="checkbox"
                      checked={allowSports}
                      onChange={(e) => setAllowSports(e.target.checked)}
                      className="w-4 h-4 rounded text-sky-500 focus:ring-sky-500 bg-slate-800 border-slate-700"
                    />
                    <div>
                      <span className="text-xs font-bold text-sky-400 block">Sports TV</span>
                      <span className="text-[10px] text-slate-400">Cricket, Soccer</span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800 mt-4">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white bg-slate-950 rounded-lg border border-slate-800 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modalLoading}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-md shadow-emerald-600/30 transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{modalLoading ? 'Saving...' : 'Authorize & Save'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

