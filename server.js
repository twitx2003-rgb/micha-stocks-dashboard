import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const distDir = join(__dirname, "dist");
const dataDir = join(__dirname, "data");
const cacheDir = join(dataDir, "cache");
const configPath = join(__dirname, "config.json");
const universePath = join(dataDir, "universe.json");
const analysisSnapshotPath = join(dataDir, "last-analysis.json");
const dashboardCachePath = join(cacheDir, "dashboard.json");
const ideasCachePath = join(cacheDir, "ideas.json");
const analysisSummaryCachePath = join(cacheDir, "analysis-summary.json");
const dailyNewsCachePath = join(cacheDir, "daily-news.json");
const refreshStatePath = join(cacheDir, "refresh-state.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2));
}

function localNetworkUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJsonSafe(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return await readJson(path);
  } catch {
    return fallback;
  }
}

function escapeXml(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function getTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? escapeXml(match[1].trim()) : "";
}

function getLink(entry) {
  const match = entry.match(/<link[^>]*href="([^"]+)"/i);
  return match ? escapeXml(match[1]) : "";
}

function parseYouTubeFeed(xml) {
  return xml
    .split("<entry>")
    .slice(1)
    .map((chunk) => chunk.split("</entry>")[0])
    .map((entry) => ({
      id: getTag(entry, "yt:videoId"),
      title: getTag(entry, "title"),
      url: getLink(entry),
      published: getTag(entry, "published"),
      updated: getTag(entry, "updated"),
      author: getTag(entry, "name")
    }))
    .filter((video) => video.id && video.title);
}

function hourInJerusalem(value) {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: "Asia/Jerusalem"
  }).formatToParts(new Date(value));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : null;
}

function classifyVideo(video, sessions = []) {
  const title = video.title.toLowerCase();
  const hour = hourInJerusalem(video.published);

  for (const session of sessions) {
    const keywords = session.keywords || [];
    if (keywords.some((keyword) => title.includes(keyword.toLowerCase()))) {
      return { id: session.id, label: session.label, matchedBy: "keyword" };
    }
  }

  const byTime = sessions.find((session) => {
    if (hour === null) return false;
    return hour >= session.startHour && hour < session.endHour;
  });

  if (byTime) {
    return { id: byTime.id, label: byTime.label, matchedBy: "time" };
  }

  return { id: "general", label: "כללי", matchedBy: "fallback" };
}

function normalizeTicker(raw, defaultExchange) {
  const value = raw.replace(/^\$/, "").toUpperCase();
  if (value.includes(":")) return value;
  return `${defaultExchange}:${value}`;
}

function extractTickers(text, defaultExchange) {
  const candidates = new Set();
  const patterns = [
    /\$[A-Z]{1,5}\b/g,
    /\b(?:NASDAQ|NYSE|AMEX|TSX|LSE|TASE):[A-Z0-9.]{1,8}\b/gi,
    /\b[A-Z]{2,5}\b/g
  ];

  const blocked = new Set([
    "THE",
    "AND",
    "FOR",
    "WITH",
    "THIS",
    "THAT",
    "FROM",
    "LIVE",
    "NEWS",
    "USD",
    "ETF",
    "CEO",
    "AI",
    "IPO",
    "EPS"
  ]);

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[0].replace(/^\$/, "").toUpperCase();
      if (!blocked.has(symbol) && symbol.length > 1) {
        candidates.add(normalizeTicker(match[0], defaultExchange));
      }
    }
  }

  return [...candidates].slice(0, 80);
}

function normalizeUniverseSymbol(symbol) {
  return symbol.replace(/\s+/g, "").replaceAll(".", "-").toUpperCase();
}

function parsePipeTable(text) {
  const lines = text.trim().split(/\r?\n/).filter((line) => line && !line.startsWith("File Creation Time"));
  const headers = lines.shift()?.split("|") || [];
  return lines
    .map((line) => line.split("|"))
    .filter((cells) => cells.length === headers.length)
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header.trim(), (cells[index] || "").trim()]))
    );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "local-tradingview-youtube-dashboard" }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function buildUniverseRecord(symbol, exchange, raw) {
  return {
    symbol: normalizeUniverseSymbol(symbol),
    tvSymbol: `${exchange}:${normalizeUniverseSymbol(symbol)}`,
    exchange,
    name: raw["Security Name"] || raw["Company Name"] || "",
    raw
  };
}

