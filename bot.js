/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY", "ALPACA_BASE_URL"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Alpaca credentials",
        "ALPACA_API_KEY=",
        "ALPACA_SECRET_KEY=",
        "ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=20",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSD",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    console.log(
      "Fill in your Alpaca credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSD",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "20"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets/v2",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Kraken public API — free, no auth, works globally) ─────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Kraken interval in minutes
  const intervalMap = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1H": 60,
    "4H": 240,
    "1D": 1440,
    "1W": 10080,
  };
  const krakenInterval = intervalMap[interval] || 60;

  // Kraken uses XBTUSD for BTC/USD
  const krakenPair = symbol.replace("BTCUSD", "XBTUSD");

  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${krakenInterval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(`Kraken error: ${data.error[0]}`);

  // Kraken returns { result: { XXBTZUSD: [...bars], last: N } }
  const pairKey = Object.keys(data.result).find((k) => k !== "last");
  const bars = data.result[pairKey] || [];

  // Kraken returns: [time, open, high, low, close, vwap, volume, count]
  return bars.slice(-limit).map((k) => ({
    time: k[0] * 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── RLS Signal Check ────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3Safe, rules) {
  const results = [];
  const signal = (process.env.RLS_SIGNAL || "none").toLowerCase();

  console.log("\n── RLS Signal Check ─────────────────────────────────────\n");
  console.log(`  Signal received: ${signal.toUpperCase()}`);

  if (signal === "buy") {
    console.log("  RLS Buy signal detected — checking long entry\n");
    results.push({ label: "RLS Buy signal", required: "buy", actual: signal, pass: true });
    console.log(`  ✅ RLS Buy signal confirmed`);
    console.log(`     Current price: $${price.toFixed(2)}`);
  } else if (signal === "sell") {
    console.log("  RLS Sell signal detected — checking short entry\n");
    results.push({ label: "RLS Sell signal", required: "sell", actual: signal, pass: true });
    console.log(`  ✅ RLS Sell signal confirmed`);
    console.log(`     Current price: $${price.toFixed(2)}`);
  } else {
    console.log("  No RLS signal — no trade.\n");
    results.push({ label: "RLS signal", required: "buy or sell", actual: "none", pass: false });
    console.log(`  🚫 No active RLS signal`);
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, signal };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Alpaca Execution ────────────────────────────────────────────────────────

// Ensure base URL always includes /v2
function alpacaBaseUrl() {
  return CONFIG.alpaca.baseUrl.replace(/\/v2$/, "") + "/v2";
}

// Alpaca crypto requires "BTC/USD" format, not "BTCUSD"
function alpacaSymbol(symbol) {
  return symbol.replace(/^BTC(USD)$/, "BTC/$1");
}

async function getAlpacaPosition(symbol) {
  const encodedSymbol = encodeURIComponent(alpacaSymbol(symbol));
  const res = await fetch(`${alpacaBaseUrl()}/positions/${encodedSymbol}`, {
    headers: {
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (res.status === 404) return null; // No position open
  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca position fetch failed: ${data.message}`);
  return data; // { qty, market_value, avg_entry_price, ... }
}

async function placeAlpacaOrder(symbol, side, sizeUSD, price) {
  let quantity;

  if (side === "sell") {
    // Sell the ENTIRE position — fetch actual qty held
    const position = await getAlpacaPosition(symbol);
    if (!position || parseFloat(position.qty) <= 0) {
      throw new Error("No open position to sell");
    }
    quantity = position.qty; // Use exact qty from Alpaca
    console.log(`  Selling full position: ${quantity} ${alpacaSymbol(symbol)}`);
  } else {
    // Buy a fixed USD amount
    quantity = (sizeUSD / price).toFixed(6);
  }

  const body = JSON.stringify({
    symbol: alpacaSymbol(symbol),
    qty: quantity,
    side,
    type: "market",
    time_in_force: "gtc",
  });

  const res = await fetch(`${alpacaBaseUrl()}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
  }

  return data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.signal === "sell" ? "SELL" : "BUY";
    quantity = logEntry.fillQty || (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = (parseFloat(quantity) * logEntry.price).toFixed(2);
    fee = (parseFloat(totalUSD) * 0.001).toFixed(4);
    netAmount = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.signal === "sell" ? "SELL" : "BUY";
    quantity = logEntry.fillQty || (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = (parseFloat(quantity) * logEntry.price).toFixed(2);
    fee = (parseFloat(totalUSD) * 0.001).toFixed(4);
    netAmount = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Alpaca",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Alpaca ────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  console.log(`  Bars received: ${candles.length}`);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap) {
    console.log("\n⚠️  Not enough data to calculate VWAP. Exiting.");
    return;
  }
  // RSI requires at least period+1 bars — use price as fallback if insufficient data
  const rsi3Safe = rsi3 ?? 50;

  // Run safety check
  const { results, allPass, signal } = runSafetyCheck(price, ema8, vwap, rsi3Safe, rules);

  // Calculate position size (used for buys; sells use actual position qty)
  // 10% of portfolio value, capped at MAX_TRADE_SIZE_USD ($100)
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.10,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    signal,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    fillQty: null,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    const orderSide = signal === "sell" ? "sell" : "buy";
    console.log(`✅ RLS SIGNAL CONFIRMED — ${orderSide.toUpperCase()}`);

    if (CONFIG.paperTrading) {
      const paperQty = orderSide === "sell" ? "full position" : `~$${tradeSize.toFixed(2)}`;
      console.log(`\n📋 PAPER TRADE — would ${orderSide} ${CONFIG.symbol} ${paperQty} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.fillQty = (tradeSize / price).toFixed(6);
    } else {
      const label = orderSide === "sell"
        ? `SELL ENTIRE POSITION ${CONFIG.symbol}`
        : `BUY $${tradeSize.toFixed(2)} ${CONFIG.symbol}`;
      console.log(`\n🔴 PLACING LIVE ORDER — ${label}`);
      try {
        const order = await placeAlpacaOrder(
          CONFIG.symbol,
          orderSide,
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.id;
        logEntry.fillQty = order.qty;
        console.log(`✅ ORDER PLACED — ${order.id} | qty: ${order.qty}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
