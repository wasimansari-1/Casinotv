import React, { useState, useEffect, useRef } from 'react';
import { 
  Tv, 
  Grid, 
  Maximize2, 
  RotateCw, 
  Copy, 
  Check, 
  Search, 
  Flame, 
  Volume2, 
  Info, 
  X,
  Layers,
  Sparkles,
  ExternalLink,
  Trophy,
  Activity,
  Shield
} from 'lucide-react';
import MasterAdmin from './MasterAdmin';

const CATEGORIES = [
  'ALL', 
  'Teen Patti', 
  'Dragon Tiger', 
  'Lucky 7', 
  'Andar Bahar', 
  'Cards', 
  'Baccarat', 
  'Poker'
];

const SPORT_FILTERS = ['ALL', 'Cricket', 'Soccer', 'Tennis'];

export default function App() {
  const [mainHub, setMainHub] = useState(() => {
    if (typeof window !== 'undefined') {
      const p = (window.location.pathname + window.location.hash).toLowerCase();
      if (p.includes('master')) return 'master';
      if (p.includes('sports')) return 'sports';
    }
    return 'casino';
  });

  useEffect(() => {
    const handlePopState = () => {
      const p = (window.location.pathname + window.location.hash).toLowerCase();
      if (p.includes('master')) setMainHub('master');
      else if (p.includes('sports')) setMainHub('sports');
      else setMainHub('casino');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  
  // Casino State
  const [tables, setTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null);
  const [activeCategory, setActiveCategory] = useState('ALL');
  const [viewMode, setViewMode] = useState('single'); // 'single' | 'grid-2' | 'grid-4'
  const [loadedCasinoTableIds, setLoadedCasinoTableIds] = useState(new Set());

  // Automatically track loaded tables so they stay alive in background (Instant 0ms switching)
  useEffect(() => {
    if (selectedTable?.id) {
      setLoadedCasinoTableIds(prev => new Set(prev).add(selectedTable.id));
    }
  }, [selectedTable]);

  // Sports State
  const [sportsEvents, setSportsEvents] = useState([]);
  const [selectedSportMatch, setSelectedSportMatch] = useState(null);
  const [activeSportFilter, setActiveSportFilter] = useState('Cricket');

  // Shared State
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [streamInfoModal, setStreamInfoModal] = useState(false);
  const [directStreamData, setDirectStreamData] = useState(null);
  const [loadingDirect, setLoadingDirect] = useState(false);
  const [reloadKey, setReloadKey] = useState(Date.now());
  const playerContainerRef = useRef(null);

  // Fetch Casino tables
  useEffect(() => {
    fetch('/api/stream/tables')
      .then(res => res.json())
      .then(data => {
        if (data.tables && data.tables.length > 0) {
          setTables(data.tables);
          setSelectedTable(data.tables[0]);
        }
      })
      .catch(err => console.error('Error fetching tables:', err));
  }, []);

  // Fetch Live Sports Matches
  useEffect(() => {
    fetch('/api/stream/sports/events')
      .then(res => res.json())
      .then(data => {
        if (data.events && data.events.length > 0) {
          setSportsEvents(data.events);
          const liveMatch = data.events.find(e => e.inPlay) || data.events[0];
          setSelectedSportMatch(liveMatch);
          if (liveMatch && liveMatch.sportName) {
            setActiveSportFilter(liveMatch.sportName);
          }
        }
      })
      .catch(err => console.error('Error fetching sports:', err));
  }, []);

  // Filter casino tables
  const filteredTables = tables.filter(t => {
    const matchesCat = activeCategory === 'ALL' || t.category === activeCategory;
    const matchesSearch = t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          t.id.includes(searchQuery) ||
                          t.streamId.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesSearch;
  });

  // Filter sports events
  const filteredSports = sportsEvents.filter(e => {
    const matchesSport = activeSportFilter === 'ALL' || e.sportName === activeSportFilter;
    const matchesSearch = e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (e.tournament && e.tournament.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesSport && matchesSearch;
  });

  const handleCopyIframe = () => {
    let code = '';
    if (mainHub === 'casino' && selectedTable) {
      code = `<iframe src="${window.location.origin}/api/stream/player/${selectedTable.id}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`;
    } else if (mainHub === 'sports' && selectedSportMatch) {
      code = `<iframe src="${window.location.origin}/api/stream/sports/player/${selectedSportMatch.id}?sportId=${selectedSportMatch.sportId}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`;
    }
    if (code) {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleReload = () => {
    setReloadKey(Date.now());
  };

  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return;
    if (!document.fullscreenElement) {
      playerContainerRef.current.requestFullscreen().catch(err => {
        console.error('Error entering fullscreen:', err);
      });
    } else {
      document.exitFullscreen();
    }
  };

  if (mainHub === 'master') {
    return (
      <MasterAdmin
        onBack={() => {
          setMainHub('casino');
          if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col font-sans selection:bg-amber-500 selection:text-black">
      {/* Top Navbar */}
      <header className="border-b border-white/10 bg-[#0d1017]/90 backdrop-blur-xl sticky top-0 z-50 px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        {/* Left Branding */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 via-rose-500 to-purple-600 flex items-center justify-center text-xl shadow-lg shadow-amber-500/20">
            {mainHub === 'casino' ? '♠️' : '🏏'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                {mainHub === 'casino' ? 'CasinoTV Live' : 'SportsTV Live'}
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-400">
                PRO
              </span>
            </div>
            <p className="text-xs text-slate-400">Zero-Latency WebRTC Stream Engine</p>
          </div>
        </div>

        {/* Center: Hub Switcher (Casino vs Sports vs Master Guard) */}
        <div className="flex items-center bg-black/40 border border-white/10 p-1 rounded-2xl">
          <button
            onClick={() => {
              setMainHub('casino');
              if (window.location.pathname !== '/') window.history.pushState(null, '', '/');
            }}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              mainHub === 'casino'
                ? 'bg-gradient-to-r from-amber-500 to-rose-500 text-black shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🎰 Casino Tables</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/20 text-black font-bold">
              {tables.length}
            </span>
          </button>

          <button
            onClick={() => {
              setMainHub('sports');
              if (window.location.pathname !== '/sports') window.history.pushState(null, '', '/sports');
            }}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-xl text-xs font-semibold transition-all ${
              mainHub === 'sports'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-black shadow-md shadow-emerald-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Trophy className="w-3.5 h-3.5" />
            <span>🏏 Sports TV</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/20 text-black font-bold">
              {sportsEvents.length}
            </span>
          </button>
        </div>

        {/* Right Search Input */}
        <div className="relative min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder={mainHub === 'casino' ? "Search tables..." : "Search matches, leagues..."}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/60 transition-colors"
          />
        </div>
      </header>

      {/* Sub Header Toolbar */}
      <div className="max-w-7xl w-full mx-auto px-6 pt-5 pb-2 flex flex-wrap items-center justify-between gap-4">
        {/* Category / Sport Filter Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
          {mainHub === 'casino' ? (
            CATEGORIES.map(cat => {
              const count = cat === 'ALL' 
                ? tables.length 
                : tables.filter(t => t.category === cat).length;
              const isActive = activeCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${
                    isActive
                      ? 'bg-gradient-to-r from-amber-500/20 to-purple-500/20 border-amber-500 text-amber-400 shadow-sm shadow-amber-500/20 font-semibold'
                      : 'bg-[#0d1017]/80 border-white/5 text-slate-400 hover:text-white hover:border-white/20'
                  }`}
                >
                  <span>{cat}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-amber-500/30 text-amber-300' : 'bg-white/5 text-slate-400'}`}>
                    {count}
                  </span>
                </button>
              );
            })
          ) : (
            SPORT_FILTERS.map(sport => {
              const count = sport === 'ALL'
                ? sportsEvents.length
                : sportsEvents.filter(e => e.sportName === sport).length;
              const isActive = activeSportFilter === sport;
              return (
                <button
                  key={sport}
                  onClick={() => setActiveSportFilter(sport)}
                  className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${
                    isActive
                      ? 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 border-emerald-500 text-emerald-400 shadow-sm shadow-emerald-500/20 font-semibold'
                      : 'bg-[#0d1017]/80 border-white/5 text-slate-400 hover:text-white hover:border-white/20'
                  }`}
                >
                  <span>{sport}</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-emerald-500/30 text-emerald-300' : 'bg-white/5 text-slate-400'}`}>
                    {count}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Layout Switcher (Casino Only) */}
        {mainHub === 'casino' && (
          <div className="flex bg-white/5 border border-white/10 p-1 rounded-xl">
            <button
              onClick={() => setViewMode('single')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                viewMode === 'single'
                  ? 'bg-amber-500 text-black font-semibold shadow-md shadow-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Tv className="w-3.5 h-3.5" />
              <span>Single TV</span>
            </button>

            <button
              onClick={() => setViewMode('grid-4')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                viewMode === 'grid-4'
                  ? 'bg-amber-500 text-black font-semibold shadow-md shadow-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
              <span>4x Grid</span>
            </button>

            <button
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                viewMode === 'all'
                  ? 'bg-gradient-to-r from-amber-500 to-rose-500 text-black font-bold shadow-md shadow-amber-500/30'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>All Tables ({tables.length})</span>
            </button>
          </div>
        )}
      </div>

      {/* Main Content Area */}
      <main className="max-w-7xl w-full mx-auto px-6 py-4 flex-1">
        {mainHub === 'casino' ? (
          /* ==================== CASINO HUB ==================== */
          viewMode === 'single' ? (
            /* Single Theater View */
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-8 flex flex-col gap-4">
                <div 
                  ref={playerContainerRef}
                  className="bg-[#0e121b] border border-white/10 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md flex flex-col"
                >
                  <div className="px-5 py-3.5 bg-white/[0.03] border-b border-white/10 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      <div>
                        <h2 className="text-sm font-semibold text-white tracking-wide">
                          {selectedTable?.name || 'Loading Stream...'}
                        </h2>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                          <span>Table ID: <strong className="text-slate-300">{selectedTable?.id}</strong></span>
                          <span>•</span>
                          <span className="text-purple-400 font-mono font-medium">{selectedTable?.streamId}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleReload}
                        title="Reload Stream Feed"
                        className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-colors"
                      >
                        <RotateCw className="w-4 h-4" />
                      </button>

                      <button
                        onClick={toggleFullscreen}
                        title="Fullscreen Player"
                        className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-colors"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* 16:9 Video Aspect Ratio with Persistent Keep-Alive Stream Cache */}
                  <div className="relative w-full aspect-video bg-black flex items-center justify-center overflow-hidden">
                    {tables.filter(t => loadedCasinoTableIds.has(t.id)).map(table => {
                      const isSelected = selectedTable?.id === table.id;
                      return (
                        <iframe
                          key={`casino-${table.id}-${reloadKey}`}
                          src={`/api/stream/player/${table.id}?t=${reloadKey}`}
                          title={table.name}
                          style={{
                            display: isSelected ? 'block' : 'none',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            border: 'none'
                          }}
                          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                          allowFullScreen
                        />
                      );
                    })}
                    {!selectedTable && (
                      <div className="text-slate-500 flex flex-col items-center gap-2 text-xs">
                        <RotateCw className="w-6 h-6 animate-spin text-amber-500" />
                        <span>Loading live table...</span>
                      </div>
                    )}
                  </div>

                  {/* Bottom Toolbar */}
                  <div className="px-5 py-3 bg-black/40 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 max-w-full overflow-hidden">
                      <span className="text-slate-400 font-medium shrink-0">Iframe Tag:</span>
                      <code className="text-sky-400 font-mono truncate select-all">
                        {selectedTable 
                          ? `<iframe src="${window.location.origin}/api/stream/player/${selectedTable.id}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`
                          : ''}
                      </code>
                    </div>

                    <button
                      onClick={handleCopyIframe}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors shrink-0"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied!' : 'Copy Code'}</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Table Selector */}
              <div className="lg:col-span-4 bg-[#0e121b] border border-white/10 rounded-2xl p-4 flex flex-col gap-3 shadow-xl max-h-[640px]">
                <div className="flex items-center justify-between border-b border-white/10 pb-3">
                  <span className="text-xs font-semibold text-slate-300">Live Casino Tables</span>
                  <span className="text-[11px] text-slate-400">{filteredTables.length} available</span>
                </div>

                <div className="overflow-y-auto pr-1 flex flex-col gap-2 scrollbar-thin">
                  {filteredTables.map(table => {
                    const isCurrent = selectedTable?.id === table.id;
                    return (
                      <div
                        key={table.id}
                        onClick={() => setSelectedTable(table)}
                        className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                          isCurrent
                            ? 'bg-amber-500/10 border-amber-500/60 shadow-md shadow-amber-500/10'
                            : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`w-2 h-2 rounded-full ${isCurrent ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`}></span>
                          <div>
                            <div className="text-xs font-semibold text-white tracking-wide">{table.name}</div>
                            <div className="text-[10px] text-slate-400 mt-0.5">{table.category} • ID: {table.id}</div>
                          </div>
                        </div>

                        <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md bg-purple-500/20 border border-purple-500/30 text-purple-300">
                          {table.streamId}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            /* Multi-TV Grid Mode */
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                <span>
                  {viewMode === 'all' 
                    ? `Showing All ${filteredTables.length} Live Dealer Tables` 
                    : `Showing 4-Table Focus (${filteredTables.length} total available)`}
                </span>
                <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  Zero-latency WebRTC streams active
                </span>
              </div>

              <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
                {(viewMode === 'all' ? filteredTables : filteredTables.slice(0, 4)).map(table => (
                  <div key={table.id} className="bg-[#0e121b] border border-white/10 rounded-xl overflow-hidden flex flex-col shadow-lg hover:border-amber-500/40 transition-colors">
                    <div className="px-3.5 py-2 bg-white/[0.04] border-b border-white/10 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        <span className="text-xs font-semibold text-white truncate max-w-[160px]">{table.name}</span>
                      </div>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 bg-purple-500/20 text-purple-300 rounded border border-purple-500/30">
                        {table.streamId}
                      </span>
                    </div>

                    <div className="relative w-full aspect-video bg-black">
                      <iframe
                        src={`/api/stream/player/${table.id}?t=${reloadKey}`}
                        title={table.name}
                        className="absolute inset-0 w-full h-full border-none"
                        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        ) : (
          /* ==================== SPORTS TV HUB ==================== */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left 8 Cols: Sports TV Player */}
            <div className="lg:col-span-8 flex flex-col gap-4">
              <div 
                ref={playerContainerRef}
                className="bg-[#0e121b] border border-white/10 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-md flex flex-col"
              >
                <div className="px-5 py-3.5 bg-white/[0.03] border-b border-white/10 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping"></span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold text-white tracking-wide">
                          {selectedSportMatch?.name || 'Select a Match to Watch Live'}
                        </h2>
                        {selectedSportMatch?.inPlay ? (
                          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            LIVE NOW
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                            UPCOMING
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400">
                        <span className="text-emerald-400 font-semibold">{selectedSportMatch?.sportName}</span>
                        <span>•</span>
                        <span className="text-slate-300">{selectedSportMatch?.tournament || 'International League'}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleReload}
                      title="Reload Match Stream"
                      className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-colors"
                    >
                      <RotateCw className="w-4 h-4" />
                    </button>

                    <button
                      onClick={toggleFullscreen}
                      title="Fullscreen Player"
                      className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-colors"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* 16:9 Sports Video Aspect Ratio */}
                <div className="relative w-full aspect-video bg-black flex items-center justify-center overflow-hidden">
                  {selectedSportMatch ? (
                    <iframe
                      key={`sports-${selectedSportMatch.id}-${reloadKey}`}
                      src={`/api/stream/sports/player/${selectedSportMatch.id}?sportId=${selectedSportMatch.sportId}&t=${reloadKey}`}
                      title={selectedSportMatch.name}
                      className="absolute inset-0 w-full h-full border-none"
                      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                      allowFullScreen
                    />
                  ) : (
                    <div className="text-slate-500 flex flex-col items-center gap-2 text-xs">
                      <Trophy className="w-8 h-8 text-emerald-500" />
                      <span>Select a live match from the list on the right</span>
                    </div>
                  )}
                </div>

                {/* Bottom Toolbar */}
                <div className="px-5 py-3 bg-black/40 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 max-w-full overflow-hidden">
                    <span className="text-slate-400 font-medium shrink-0">Iframe Tag:</span>
                    <code className="text-emerald-400 font-mono truncate select-all">
                      {selectedSportMatch 
                        ? `<iframe src="${window.location.origin}/api/stream/sports/player/${selectedSportMatch.id}?sportId=${selectedSportMatch.sportId}" allow="autoplay; fullscreen; unload"></iframe>`
                        : ''}
                    </code>
                  </div>

                  <button
                    onClick={handleCopyIframe}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors shrink-0"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied!' : 'Copy Code'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Right 4 Cols: Live Matches List */}
            <div className="lg:col-span-4 bg-[#0e121b] border border-white/10 rounded-2xl p-4 flex flex-col gap-3 shadow-xl max-h-[640px]">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <span className="text-xs font-semibold text-slate-300">Live Matches with TV</span>
                <span className="text-[11px] text-slate-400">{filteredSports.length} matches</span>
              </div>

              <div className="overflow-y-auto pr-1 flex flex-col gap-2 scrollbar-thin">
                {filteredSports.map(match => {
                  const isCurrent = selectedSportMatch?.id === match.id;
                  return (
                    <div
                      key={match.id}
                      onClick={() => setSelectedSportMatch(match)}
                      className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                        isCurrent
                          ? 'bg-emerald-500/10 border-emerald-500/60 shadow-md shadow-emerald-500/10'
                          : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${isCurrent ? 'bg-emerald-400 animate-pulse' : match.inPlay ? 'bg-emerald-500' : 'bg-slate-600'}`}></span>
                        <div>
                          <div className="text-xs font-semibold text-white tracking-wide">{match.name}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {match.sportName} • {match.tournament || 'Match'}
                          </div>
                        </div>
                      </div>

                      <span className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded border ${
                        match.inPlay
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                          : 'bg-white/5 text-slate-400 border-white/10'
                      }`}>
                        {match.inPlay ? '● LIVE' : 'UPCOMING'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 bg-[#0a0d14] py-4 px-6 text-center text-xs text-slate-500">
        CasinoTV & SportsTV Live Proxy Engine • Multi-Provider Quad Redundancy • Zero Latency WebRTC Broadcast
      </footer>
    </div>
  );
}