async function refreshUniverse(config = {}) {
  const exchanges = new Set(config.universe?.exchanges || ["NASDAQ", "NYSE"]);
  const records = [];

  if (exchanges.has("NASDAQ")) {
    const rows = parsePipeTable(await fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"));
    for (const row of rows) {
      if (row["Test Issue"] === "Y" || !row.Symbol) continue;
      records.push(buildUniverseRecord(row.Symbol, "NASDAQ", row));
    }
  }

  if (exchanges.has("NYSE")) {
    const rows = parsePipeTable(await fetchText("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"));
    for (const row of rows) {
      if (row["Test Issue"] === "Y" || row.Exchange !== "N" || !row["ACT Symbol"]) continue;
      records.push(buildUniverseRecord(row["ACT Symbol"], "NYSE", row));
    }
  }

  const bySymbol = new Map();
  for (const record of records) {
    bySymbol.set(record.symbol, record);
    bySymbol.set(record.tvSymbol, record);
  }

  const uniqueRecords = [...new Map(records.map((record) => [record.tvSymbol, record])).values()].sort((a, b) =>
    a.tvSymbol.localeCompare(b.tvSymbol)
  );
  const payload = {
    updatedAt: new Date().toISOString(),
    source: "nasdaqtrader.com",
    includeAllSecurityTypes: config.universe?.includeAllSecurityTypes !== false,
    counts: {
      total: uniqueRecords.length,
      NASDAQ: uniqueRecords.filter((record) => record.exchange === "NASDAQ").length,
      NYSE: uniqueRecords.filter((record) => record.exchange === "NYSE").length
    },
    records: uniqueRecords
  };
  await writeJson(universePath, payload);
  return payload;
}

async function loadUniverse(config = {}) {
  if (config.universe?.enabled === false) return null;
  if (existsSync(universePath)) return readJson(universePath);
  return refreshUniverse(config);
}

function universeIndex(universe) {
  const index = new Map();
  for (const record of universe?.records || []) {
    index.set(record.symbol, record);
    index.set(record.tvSymbol, record);
  }
  return index;
}

function validateUniverseSymbol(symbol, index) {
  if (!index?.size) return { valid: true, symbol };
  const clean = symbol.includes(":") ? symbol.split(":").at(-1) : symbol;
  const normalized = normalizeUniverseSymbol(clean);
  const direct = index.get(symbol.toUpperCase()) || index.get(normalized);
  if (!direct) return { valid: false, symbol };
  return { valid: true, symbol: direct.tvSymbol, record: direct };
}

function normalizeCompanyText(value = "") {
  return value
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/[^a-z0-9׳-׳×]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyAliasPhrases(name = "") {
  const normalized = normalizeCompanyText(name);
  const stopWords = new Set([
    "inc",
    "incorporated",
    "corp",
    "corporation",
    "company",
    "co",
    "class",
    "ordinary",
    "shares",
    "common",
    "stock",
    "plc",
    "ltd",
    "limited",
    "holdings",
    "holding",
    "group",
    "the",
    "and",
    "of",
    "new",
    "american",
    "acquisition",
    "capital",
    "technologies",
    "technology"
  ]);
  const tokens = normalized.split(" ").filter((token) => token.length >= 3 && !stopWords.has(token));
  const aliases = new Set();
  if (tokens.length >= 2) aliases.add(tokens.slice(0, 2).join(" "));
  if (tokens.length >= 3) aliases.add(tokens.slice(0, 3).join(" "));
  if (tokens[0]?.length >= 5) aliases.add(tokens[0]);
  return [...aliases].filter((alias) => alias.length >= 5);
}

function buildCompanyAliasIndex(universe) {
  const aliases = new Map();
  const collisions = new Set();
  for (const record of universe?.records || []) {
    for (const alias of companyAliasPhrases(record.name)) {
      if (aliases.has(alias) && aliases.get(alias).tvSymbol !== record.tvSymbol) collisions.add(alias);
      else aliases.set(alias, record);
    }
  }
  for (const alias of collisions) aliases.delete(alias);
  return aliases;
}

function extractUniverseCompanyMentions(text, universe) {
  const normalizedText = ` ${normalizeCompanyText(text)} `;
  const matches = [];
  const aliases = buildCompanyAliasIndex(universe);
  for (const [alias, record] of aliases) {
    if (normalizedText.includes(` ${alias} `)) {
      matches.push({
        symbol: record.tvSymbol,
        record,
        alias
      });
    }
  }
  return matches.slice(0, 120);
}

function transcriptQualityContext(text, ticker) {
  const normalizedTicker = (ticker.includes(":") ? ticker.split(":").at(-1) : ticker).toUpperCase();
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|[\n\r]+/)
    .filter(Boolean);
  const hits = sentences.filter((sentence) => {
    const upper = sentence.toUpperCase();
    return upper.includes(`$${normalizedTicker}`) || upper.includes(normalizedTicker);
  });
  return hits.slice(0, 4);
}

function qualityScore(contexts, mentions) {
  const signalWords = [
    "breakout",
    "resistance",
    "support",
    "trend",
    "volume",
    "rsi",
    "macd",
    "moving average",
    "sma",
    "ema",
    "׳₪׳¨׳™׳¦׳”",
    "׳”׳×׳ ׳’׳“׳•׳×",
    "׳×׳׳™׳›׳”",
    "׳׳’׳׳”",
    "׳׳—׳–׳•׳¨",
    "׳׳׳•׳¦׳¢",
    "׳—׳–׳§׳”",
    "׳׳•׳׳ ׳˜׳•׳",
    "׳׳¢׳§׳‘"
  ];
  const contextText = contexts.join(" ").toLowerCase();
  const signalCount = signalWords.filter((word) => contextText.includes(word.toLowerCase())).length;
  return mentions + Math.min(5, signalCount);
}

function mergeTickerCandidates(rawTickers, companyMentions) {
  const merged = new Map();
  for (const ticker of rawTickers) {
    merged.set(ticker, { rawTicker: ticker, alias: null });
  }
  for (const mention of companyMentions) {
    merged.set(mention.symbol, {
      rawTicker: mention.symbol,
      alias: mention.alias,
      record: mention.record
    });
  }
  return [...merged.values()];
}

function extractCaptionTrack(videoHtml) {
  const playerMatch = videoHtml.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\smeta|<\/script>)/s);
  if (!playerMatch) return null;
  try {
    const player = JSON.parse(playerMatch[1]);
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return (
      tracks.find((track) => track.languageCode === "he") ||
      tracks.find((track) => track.languageCode === "iw") ||
      tracks.find((track) => track.languageCode === "en") ||
      tracks[0] ||
      null
    );
  } catch {
    return null;
  }
}

function parseTranscriptXml(xml) {
  return xml
    .split(/<text\b/i)
    .slice(1)
    .map((chunk) => chunk.split("</text>")[0])
    .map((chunk) => chunk.replace(/^.*?>/s, ""))
    .map(escapeXml)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTranscript(videoId) {
  const page = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: { "user-agent": "local-tradingview-youtube-dashboard" }
  });
  if (!page.ok) throw new Error(`Video page returned ${page.status}`);
  const captionTrack = extractCaptionTrack(await page.text());
  if (!captionTrack?.baseUrl) throw new Error("No public transcript found");

  const headers = { "user-agent": "local-tradingview-youtube-dashboard" };
  const formats = ["srv3", "srv1"];
  let lastStatus = null;

  for (const fmt of formats) {
    const response = await fetch(`${captionTrack.baseUrl}&fmt=${fmt}`, { headers });
    lastStatus = response.status;
    if (!response.ok) continue;
    const parsed = parseTranscriptXml(await response.text());
    if (parsed) return parsed;
  }

  // Some videos expose transcripts only without a fmt parameter.
  const fallback = await fetch(captionTrack.baseUrl, { headers });
  lastStatus = fallback.status;
  if (!fallback.ok) throw new Error(`Transcript returned ${lastStatus}`);
  const parsed = parseTranscriptXml(await fallback.text());
  if (parsed) return parsed;
  throw new Error("Transcript was empty");
}

