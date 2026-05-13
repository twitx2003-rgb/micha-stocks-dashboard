import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const tabs = [
  { id: "hot", label: "חמות" },
  { id: "list", label: "רשימה" },
  { id: "chart", label: "גרף" },
  { id: "analysis", label: "ניתוח" },
  { id: "news", label: "חדשות" }
];

const tierRank = { very_hot: 4, breakout: 3, interesting: 2, watch: 1 };

function api(path, options) {
  return fetch(path, options).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
    return body;
  });
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toFixed(digits);
}

function dateTime(value) {
  if (!value) return "עדיין אין עדכון";
  return new Date(value).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
}

function filterHottest(ideas) {
  const veryHot = ideas.filter((idea) => idea.setup?.tier === "very_hot");
  if (veryHot.length >= 8) return veryHot;
  const breakout = ideas.filter((idea) => idea.setup?.tier === "breakout");
  return [...veryHot, ...breakout].slice(0, 16);
}

function ideaSort(a, b) {
  return (tierRank[b.setup?.tier] || 0) - (tierRank[a.setup?.tier] || 0) || (b.setup?.score || 0) - (a.setup?.score || 0);
}

function statusText(refresh) {
  if (refresh?.status === "running") return "מרענן ברקע";
  if (refresh?.status === "failed") return "שגיאה ברענון";
  if (refresh?.lastFinishedAt) return "מעודכן";
  return "מכין נתונים";
}

function App() {
  const isMobile = useMemo(() => window.matchMedia("(max-width: 760px)").matches, []);
  const [activeTab, setActiveTab] = useState(isMobile ? "hot" : "list");
  const [dashboard, setDashboard] = useState(null);
  const [ideas, setIdeas] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [detail, setDetail] = useState(null);
  const [news, setNews] = useState(null);
  const [refresh, setRefresh] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(isMobile ? "hottest" : "all");
  const [notice, setNotice] = useState("");

  async function loadShell() {
    const [dashboardData, ideasData, refreshData] = await Promise.all([
      api("/api/dashboard"),
      api("/api/ideas"),
      api("/api/refresh/status")
    ]);
    setDashboard(dashboardData);
    setIdeas((ideasData.items || []).sort(ideaSort));
    setRefresh(refreshData);
    if (!selectedSymbol && ideasData.items?.length) {
      const first = filterHottest(ideasData.items)[0] || ideasData.items[0];
      setSelectedSymbol(first.symbol);
    }
  }

  async function loadDetail(symbol) {
    if (!symbol) return;
    setDetail(null);
    setDetail(await api(`/api/ideas/${encodeURIComponent(symbol)}`));
  }

  async function loadNews() {
    setNews(await api("/api/news/daily"));
  }

  async function refreshNow() {
    const state = await api("/api/refresh", { method: "POST" });
    setRefresh(state);
    setNotice("הרענון רץ ברקע. הנתונים הקיימים נשארים זמינים.");
  }

  useEffect(() => {
    loadShell().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if (selectedSymbol && (activeTab === "chart" || activeTab === "analysis")) {
      loadDetail(selectedSymbol).catch((error) => setNotice(error.message));
    }
  }, [selectedSymbol, activeTab]);

  useEffect(() => {
    if (activeTab === "news" && !news) loadNews().catch((error) => setNotice(error.message));
  }, [activeTab, news]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const state = await api("/api/refresh/status").catch(() => null);
      if (!state) return;
      const previousVersion = refresh?.version;
      setRefresh(state);
      if (state.status === "completed" && previousVersion !== undefined && state.version !== previousVersion) {
        await loadShell();
        if (activeTab === "news") await loadNews();
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [refresh?.version, activeTab]);

  const visibleIdeas = useMemo(() => {
    let list = ideas;
    if (filter === "hottest") list = filterHottest(list);
    if (filter === "breakout") list = list.filter((idea) => ["very_hot", "breakout"].includes(idea.setup?.tier));
    if (filter === "changed") list = list.filter((idea) => ["new", "stronger", "weaker"].includes(idea.change?.type));
    if (filter === "channel") list = list.filter((idea) => ["transcript", "title"].includes(idea.sourceType));
    const needle = query.trim().toLowerCase();
    if (needle) {
      list = list.filter((idea) => [idea.symbol, idea.name, idea.note].filter(Boolean).join(" ").toLowerCase().includes(needle));
    }
    return list;
  }, [ideas, filter, query]);

  function selectIdea(idea, nextTab = isMobile ? "chart" : activeTab) {
    setSelectedSymbol(idea.symbol);
    setActiveTab(nextTab);
  }

  const selectedIdea = ideas.find((idea) => idea.symbol === selectedSymbol);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Micha.Stocks Intelligence</p>
          <h1>דשבורד מניות חי</h1>
          <span className={`status-pill ${refresh?.status || "idle"}`}>{statusText(refresh)}</span>
        </div>
        <button className="primary" onClick={refreshNow}>רענן עכשיו</button>
      </header>

      <section className="summary-strip">
        <Summary label="חמות מאוד" value={dashboard?.counts?.veryHot || 0} />
        <Summary label="לפני פריצה" value={dashboard?.counts?.breakout || 0} />
        <Summary label="מועמדות" value={dashboard?.counts?.candidates || ideas.length} />
        <Summary label="עודכן" value={dateTime(dashboard?.updatedAt || refresh?.lastFinishedAt)} wide />
      </section>

      {notice && <div className="notice">{notice}</div>}

      <section className={`workspace view-${activeTab}`}>
        <aside className="market-list">
          <div className="toolbar">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="חיפוש סימול, חברה או סיבה" />
            <div className="filters">
              {[
                ["hottest", "חמות ביותר"],
                ["all", "הכל"],
                ["breakout", "לפני פריצה"],
                ["channel", "מהערוץ"],
                ["changed", "השתנו"]
              ].map(([id, label]) => (
                <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
              ))}
            </div>
          </div>
          <IdeaList ideas={activeTab === "hot" ? filterHottest(visibleIdeas) : visibleIdeas} selected={selectedSymbol} onSelect={selectIdea} />
        </aside>

        <section className="detail-panel">
          {activeTab === "news" ? (
            <NewsPage news={news} />
          ) : (
            <>
              <ChartPage symbol={selectedSymbol} detail={detail} />
              <AnalysisPage idea={selectedIdea} detail={detail} />
            </>
          )}
        </section>
      </section>

      <nav className="bottom-nav">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>
    </main>
  );
}

