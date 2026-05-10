const state = {
  config: null,
  data: null,
  analysis: null,
  analysisPromise: null,
  selected: null,
  sessionId: "all",
  ideaFilter: "all",
  searchTerm: "",
  removed: []
};

const elements = {
  channelId: document.querySelector("#channelId"),
  watchlist: document.querySelector("#watchlist"),
  saveBtn: document.querySelector("#saveBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  refreshUniverseBtn: document.querySelector("#refreshUniverseBtn"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  status: document.querySelector("#status"),
  universeTitle: document.querySelector("#universeTitle"),
  universeMeta: document.querySelector("#universeMeta"),
  sessionTabs: document.querySelector("#sessionTabs"),
  ideaSearch: document.querySelector("#ideaSearch"),
  ideaFilters: document.querySelector("#ideaFilters"),
  ideasList: document.querySelector("#ideasList"),
  listSummary: document.querySelector("#listSummary"),
  videoCount: document.querySelector("#videoCount"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedLink: document.querySelector("#selectedLink"),
  chart: document.querySelector("#tradingviewChart"),
  technicalCanvas: document.querySelector("#technicalCanvas"),
  analysisBtn: document.querySelector("#analysisBtn"),
  analysisOutput: document.querySelector("#analysisOutput"),
  videoStrip: document.querySelector("#videoStrip")
};

function setStatus(text, warning = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("warning", warning);
}

function formatDateTime(value) {
  if (!value) return "עדיין לא עודכן";
  return new Date(value).toLocaleString("he-IL");
}

function renderUniverseStatus(universe) {
  const counts = universe?.counts || { total: 0, NASDAQ: 0, NYSE: 0 };
  elements.universeTitle.textContent = `${counts.total.toLocaleString("he-IL")} סימולים נטענו`;
  elements.universeMeta.textContent = `NASDAQ: ${counts.NASDAQ.toLocaleString("he-IL")} · NYSE: ${counts.NYSE.toLocaleString(
    "he-IL"
  )} · עודכן: ${formatDateTime(universe?.updatedAt)}`;
}

async function loadUniverseStatus() {
  renderUniverseStatus(await api("/api/universe"));
}

async function refreshUniverse() {
  elements.refreshUniverseBtn.disabled = true;
  elements.refreshUniverseBtn.textContent = "מרענן...";
  try {
    const universe = await api("/api/universe/refresh", { method: "POST" });
    renderUniverseStatus(universe);
    await loadFeed();
  } finally {
    elements.refreshUniverseBtn.disabled = false;
    elements.refreshUniverseBtn.textContent = "רענן Universe";
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(value));
}

function cleanSymbol(symbol) {
  return symbol.includes(":") ? symbol : `NASDAQ:${symbol}`;
}

function renderTradingView(symbol) {
  const selectedSymbol = cleanSymbol(symbol);
  elements.chart.innerHTML = "";
  const container = document.createElement("div");
  container.className = "tradingview-widget-container";
  container.style.height = "100%";
  container.style.width = "100%";

  const widget = document.createElement("div");
  widget.className = "tradingview-widget-container__widget";
  widget.style.height = "calc(100% - 32px)";
  widget.style.width = "100%";

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.async = true;
  script.textContent = JSON.stringify({
    autosize: true,
    symbol: selectedSymbol,
    interval: "D",
    timezone: "Asia/Jerusalem",
    theme: "light",
    style: "1",
    locale: "he_IL",
    hide_side_toolbar: false,
    allow_symbol_change: true,
    calendar: false,
    studies: [
      "MASimple@tv-basicstudies",
      "MAExp@tv-basicstudies",
      "RSI@tv-basicstudies",
      "MACD@tv-basicstudies"
    ],
    support_host: "https://www.tradingview.com"
  });

  container.append(widget, script);
  elements.chart.append(container);
  elements.selectedLink.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(selectedSymbol)}`;
}

function renderVideos(idea) {
  elements.videoStrip.innerHTML = "";
  if (!idea?.videos?.length) {
    elements.videoStrip.innerHTML = `<div class="empty">אין סרטון ספציפי שמזכיר את הסימול בכותרת. הוא מופיע מרשימת המעקב.</div>`;
    return;
  }

  for (const video of idea.videos.slice(0, 4)) {
    const link = document.createElement("a");
    link.className = "video";
    link.href = video.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML = `
      <span>${video.title}</span>
      <time>${video.session?.label || "כללי"} · ${formatDate(video.published)}</time>
    `;
    elements.videoStrip.append(link);
  }
}

function selectIdea(idea) {
  state.selected = idea;
  elements.selectedTitle.textContent = idea.symbol;
  elements.analysisOutput.textContent = "טוען ניתוח טכני וקווי גרף...";
  drawEmptyTechnicalChart(idea.symbol);
  renderTradingView(idea.symbol);
  renderVideos(idea);
  document.querySelectorAll(".idea").forEach((button) => {
    button.classList.toggle("active", button.dataset.symbol === idea.symbol);
  });
  renderSelectedAnalysis();
}

function drawEmptyTechnicalChart(symbol) {
  const canvas = elements.technicalCanvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#101615";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e7f6f2";
  ctx.font = "bold 18px Arial";
  ctx.textAlign = "center";
  ctx.fillText(`${symbol} - טוען קווי ניתוח`, canvas.width / 2, canvas.height / 2);
}

function movingAverageSeries(values, length) {
  return values.map((_, index) => {
    if (index + 1 < length) return null;
    const slice = values.slice(index + 1 - length, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / length;
  });
}

function drawTechnicalChart(item) {
  const canvas = elements.technicalCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = { left: 58, right: 28, top: 28, bottom: 38 };
  const history = item.history || [];
  if (history.length < 10) return;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#101615";
  ctx.fillRect(0, 0, width, height);

  const values = history.flatMap((point) => [point.close, item.support, item.resistance]).filter(Number.isFinite);
  const min = Math.min(...values) * 0.98;
  const max = Math.max(...values) * 1.02;
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (index / Math.max(1, history.length - 1)) * chartWidth;
  const y = (value) => pad.top + ((max - value) / (max - min)) * chartHeight;

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.top + (i / 4) * chartHeight;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
  }

  function line(points, color, widthValue = 2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = widthValue;
    ctx.beginPath();
    let started = false;
    points.forEach((point, index) => {
      if (!Number.isFinite(point)) return;
      const xx = x(index);
      const yy = y(point);
      if (!started) {
        ctx.moveTo(xx, yy);
        started = true;
      }
      else ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  }

  const closeSeries = history.map((point) => point.close);
  line(closeSeries, "#7dd3fc", 2.5);
  line(movingAverageSeries(closeSeries, 20), "#f8fafc", 1.6);
  line(movingAverageSeries(closeSeries, 50), "#38bdf8", 1.6);

  const supportY = y(item.support);
  const resistanceY = y(item.resistance);
  ctx.setLineDash([8, 7]);
  ctx.strokeStyle = "#22c55e";
  ctx.beginPath();
  ctx.moveTo(pad.left, supportY);
  ctx.lineTo(width - pad.right, supportY);
  ctx.stroke();
  ctx.strokeStyle = "#f59e0b";
  ctx.beginPath();
  ctx.moveTo(pad.left, resistanceY);
  ctx.lineTo(width - pad.right, resistanceY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (item.trendline) {
    const start = Math.max(0, history.length - 60);
    ctx.strokeStyle = "#e879f9";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(start), y(item.trendline.start));
    ctx.lineTo(width - pad.right, y(item.trendline.end));
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(245,158,11,0.16)";
  ctx.fillRect(pad.left, resistanceY - 10, chartWidth, 20);

  ctx.fillStyle = "#e7f6f2";
  ctx.font = "bold 15px Arial";
  ctx.textAlign = "left";
  ctx.fillText(item.symbol, pad.left, 20);
  ctx.font = "12px Arial";
  ctx.fillStyle = "#f8fafc";
  ctx.fillText("SMA20", pad.left + 88, 20);
  ctx.fillStyle = "#38bdf8";
  ctx.fillText("SMA50", pad.left + 140, 20);
  ctx.font = "12px Arial";
  ctx.fillStyle = "#22c55e";
  ctx.fillText(`תמיכה ${formatNumber(item.support)}`, pad.left + 8, supportY - 8);
  ctx.fillStyle = "#f59e0b";
  ctx.fillText(`התנגדות / פריצה ${formatNumber(item.resistance)}`, pad.left + 8, resistanceY - 8);
  ctx.fillStyle = "#e7f6f2";
  ctx.textAlign = "right";
  ctx.fillText(`מחיר ${formatNumber(item.last)}`, width - pad.right, y(item.last) - 8);
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

function tierLabel(setup = {}) {
  return setup.label || {
    very_hot: "חמה מאוד",
    breakout: "לפני פריצה",
    interesting: "מעניינת",
    watch: "מעקב"
  }[setup.tier] || "מעקב";
}

function tierClass(setup = {}) {
  return setup.tier || (setup.isHot ? "very_hot" : "watch");
}

function sourceLabel(idea = {}) {
  if (idea.sourceType === "transcript") return "תמלול";
  if (idea.sourceType === "title") return "כותרת";
  if (idea.sourceType === "scout" || idea.scout) return "סריקת שוק";
  if (idea.sourceType === "manual" || idea.manual) return "עדיפות";
  return "דינמי";
}

function ideaSearchText(idea) {
  return [
    idea.symbol,
    idea.name,
    idea.notes?.join(" "),
    idea.sessions?.join(" "),
    idea.analysis?.entryReason?.evidence,
    idea.analysis?.entryReason?.technical
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function passesIdeaFilter(idea) {
  if (state.ideaFilter === "all") return true;
  if (state.ideaFilter === "very_hot") return idea.analysis?.setup?.tier === "very_hot";
  if (state.ideaFilter === "breakout") return ["very_hot", "breakout"].includes(idea.analysis?.setup?.tier);
  if (state.ideaFilter === "channel") return ["transcript", "title"].includes(idea.sourceType);
  if (state.ideaFilter === "scout") return idea.sourceType === "scout" || idea.scout;
  if (state.ideaFilter === "changed") return ["new", "stronger", "weaker"].includes(idea.analysis?.change?.type);
  return true;
}

function renderIdeaFilters() {
  const filters = [
    ["all", "הכל"],
    ["channel", "מהערוץ"],
    ["scout", "סריקת שוק"],
    ["breakout", "לפני פריצה"],
    ["very_hot", "חמות בלבד"],
    ["changed", "השתנו"]
  ];
  elements.ideaFilters.innerHTML = "";
  for (const [id, label] of filters) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = id === state.ideaFilter ? "active" : "";
    button.addEventListener("click", () => {
      state.ideaFilter = id;
      renderIdeaFilters();
      renderIdeas();
    });
    elements.ideaFilters.append(button);
  }
}

async function loadAnalysis() {
  if (state.analysisPromise) return state.analysisPromise;
  elements.analysisOutput.textContent = "מחשב ניתוח טכני...";
  state.analysisPromise = api("/api/analysis")
    .then((data) => {
      state.analysis = data.analysis;
      state.removed = data.removed || [];
      state.analysisPromise = null;
      renderIdeas();
      renderSelectedAnalysis();
      return data.analysis;
    })
    .catch((error) => {
      state.analysisPromise = null;
      throw error;
    });
  return state.analysisPromise;
}

function renderSelectedAnalysis() {
  if (!state.selected) return;
  if (!state.analysis) {
    loadAnalysis().catch((error) => setStatus(error.message, true));
    return;
  }

  const item = state.analysis.find((entry) => entry.symbol === state.selected.symbol);
  if (!item) {
    elements.analysisOutput.textContent = "לא נמצא ניתוח עבור הסימול הזה.";
    return;
  }
  if (item.error) {
    elements.analysisOutput.textContent = `לא הצלחתי למשוך נתוני מחיר עבור ${item.symbol}: ${item.error}`;
    return;
  }

  drawTechnicalChart(item);
  const reason = item.entryReason || {};
  const change = item.change || { type: "stable", label: "ללא שינוי חד", detail: "" };
  elements.analysisOutput.innerHTML = `
    <span class="hot-badge ${item.setup?.isHot ? "" : "neutral"}">${item.setup?.isHot ? "מניה חמה" : "סטטוס"}: ${item.setup?.label || "במעקב"}</span>
    <div class="checklist-copy">
      <strong>למה היא נכנסה לצ׳ק ליסט:</strong>
      <p>${item.checklistReason}</p>
      <p>${item.plainSummary}</p>
    </div>
    <div class="analysis-badges">
      <span class="hot-badge ${tierClass(item.setup)}">${tierLabel(item.setup)}</span>
      <span class="change-badge ${change.type}">${change.label}${change.detail ? ` · ${change.detail}` : ""}</span>
    </div>
    <div class="reason-grid">
      <div><span>מקור</span><strong>${reason.source || sourceLabel(state.selected)}</strong></div>
      <div><span>עדות</span><strong>${reason.evidence || state.selected?.notes?.[0] || "-"}</strong></div>
      <div><span>מה רואים טכנית</span><strong>${reason.technical || "-"}</strong></div>
      <div><span>טריגר</span><strong>${reason.trigger || formatNumber(item.breakoutTrigger)}</strong></div>
      <div><span>ביטול</span><strong>${reason.invalidation || formatNumber(item.invalidation)}</strong></div>
      <div><span>מה צריך לקרות</span><strong>${reason.strengthen || "-"}</strong></div>
    </div>
    <div class="metric-grid">
      <div class="metric"><span>מחיר אחרון</span><strong>${formatNumber(item.last)}</strong></div>
      <div class="metric"><span>שינוי יומי</span><strong>${formatNumber(item.changePct)}%</strong></div>
      <div class="metric"><span>RSI 14</span><strong>${formatNumber(item.rsi14)}</strong></div>
      <div class="metric"><span>MACD</span><strong>${formatNumber(item.macd)}</strong></div>
      <div class="metric"><span>ממוצע 20</span><strong>${formatNumber(item.sma20)}</strong></div>
      <div class="metric"><span>ממוצע 50</span><strong>${formatNumber(item.sma50)}</strong></div>
      <div class="metric"><span>תמיכה</span><strong>${formatNumber(item.support)}</strong></div>
      <div class="metric"><span>התנגדות / טריגר</span><strong>${formatNumber(item.resistance)}</strong></div>
      <div class="metric"><span>ניקוד חום</span><strong>${item.setup?.score || 0}/7</strong></div>
      <div class="metric"><span>מרחק מפריצה</span><strong>${formatNumber(item.setup?.breakoutDistancePct)}%</strong></div>
    </div>
    <ul class="signals">${item.signals.map((signal) => `<li>${signal}</li>`).join("")}</ul>
    <p>${item.disclaimer}</p>
  `;
}

function renderIdeas() {
  const currentSession = getCurrentSession();
  let ideas = currentSession?.ideas || state.data?.ideas || [];
  const sourceCount = ideas.length;
  if (state.analysis) {
    const minTechnicalScore = state.config?.research?.minDynamicTechnicalScore ?? 2;
    const minQualityScore = state.config?.research?.minQualityScore ?? 1;
    ideas = ideas
      .map((idea) => ({
        ...idea,
        analysis: state.analysis.find((entry) => entry.symbol === idea.symbol)
      }))
      .filter((idea) => {
        if (!idea.analysis || idea.analysis.error) return false;
        return (idea.analysis.setup?.score || 0) >= minTechnicalScore || (idea.qualityScore || 0) >= minQualityScore + 1;
      })
      .filter((idea) => passesIdeaFilter(idea))
      .filter((idea) => {
        const query = state.searchTerm.trim().toLowerCase();
        return !query || ideaSearchText(idea).includes(query);
      })
      .sort((a, b) => {
        const rank = { very_hot: 4, breakout: 3, interesting: 2, watch: 1 };
        const tierDelta = (rank[b.analysis?.setup?.tier] || 0) - (rank[a.analysis?.setup?.tier] || 0);
        if (tierDelta) return tierDelta;
        const technicalDelta = (b.analysis?.setup?.score || 0) - (a.analysis?.setup?.score || 0);
        if (technicalDelta) return technicalDelta;
        return (b.qualityScore || 0) - (a.qualityScore || 0);
      });
  }
  elements.ideasList.innerHTML = "";
  const videoTotal =
    state.sessionId === "all" ? state.data?.videos?.length || 0 : currentSession?.videos?.length || 0;
  elements.videoCount.textContent = `${videoTotal} סרטונים`;
  elements.listSummary.textContent = state.analysis
    ? `${ideas.length} מניות מעניינות מתוך ${sourceCount} מועמדות שנותחו`
    : `${sourceCount} מועמדות מהתמלולים לפני סינון טכני`;

  if (state.analysis) {
    elements.listSummary.textContent = `${ideas.length} מניות מוצגות מתוך ${sourceCount} מועמדות · ${state.removed.length} ירדו מהריצה הקודמת`;
  }

  if (!ideas.length) {
    elements.ideasList.innerHTML = `<div class="empty">אין כרגע מניות שעומדות בתנאים הטכניים הדינמיים של היום.</div>`;
    return;
  }

  for (const idea of ideas) {
    const analysisItem = idea.analysis || state.analysis?.find((entry) => entry.symbol === idea.symbol);
    const tier = tierClass(analysisItem?.setup);
    const isHot = tier === "very_hot";
    const change = analysisItem?.change;
    const button = document.createElement("button");
    button.className = `idea ${tier}${isHot ? " hot" : ""}`;
    button.dataset.symbol = idea.symbol;
    button.innerHTML = `
      <span>
        <span class="symbol">${idea.symbol}</span>
        <span class="meta">${idea.name ? `${idea.name} · ` : ""}${idea.notes[0] || ""}</span>
        <span class="session-label">${(idea.sessions || []).join(" · ")}</span>
      </span>
      <span class="score${isHot ? " hot" : ""}">${
        isHot
          ? "חמה"
          : analysisItem?.setup?.score
            ? `טכני ${analysisItem.setup.score}/7`
            : idea.scout
              ? "סריקה"
              : idea.qualityScore
                ? `איכות ${idea.qualityScore}`
                : `${idea.mentions} אזכורים`
      }</span>
    `;
    button.innerHTML = `
      <span>
        <span class="symbol">${idea.symbol}</span>
        <span class="meta">${idea.name ? `${idea.name} · ` : ""}${idea.notes[0] || ""}</span>
        <span class="pill-row">
          <span class="session-label">${(idea.sessions || []).join(" · ") || "סריקה"}</span>
          <span class="source-pill">${sourceLabel(idea)}</span>
          ${change ? `<span class="change-pill ${change.type}">${change.label}</span>` : ""}
        </span>
      </span>
      <span class="score ${tier}">${analysisItem?.setup ? `${tierLabel(analysisItem.setup)} ${analysisItem.setup.score}/7` : "סריקה"}</span>
    `;
    button.addEventListener("click", () => selectIdea(idea));
    elements.ideasList.append(button);
  }

  selectIdea(ideas.find((idea) => idea.symbol === state.selected?.symbol) || ideas[0]);
}

function getCurrentSession() {
  if (state.sessionId === "all") {
    return { id: "all", label: "הכל", videos: state.data?.videos || [], ideas: state.data?.ideas || [] };
  }
  return (state.data?.sessions || []).find((session) => session.id === state.sessionId);
}

function renderSessionTabs() {
  const sessions = [
    { id: "all", label: "הכל", videos: state.data?.videos || [] },
    ...(state.data?.sessions || []).filter((session) => session.id !== "general")
  ];

  elements.sessionTabs.innerHTML = "";
  for (const session of sessions) {
    const button = document.createElement("button");
    button.textContent = `${session.label} (${session.videos.length})`;
    button.className = session.id === state.sessionId ? "active" : "";
    button.addEventListener("click", () => {
      state.sessionId = session.id;
      state.selected = null;
      renderSessionTabs();
      renderIdeas();
    });
    elements.sessionTabs.append(button);
  }
}

async function loadConfig() {
  state.config = await api("/api/config");
  elements.channelId.value = state.config.youtube.channelId || "";
  elements.watchlist.value = (state.config.watchlist || []).join(", ");
}

async function loadFeed() {
  setStatus("טוען נתונים מהערוץ...");
  state.data = await api("/api/feed");
  state.analysis = null;
  state.removed = [];
  if (!state.data.configured) {
    setStatus(state.data.message, true);
  } else {
    setStatus(`עודכן לאחרונה: ${new Date(state.data.fetchedAt).toLocaleString("he-IL")}`);
  }
  renderUniverseStatus(state.data.universe);
  renderSessionTabs();
  renderIdeas();
}

async function saveConfig() {
  const channelId = elements.channelId.value.trim();
  const watchlist = elements.watchlist.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(cleanSymbol);

  state.config.youtube.channelId = channelId;
  state.config.watchlist = watchlist;

  await api("/api/config", {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(state.config)
  });
  await loadFeed();
}

elements.saveBtn.addEventListener("click", saveConfig);
elements.refreshBtn.addEventListener("click", loadFeed);
elements.settingsToggle.addEventListener("click", () => {
  elements.settingsPanel.classList.toggle("collapsed");
});
elements.refreshUniverseBtn.addEventListener("click", () => {
  refreshUniverse().catch((error) => setStatus(error.message, true));
});
elements.ideaSearch.addEventListener("input", () => {
  state.searchTerm = elements.ideaSearch.value;
  renderIdeas();
});
elements.analysisBtn.addEventListener("click", () => {
  state.analysis = null;
  loadAnalysis().catch((error) => setStatus(error.message, true));
});

try {
  renderIdeaFilters();
  await loadConfig();
  await loadUniverseStatus();
  await loadFeed();
} catch (error) {
  setStatus(error.message, true);
}