async function enrichVideosWithTranscripts(videos, config) {
  if (!config.research?.useTranscripts) return videos;
  const limit = config.research.maxTranscriptVideos || 8;
  const enriched = [];
  for (const video of videos) {
    if (enriched.length >= limit) {
      enriched.push(video);
      continue;
    }
    try {
      const transcript = await fetchTranscript(video.id);
      enriched.push({
        ...video,
        transcript,
        transcriptStatus: transcript ? "loaded" : "empty"
      });
    } catch (error) {
      enriched.push({
        ...video,
        transcript: "",
        transcriptStatus: "missing",
        transcriptError: error.message
      });
    }
  }
  return enriched;
}

function transcriptIdeas(videos, config, sessionId = "all", universe = null) {
  const scopedVideos =
    sessionId === "all" ? videos : videos.filter((video) => video.session?.id === sessionId);
  const tickerMap = new Map();
  const index = universeIndex(universe);
  for (const video of scopedVideos) {
    const transcriptText = video.transcript || "";
    const hasTranscript = Boolean(transcriptText && transcriptText.trim());
    const researchText = [video.title, transcriptText].join(" ");
    const rawTickers = extractTickers(researchText, config.market.defaultExchange);
    const companyMentions = config.research?.useCompanyNameMatching
      ? extractUniverseCompanyMentions(researchText, universe)
      : [];
    const candidates = mergeTickerCandidates(rawTickers, companyMentions);
    for (const candidate of candidates) {
      const validation = candidate.record
        ? { valid: true, symbol: candidate.record.tvSymbol, record: candidate.record }
        : validateUniverseSymbol(candidate.rawTicker, index);
      if (!validation.valid) continue;
      const ticker = validation.symbol;
      const current = tickerMap.get(ticker) || {
        symbol: ticker,
        exchange: validation.record?.exchange,
        name: validation.record?.name,
        mentions: 0,
        videos: [],
        notes: [],
        sessions: new Set(),
        contexts: [],
        transcriptMentions: 0,
        qualityScore: 0,
        sourceType: hasTranscript ? "transcript" : "title"
      };
      if (hasTranscript) current.sourceType = "transcript";
      const contextBase = hasTranscript ? transcriptText : video.title;
      const contexts = transcriptQualityContext(contextBase, ticker);
      const aliasContexts = candidate.alias ? transcriptQualityContext(researchText, candidate.alias) : [];
      const allContexts = [...contexts, ...aliasContexts];
      current.mentions += 1;
      current.transcriptMentions += allContexts.length || (candidate.alias ? 1 : 0);
      current.videos.push(video);
      current.contexts.push(...allContexts);
      current.notes.push(
        allContexts[0]
          ? `הוזכר בטקסט זמין: "${allContexts[0].slice(0, 180)}"`
          : candidate.alias
            ? `׳–׳•׳”׳” ׳׳₪׳™ ׳©׳ ׳—׳‘׳¨׳”: "${candidate.alias}" ׳‘׳¡׳¨׳˜׳•׳ "${video.title}"`
            : `׳”׳•׳–׳›׳¨ ׳‘׳¡׳¨׳˜׳•׳: "${video.title}"`
      );
      current.sessions.add(video.session?.label || "כללי");
      tickerMap.set(ticker, current);
    }
  }

  return [...tickerMap.values()]
    .map((item) => ({
      ...item,
      sessions: [...item.sessions],
      contexts: item.contexts.slice(0, 8),
      sourceType: item.sourceType || "transcript",
      qualityScore: qualityScore(item.contexts, item.mentions + item.transcriptMentions)
    }))
    .filter((item) => item.qualityScore >= (config.research?.minQualityScore || 2))
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, config.research?.maxQualityIdeas || 40);
}

function marketScoutIdeas(config, universe, existingSymbols = new Set()) {
  if (!config.marketScout?.enabled) return [];
  const index = universeIndex(universe);
  const ideas = [];
  for (const symbol of config.marketScout.expansionSymbols || []) {
    const validation = validateUniverseSymbol(symbol, index);
    if (!validation.valid || existingSymbols.has(validation.symbol)) continue;
    ideas.push({
      symbol: validation.symbol,
      exchange: validation.record?.exchange,
      name: validation.record?.name,
      mentions: 0,
      videos: [],
      notes: ["מועמדת הרחבה: נכנסה לסריקה טכנית כי רשימת הסרטונים הישירה הייתה מצומצמת"],
      sessions: ["סריקת שוק"],
      contexts: [],
      transcriptMentions: 0,
      qualityScore: 1,
      scout: true,
      sourceType: "scout"
    });
  }
  return ideas;
}

function summarize(videos, config, sessionId = "all", universe = null) {
  const tickerMap = new Map();
  const index = universeIndex(universe);
  const scopedVideos =
    sessionId === "all" ? videos : videos.filter((video) => video.session?.id === sessionId);

  for (const video of scopedVideos) {
    const tickers = extractTickers(video.title, config.market.defaultExchange);
    for (const rawTicker of tickers) {
      const validation = validateUniverseSymbol(rawTicker, index);
      if (!validation.valid) continue;
      const ticker = validation.symbol;
      const current = tickerMap.get(ticker) || {
        symbol: ticker,
        exchange: validation.record?.exchange,
        name: validation.record?.name,
        mentions: 0,
        videos: [],
        notes: [],
        sessions: new Set(),
        sourceType: "title"
      };
      current.mentions += 1;
      current.videos.push(video);
      current.notes.push(`׳”׳•׳–׳›׳¨ ׳‘׳›׳•׳×׳¨׳×: "${video.title}"`);
      current.sessions.add(video.session?.label || "כללי");
      tickerMap.set(ticker, current);
    }
  }

  const includeManualWatchlist = Boolean(config.research?.includeManualWatchlist);
  const configured = includeManualWatchlist
    ? (config.watchlist || []).map((symbol) => ({
        symbol,
        mentions: tickerMap.get(symbol)?.mentions || 0,
        videos: tickerMap.get(symbol)?.videos || [],
        notes: tickerMap.get(symbol)?.notes || ["׳‘׳¨׳©׳™׳׳× ׳”׳׳¢׳§׳‘ ׳”׳™׳“׳ ׳™׳×"],
        sessions: [...(tickerMap.get(symbol)?.sessions || [])],
        manual: true,
        sourceType: "manual"
      }))
    : [];

  const transcriptDiscovered = transcriptIdeas(videos, config, sessionId, universe);
  const discovered = [...tickerMap.values()]
    .filter((item) => !configured.some((saved) => saved.symbol === item.symbol))
    .sort((a, b) => b.mentions - a.mentions)
    .map((item) => ({
      ...item,
      sessions: [...item.sessions],
      sourceType: item.sourceType || "title"
    }));

  const merged = new Map();
  for (const item of [...transcriptDiscovered, ...discovered, ...configured]) {
    const existing = merged.get(item.symbol);
    if (!existing || (item.qualityScore || 0) > (existing.qualityScore || 0)) {
      merged.set(item.symbol, item);
    }
  }
  if (sessionId === "all" && merged.size < (config.marketScout?.minCandidateIdeas || 0)) {
    for (const item of marketScoutIdeas(config, universe, new Set(merged.keys()))) {
      merged.set(item.symbol, item);
      if (merged.size >= (config.marketScout?.minCandidateIdeas || 25)) break;
    }
  }
  return [...merged.values()].slice(0, config.research?.maxQualityIdeas || 40);
}

