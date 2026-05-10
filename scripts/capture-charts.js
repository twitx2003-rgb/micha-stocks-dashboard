import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = join(root, "config.json");
const outputDir = join(root, "screenshots");
const chromePaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

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

function parseYouTubeFeed(xml) {
  return xml
    .split("<entry>")
    .slice(1)
    .map((chunk) => chunk.split("</entry>")[0])
    .map((entry) => ({
      title: getTag(entry, "title"),
      published: getTag(entry, "published")
    }))
    .filter((video) => video.title);
}

function normalizeTicker(raw, defaultExchange) {
  const value = raw.replace(/^\$/, "").toUpperCase();
  if (value.includes(":")) return value;
  return `${defaultExchange}:${value}`;
}

function extractTickers(text, defaultExchange) {
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
  const tickers = new Set();
  const patterns = [
    /\$[A-Z]{1,5}\b/g,
    /\b(?:NASDAQ|NYSE|AMEX|TSX|LSE|TASE):[A-Z0-9.]{1,8}\b/gi,
    /\b[A-Z]{2,5}\b/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].replace(/^\$/, "").toUpperCase();
      if (value.length > 1 && !blocked.has(value)) {
        tickers.add(normalizeTicker(match[0], defaultExchange));
      }
    }
  }
  return [...tickers];
}

async function relevantSymbols(config) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(
    config.youtube.channelId
  )}`;
  const response = await fetch(feedUrl, {
    headers: { "user-agent": "local-tradingview-youtube-dashboard" }
  });
  if (!response.ok) throw new Error(`YouTube feed returned ${response.status}`);

  const videos = parseYouTubeFeed(await response.text()).slice(0, config.market.maxVideos || 24);
  const symbols = new Set(config.watchlist || []);
  for (const video of videos) {
    for (const ticker of extractTickers(video.title, config.market.defaultExchange)) {
      symbols.add(ticker);
    }
  }
  return [...symbols].slice(0, 8);
}

function fileSafeSymbol(symbol) {
  return symbol.replace(/[^A-Z0-9]+/gi, "_");
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const executablePath = chromePaths.find((path) => existsSync(path));
  if (!executablePath) throw new Error("Chrome or Edge was not found on this computer.");

  await mkdir(outputDir, { recursive: true });
  const symbols = await relevantSymbols(config);
  const browser = await chromium.launch({
    executablePath,
    headless: true
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const created = [];

  for (const symbol of symbols) {
    const url = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);
    const target = join(outputDir, `${fileSafeSymbol(symbol)}.png`);
    await page.screenshot({ path: target, fullPage: false });
    created.push({ symbol, path: target });
  }

  await browser.close();
  console.log(JSON.stringify({ created }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