function Summary({ label, value, wide }) {
  return (
    <div className={wide ? "summary wide" : "summary"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IdeaList({ ideas, selected, onSelect }) {
  if (!ideas.length) return <div className="empty">אין כרגע מניות בתצוגה הזו. אפשר לעבור ל״הכל״ או לרענן ברקע.</div>;
  return (
    <div className="idea-list">
      {ideas.map((idea) => (
        <button key={idea.symbol} className={`idea-card ${idea.setup?.tier} ${selected === idea.symbol ? "selected" : ""}`} onClick={() => onSelect(idea)}>
          <span className="symbol">{idea.symbol}</span>
          <span className="name">{idea.name || idea.note || "מניה במעקב"}</span>
          <span className="card-row">
            <b>{idea.setup?.label || "מעקב"} {idea.setup?.score || 0}/7</b>
            <small>RSI {fmt(idea.metrics?.rsi14, 1)} · פריצה {fmt(idea.setup?.breakoutDistancePct, 1)}%</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function ChartPage({ symbol, detail }) {
  const tvSymbol = symbol || "NASDAQ:NVDA";
  return (
    <section className="chart-page">
      <div className="panel-title">
        <h2>{tvSymbol}</h2>
        <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`} target="_blank" rel="noreferrer">פתח ב-TradingView</a>
      </div>
      <div className="tv-frame">
        <iframe
          title="TradingView"
          src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&theme=light&style=1&locale=he_IL`}
        />
      </div>
      <MiniChart detail={detail} />
    </section>
  );
}

function MiniChart({ detail }) {
  if (!detail?.history?.length) return <div className="mini-chart empty">בחר מניה כדי לטעון קווי תמיכה והתנגדות.</div>;
  const values = detail.history.map((point) => point.close).filter(Number.isFinite);
  const min = Math.min(...values, detail.support);
  const max = Math.max(...values, detail.resistance);
  const points = detail.history.map((point, index) => {
    const x = (index / Math.max(1, detail.history.length - 1)) * 100;
    const y = 100 - ((point.close - min) / Math.max(1, max - min)) * 100;
    return `${x},${y}`;
  }).join(" ");
  const supportY = 100 - ((detail.support - min) / Math.max(1, max - min)) * 100;
  const resistanceY = 100 - ((detail.resistance - min) / Math.max(1, max - min)) * 100;
  return (
    <svg className="mini-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="#2f80ed" strokeWidth="1.8" />
      <line x1="0" x2="100" y1={supportY} y2={supportY} stroke="#18a058" strokeDasharray="3 3" />
      <line x1="0" x2="100" y1={resistanceY} y2={resistanceY} stroke="#d98c16" strokeDasharray="3 3" />
    </svg>
  );
}

function AnalysisPage({ idea, detail }) {
  const item = detail || idea;
  if (!item) return <div className="analysis-page empty">בחר מניה מהרשימה.</div>;
  return (
    <section className="analysis-page">
      <div className="analysis-card hot">
        <span>סטטוס</span>
        <strong>{item.setup?.label || idea?.setup?.label || "מעקב"}</strong>
      </div>
      <div className="analysis-grid">
        <Metric label="מחיר" value={fmt(item.last || item.metrics?.last)} />
        <Metric label="שינוי יומי" value={`${fmt(item.changePct || item.metrics?.changePct)}%`} />
        <Metric label="RSI" value={fmt(item.rsi14 || item.metrics?.rsi14, 1)} />
        <Metric label="MACD" value={fmt(item.macd || item.metrics?.macd, 2)} />
        <Metric label="תמיכה" value={fmt(item.support || item.metrics?.support)} />
        <Metric label="התנגדות" value={fmt(item.resistance || item.metrics?.resistance)} />
      </div>
      <div className="reason-card">
        <h3>למה נכנסה</h3>
        <p>{item.entryReason?.plain || idea?.note || "המניה עומדת בתנאים הטכניים של הרשימה הדינמית."}</p>
        <p>{item.entryReason?.technical || item.plainSummary || ""}</p>
      </div>
    </section>
  );
}

function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function NewsPage({ news }) {
  if (!news) return <div className="empty">טוען חדשות יומיות מהתמלולים...</div>;
  return (
    <section className="news-page">
      <div className="panel-title">
        <h2>{news.title}</h2>
        <span>{dateTime(news.updatedAt)}</span>
      </div>
      <div className="news-summary">
        <Summary label="סרטונים" value={news.summary?.videos || 0} />
        <Summary label="טעוני תמלול" value={news.summary?.transcriptLoaded || 0} />
        <Summary label="מניות בולטות" value={news.summary?.highlightedSymbols || 0} />
      </div>
      <h3>עיקרי היום</h3>
      <div className="news-list">
        {(news.highlights || []).map((item) => (
          <article key={item.symbol} className="news-item">
            <strong>{item.symbol} · {item.label} {item.score}/7</strong>
            <p>{item.reason}</p>
            {item.videos?.[0]?.url && <a href={item.videos[0].url} target="_blank" rel="noreferrer">מקור YouTube</a>}
          </article>
        ))}
      </div>
      <h3>לפי סשנים</h3>
      <div className="news-list">
        {(news.sessions || []).map((session) => (
          <article key={session.id} className="news-item">
            <strong>{session.label}</strong>
            <p>{session.videos?.length || 0} סרטונים · מניות: {(session.symbols || []).join(", ") || "-"}</p>
          </article>
        ))}
      </div>
      <p className="disclaimer">{news.disclaimer}</p>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