function groupBySession(videos, config, universe = null) {
  const sessionConfigs = [
    ...(config.sessions || []),
    { id: "general", label: "כללי" }
  ];

  return sessionConfigs.map((session) => {
    const sessionVideos = videos.filter((video) => video.session?.id === session.id);
    return {
      id: session.id,
      label: session.label,
      videos: sessionVideos,
      ideas: summarize(videos, config, session.id, universe)
    };
  });
}

function feedUrl(config) {
  if (config.youtube.channelId) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(config.youtube.channelId)}`;
  }
  return "";
}

function toYahooSymbol(symbol) {
  const clean = symbol.includes(":") ? symbol.split(":").at(-1) : symbol;
  return clean.replace(".", "-");
}

function sma(values, length) {
  if (values.length < length) return null;
  const slice = values.slice(-length);
  return slice.reduce((sum, value) => sum + value, 0) / length;
}

function rsi(values, length = 14) {
  if (values.length <= length) return null;
  let gains = 0;
  let losses = 0;
  const slice = values.slice(-(length + 1));
  for (let index = 1; index < slice.length; index += 1) {
    const change = slice[index] - slice[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function ema(values, length) {
  if (values.length < length) return null;
  const multiplier = 2 / (length + 1);
  let current = sma(values.slice(0, length), length);
  for (const value of values.slice(length)) {
    current = value * multiplier + current * (1 - multiplier);
  }
  return current;
}

function macd(values) {
  if (values.length < 35) return null;
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  if (fast === null || slow === null) return null;
  return fast - slow;
}

async function fetchPriceHistory(symbol) {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahooSymbol
  )}?range=6mo&interval=1d`;
  const response = await fetch(url, {
    headers: { "user-agent": "local-tradingview-youtube-dashboard" }
  });
  if (!response.ok) throw new Error(`Price data returned ${response.status}`);
  const body = await response.json();
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!quote?.close) throw new Error("No price data");
  return result.timestamp
    .map((time, index) => ({
      time,
      close: quote.close[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      volume: quote.volume?.[index]
    }))
    .filter((point) => Number.isFinite(point.close));
}

function trendline(points) {
  const recent = points.slice(-60);
  if (recent.length < 20) return null;
  const first = recent[0];
  const last = recent.at(-1);
  const slope = (last.close - first.close) / (recent.length - 1);
  return {
    startIndex: Math.max(0, points.length - recent.length),
    start: first.close,
    endIndex: points.length - 1,
    end: last.close,
    slope
  };
}

function hotSetup({ last, ma20, ma50, rsi14, macdValue, resistance, mentions, sourceIdea }) {
  const breakoutDistancePct = resistance ? ((resistance - last) / last) * 100 : null;
  const sourceType = sourceIdea?.sourceType || (sourceIdea?.scout ? "scout" : "unknown");
  const hasChannelEvidence = ["transcript", "title"].includes(sourceType) && (mentions > 0 || sourceIdea?.transcriptMentions > 0);
  const checks = [
    breakoutDistancePct !== null && breakoutDistancePct >= -1 && breakoutDistancePct <= 5,
    ma20 !== null && last > ma20,
    ma50 !== null && last > ma50,
    ma20 !== null && ma50 !== null && ma20 >= ma50 * 0.98,
    rsi14 !== null && rsi14 >= 50 && rsi14 <= 70,
    macdValue !== null && macdValue > 0,
    mentions > 1
  ];
  const score = checks.filter(Boolean).length;
  let tier = "watch";
  let label = "מעקב טכני";
  if (score >= 6 && hasChannelEvidence) {
    tier = "very_hot";
    label = "חמה מאוד";
  } else if (score >= 5) {
    tier = "breakout";
    label = "לפני פריצה";
  } else if (score >= 3) {
    tier = "interesting";
    label = "מעניינת";
  }
  return {
    score,
    tier,
    isHot: tier === "very_hot",
    isInteresting: score >= 2,
    breakoutDistancePct,
    label
  };
}

function sourceLabel(sourceIdea = {}) {
  if (sourceIdea.sourceType === "transcript") return "תמלול/סרטוני הערוץ";
  if (sourceIdea.sourceType === "title") return "כותרות הסרטונים";
  if (sourceIdea.sourceType === "scout" || sourceIdea.scout) return "סריקת שוק להרחבת הרשימה";
  if (sourceIdea.sourceType === "manual" || sourceIdea.manual) return "רשימת עדיפות ידנית";
  return "מקור דינמי";
}

