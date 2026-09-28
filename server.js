const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocket } = require("ws");

function loadEnv() {
  const p = path.join(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const k = s.slice(0, i).trim(),
      v = s
        .slice(i + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8787);
const BASE =
  process.env.BINANCE_FUTURES_BASE_URL || "https://demo-fapi.binance.com";
const WS_BASE =
  process.env.BINANCE_FUTURES_WS_URL || "wss://fstream.binancefuture.com";
const API_KEY = process.env.BINANCE_API_KEY || "";
const API_SECRET = process.env.BINANCE_API_SECRET || "";
const AUTO_TRADE =
  String(process.env.AUTO_TRADE || "false").toLowerCase() === "true";
const SYMBOLS = (
  process.env.SYMBOLS ||
  "SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,SUIUSDT,APTUSDT,NEARUSDT,INJUSDT"
)
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter(Boolean);
const RISK = Number(process.env.INITIAL_RISK || 0.005);
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS || 3);
const MAX_ENTRY_LEVERAGE = Number(process.env.MAX_ENTRY_LEVERAGE || 1.75);
const LEVERAGE_BUFFER = Number(process.env.LEVERAGE_BUFFER || 0.95);
const ATR_MULTIPLIER = Number(process.env.ATR_MULTIPLIER || 1.8);
const PULLBACK_LOOKBACK = Number(process.env.PULLBACK_LOOKBACK || 6);
const MAX_PULLBACK_AGE = Number(process.env.MAX_PULLBACK_AGE || 3);
const BREAKOUT_ATR_BUFFER = Number(process.env.BREAKOUT_ATR_BUFFER || 0.2);
const EMA_SLOPE_LOOKBACK = Number(process.env.EMA_SLOPE_LOOKBACK || 3);
const MIN_LONG_CLOSE_LOCATION = Number(
  process.env.MIN_LONG_CLOSE_LOCATION || 0.72
);
const MAX_SHORT_CLOSE_LOCATION = Number(
  process.env.MIN_SHORT_CLOSE_LOCATION || 0.24
);
const MIN_15_EMA_GAP = Number(process.env.MIN_15_EMA_GAP || 0.0025);
const MIN_1H_EMA_GAP = Number(process.env.MIN_1H_EMA_GAP || 0.002);
const MIN_BREAKOUT_BODY_ATR = Number(process.env.MIN_BREAKOUT_BODY_ATR || 0.35);
const MIN_SHORT_BODY_ATR = Number(process.env.MIN_SHORT_BODY_ATR || 0.45);
const MAX_STOP_ATR = Number(process.env.MAX_STOP_ATR || 2.6);
const MIN_SIGNAL_QUALITY = Number(process.env.MIN_SIGNAL_QUALITY || 70);
const SHORT_MIN_SIGNAL_QUALITY = Number(
  process.env.SHORT_MIN_SIGNAL_QUALITY || 74
);
const QUALITY_GAP_CAP = Number(process.env.QUALITY_GAP_CAP || 0.02);
const ENTRY_COOLDOWN_BARS = Number(process.env.ENTRY_COOLDOWN_BARS || 4);

// Hard safety gate: this bridge must not talk to production.
if (!/demo-fapi\.binance\.com|testnet\.binancefuture\.com/i.test(BASE)) {
  throw new Error(
    "SAFETY STOP: BINANCE_FUTURES_BASE_URL must be a Demo/Testnet host. Production fapi.binance.com is refused."
  );
}

const state = {
  startedAt: Date.now(),
  running: AUTO_TRADE,
  lastCycle: null,
  lastSignals: [],
  logs: [],
  exchangeInfo: null,
  filters: {},
  positions: [],
  account: null,
  lastClosed15m: {},
};
function log(msg, extra) {
  const line =
    new Date().toISOString() +
    " " +
    msg +
    (extra ? " " + JSON.stringify(extra) : "");
  state.logs.unshift(line);
  state.logs = state.logs.slice(0, 300);
  console.log(line);
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function ema(values, p) {
  if (!values.length) return [];
  const k = 2 / (p + 1),
    out = new Array(values.length);
  let e = values[0];
  out[0] = e;
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function atr(data, p = 14) {
  const out = new Array(data.length).fill(NaN),
    tr = new Array(data.length).fill(NaN);
  if (data.length <= p) return out;
  for (let i = 1; i < data.length; i++) {
    const pc = data[i - 1].close;
    tr[i] = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - pc),
      Math.abs(data[i].low - pc)
    );
  }
  let sum = 0;
  for (let i = 1; i <= p; i++) sum += tr[i];
  let cur = sum / p;
  out[p] = cur;
  for (let i = p + 1; i < data.length; i++) {
    cur = (cur * (p - 1) + tr[i]) / p;
    out[i] = cur;
  }
  return out;
}
function gap(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
}
function clamp01(x) {
  return clamp(x, 0, 1);
}
function normGap(g) {
  return clamp01(g / QUALITY_GAP_CAP);
}
function body(c) {
  return Math.abs(c.close - c.open);
}
function loc(c) {
  const r = c.high - c.low;
  return r > 0 ? (c.close - c.low) / r : 0.5;
}
function longPB(data, e20, i) {
  const start = Math.max(1, i - PULLBACK_LOOKBACK);
  for (let j = i - 1; j >= start; j--)
    if (data[j].low <= e20[j] && data[j].close <= e20[j]) return j;
  return -1;
}
function shortPB(data, e20, i) {
  const start = Math.max(1, i - PULLBACK_LOOKBACK);
  for (let j = i - 1; j >= start; j--)
    if (data[j].high >= e20[j] && data[j].close >= e20[j]) return j;
  return -1;
}
function quality(side, vals) {
  let s = 0;
  const aligned =
    side === "LONG"
      ? [vals.b4, vals.b1, vals.b15].filter(Boolean).length
      : [vals.s4, vals.s1, vals.s15].filter(Boolean).length;
  s += aligned * (25 / 3);
  s += 20 * normGap(vals.g1);
  s += 15 * normGap(vals.g15);
  if (side === "LONG" ? vals.slopeBull : vals.slopeBear) s += 10;
  if (vals.fresh) s += 10;
  s += 10 * clamp01(vals.bodyAtr / 1);
  const l = side === "LONG" ? vals.closeLoc : 1 - vals.closeLoc;
  s += 10 * clamp01((l - 0.5) / 0.5);
  return clamp(s, 0, 100);
}
function candleFromK(k) {
  return {
    openTime: +k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: +k[6],
  };
}
function qs(params) {
  return new URLSearchParams(params).toString();
}
function sign(params) {
  const q = qs(params);
  return (
    q +
    "&signature=" +
    crypto.createHmac("sha256", API_SECRET).update(q).digest("hex")
  );
}
async function api(method, pathName, params = {}, signed = false) {
  const p = { ...params };
  if (signed) {
    p.timestamp = Date.now();
    p.recvWindow = 5000;
  }
  const query = signed ? sign(p) : qs(p);
  const url = BASE + pathName + (query ? "?" + query : "");
  const headers = {};
  if (API_KEY) headers["X-MBX-APIKEY"] = API_KEY;
  const r = await fetch(url, { method, headers });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Binance non-JSON " + r.status + ": " + text.slice(0, 300));
  }
  if (!r.ok || (data && data.code < 0))
    throw new Error(`Binance ${r.status}: ${data?.msg || text}`);
  return data;
}
async function postForm(pathName, params = {}, signed = true) {
  const p = { ...params };
  if (signed) {
    p.timestamp = Date.now();
    p.recvWindow = 5000;
  }
  const q = signed ? sign(p) : qs(p);
  const r = await fetch(BASE + pathName, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-MBX-APIKEY": API_KEY,
    },
    body: q,
  });
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(text);
  }
  if (!r.ok || d.code < 0)
    throw new Error(`Binance ${r.status}: ${d.msg || text}`);
  return d;
}
async function putForm(pathName, params = {}) {
  const p = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const q = sign(p);
  const r = await fetch(BASE + pathName, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-MBX-APIKEY": API_KEY,
    },
    body: q,
  });
  const t = await r.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    throw new Error(t);
  }
  if (!r.ok || d.code < 0)
    throw new Error(`Binance ${r.status}: ${d.msg || t}`);
  return d;
}
async function getKlines(symbol, interval, limit = 300) {
  const a = await api("GET", "/fapi/v1/klines", { symbol, interval, limit });
  return a.map(candleFromK);
}
function roundStep(v, step) {
  if (!step || !Number.isFinite(v)) return v;
  const n = Math.floor(v / step + 1e-12);
  return Number((n * step).toFixed(12));
}
function roundPrice(v, tick) {
  if (!tick) return v;
  const n = Math.round(v / tick);
  return Number((n * tick).toFixed(12));
}
async function loadExchangeInfo() {
  state.exchangeInfo = await api("GET", "/fapi/v1/exchangeInfo");
  for (const s of state.exchangeInfo.symbols || []) {
    const f = {};
    for (const x of s.filters || []) {
      if (x.filterType === "LOT_SIZE")
        (f.step = Number(x.stepSize)), (f.minQty = Number(x.minQty));
      if (x.filterType === "PRICE_FILTER") f.tick = Number(x.tickSize);
      if (x.filterType === "MIN_NOTIONAL")
        f.minNotional = Number(x.notional || x.minNotional || 0);
    }
    state.filters[s.symbol] = f;
  }
  return state.exchangeInfo;
}
async function syncAccount() {
  state.account = await api("GET", "/fapi/v2/account", {}, true);
  state.positions = (state.account.positions || [])
    .filter((p) => Math.abs(Number(p.positionAmt || 0)) > 0)
    .map((p) => ({
      symbol: p.symbol,
      amt: Number(p.positionAmt),
      entry: Number(p.entryPrice),
      unrealized: Number(p.unrealizedProfit),
      notional:
        Math.abs(Number(p.positionAmt)) * Number(p.markPrice || p.entryPrice),
      leverage: Number(p.leverage || 1),
    }));
  return state.account;
}
function currentEquity() {
  return (
    Number(
      state.account?.totalWalletBalance ||
        state.account?.totalMarginBalance ||
        0
    ) || 10000
  );
}
function canOpen(symbol, plannedNotional = 0) {
  if (state.positions.some((p) => p.symbol === symbol)) return false;
  if (state.positions.length >= MAX_POSITIONS) return false;
  const eq = currentEquity();
  const cap = eq * MAX_ENTRY_LEVERAGE * LEVERAGE_BUFFER;
  const used = state.positions.reduce(
    (a, p) => a + Math.abs(p.notional || 0),
    0
  );
  return used + Math.max(0, plannedNotional) <= cap + 1e-9;
}
async function placeEntry(symbol, side, qty, stopPrice) {
  if (!AUTO_TRADE) {
    log("SIGNAL_ONLY", { symbol, side, qty, stopPrice });
    return { dryRun: true };
  }
  const f = state.filters[symbol] || {};
  qty = roundStep(qty, f.step);
  if (qty <= 0 || qty < (f.minQty || 0))
    throw new Error(symbol + " quantity below minQty");
  const order = await postForm("/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity: qty,
    newOrderRespType: "RESULT",
  });
  log("ENTRY_FILLED", { symbol, side, qty, orderId: order.orderId });
  const stopSide = side === "BUY" ? "SELL" : "BUY";
  stopPrice = roundPrice(stopPrice, f.tick);
  try {
    const stop = await postForm("/fapi/v1/order", {
      symbol,
      side: stopSide,
      type: "STOP_MARKET",
      stopPrice,
      closePosition: "true",
      workingType: "MARK_PRICE",
    });
    log("STOP_PLACED", { symbol, stopPrice, orderId: stop.orderId });
  } catch (e) {
    log("STOP_ERROR", { symbol, error: e.message });
    throw e;
  }
  return order;
}
async function evaluateSymbol(symbol) {
  const [d15, d1, d4] = await Promise.all([
    getKlines(symbol, "15m", 220),
    getKlines(symbol, "1h", 220),
    getKlines(symbol, "4h", 220),
  ]);
  if (d15.length < 80 || d1.length < 80 || d4.length < 80) return null;
  // Last kline may be open. Use the latest fully closed 15m candle.
  const now = Date.now();
  let i15 = d15.length - 1;
  if (d15[i15].closeTime > now) i15--;
  if (i15 < 20) return null;
  const t = d15[i15].closeTime;
  let i1 = -1;
  for (let i = d1.length - 1; i >= 0; i--)
    if (d1[i].closeTime <= t) {
      i1 = i;
      break;
    }
  let i4 = -1;
  for (let i = d4.length - 1; i >= 0; i--)
    if (d4[i].closeTime <= t) {
      i4 = i;
      break;
    }
  if (i1 < EMA_SLOPE_LOOKBACK || i4 < 1) return null;
  const e15_20 = ema(
      d15.map((x) => x.close),
      20
    ),
    e15_50 = ema(
      d15.map((x) => x.close),
      50
    ),
    e1_20 = ema(
      d1.map((x) => x.close),
      20
    ),
    e1_50 = ema(
      d1.map((x) => x.close),
      50
    ),
    e4_50 = ema(
      d4.map((x) => x.close),
      50
    ),
    e4_200 = ema(
      d4.map((x) => x.close),
      200
    ),
    a15 = atr(d15, 14);
  const c = d15[i15],
    prev = d15[i15 - 1],
    a = a15[i15];
  if (!Number.isFinite(a) || a <= 0) return null;
  const b4 = e4_50[i4] > e4_200[i4],
    s4 = e4_50[i4] < e4_200[i4],
    b1 = e1_20[i1] > e1_50[i1],
    s1 = e1_20[i1] < e1_50[i1],
    b15 = e15_20[i15] > e15_50[i15],
    s15 = e15_20[i15] < e15_50[i15];
  const slopeBull = e1_20[i1] > e1_20[i1 - EMA_SLOPE_LOOKBACK],
    slopeBear = e1_20[i1] < e1_20[i1 - EMA_SLOPE_LOOKBACK];
  const g15 = gap(e15_20[i15], e15_50[i15]),
    g1 = gap(e1_20[i1], e1_50[i1]);
  const lp = longPB(d15, e15_20, i15),
    sp = shortPB(d15, e15_20, i15),
    lf = lp >= 0 && i15 - lp <= MAX_PULLBACK_AGE,
    sf = sp >= 0 && i15 - sp <= MAX_PULLBACK_AGE;
  const longReclaim = prev.close <= e15_20[i15 - 1] && c.close > e15_20[i15],
    shortReclaim = prev.close >= e15_20[i15 - 1] && c.close < e15_20[i15];
  const cl = loc(c),
    ba = body(c) / a;
  const longBreak =
    c.close > prev.high + a * BREAKOUT_ATR_BUFFER &&
    cl >= MIN_LONG_CLOSE_LOCATION &&
    ba >= MIN_BREAKOUT_BODY_ATR;
  const shortBreak =
    c.close < prev.low - a * BREAKOUT_ATR_BUFFER &&
    cl <= MAX_SHORT_CLOSE_LOCATION &&
    ba >= MIN_SHORT_BODY_ATR;
  const lq =
    g15 >= MIN_15_EMA_GAP &&
    g1 >= MIN_1H_EMA_GAP &&
    slopeBull &&
    lf &&
    longReclaim &&
    c.close > e15_20[i15];
  const sq =
    g15 >= MIN_15_EMA_GAP &&
    g1 >= MIN_1H_EMA_GAP &&
    slopeBear &&
    sf &&
    shortReclaim &&
    c.close < e15_20[i15];
  let side = null;
  if (b4 && b1 && b15 && slopeBull && lq && longBreak) side = "LONG";
  else if (s4 && s1 && s15 && slopeBear && sq && shortBreak) side = "SHORT";
  if (!side) return { symbol, closedAt: t, signal: null };
  const q = quality(side, {
    b4,
    b1,
    b15,
    s4,
    s1,
    s15,
    slopeBull,
    slopeBear,
    g15,
    g1,
    bodyAtr: ba,
    closeLoc: cl,
    fresh: side === "LONG" ? lf : sf,
  });
  const threshold =
    side === "SHORT" ? SHORT_MIN_SIGNAL_QUALITY : MIN_SIGNAL_QUALITY;
  if (q < threshold)
    return { symbol, closedAt: t, signal: null, filtered: true, quality: q };
  let stopDistance = ATR_MULTIPLIER * a;
  if (side === "LONG" && lp >= 0)
    stopDistance = Math.max(stopDistance, c.close - d15[lp].low);
  if (side === "SHORT" && sp >= 0)
    stopDistance = Math.max(stopDistance, d15[sp].high - c.close);
  if (stopDistance > a * MAX_STOP_ATR)
    return {
      symbol,
      closedAt: t,
      signal: null,
      filtered: "wideStop",
      quality: q,
    };
  const stop =
    side === "LONG" ? c.close - stopDistance : c.close + stopDistance;
  return {
    symbol,
    closedAt: t,
    signal: {
      side,
      quality: q,
      signalClose: c.close,
      atr: a,
      stopDistance,
      stop,
    },
    nextOpen: t + 1,
  };
}
async function runCycle() {
  try {
    await syncAccount();
    for (const symbol of SYMBOLS) {
      const r = await evaluateSymbol(symbol);
      if (!r) continue;
      const last = state.lastClosed15m[symbol] || 0;
      if (r.closedAt <= last) continue;
      state.lastClosed15m[symbol] = r.closedAt;
      if (!r.signal) continue;

      state.lastSignals.unshift(r);
      state.lastSignals = state.lastSignals.slice(0, 100);
      log("SIGNAL", { symbol, ...r.signal });

      const eq = currentEquity();
      const riskCash = eq * RISK;
      const f = state.filters[symbol] || {};
      let qty = roundStep(riskCash / r.signal.stopDistance, f.step);
      const plannedNotional = qty * r.signal.signalClose;
      if (!canOpen(symbol, plannedNotional)) {
        log("ENTRY_REJECT_CAPACITY", { symbol, plannedNotional });
        continue;
      }

      const entryDelay = Math.max(0, r.closedAt + 15000 - Date.now());
      setTimeout(async () => {
        try {
          await syncAccount();
          if (canOpen(symbol, qty * r.signal.signalClose)) {
            const side = r.signal.side === "LONG" ? "BUY" : "SELL";
            await placeEntry(symbol, side, qty, r.signal.stop);
          } else {
            log("ENTRY_REJECT_CAPACITY", { symbol });
          }
        } catch (e) {
          log("ENTRY_ERROR", { symbol, error: e.message });
        }
      }, entryDelay);
    }
    state.lastCycle = Date.now();
  } catch (e) {
    log("CYCLE_ERROR", { error: e.message });
  }
}
async function startUserStream() {
  if (!API_KEY) return;
  try {
    const d = await postForm("/fapi/v1/listenKey", {}, false);
    const key = d.listenKey;
    const ws = new WebSocket(WS_BASE + "/ws/" + key);
    ws.on("open", () => log("USER_WS_CONNECTED"));
    ws.on("message", (buf) => {
      try {
        const x = JSON.parse(buf.toString());
        if (x.e === "ORDER_TRADE_UPDATE" || x.e === "ACCOUNT_UPDATE")
          log("USER_EVENT", { event: x.e });
      } catch {}
    });
    ws.on("close", () => {
      log("USER_WS_CLOSED");
      setTimeout(startUserStream, 5000);
    });
    ws.on("error", (e) => log("USER_WS_ERROR", { error: e.message }));
    setInterval(async () => {
      try {
        await putForm("/fapi/v1/listenKey", { listenKey: key });
      } catch (e) {
        log("USER_WS_KEEPALIVE_ERROR", { error: e.message });
      }
    }, 30 * 60 * 1000);
  } catch (e) {
    log("USER_WS_START_ERROR", { error: e.message });
  }
}
async function init() {
  await loadExchangeInfo();
  await syncAccount();
  log("READY", { base: BASE, autoTrade: AUTO_TRADE, symbols: SYMBOLS });
  startUserStream();
  setInterval(runCycle, 20000);
  await runCycle();
}
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}
async function route(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/api/health")
      return json(res, 200, {
        ok: true,
        version: "3.7.19",
        autoTrade: AUTO_TRADE,
        base: BASE,
      });
    if (u.pathname === "/api/demo/ping")
      return json(res, 200, {
        ok: true,
        data: await api("GET", "/fapi/v1/ping"),
      });
    if (u.pathname === "/api/demo/account")
      return json(res, 200, { ok: true, data: await syncAccount() });
    if (u.pathname === "/api/demo/openOrders")
      return json(res, 200, {
        ok: true,
        data: await api(
          "GET",
          "/fapi/v1/openOrders",
          { symbol: u.searchParams.get("symbol") || undefined },
          true
        ),
      });
    if (u.pathname === "/api/live/klines")
      return json(res, 200, {
        ok: true,
        data: await getKlines(
          u.searchParams.get("symbol"),
          u.searchParams.get("interval") || "15m",
          Math.min(500, Number(u.searchParams.get("limit") || 200))
        ),
      });
    if (u.pathname === "/api/demo/exchangeInfo")
      return json(res, 200, {
        ok: true,
        data: state.exchangeInfo || (await loadExchangeInfo()),
      });
    if (u.pathname === "/api/state")
      return json(res, 200, {
        ok: true,
        state: { ...state, exchangeInfo: undefined },
      });
    if (u.pathname === "/api/demo/order" && req.method === "POST") {
      let b = "";
      for await (const c of req) b += c;
      const p = JSON.parse(b || "{}");
      if (!p.symbol || !p.side) throw new Error("symbol/side required");
      return json(res, 200, {
        ok: true,
        data: await postForm("/fapi/v1/order", p, true),
      });
    }
    if (u.pathname === "/api/demo/cancel" && req.method === "POST") {
      let b = "";
      for await (const c of req) b += c;
      const p = JSON.parse(b || "{}");
      return json(res, 200, {
        ok: true,
        data: await api("DELETE", "/fapi/v1/order", p, true),
      });
    }
    if (u.pathname === "/")
      return sendFile(
        res,
        path.join(__dirname, "Quant_V3.7.19.html"),
        "text/html; charset=utf-8"
      );
    if (u.pathname === "/README.md")
      return sendFile(
        res,
        path.join(__dirname, "README.md"),
        "text/plain; charset=utf-8"
      );
    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}
function sendFile(res, p, type) {
  try {
    const b = fs.readFileSync(p);
    res.writeHead(200, { "Content-Type": type });
    res.end(b);
  } catch (e) {
    res.writeHead(404);
    res.end("not found");
  }
}
http.createServer(route).listen(PORT, () => {
  log("HTTP_READY", { url: `http://127.0.0.1:${PORT}`, autoTrade: AUTO_TRADE });
});
init().catch((e) => {
  log("INIT_FATAL", { error: e.message });
  process.exitCode = 1;
});