function buildEntryReason({ sourceIdea, setup, support, resistance, last, signals }) {
  const evidence =
    sourceIdea?.contexts?.[0] ||
    sourceIdea?.notes?.[0] ||
    (sourceIdea?.scout
      ? "׳”׳׳ ׳™׳” ׳ ׳•׳¡׳₪׳” ׳׳¡׳¨׳™׳§׳” ׳¨׳—׳‘׳” ׳›׳™ ׳”׳¨׳©׳™׳׳” ׳©׳¢׳׳×׳” ׳׳”׳¡׳¨׳˜׳•׳ ׳™׳ ׳”׳™׳™׳×׳” ׳¦׳¨׳” ׳׳“׳™."
      : "׳”׳׳ ׳™׳” ׳–׳•׳”׳×׳” ׳›׳׳•׳¢׳׳“׳× ׳׳×׳•׳ ׳׳§׳•׳¨׳•׳× ׳”׳׳—׳§׳¨ ׳©׳ ׳”׳™׳•׳.");
  const distance =
    setup.breakoutDistancePct === null ? null : `${setup.breakoutDistancePct.toFixed(2)}%`;
  const technical = signals.slice(0, 3).join(" ֲ· ") || "׳ ׳‘׳“׳§׳× ׳׳•׳ ׳׳׳•׳¦׳¢׳™׳, ׳׳•׳׳ ׳˜׳•׳, ׳×׳׳™׳›׳” ׳•׳”׳×׳ ׳’׳“׳•׳×.";
  return {
    source: sourceLabel(sourceIdea),
    evidence,
    technical,
    trigger: resistance ? `׳₪׳¨׳™׳¦׳”/׳¡׳’׳™׳¨׳” ׳׳¢׳ ${resistance.toFixed(2)}` : "׳˜׳¨׳™׳’׳¨ ׳™׳™׳§׳‘׳¢ ׳׳—׳¨׳™ ׳¢׳•׳“ ׳ ׳×׳•׳ ׳™ ׳׳—׳™׳¨",
    invalidation: support ? `׳׳™׳‘׳•׳“ ׳׳–׳•׳¨ ${support.toFixed(2)}` : "׳׳™׳ ׳¢׳“׳™׳™׳ ׳׳–׳•׳¨ ׳‘׳™׳˜׳•׳ ׳™׳¦׳™׳‘",
    strengthen:
      distance !== null
        ? `׳׳¢׳§׳‘ ׳׳ ׳”׳׳—׳™׳¨ ׳׳×׳§׳¨׳‘ ׳׳₪׳¨׳™׳¦׳”, ׳›׳¨׳’׳¢ ׳”׳׳¨׳—׳§ ׳׳”׳”׳×׳ ׳’׳“׳•׳× ׳”׳•׳ ${distance}.`
        : "׳׳¢׳§׳‘ ׳׳—׳¨׳™ ׳©׳™׳₪׳•׳¨ ׳׳•׳׳ ׳˜׳•׳ ׳•׳׳‘׳ ׳” ׳׳—׳™׳¨׳™׳.",
    plain: sourceIdea?.mentions > 0
      ? `׳ ׳›׳ ׳¡׳” ׳›׳™ ׳”׳•׳₪׳™׳¢׳” ׳‘׳×׳•׳›׳ ׳”׳¢׳¨׳•׳¥ ${sourceIdea.mentions} ׳₪׳¢׳׳™׳ ׳•׳¢׳‘׳¨׳” ׳‘׳“׳™׳§׳” ׳˜׳›׳ ׳™׳× ׳™׳•׳׳™׳×.`
      : "׳ ׳›׳ ׳¡׳” ׳›׳™ ׳¡׳¨׳™׳§׳× ׳”׳©׳•׳§ ׳”׳¨׳—׳‘׳” ׳׳¦׳׳” ׳׳‘׳ ׳” ׳˜׳›׳ ׳™ ׳©׳¨׳׳•׳™ ׳׳‘׳“׳™׳§׳” ׳”׳™׳•׳."
  };
}

function technicalSummary(symbol, points, sourceIdea = null) {
  const closes = points.map((point) => point.close);
  const last = closes.at(-1);
  const previous = closes.at(-2);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdValue = macd(closes);
  const recent = closes.slice(-60);
  const support = Math.min(...recent);
  const resistance = Math.max(...recent);
  const setup = hotSetup({
    last,
    ma20,
    ma50,
    rsi14,
    macdValue,
    resistance,
    mentions: sourceIdea?.mentions || 0,
    sourceIdea
  });

  const signals = [];
  if (ma20 && ma50) {
    signals.push(ma20 > ma50 ? "׳”׳׳ ׳™׳” ׳׳¢׳ ׳׳‘׳ ׳” ׳׳׳•׳¦׳¢׳™׳ ׳—׳™׳•׳‘׳™" : "׳”׳׳ ׳™׳” ׳¢׳“׳™׳™׳ ׳׳×׳—׳× ׳׳׳‘׳ ׳” ׳׳׳•׳¦׳¢׳™׳ ׳׳™׳“׳™׳׳׳™");
  }
  if (rsi14 !== null) {
    if (rsi14 >= 70) signals.push("RSI ׳’׳‘׳•׳”: ׳™׳© ׳׳•׳׳ ׳˜׳•׳, ׳׳‘׳ ׳’׳ ׳¨׳’׳™׳©׳•׳× ׳׳×׳™׳§׳•׳");
    else if (rsi14 <= 30) signals.push("RSI ׳ ׳׳•׳: ׳”׳׳ ׳™׳” ׳—׳׳©׳” ׳׳ ׳¢׳©׳•׳™׳” ׳׳”׳™׳›׳ ׳¡ ׳׳׳¢׳§׳‘ ׳”׳×׳׳•׳©׳©׳•׳×");
    else signals.push("RSI ׳‘׳×׳—׳•׳ ׳¢׳‘׳•׳“׳” ׳×׳§׳™׳ ׳׳׳¢׳§׳‘");
  }
  if (macdValue !== null) {
    signals.push(macdValue >= 0 ? "MACD ׳—׳™׳•׳‘׳™" : "MACD ׳©׳׳™׳׳™");
  }
  if (setup.breakoutDistancePct !== null && setup.breakoutDistancePct <= 5) {
    signals.push("׳”׳׳—׳™׳¨ ׳§׳¨׳•׳‘ ׳׳׳–׳•׳¨ ׳”׳×׳ ׳’׳“׳•׳×/׳₪׳¨׳™׳¦׳”");
  }

  const entryReason = buildEntryReason({ sourceIdea, setup, support, resistance, last, signals });

  return {
    symbol,
    last,
    changePct: previous ? ((last - previous) / previous) * 100 : null,
    sma20: ma20,
    sma50: ma50,
    rsi14,
    macd: macdValue,
    support,
    resistance,
    breakoutTrigger: resistance,
    invalidation: support,
    trendline: trendline(points),
    history: points.slice(-90),
    signals,
    setup,
    entryReason,
    sourceType: sourceIdea?.sourceType || (sourceIdea?.scout ? "scout" : "unknown"),
    checklistReason:
      sourceIdea?.mentions > 0
        ? `׳ ׳›׳ ׳¡׳” ׳׳¦׳³׳§ ׳׳™׳¡׳˜ ׳›׳™ ׳”׳•׳₪׳™׳¢׳” ׳‘׳×׳•׳›׳ ׳”׳¢׳¨׳•׳¥ ${sourceIdea.mentions} ׳₪׳¢׳׳™׳, ׳•׳¢׳›׳©׳™׳• ׳ ׳‘׳“׳§׳× ׳׳•׳ ׳׳‘׳ ׳” ׳˜׳›׳ ׳™.`
        : "׳ ׳›׳ ׳¡׳” ׳׳¦׳³׳§ ׳׳™׳¡׳˜ ׳›׳™ ׳”׳™׳ ׳ ׳׳¦׳׳× ׳‘׳¨׳©׳™׳׳× ׳”׳׳¢׳§׳‘ ׳”׳™׳“׳ ׳™׳× ׳©׳׳.",
    plainSummary: `${setup.label}. ׳”׳˜׳¨׳™׳’׳¨ ׳”׳׳¨׳›׳–׳™ ׳׳׳¢׳§׳‘ ׳”׳•׳ ׳”׳×׳׳•׳“׳“׳•׳× ׳¢׳ ׳׳–׳•׳¨ ${resistance.toFixed(
      2
    )}; ׳׳™׳‘׳•׳“ ׳׳–׳•׳¨ ${support.toFixed(2)} ׳™׳—׳׳™׳© ׳׳× ׳”׳×׳׳•׳ ׳” ׳”׳˜׳›׳ ׳™׳×.`,
    disclaimer: "׳ ׳™׳×׳•׳— ׳˜׳›׳ ׳™ ׳׳•׳˜׳•׳׳˜׳™ ׳׳¦׳•׳¨׳›׳™ ׳׳™׳“׳¢ ׳‘׳׳‘׳“, ׳׳ ׳”׳׳׳¦׳× ׳”׳©׳§׳¢׳”."
  };
}

async function analyzeSymbols(symbols, ideas = [], limit = 24) {
  const results = [];
  for (const symbol of symbols.slice(0, limit)) {
    try {
      const points = await fetchPriceHistory(symbol);
      const sourceIdea = ideas.find((idea) => idea.symbol === symbol);
      results.push(technicalSummary(symbol, points, sourceIdea));
    } catch (error) {
      results.push({ symbol, error: error.message });
    }
  }
  return results;
}

function tierRank(tier) {
  return { watch: 0, interesting: 1, breakout: 2, very_hot: 3 }[tier] ?? 0;
}

async function readAnalysisSnapshot() {
  if (!existsSync(analysisSnapshotPath)) return null;
  try {
    return await readJson(analysisSnapshotPath);
  } catch {
    return null;
  }
}

function withAnalysisChanges(analysis, previousSnapshot) {
  const previous = new Map((previousSnapshot?.items || []).map((item) => [item.symbol, item]));
  const currentSymbols = new Set(analysis.map((item) => item.symbol));
  const decorated = analysis.map((item) => {
    if (item.error) return item;
    const prior = previous.get(item.symbol);
    if (!prior) {
      return { ...item, change: { type: "new", label: "חדשה", detail: "לא הופיעה בריצה הקודמת" } };
    }
    const scoreDelta = (item.setup?.score || 0) - (prior.score || 0);
    const tierDelta = tierRank(item.setup?.tier) - tierRank(prior.tier);
    if (tierDelta > 0 || scoreDelta >= 2) {
      return { ...item, change: { type: "stronger", label: "התחזקה", detail: `ניקוד ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}` } };
    }
    if (tierDelta < 0 || scoreDelta <= -2) {
      return { ...item, change: { type: "weaker", label: "נחלשה", detail: `ניקוד ${scoreDelta}` } };
    }
    return { ...item, change: { type: "stable", label: "ללא שינוי", detail: `ניקוד ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}` } };
  });
  const removed = [...previous.values()]
    .filter((item) => !currentSymbols.has(item.symbol))
    .map((item) => ({
      symbol: item.symbol,
      label: "ירדה מהרשימה",
      previousTier: item.tier,
      previousScore: item.score
    }));
  return { analysis: decorated, removed };
}

async function saveAnalysisSnapshot(analysis) {
  await writeJson(analysisSnapshotPath, {
    updatedAt: new Date().toISOString(),
    items: analysis
      .filter((item) => !item.error)
      .map((item) => ({
        symbol: item.symbol,
        score: item.setup?.score || 0,
        tier: item.setup?.tier || "watch",
        label: item.setup?.label || "",
        last: item.last,
        resistance: item.resistance,
        support: item.support
      }))
  });
}

function lightIdea(idea, analysisItem) {
  const setup = analysisItem?.setup || {};
  return {
    symbol: idea.symbol,
    exchange: idea.exchange,
    name: idea.name,
    sourceType: idea.sourceType || (idea.scout ? "scout" : "unknown"),
    sessions: idea.sessions || [],
    qualityScore: idea.qualityScore || 0,
    mentions: idea.mentions || 0,
    note: idea.notes?.[0] || "",
    videos: (idea.videos || []).slice(0, 3).map((video) => ({
      title: video.title,
      url: video.url,
      published: video.published,
      session: video.session
    })),
    setup: {
      score: setup.score || 0,
      tier: setup.tier || "watch",
      label: setup.label || "מעקב",
      isHot: Boolean(setup.isHot),
      breakoutDistancePct: setup.breakoutDistancePct ?? null
    },
    metrics: analysisItem && !analysisItem.error
      ? {
          last: analysisItem.last,
          changePct: analysisItem.changePct,
          rsi14: analysisItem.rsi14,
          macd: analysisItem.macd,
          support: analysisItem.support,
          resistance: analysisItem.resistance,
          sma20: analysisItem.sma20,
          sma50: analysisItem.sma50
        }
      : null,
    change: analysisItem?.change || null,
    error: analysisItem?.error || null
  };
}

function sortLightIdeas(a, b) {
  const tierDelta = tierRank(b.setup?.tier) - tierRank(a.setup?.tier);
  if (tierDelta) return tierDelta;
  const scoreDelta = (b.setup?.score || 0) - (a.setup?.score || 0);
  if (scoreDelta) return scoreDelta;
  return (b.qualityScore || 0) - (a.qualityScore || 0);
}

function buildDashboard({ feed, ideas, analysis, refreshState }) {
  const working = ideas.filter((idea) => !idea.error);
  const counts = {
    videos: feed.videos?.length || 0,
    candidates: ideas.length,
    analyzed: analysis.filter((item) => !item.error).length,
    veryHot: working.filter((idea) => idea.setup?.tier === "very_hot").length,
    breakout: working.filter((idea) => idea.setup?.tier === "breakout").length,
    interesting: working.filter((idea) => idea.setup?.tier === "interesting").length
  };
  return {
    updatedAt: new Date().toISOString(),
    fetchedAt: feed.fetchedAt,
    channel: "Micha.Stocks",
    universe: feed.universe,
    counts,
    refresh: refreshState,
    topIdeas: working.slice(0, 10)
  };
}

function buildDailyNews(feed, ideas) {
  const bySession = new Map();
  for (const video of feed.videos || []) {
    const key = video.session?.id || "general";
    if (!bySession.has(key)) {
      bySession.set(key, {
        id: key,
        label: video.session?.label || "כללי",
        videos: [],
        symbols: new Set()
      });
    }
    bySession.get(key).videos.push({
      title: video.title,
      url: video.url,
      published: video.published,
      transcriptStatus: video.transcriptStatus || "unknown"
    });
  }

  for (const idea of ideas) {
    for (const sessionLabel of idea.sessions || []) {
      const match = [...bySession.values()].find((session) => session.label === sessionLabel);
      if (match) match.symbols.add(idea.symbol);
    }
  }

  const sessions = [...bySession.values()].map((session) => ({
    ...session,
    symbols: [...session.symbols].slice(0, 12)
  }));

  const headlineIdeas = ideas
    .filter((idea) => ["very_hot", "breakout"].includes(idea.setup?.tier))
    .slice(0, 12)
    .map((idea) => ({
      symbol: idea.symbol,
      label: idea.setup.label,
      score: idea.setup.score,
      source: idea.sourceType,
      reason: idea.note,
      videos: idea.videos
    }));

  return {
    updatedAt: new Date().toISOString(),
    title: "חדשות יומיות מהתמלולים",
    summary: {
      videos: feed.videos?.length || 0,
      highlightedSymbols: headlineIdeas.length,
      transcriptLoaded: (feed.videos || []).filter((video) => video.transcriptStatus === "loaded").length,
      transcriptMissing: (feed.videos || []).filter((video) => video.transcriptStatus === "missing").length
    },
    highlights: headlineIdeas,
    sessions,
    disclaimer: "מבוסס על כותרות ותמלולים זמינים מהערוץ בלבד. זהו מידע כללי ולא המלצת השקעה."
  };
}

let refreshPromise = null;

async function readRefreshState() {
  return (
    (await readJsonSafe(refreshStatePath)) || {
      status: "idle",
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      version: 0
    }
  );
}

async function writeRefreshState(next) {
  const current = await readRefreshState();
  const state = { ...current, ...next };
  await writeJson(refreshStatePath, state);
  return state;
}

async function buildAndCacheAll() {
  const started = new Date().toISOString();
  const previous = await readRefreshState();
  await writeRefreshState({
    status: "running",
    lastStartedAt: started,
    lastError: null
  });

  try {
    const config = await readJson(configPath);
    const feed = await loadFeed();
    const symbols = [...new Set((feed.ideas || []).map((idea) => idea.symbol))];
    const previousSnapshot = await readAnalysisSnapshot();
    const rawAnalysis = await analyzeSymbols(
      symbols,
      feed.ideas || [],
      config.research?.maxAnalyzedIdeas || config.research?.maxQualityIdeas || 40
    );
    const { analysis, removed } = withAnalysisChanges(rawAnalysis, previousSnapshot);
    await saveAnalysisSnapshot(analysis);

    const analysisMap = new Map(analysis.map((item) => [item.symbol, item]));
    const ideas = (feed.ideas || [])
      .map((idea) => lightIdea(idea, analysisMap.get(idea.symbol)))
      .filter((idea) => !idea.error && ((idea.setup?.score || 0) >= (config.research?.minDynamicTechnicalScore ?? 1)))
      .sort(sortLightIdeas);

    const finishedAt = new Date().toISOString();
    const completedState = {
      status: "completed",
      lastStartedAt: started,
      lastFinishedAt: finishedAt,
      lastError: null,
      version: (previous.version || 0) + 1
    };
    const dashboard = buildDashboard({ feed, ideas, analysis, refreshState: completedState });
    const news = buildDailyNews(feed, ideas);

    await writeJson(ideasCachePath, { updatedAt: finishedAt, items: ideas, removed });
    await writeJson(analysisSummaryCachePath, { updatedAt: finishedAt, items: analysis });
    await writeJson(dashboardCachePath, dashboard);
    await writeJson(dailyNewsCachePath, news);
    await writeRefreshState(completedState);
    return completedState;
  } catch (error) {
    return writeRefreshState({
      status: "failed",
      lastFinishedAt: new Date().toISOString(),
      lastError: error.message
    });
  }
}

function startBackgroundRefresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = buildAndCacheAll().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function ensureInitialRefresh() {
  const dashboard = await readJsonSafe(dashboardCachePath);
  if (!dashboard && !refreshPromise) {
    startBackgroundRefresh();
  }
}

function omitHistory(item) {
  if (!item || item.error) return item;
  const { history, ...rest } = item;
  return rest;
}

async function loadFeed() {
  const config = await readJson(configPath);
  const universe = await loadUniverse(config);
  const url = feedUrl(config);
  if (!url) {
    return {
      configured: false,
      videos: [],
      ideas: summarize([], config, "all", universe),
      universe: universeSummary(universe),
      message: "׳¦׳¨׳™׳ ׳׳”׳•׳¡׳™׳£ channelId ׳‘׳§׳•׳‘׳¥ config.json ׳›׳“׳™ ׳׳׳©׳•׳ ׳¡׳¨׳˜׳•׳ ׳™׳ ׳׳”׳¢׳¨׳•׳¥."
    };
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "local-tradingview-youtube-dashboard"
    }
  });
  if (!response.ok) {
    throw new Error(`YouTube feed returned ${response.status}`);
  }

  const xml = await response.text();
  const videos = await enrichVideosWithTranscripts(parseYouTubeFeed(xml)
    .slice(0, config.market.maxVideos || 12)
    .map((video) => ({
      ...video,
      session: classifyVideo(video, config.sessions || [])
    })), config);
  return {
    configured: true,
    videos,
    ideas: summarize(videos, config, "all", universe),
    sessions: groupBySession(videos, config, universe),
    universe: universeSummary(universe),
    fetchedAt: new Date().toISOString()
  };
}

function universeSummary(universe) {
  if (!universe) return { enabled: false, counts: { total: 0, NASDAQ: 0, NYSE: 0 } };
  return {
    enabled: true,
    updatedAt: universe.updatedAt,
    source: universe.source,
    includeAllSecurityTypes: universe.includeAllSecurityTypes,
    counts: universe.counts
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, await readJson(configPath));
  }

  if (pathname === "/api/config" && req.method === "PUT") {
    const nextConfig = JSON.parse(await readRequestBody(req));
    await writeFile(configPath, JSON.stringify(nextConfig, null, 2) + "\n", "utf8");
    return json(res, 200, nextConfig);
  }

  if (pathname === "/api/feed" && req.method === "GET") {
    return json(res, 200, await loadFeed());
  }

  if (pathname === "/api/dashboard" && req.method === "GET") {
    await ensureInitialRefresh();
    const dashboard = await readJsonSafe(dashboardCachePath);
    const refresh = await readRefreshState();
    return json(res, 200, dashboard || {
      updatedAt: null,
      counts: { videos: 0, candidates: 0, analyzed: 0, veryHot: 0, breakout: 0, interesting: 0 },
      topIdeas: [],
      refresh,
      empty: true,
      message: "אין עדיין נתונים שמורים. הרענון הראשוני רץ ברקע."
    });
  }

  if (pathname === "/api/ideas" && req.method === "GET") {
    await ensureInitialRefresh();
    const cache = await readJsonSafe(ideasCachePath, { updatedAt: null, items: [], removed: [] });
    return json(res, 200, cache);
  }

  const ideaMatch = pathname.match(/^\/api\/ideas\/([^/]+)$/);
  if (ideaMatch && req.method === "GET") {
    await ensureInitialRefresh();
    const symbol = decodeURIComponent(ideaMatch[1]).toUpperCase();
    const cache = await readJsonSafe(analysisSummaryCachePath, { items: [] });
    const item = cache.items.find((entry) => entry.symbol.toUpperCase() === symbol);
    if (!item) return json(res, 404, { error: "Symbol not found in current analysis" });
    return json(res, 200, item);
  }

  if (pathname === "/api/news/daily" && req.method === "GET") {
    await ensureInitialRefresh();
    const news = await readJsonSafe(dailyNewsCachePath);
    return json(res, 200, news || {
      updatedAt: null,
      title: "חדשות יומיות מהתמלולים",
      summary: { videos: 0, highlightedSymbols: 0, transcriptLoaded: 0, transcriptMissing: 0 },
      highlights: [],
      sessions: [],
      disclaimer: "אין עדיין חדשות שמורות. הרענון הראשוני רץ ברקע."
    });
  }

  if (pathname === "/api/refresh/status" && req.method === "GET") {
    return json(res, 200, await readRefreshState());
  }

  if (pathname === "/api/refresh" && req.method === "POST") {
    const state = await readRefreshState();
    if (refreshPromise) {
      return json(res, 202, state);
    }
    startBackgroundRefresh();
    return json(res, 202, await readRefreshState());
  }

  if (pathname === "/api/universe" && req.method === "GET") {
    const config = await readJson(configPath);
    return json(res, 200, universeSummary(await loadUniverse(config)));
  }

  if (pathname === "/api/universe/refresh" && req.method === "POST") {
    const config = await readJson(configPath);
    return json(res, 200, universeSummary(await refreshUniverse(config)));
  }

  if (pathname === "/api/analysis" && req.method === "GET") {
    const config = await readJson(configPath);
    const feed = await loadFeed();
    const manualSeeds = config.research?.includeManualWatchlist ? config.watchlist || [] : [];
    const symbols = [...new Set([...(feed.ideas || []).map((idea) => idea.symbol), ...manualSeeds])];
    const previousSnapshot = await readAnalysisSnapshot();
    const rawAnalysis = await analyzeSymbols(
      symbols,
      feed.ideas || [],
      config.research?.maxAnalyzedIdeas || config.research?.maxQualityIdeas || 40
    );
    const { analysis, removed } = withAnalysisChanges(rawAnalysis, previousSnapshot);
    await saveAnalysisSnapshot(analysis);
    return json(res, 200, {
      fetchedAt: new Date().toISOString(),
      candidates: symbols.length,
      analyzed: analysis.filter((item) => !item.error).length,
      removed,
      analysis
    });
  }

  json(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const staticDir = existsSync(distDir) ? distDir : publicDir;
  let target = resolve(staticDir, `.${safePath}`);
  if (!target.startsWith(resolve(staticDir)) || !existsSync(target)) {
    target = resolve(staticDir, "./index.html");
  }
  if (!target.startsWith(resolve(staticDir)) || !existsSync(target)) {
    return send(res, 404, "Not found", "text/plain; charset=utf-8");
  }

  const body = await readFile(target);
  send(res, 200, body, contentTypes[extname(target)] || "application/octet-stream");
}

export {
  analyzeSymbols,
  loadFeed,
  readAnalysisSnapshot,
  saveAnalysisSnapshot,
  technicalSummary,
  transcriptIdeas,
  summarize,
  startBackgroundRefresh
};

const isMain = (() => {
  try {
    const entry = process.argv?.[1];
    if (!entry) return false;
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  }).listen(port, host, () => {
    console.log(`Local dashboard running at http://localhost:${port}`);
    for (const url of localNetworkUrls()) {
      console.log(`Phone URL on the same Wi-Fi: ${url}`);
    }
  });
}
