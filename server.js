const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const AdmZip = require('adm-zip');
const { URL } = require('url');

function loadEnv(){
  const p=path.join(__dirname,'.env');
  if(!fs.existsSync(p)) return;

  for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){
    const s=line.trim();

    if(!s || s.startsWith('#')) continue;

    const i=s.indexOf('=');

    if(i<0) continue;

    const k=s.slice(0,i).trim();

    const v=s
      .slice(i+1)
      .trim()
      .replace(/^['"]|['"]$/g,'');

    if(process.env[k]===undefined){
      process.env[k]=v;
    }
  }
}

loadEnv();


/*
 * ============================================================
 * Quant V3.7.18.10
 *
 * Binance USD-M Futures
 *
 * 后端服务器
 *
 * 本版本重点：
 *
 * 1. 保留原正式交易框架
 * 2. 保留 3 仓限制
 * 3. 保留原风险参数
 * 4. 保留 Demo/Testnet 安全闸门
 * 5. 保留原行情接口
 * 6. Funding 改为 Binance Public Data 历史归档
 * 7. Funding 不再依赖受限地区的实时 Funding API
 * 8. Funding 数据加入完整性诊断
 * 9. Funding 没有真实数据时绝不伪造
 *
 * ============================================================
 */


/*
 * ============================================================
 * 网络兼容
 * ============================================================
 */

try{

  dns.setDefaultResultOrder(
    'ipv4first'
  );

}catch{}


/*
 * ============================================================
 * 基础配置
 * ============================================================
 */

const PORT =
  Number(
    process.env.PORT || 8787
  );


/*
 * ============================================================
 * Demo / Testnet 交易地址
 *
 * 注意：
 *
 * 这里只允许 Demo / Testnet。
 *
 * ============================================================
 */

const BASE =
  process.env.BINANCE_FUTURES_BASE_URL ||
  'https://demo-fapi.binance.com';


/*
 * ============================================================
 * Public Market Data
 *
 * 只读。
 *
 * ============================================================
 */

const PUBLIC_BASE =
  process.env.BINANCE_PUBLIC_FUTURES_BASE_URL ||
  'https://fapi.binance.com';


/*
 * ============================================================
 * WebSocket
 * ============================================================
 */

const WS_BASE =
  process.env.BINANCE_FUTURES_WS_URL ||
  'wss://fstream.binancefuture.com';


/*
 * ============================================================
 * API Key
 * ============================================================
 */

const API_KEY =
  process.env.BINANCE_API_KEY ||
  '';


const API_SECRET =
  process.env.BINANCE_API_SECRET ||
  '';


/*
 * ============================================================
 * 自动交易
 * ============================================================
 */

const AUTO_TRADE =
  String(
    process.env.AUTO_TRADE || 'false'
  ).toLowerCase() === 'true';


/*
 * ============================================================
 * Symbols
 * ============================================================
 */

const SYMBOLS =
  (
    process.env.SYMBOLS ||
    'SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,SUIUSDT,APTUSDT,NEARUSDT,INJUSDT'
  )
    .split(',')
    .map(
      x =>
        x
          .trim()
          .toUpperCase()
    )
    .filter(Boolean);


/*
 * ============================================================
 * 风险参数
 * ============================================================
 */

const RISK =
  Number(
    process.env.INITIAL_RISK ||
    0.005
  );


/*
 * ============================================================
 * 最大仓位
 *
 * 保持 3 仓
 * ============================================================
 */

const MAX_POSITIONS =
  Number(
    process.env.MAX_POSITIONS ||
    3
  );


/*
 * ============================================================
 * 最大入场杠杆
 * ============================================================
 */

const MAX_ENTRY_LEVERAGE =
  Number(
    process.env.MAX_ENTRY_LEVERAGE ||
    1.75
  );


const LEVERAGE_BUFFER =
  Number(
    process.env.LEVERAGE_BUFFER ||
    0.95
  );


/*
 * ============================================================
 * ATR
 * ============================================================
 */

const ATR_MULTIPLIER =
  Number(
    process.env.ATR_MULTIPLIER ||
    1.8
  );


/*
 * ============================================================
 * Pullback
 * ============================================================
 */

const PULLBACK_LOOKBACK =
  Number(
    process.env.PULLBACK_LOOKBACK ||
    6
  );


const MAX_PULLBACK_AGE =
  Number(
    process.env.MAX_PULLBACK_AGE ||
    3
  );


/*
 * ============================================================
 * Breakout
 * ============================================================
 */

const BREAKOUT_ATR_BUFFER =
  Number(
    process.env.BREAKOUT_ATR_BUFFER ||
    0.20
  );


/*
 * ============================================================
 * EMA
 * ============================================================
 */

const EMA_SLOPE_LOOKBACK =
  Number(
    process.env.EMA_SLOPE_LOOKBACK ||
    3
  );


const MIN_LONG_CLOSE_LOCATION =
  Number(
    process.env.MIN_LONG_CLOSE_LOCATION ||
    0.72
  );


const MAX_SHORT_CLOSE_LOCATION =
  Number(
    process.env.MAX_SHORT_CLOSE_LOCATION ||
    0.24
  );


const MIN_15_EMA_GAP =
  Number(
    process.env.MIN_15_EMA_GAP ||
    0.0025
  );


const MIN_1H_EMA_GAP =
  Number(
    process.env.MIN_1H_EMA_GAP ||
    0.0020
  );


/*
 * ============================================================
 * Breakout Body
 * ============================================================
 */

const MIN_BREAKOUT_BODY_ATR =
  Number(
    process.env.MIN_BREAKOUT_BODY_ATR ||
    0.35
  );


const MIN_SHORT_BODY_ATR =
  Number(
    process.env.MIN_SHORT_BODY_ATR ||
    0.45
  );


/*
 * ============================================================
 * Stop
 * ============================================================
 */

const MAX_STOP_ATR =
  Number(
    process.env.MAX_STOP_ATR ||
    2.6
  );


/*
 * ============================================================
 * Signal Quality
 * ============================================================
 */

const MIN_SIGNAL_QUALITY =
  Number(
    process.env.MIN_SIGNAL_QUALITY ||
    70
  );


const SHORT_MIN_SIGNAL_QUALITY =
  Number(
    process.env.SHORT_MIN_SIGNAL_QUALITY ||
    74
  );


const QUALITY_GAP_CAP =
  Number(
    process.env.QUALITY_GAP_CAP ||
    0.02
  );


const ENTRY_COOLDOWN_BARS =
  Number(
    process.env.ENTRY_COOLDOWN_BARS ||
    4
  );


/*
 * ============================================================
 * 安全闸门
 *
 * 禁止生产环境。
 * ============================================================
 */

if(
  !/demo-fapi\.binance\.com|testnet\.binancefuture\.com/i.test(
    BASE
  )
){

  throw new Error(

    'SAFETY STOP: BINANCE_FUTURES_BASE_URL must be a Demo/Testnet host. Production fapi.binance.com is refused.'

  );

}


/*
 * ============================================================
 * State
 * ============================================================
 */

const state = {

  startedAt:
    Date.now(),

  running:
    AUTO_TRADE,

  lastCycle:
    null,

  lastSignals:
    [],

  logs:
    [],

  exchangeInfo:
    null,

  filters:
    {},

  positions:
    [],

  account:
    null,

  lastClosed15m:
    {}

};


/*
 * ============================================================
 * Log
 * ============================================================
 */

function log(

  msg,

  extra

){

  const line =

    new Date()
      .toISOString() +

    ' ' +

    msg +

    (

      extra

        ? ' ' +
          JSON.stringify(extra)

        : ''

    );


  state.logs.unshift(
    line
  );


  state.logs =
    state.logs.slice(
      0,
      300
    );


  console.log(
    line
  );

}


/*
 * ============================================================
 * Clamp
 * ============================================================
 */

function clamp(

  x,

  a,

  b

){

  return Math.max(

    a,

    Math.min(
      b,
      x
    )

  );

}


/*
 * ============================================================
 * EMA
 * ============================================================
 */

function ema(

  values,

  p

){

  if(
    !values.length
  ){

    return [];

  }


  const k =
    2 /
    (
      p + 1
    );


  const out =
    new Array(
      values.length
    );


  let e =
    values[0];


  out[0] =
    e;


  for(

    let i = 1;

    i < values.length;

    i++

  ){

    e =
      values[i] *
      k +

      e *
      (
        1 - k
      );


    out[i] =
      e;

  }


  return out;

}


/*
 * ============================================================
 * ATR
 * ============================================================
 */

function atr(

  data,

  p = 14

){

  const out =
    new Array(
      data.length
    ).fill(
      NaN
    );


  const tr =
    new Array(
      data.length
    ).fill(
      NaN
    );


  if(
    data.length <= p
  ){

    return out;

  }


  for(

    let i = 1;

    i < data.length;

    i++

  ){

    const pc =
      data[
        i - 1
      ].close;


    tr[i] =
      Math.max(

        data[i].high -
        data[i].low,

        Math.abs(
          data[i].high -
          pc
        ),

        Math.abs(
          data[i].low -
          pc
        )

      );

  }


  let sum =
    0;


  for(

    let i = 1;

    i <= p;

    i++

  ){

    sum +=
      tr[i];

  }


  let cur =
    sum / p;


  out[p] =
    cur;


  for(

    let i = p + 1;

    i < data.length;

    i++

  ){

    cur =

      (

        cur *
        (
          p - 1
        )

      +

        tr[i]

      ) / p;


    out[i] =
      cur;

  }


  return out;

}


/*
 * ============================================================
 * Gap
 * ============================================================
 */

function gap(

  a,

  b

){

  return (

    Math.abs(
      a - b
    ) /

    Math.max(
      Math.abs(b),
      1e-12
    )

  );

}


/*
 * ============================================================
 * Clamp 0-1
 * ============================================================
 */

function clamp01(
  x
){

  return clamp(
    x,
    0,
    1
  );

}


/*
 * ============================================================
 * Normalize Gap
 * ============================================================
 */

function normGap(
  g
){

  return clamp01(

    g /
    QUALITY_GAP_CAP

  );

}


/*
 * ============================================================
 * Candle Body
 * ============================================================
 */

function body(
  c
){

  return Math.abs(

    c.close -
    c.open

  );

}


/*
 * ============================================================
 * Candle Location
 * ============================================================
 */

function loc(
  c
){

  const r =
    c.high -
    c.low;


  return r > 0

    ? (
        c.close -
        c.low
      ) / r

    : 0.5;

}


/*
 * ============================================================
 * Long Pullback
 * ============================================================
 */

function longPB(

  data,

  e20,

  i

){

  const start =
    Math.max(

      1,

      i -
      PULLBACK_LOOKBACK

    );


  for(

    let j = i - 1;

    j >= start;

    j--

  ){

    if(

      data[j].low <=
        e20[j] &&

      data[j].close <=
        e20[j]

    ){

      return j;

    }

  }


  return -1;

}


/*
 * ============================================================
 * Short Pullback
 * ============================================================
 */

function shortPB(

  data,

  e20,

  i

){

  const start =
    Math.max(

      1,

      i -
      PULLBACK_LOOKBACK

    );


  for(

    let j = i - 1;

    j >= start;

    j--

  ){

    if(

      data[j].high >=
        e20[j] &&

      data[j].close >=
        e20[j]

    ){

      return j;

    }

  }


  return -1;

}


/*
 * ============================================================
 * Quality
 * ============================================================
 */

function quality(

  side,

  vals

){

  let s =
    0;


  const aligned =

    side === 'LONG'

      ? [
          vals.b4,
          vals.b1,
          vals.b15
        ].filter(Boolean).length

      : [
          vals.s4,
          vals.s1,
          vals.s15
        ].filter(Boolean).length;


  s +=
    aligned *
    (
      25 / 3
    );


  s +=
    20 *
    normGap(
      vals.g1
    );


  s +=
    15 *
    normGap(
      vals.g15
    );


  if(

    side === 'LONG'

      ? vals.slopeBull

      : vals.slopeBear

  ){

    s += 10;

  }


  if(
    vals.fresh
  ){

    s += 10;

  }


  s +=

    10 *
    clamp01(
      vals.bodyAtr / 1
    );


  const l =

    side === 'LONG'

      ? vals.closeLoc

      : 1 -
        vals.closeLoc;


  s +=

    10 *
    clamp01(
      (
        l -
        0.5
      ) / 0.5
    );


  return clamp(
    s,
    0,
    100
  );

}


/*
 * ============================================================
 * Kline
 * ============================================================
 */

function candleFromK(
  k
){

  return {

    openTime:
      +k[0],

    open:
      +k[1],

    high:
      +k[2],

    low:
      +k[3],

    close:
      +k[4],

    volume:
      +k[5],

    closeTime:
      +k[6]

  };

}


/*
 * ============================================================
 * Query String
 * ============================================================
 */

function qs(
  params
){

  return new URLSearchParams(
    params
  ).toString();

}


/*
 * ============================================================
 * Signature
 * ============================================================
 */

function sign(
  params
){

  const q =
    qs(
      params
    );


  return (

    q +

    '&signature=' +

    crypto
      .createHmac(
        'sha256',
        API_SECRET
      )
      .update(q)
      .digest('hex')

  );

}


/*
 * ============================================================
 * HTTP Text Request
 * ============================================================
 */

function requestText(

  url,

  options = {}

){

  return new Promise(

    (

      resolve,

      reject

    ) => {

      const u =
        new URL(
          url
        );


      const isHttps =
        u.protocol ===
        'https:';


      const client =
        isHttps
          ? https
          : http;


      const req =
        client.request(

          {

            protocol:
              u.protocol,

            hostname:
              u.hostname,

            port:
              u.port ||
              undefined,

            path:
              u.pathname +
              u.search,

            method:
              options.method ||
              'GET',

            headers:
              options.headers ||
              {},

            family:
              4,

            timeout:
              Math.min(

                Number(
                  options.timeout ||
                  30000
                ),

                120000

              )

          },

          res => {

            let text =
              '';


            res.setEncoding(
              'utf8'
            );


            res.on(
              'data',
              c =>
                text += c
            );


            res.on(

              'end',

              () => {

                resolve({

                  status:
                    res.statusCode ||
                    0,

                  headers:
                    res.headers,

                  text

                });

              }

            );

          }

        );


      req.on(

        'timeout',

        () =>

          req.destroy(
            new Error(
              'request timeout'
            )
          )

      );


      req.on(
        'error',
        reject
      );


      if(
        options.body
      ){

        req.write(
          options.body
        );

      }


      req.end();

    }

  );

}


/*
 * ============================================================
 * HTTP Buffer Request
 * ============================================================
 */

function requestBuffer(

  url,

  options = {}

){

  return new Promise(

    (

      resolve,

      reject

    ) => {

      const u =
        new URL(
          url
        );


      const isHttps =
        u.protocol ===
        'https:';


      const client =
        isHttps
          ? https
          : http;


      const req =
        client.request(

          {

            protocol:
              u.protocol,

            hostname:
              u.hostname,

            port:
              u.port ||
              undefined,

            path:
              u.pathname +
              u.search,

            method:
              options.method ||
              'GET',

            headers:
              options.headers ||
              {},

            family:
              4,

            timeout:
              Math.min(

                Number(
                  options.timeout ||
                  60000
                ),

                120000

              )

          },

          res => {

            const chunks =
              [];


            res.on(

              'data',

              c =>
                chunks.push(
                  Buffer.from(c)
                )

            );


            res.on(

              'end',

              () => {

                resolve({

                  status:
                    res.statusCode ||
                    0,

                  headers:
                    res.headers,

                  buffer:
                    Buffer.concat(
                      chunks
                    )

                });

              }

            );

          }

        );


      req.on(

        'timeout',

        () =>

          req.destroy(
            new Error(
              'request timeout'
            )
          )

      );


      req.on(
        'error',
        reject
      );


      req.end();

    }

  );

}


/*
 * ============================================================
 * JSON Request
 * ============================================================
 */

async function requestJson(

  url,

  options = {}

){

  let lastErr =
    null;


  for(

    let attempt = 0;

    attempt < 2;

    attempt++

  ){

    try{

      const r =
        await requestText(
          url,
          options
        );


      let data;


      try{

        data =
          JSON.parse(
            r.text
          );

      }catch{

        throw new Error(

          'Binance non-JSON ' +

          r.status +

          ': ' +

          r.text.slice(
            0,
            300
          )

        );

      }


      if(

        r.status < 200 ||

        r.status >= 300 ||

        (
          data &&
          data.code < 0
        )

      ){

        throw new Error(

          `Binance ${r.status}: ` +

          `${
            data?.msg ||
            r.text
          }`

        );

      }


      return data;

    }catch(e){

      lastErr =
        e;


      if(
        attempt === 0
      ){

        await new Promise(

          r =>
            setTimeout(
              r,
              500
            )

        );

      }

    }

  }


  throw (

    lastErr ||

    new Error(
      'request failed'
    )

  );

}


/*
 * ============================================================
 * Demo API
 * ============================================================
 */

async function api(

  method,

  pathName,

  params = {},

  signed = false

){

  const p =
    {
      ...params
    };


  if(
    signed
  ){

    p.timestamp =
      Date.now();


    p.recvWindow =
      5000;

  }


  const query =
    signed

      ? sign(p)

      : qs(p);


  const url =

    BASE +

    pathName +

    (
      query

        ? '?' +
          query

        : ''
    );


  const headers =
    {};


  if(
    API_KEY
  ){

    headers[
      'X-MBX-APIKEY'
    ] =
      API_KEY;

  }


  return requestJson(

    url,

    {

      method,

      headers,

      timeout:
        30000

    }

  );

}


/*
 * ============================================================
 * POST Form
 * ============================================================
 */

async function postForm(

  pathName,

  params = {},

  signed = true

){

  const p =
    {
      ...params
    };


  if(
    signed
  ){

    p.timestamp =
      Date.now();

    p.recvWindow =
      5000;

  }


  const q =

    signed

      ? sign(p)

      : qs(p);


  const r =
    await fetch(

      BASE +
      pathName,

      {

        method:
          'POST',

        headers:{

          'Content-Type':
            'application/x-www-form-urlencoded',

          'X-MBX-APIKEY':
            API_KEY

        },

        body:
          q

      }

    );


  const text =
    await r.text();


  let d;


  try{

    d =
      JSON.parse(
        text
      );

  }catch{

    throw new Error(
      text
    );

  }


  if(

    !r.ok ||

    d.code < 0

  ){

    throw new Error(

      `Binance ${r.status}: ` +

      (
        d.msg ||
        text
      )

    );

  }


  return d;

}


/*
 * ============================================================
 * PUT Form
 * ============================================================
 */

async function putForm(

  pathName,

  params = {}

){

  const p =

    {

      ...params,

      timestamp:
        Date.now(),

      recvWindow:
        5000

    };


  const q =
    sign(p);


  const r =
    await fetch(

      BASE +
      pathName,

      {

        method:
          'PUT',

        headers:{

          'Content-Type':
            'application/x-www-form-urlencoded',

          'X-MBX-APIKEY':
            API_KEY

        },

        body:
          q

      }

    );


  const t =
    await r.text();


  let d;


  try{

    d =
      JSON.parse(
        t
      );

  }catch{

    throw new Error(
      t
    );

  }


  if(

    !r.ok ||

    d.code < 0

  ){

    throw new Error(

      `Binance ${r.status}: ` +

      (
        d.msg ||
        t
      )

    );

  }


  return d;

}


/*
 * ============================================================
 * Live Klines
 * ============================================================
 */

async function getKlines(

  symbol,

  interval,

  limit = 300

){

  const a =
    await api(

      'GET',

      '/fapi/v1/klines',

      {

        symbol,

        interval,

        limit

      }

    );


  return a.map(
    candleFromK
  );

}


/*
 * ============================================================
 * Parse Time
 * ============================================================
 */

function parseTime(

  v,

  fallback

){

  if(

    v === undefined ||

    v === null ||

    v === ''

  ){

    return fallback;

  }


  if(
    typeof v === 'number'
  ){

    return v < 1e12

      ? v * 1000

      : v;

  }


  const n =
    Number(v);


  if(
    Number.isFinite(n)
  ){

    return n < 1e12

      ? n * 1000

      : n;

  }


  const t =
    Date.parse(
      String(v)
    );


  return Number.isFinite(t)

    ? t

    : fallback;

}


/*
 * ============================================================
 * Interval
 * ============================================================
 */

const INTERVAL_MS = {

  '15m':
    15 *
    60 *
    1000,

  '1h':
    60 *
    60 *
    1000,

  '4h':
    4 *
    60 *
    60 *
    1000

};


/*
 * ============================================================
 * Public API
 * ============================================================
 */

async function publicApi(

  pathName,

  params = {}

){

  const query =
    qs(params);


  const url =

    PUBLIC_BASE +

    pathName +

    (
      query

        ? '?' +
          query

        : ''
    );


  return requestJson(

    url,

    {

      method:
        'GET',

      headers:{

        'User-Agent':
          'Quant-V3.7.18.10/1.0'

      },

      timeout:
        30000

    }

  );

}


/*
 * ============================================================
 * Historical Klines
 * ============================================================
 */

async function getHistoricalKlines(

  symbol,

  interval,

  startTime,

  endTime

){

  const step =
    INTERVAL_MS[
      interval
    ];


  if(
    !step
  ){

    throw new Error(

      'Unsupported interval: ' +
      interval

    );

  }


  let start =
    parseTime(

      startTime,

      Date.now() -
      30 *
      24 *
      60 *
      60 *
      1000

    );


  const end =
    parseTime(

      endTime,

      Date.now()

    );


  if(

    !Number.isFinite(start) ||

    !Number.isFinite(end) ||

    end < start

  ){

    throw new Error(
      'Invalid start/end'
    );

  }


  const out =
    [];


  const seen =
    new Set();


  for(

    let page = 0;

    page < 200;

    page++

  ){

    const rows =
      await publicApi(

        '/fapi/v1/klines',

        {

          symbol,

          interval,

          startTime:
            Math.floor(
              start
            ),

          endTime:
            Math.floor(
              end
            ),

          limit:
            1500

        }

      );


    if(

      !Array.isArray(rows) ||

      !rows.length

    ){

      break;

    }


    for(
      const k of rows
    ){

      const c =
        candleFromK(
          k
        );


      if(

        c.openTime <
          start ||

        c.openTime >
          end

      ){

        continue;

      }


      if(
        !seen.has(
          c.openTime
        )
      ){

        seen.add(
          c.openTime
        );


        out.push(
          c
        );

      }

    }


    const lastOpen =
      Number(
        rows[
          rows.length - 1
        ]?.[0]
      );


    if(

      !Number.isFinite(
        lastOpen
      ) ||

      lastOpen >= end ||

      rows.length < 1500

    ){

      break;

    }


    const next =
      lastOpen +
      step;


    if(
      next <= start
    ){

      break;

    }


    start =
      next;

  }


  out.sort(

    (a,b) =>
      a.openTime -
      b.openTime

  );


  return out;

}


/*
 * ============================================================
 * Funding Normalization
 * ============================================================
 */

function normalizeFundingRows(

  rows

){

  const out =
    [];


  for(
    const x of
      (
        Array.isArray(rows)
          ? rows
          : []
      )
  ){

    const obj =

      Array.isArray(x)

        ? {

            calcTime:
              x[0],

            fundingIntervalHours:
              x[1],

            fundingRate:
              x[2]

          }

        : x || {};


    let t =

      Number(

        obj.calcTime ??

        obj.fundingTime ??

        obj.funding_time ??

        obj.time

      );


    if(

      Number.isFinite(t) &&

      t < 1e12

    ){

      t *= 1000;

    }


    const rate =

      Number(

        obj.lastFundingRate ??

        obj.fundingRate ??

        obj.funding_rate ??

        obj.rate

      );


    const interval =

      Number(

        obj.fundingIntervalHours ??

        obj.funding_interval_hours ??

        8

      );


    if(

      Number.isFinite(t) &&

      Number.isFinite(rate)

    ){

      out.push({

        symbol:
          obj.symbol,

        fundingTime:
          t,

        fundingRate:
          rate,

        fundingIntervalHours:

          Number.isFinite(interval) &&
          interval > 0

            ? interval

            : 8,

        markPrice:

          Number(

            obj.markPrice ??
            obj.mark_price ??
            NaN

          )

      });

    }

  }


  return out;

}


/*
 * ============================================================
 * Funding Archive Cache
 * ============================================================
 */

const fundingArchiveCache =
  new Map();


/*
 * ============================================================
 * Binance Public Data Funding Archive
 *
 * USD-M Futures
 *
 * ============================================================
 */

const FUNDING_ARCHIVE_BASE =

  'https://data.binance.vision/data/futures/um/monthly/fundingRate';


/*
 * ============================================================
 * Month Floor
 * ============================================================
 */

function monthFloor(
  ms
){

  const d =
    new Date(
      ms
    );


  return Date.UTC(

    d.getUTCFullYear(),

    d.getUTCMonth(),

    1

  );

}


/*
 * ============================================================
 * Next Month
 * ============================================================
 */

function nextMonth(
  ms
){

  const d =
    new Date(
      ms
    );


  return Date.UTC(

    d.getUTCFullYear(),

    d.getUTCMonth() + 1,

    1

  );

}


/*
 * ============================================================
 * Funding Archive URL
 * ============================================================
 */

function fundingArchiveUrl(

  symbol,

  monthStart

){

  const d =
    new Date(
      monthStart
    );


  const ym =

    `${d.getUTCFullYear()}-` +

    `${String(
      d.getUTCMonth() + 1
    ).padStart(
      2,
      '0'
    )}`;


  return (

    `${FUNDING_ARCHIVE_BASE}/` +

    `${symbol}/` +

    `${symbol}-fundingRate-${ym}.zip`

  );

}


/*
 * ============================================================
 * Download Funding Archive
 * ============================================================
 */

async function downloadArchive(
  url
){

  const r =
    await requestBuffer(

      url,

      {

        method:
          'GET',

        headers:{

          'User-Agent':
            'Quant-V3.7.18.10-FundingArchive/1.0'

        },

        timeout:
          60000

      }

    );


  if(
    r.status === 404
  ){

    return null;

  }


  if(

    r.status < 200 ||

    r.status >= 300

  ){

    throw new Error(

      `Funding archive HTTP ${r.status}`

    );

  }


  if(
    !r.buffer.length
  ){

    throw new Error(
      'Funding archive empty'
    );

  }


  return r.buffer;

}


/*
 * ============================================================
 * Parse Funding ZIP
 * ============================================================
 */

function parseFundingArchiveBuffer(

  buffer,

  symbol

){

  const zip =
    new AdmZip(
      buffer
    );


  const entries =
    zip.getEntries();


  const entry =
    entries.find(

      e =>

        !e.isDirectory &&

        /\.(csv|csv\.gz)$/i.test(
          e.entryName
        )

    );


  if(
    !entry
  ){

    throw new Error(
      'Funding ZIP 中没有 CSV 文件'
    );

  }


  const text =
    entry
      .getData()
      .toString(
        'utf8'
      );


  const lines =

    text
      .replace(
        /^\uFEFF/,
        ''
      )
      .trim()
      .split(
        /\r?\n/
      );


  const rows =
    [];


  for(
    const line of lines
  ){

    if(
      !line.trim()
    ){

      continue;

    }


    const cols =
      line
        .split(',')
        .map(
          x =>
            x.trim()
        );


    if(
      !Number.isFinite(
        Number(
          cols[0]
        )
      )
    ){

      continue;

    }


    const obj = {

      symbol:
        cols[1] ||
        symbol,

      calcTime:
        cols[0],

      fundingIntervalHours:
        cols[2],

      lastFundingRate:
        cols[3]

    };


    const n =
      normalizeFundingRows(
        [obj]
      );


    if(
      n.length
    ){

      rows.push(
        n[0]
      );

    }

  }


  return rows;

}


/*
 * ============================================================
 * Historical Funding
 * ============================================================
 */

async function getHistoricalFunding(

  symbol,

  startTime,

  endTime

){

  let start =
    parseTime(

      startTime,

      Date.now() -
      30 *
      24 *
      60 *
      60 *
      1000

    );


  const end =
    parseTime(

      endTime,

      Date.now()

    );


  if(

    !Number.isFinite(start) ||

    !Number.isFinite(end) ||

    end < start

  ){

    throw new Error(
      'Invalid funding start/end'
    );

  }


  const first =
    monthFloor(
      start
    );


  const last =
    monthFloor(
      end
    );


  const all =
    [];


  for(

    let m = first;

    m <= last;

    m = nextMonth(m)

  ){

    const url =
      fundingArchiveUrl(

        symbol,

        m

      );


    let rows =
      fundingArchiveCache.get(
        url
      );


    if(
      !rows
    ){

      const buf =
        await downloadArchive(
          url
        );


      rows =

        buf

          ? parseFundingArchiveBuffer(
              buf,
              symbol
            )

          : [];


      fundingArchiveCache.set(

        url,

        rows

      );

    }


    for(
      const x of rows
    ){

      if(

        x.fundingTime >=
          start &&

        x.fundingTime <=
          end

      ){

        all.push(
          x
        );

      }

    }

  }


  const map =
    new Map();


  for(
    const x of all
  ){

    map.set(

      x.fundingTime,

      x

    );

  }


  return [

    ...map.values()

  ].sort(

    (a,b) =>
      a.fundingTime -
      b.fundingTime

  );

}


/*
 * ============================================================
 * Funding API
 *
 * /api/funding
 * /api/funding-rate
 * /api/market/funding
 *
 * ============================================================
 */

async function handleFunding(

  req,

  res,

  u

){

  const symbol =

    (

      u.searchParams.get(
        'symbol'
      ) ||

      ''

    )
      .trim()
      .toUpperCase();


  if(

    !/^[A-Z0-9]{5,20}$/.test(
      symbol
    )

  ){

    return json(

      res,

      400,

      {

        ok:false,

        error:
          'symbol required/invalid'

      }

    );

  }


  const start =
    u.searchParams.get(
      'startTime'
    ) ||

    u.searchParams.get(
      'start'
    );


  const end =
    u.searchParams.get(
      'endTime'
    ) ||

    u.searchParams.get(
      'end'
    );


  const rows =
    await getHistoricalFunding(

      symbol,

      start,

      end

    );


  const rangeStart =
    parseTime(

      start,

      Date.now() -
      30 *
      24 *
      60 *
      60 *
      1000

    );


  const rangeEnd =
    parseTime(

      end,

      Date.now()

    );


  /*
   * 理论上每 8 小时一次。
   *
   * 这里只作为近似诊断，
   * 不把 expected 当作强制数据标准。
   */

  const expected =

    Math.max(

      0,

      Math.floor(

        (
          rangeEnd -
          rangeStart
        ) /

        (
          8 *
          60 *
          60 *
          1000
        )

      )

    );


  const gaps =
    [];


  for(

    let i = 1;

    i < rows.length;

    i++

  ){

    const dt =

      rows[i].fundingTime -

      rows[
        i - 1
      ].fundingTime;


    if(

      dt >
      12 *
      60 *
      60 *
      1000

    ){

      gaps.push({

        from:
          rows[
            i - 1
          ].fundingTime,

        to:
          rows[i].fundingTime,

        deltaMs:
          dt

      });

    }

  }


  return json(

    res,

    200,

    {

      ok:true,

      source:
        'Binance Public Data fundingRate archive',

      symbol,

      start:
        rangeStart,

      end:
        rangeEnd,

      data:
        rows,

      rows,

      diagnostics:{

        available:
          rows.length > 0,

        events:
          rows.length,

        expectedApprox:
          expected,

        coverageRatio:

          expected > 0

            ? rows.length /
              expected

            : null,

        gaps:
          gaps.slice(
            0,
            20
          ),

        archiveBase:
          FUNDING_ARCHIVE_BASE

      }

    }

  );

}


/*
 * ============================================================
 * Market API
 * ============================================================
 */

async function handleMarket(

  req,

  res,

  u

){

  const symbol =

    (

      u.searchParams.get(
        'symbol'
      ) ||

      ''

    )
      .trim()
      .toUpperCase();


  if(
    !symbol
  ){

    return json(

      res,

      400,

      {

        ok:false,

        error:
          'symbol required'

      }

    );

  }


  const now =
    Date.now();


  const start =
    parseTime(

      u.searchParams.get(
        'start'
      ),

      now -
      30 *
      24 *
      60 *
      60 *
      1000

    );


  const end =
    parseTime(

      u.searchParams.get(
        'end'
      ),

      now

    );


  const data =
    {};


  for(

    const interval of [

      '15m',

      '1h',

      '4h'

    ]

  ){

    data[interval] =

      await getHistoricalKlines(

        symbol,

        interval,

        start,

        end

      );

  }


  return json(

    res,

    200,

    {

      ok:true,

      data,

      meta:{

        symbol,

        start,

        end,

        backtestStart:

          parseTime(

            u.searchParams.get(
              'backtestStart'
            ),

            start

          ),

        backtestEnd:

          parseTime(

            u.searchParams.get(
              'backtestEnd'
            ),

            end

          ),

        publicBase:
          PUBLIC_BASE

      }

    }

  );

}


/*
 * ============================================================
 * Quantity / Price
 * ============================================================
 */

function roundStep(

  v,

  step

){

  if(

    !step ||

    !Number.isFinite(v)

  ){

    return v;

  }


  const n =

    Math.floor(

      v /
      step +
      1e-12

    );


  return Number(

    (
      n *
      step
    ).toFixed(
      12
    )

  );

}


function roundPrice(

  v,

  tick

){

  if(
    !tick
  ){

    return v;

  }


  const n =
    Math.round(
      v /
      tick
    );


  return Number(

    (
      n *
      tick
    ).toFixed(
      12
    )

  );

}


/*
 * ============================================================
 * Exchange Info
 * ============================================================
 */

async function loadExchangeInfo(){

  state.exchangeInfo =

    await api(

      'GET',

      '/fapi/v1/exchangeInfo'

    );


  for(

    const s of
      state.exchangeInfo.symbols || []

  ){

    const f =
      {};


    for(
      const x of
        s.filters || []
    ){

      if(
        x.filterType ===
        'LOT_SIZE'
      ){

        f.step =
          Number(
            x.stepSize
          );

        f.minQty =
          Number(
            x.minQty
          );

      }


      if(
        x.filterType ===
        'PRICE_FILTER'
      ){

        f.tick =
          Number(
            x.tickSize
          );

      }


      if(
        x.filterType ===
        'MIN_NOTIONAL'
      ){

        f.minNotional =
          Number(

            x.notional ||

            x.minNotional ||

            0

          );

      }

    }


    state.filters[
      s.symbol
    ] =
      f;

  }


  return state.exchangeInfo;

}


/*
 * ============================================================
 * Sync Account
 * ============================================================
 */

async function syncAccount(){

  state.account =

    await api(

      'GET',

      '/fapi/v2/account',

      {},

      true

    );


  state.positions =

    (
      state.account.positions ||
      []
    )

      .filter(

        p =>

          Math.abs(

            Number(
              p.positionAmt ||
              0
            )

          ) > 0

      )

      .map(

        p => ({

          symbol:
            p.symbol,

          amt:
            Number(
              p.positionAmt
            ),

          entry:
            Number(
              p.entryPrice
            ),

          unrealized:
            Number(
              p.unrealizedProfit
            ),

          notional:

            Math.abs(
              Number(
                p.positionAmt
              )
            ) *

            Number(

              p.markPrice ||

              p.entryPrice

            ),

          leverage:
            Number(
              p.leverage ||
              1
            )

        })

      );


  return state.account;

}


/*
 * ============================================================
 * Current Equity
 * ============================================================
 */

function currentEquity(){

  return (

    Number(

      state.account?.totalWalletBalance ||

      state.account?.totalMarginBalance ||

      0

    ) ||

    10000

  );

}


/*
 * ============================================================
 * Capacity
 *
 * 最大 3 仓
 * ============================================================
 */

function canOpen(

  symbol,

  plannedNotional = 0

){

  if(

    state.positions.some(

      p =>
        p.symbol ===
        symbol

    )

  ){

    return false;

  }


  if(

    state.positions.length >=
    MAX_POSITIONS

  ){

    return false;

  }


  const eq =
    currentEquity();


  const cap =

    eq *

    MAX_ENTRY_LEVERAGE *

    LEVERAGE_BUFFER;


  const used =

    state.positions.reduce(

      (

        a,

        p

      ) =>

        a +
        Math.abs(
          p.notional || 0
        ),

      0

    );


  return (

    used +

    Math.max(
      0,
      plannedNotional
    )

  )

  <=

  cap + 1e-9;

}


/*
 * ============================================================
 * Place Entry
 * ============================================================
 */

async function placeEntry(

  symbol,

  side,

  qty,

  stopPrice

){

  if(
    !AUTO_TRADE
  ){

    log(

      'SIGNAL_ONLY',

      {

        symbol,

        side,

        qty,

        stopPrice

      }

    );


    return {
      dryRun:true
    };

  }


  const f =
    state.filters[
      symbol
    ] ||
    {};


  qty =
    roundStep(
      qty,
      f.step
    );


  if(

    qty <= 0 ||

    qty <
    (
      f.minQty ||
      0
    )

  ){

    throw new Error(

      symbol +
      ' quantity below minQty'

    );

  }


  const order =
    await postForm(

      '/fapi/v1/order',

      {

        symbol,

        side,

        type:
          'MARKET',

        quantity:
          qty,

        newOrderRespType:
          'RESULT'

      }

    );


  log(

    'ENTRY_FILLED',

    {

      symbol,

      side,

      qty,

      orderId:
        order.orderId

    }

  );


  const stopSide =

    side === 'BUY'

      ? 'SELL'

      : 'BUY';


  stopPrice =
    roundPrice(
      stopPrice,
      f.tick
    );


  try{

    const stop =

      await postForm(

        '/fapi/v1/order',

        {

          symbol,

          side:
            stopSide,

          type:
            'STOP_MARKET',

          stopPrice,

          closePosition:
            'true',

          workingType:
            'MARK_PRICE'

        }

      );


    log(

      'STOP_PLACED',

      {

        symbol,

        stopPrice,

        orderId:
          stop.orderId

      }

    );

  }catch(e){

    log(

      'STOP_ERROR',

      {

        symbol,

        error:
          e.message

      }

    );


    throw e;

  }


  return order;

}


/*
 * ============================================================
 * Evaluate Symbol
 * ============================================================
 */

async function evaluateSymbol(
  symbol
){

  const [

    d15,

    d1,

    d4

  ] =

    await Promise.all([

      getKlines(
        symbol,
        '15m',
        220
      ),

      getKlines(
        symbol,
        '1h',
        220
      ),

      getKlines(
        symbol,
        '4h',
        220
      )

    ]);


  if(

    d15.length < 80 ||

    d1.length < 80 ||

    d4.length < 80

  ){

    return null;

  }


  /*
   * 最新 K 线可能还没有结束。
   */

  const now =
    Date.now();


  let i15 =
    d15.length - 1;


  if(

    d15[i15].closeTime >
    now

  ){

    i15--;

  }


  if(
    i15 < 20
  ){

    return null;

  }


  const t =
    d15[i15].closeTime;


  let i1 =
    -1;


  for(

    let i =
      d1.length - 1;

    i >= 0;

    i--

  ){

    if(

      d1[i].closeTime <=
      t

    ){

      i1 =
        i;

      break;

    }

  }


  let i4 =
    -1;


  for(

    let i =
      d4.length - 1;

    i >= 0;

    i--

  ){

    if(

      d4[i].closeTime <=
      t

    ){

      i4 =
        i;

      break;

    }

  }


  if(

    i1 <
    EMA_SLOPE_LOOKBACK ||

    i4 < 1

  ){

    return null;

  }


  const e15_20 =
    ema(
      d15.map(
        x => x.close
      ),
      20
    );


  const e15_50 =
    ema(
      d15.map(
        x => x.close
      ),
      50
    );


  const e1_20 =
    ema(
      d1.map(
        x => x.close
      ),
      20
    );


  const e1_50 =
    ema(
      d1.map(
        x => x.close
      ),
      50
    );


  const e4_50 =
    ema(
      d4.map(
        x => x.close
      ),
      50
    );


  const e4_200 =
    ema(
      d4.map(
        x => x.close
      ),
      200
    );


  const a15 =
    atr(
      d15,
      14
    );


  const c =
    d15[i15];


  const prev =
    d15[i15 - 1];


  const a =
    a15[i15];


  if(

    !Number.isFinite(a) ||

    a <= 0

  ){

    return null;

  }


  const b4 =
    e4_50[i4] >
    e4_200[i4];


  const s4 =
    e4_50[i4] <
    e4_200[i4];


  const b1 =
    e1_20[i1] >
    e1_50[i1];


  const s1 =
    e1_20[i1] <
    e1_50[i1];


  const b15 =
    e15_20[i15] >
    e15_50[i15];


  const s15 =
    e15_20[i15] <
    e15_50[i15];


  const slopeBull =

    e1_20[i1] >

    e1_20[
      i1 -
      EMA_SLOPE_LOOKBACK
    ];


  const slopeBear =

    e1_20[i1] <

    e1_20[
      i1 -
      EMA_SLOPE_LOOKBACK
    ];


  const g15 =
    gap(
      e15_20[i15],
      e15_50[i15]
    );


  const g1 =
    gap(
      e1_20[i1],
      e1_50[i1]
    );


  const lp =
    longPB(
      d15,
      e15_20,
      i15
    );


  const sp =
    shortPB(
      d15,
      e15_20,
      i15
    );


  const lf =

    lp >= 0 &&

    i15 - lp <=
    MAX_PULLBACK_AGE;


  const sf =

    sp >= 0 &&

    i15 - sp <=
    MAX_PULLBACK_AGE;


  const longReclaim =

    prev.close <=
      e15_20[
        i15 - 1
      ] &&

    c.close >
      e15_20[
        i15
      ];


  const shortReclaim =

    prev.close >=
      e15_20[
        i15 - 1
      ] &&

    c.close <
      e15_20[
        i15
      ];


  const cl =
    loc(c);


  const ba =
    body(c) /
    a;


  const longBreak =

    c.close >

    prev.high +

    a *
    BREAKOUT_ATR_BUFFER &&

    cl >=
    MIN_LONG_CLOSE_LOCATION &&

    ba >=
    MIN_BREAKOUT_BODY_ATR;


  const shortBreak =

    c.close <

    prev.low -

    a *
    BREAKOUT_ATR_BUFFER &&

    cl <=
    MAX_SHORT_CLOSE_LOCATION &&

    ba >=
    MIN_SHORT_BODY_ATR;


  const lq =

    g15 >=
    MIN_15_EMA_GAP &&

    g1 >=
    MIN_1H_EMA_GAP &&

    slopeBull &&

    lf &&

    longReclaim &&

    c.close >
    e15_20[i15];


  const sq =

    g15 >=
    MIN_15_EMA_GAP &&

    g1 >=
    MIN_1H_EMA_GAP &&

    slopeBear &&

    sf &&

    shortReclaim &&

    c.close <
    e15_20[i15];


  let side =
    null;


  if(

    b4 &&
    b1 &&
    b15 &&
    slopeBull &&
    lq &&
    longBreak

  ){

    side =
      'LONG';

  }else if(

    s4 &&
    s1 &&
    s15 &&
    slopeBear &&
    sq &&
    shortBreak

  ){

    side =
      'SHORT';

  }


  if(
    !side
  ){

    return {

      symbol,

      closedAt:
        t,

      signal:
        null

    };

  }


  const q =
    quality(

      side,

      {

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

        bodyAtr:
          ba,

        closeLoc:
          cl,

        fresh:
          side === 'LONG'
            ? lf
            : sf

      }

    );


  const threshold =

    side === 'SHORT'

      ? SHORT_MIN_SIGNAL_QUALITY

      : MIN_SIGNAL_QUALITY;


  if(
    q < threshold
  ){

    return {

      symbol,

      closedAt:
        t,

      signal:
        null,

      filtered:
        true,

      quality:
        q

    };

  }


  let stopDistance =

    ATR_MULTIPLIER *
    a;


  if(

    side === 'LONG' &&

    lp >= 0

  ){

    stopDistance =

      Math.max(

        stopDistance,

        c.close -
        d15[lp].low

      );

  }


  if(

    side === 'SHORT' &&

    sp >= 0

  ){

    stopDistance =

      Math.max(

        stopDistance,

        d15[sp].high -
        c.close

      );

  }


  if(

    stopDistance >
    a *
    MAX_STOP_ATR

  ){

    return {

      symbol,

      closedAt:
        t,

      signal:
        null,

      filtered:
        'wideStop',

      quality:
        q

    };

  }


  const stop =

    side === 'LONG'

      ? c.close -
        stopDistance

      : c.close +
        stopDistance;


  return {

    symbol,

    closedAt:
      t,

    signal:{

      side,

      quality:
        q,

      signalClose:
        c.close,

      atr:
        a,

      stopDistance,

      stop

    },

    nextOpen:
      t + 1

  };

}


/*
 * ============================================================
 * Run Cycle
 * ============================================================
 */

async function runCycle(){

  try{

    await syncAccount();


    for(
      const symbol of SYMBOLS
    ){

      const r =
        await evaluateSymbol(
          symbol
        );


      if(
        !r
      ){

        continue;

      }


      const last =

        state.lastClosed15m[
          symbol
        ] ||

        0;


      if(
        r.closedAt <=
        last

      ){

        continue;

      }


      state.lastClosed15m[
        symbol
      ] =
        r.closedAt;


      if(
        !r.signal
      ){

        continue;

      }


      state.lastSignals.unshift(
        r
      );


      state.lastSignals =
        state.lastSignals.slice(
          0,
          100
        );


      log(

        'SIGNAL',

        {

          symbol,

          ...r.signal

        }

      );


      const eq =
        currentEquity();


      const riskCash =
        eq *
        RISK;


      const f =
        state.filters[
          symbol
        ] ||
        {};


      let qty =

        roundStep(

          riskCash /
          r.signal.stopDistance,

          f.step

        );


      const plannedNotional =

        qty *
        r.signal.signalClose;


      if(

        !canOpen(

          symbol,

          plannedNotional

        )

      ){

        log(

          'ENTRY_REJECT_CAPACITY',

          {

            symbol,

            plannedNotional

          }

        );


        continue;

      }


      const entryDelay =

        Math.max(

          0,

          r.closedAt +
          15000 -
          Date.now()

        );


      setTimeout(

        async() => {

          try{

            await syncAccount();


            if(

              canOpen(

                symbol,

                qty *
                r.signal.signalClose

              )

            ){

              const side =

                r.signal.side === 'LONG'

                  ? 'BUY'

                  : 'SELL';


              await placeEntry(

                symbol,

                side,

                qty,

                r.signal.stop

              );

            }else{

              log(

                'ENTRY_REJECT_CAPACITY',

                {

                  symbol

                }

              );

            }

          }catch(e){

            log(

              'ENTRY_ERROR',

              {

                symbol,

                error:
                  e.message

              }

            );

          }

        },

        entryDelay

      );

    }


    state.lastCycle =
      Date.now();


  }catch(e){

    log(

      'CYCLE_ERROR',

      {

        error:
          e.message

      }

    );

  }

}


/*
 * ============================================================
 * User Stream
 * ============================================================
 */

async function startUserStream(){

  if(
    !API_KEY
  ){

    return;

  }


  try{

    const d =
      await postForm(

        '/fapi/v1/listenKey',

        {},

        false

      );


    const key =
      d.listenKey;


    const ws =

      new WebSocket(

        WS_BASE +
        '/ws/' +
        key

      );


    ws.on(

      'open',

      () =>

        log(
          'USER_WS_CONNECTED'
        )

    );


    ws.on(

      'message',

      buf => {

        try{

          const x =
            JSON.parse(
              buf.toString()
            );


          if(

            x.e ===
            'ORDER_TRADE_UPDATE' ||

            x.e ===
            'ACCOUNT_UPDATE'

          ){

            log(

              'USER_EVENT',

              {

                event:
                  x.e

              }

            );

          }

        }catch{}

      }

    );


    ws.on(

      'close',

      () => {

        log(
          'USER_WS_CLOSED'
        );


        setTimeout(

          startUserStream,

          5000

        );

      }

    );


    ws.on(

      'error',

      e =>

        log(

          'USER_WS_ERROR',

          {

            error:
              e.message

          }

        )

    );


    setInterval(

      async() => {

        try{

          await putForm(

            '/fapi/v1/listenKey',

            {

              listenKey:
                key

            }

          );

        }catch(e){

          log(

            'USER_WS_KEEPALIVE_ERROR',

            {

              error:
                e.message

            }

          );

        }

      },

      30 *
      60 *
      1000

    );

  }catch(e){

    log(

      'USER_WS_START_ERROR',

      {

        error:
          e.message

      }

    );

  }

}


/*
 * ============================================================
 * Init
 * ============================================================
 */

async function init(){

  /*
   * Demo/Testnet 账户接口不可用时，
   * 不再让整个本地服务退出。
   *
   * Funding / 行情诊断仍然可以运行。
   */

  try{

    await loadExchangeInfo();

    log(
      'EXCHANGE_INFO_READY'
    );

  }catch(e){

    log(

      'EXCHANGE_INFO_ERROR',

      {

        error:
          e.message

      }

    );

  }


  try{

    await syncAccount();

    log(
      'ACCOUNT_READY'
    );

  }catch(e){

    state.account =
      null;

    state.positions =
      [];


    log(

      'ACCOUNT_ERROR',

      {

        error:
          e.message

      }

    );

  }


  log(

    'READY',

    {

      base:
        BASE,

      publicBase:
        PUBLIC_BASE,

      autoTrade:
        AUTO_TRADE,

      symbols:
        SYMBOLS

    }

  );


  startUserStream();


  setInterval(

    runCycle,

    20000

  );


  try{

    await runCycle();

  }catch(e){

    log(

      'FIRST_CYCLE_ERROR',

      {

        error:
          e.message

      }

    );

  }

}


/*
 * ============================================================
 * JSON Response
 * ============================================================
 */

function json(

  res,

  status,

  data

){

  res.writeHead(

    status,

    {

      'Content-Type':
        'application/json; charset=utf-8',

      'Access-Control-Allow-Origin':
        '*'

    }

  );


  res.end(
    JSON.stringify(
      data
    )
  );

}


/*
 * ============================================================
 * Router
 * ============================================================
 */

async function route(

  req,

  res

){

  const u =
    new URL(

      req.url,

      'http://127.0.0.1'

    );


  try{

    /*
     * Health
     */

    if(

      u.pathname ===
      '/api/health'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          version:
            '3.7.18.10',

          autoTrade:
            AUTO_TRADE,

          base:
            BASE

        }

      );

    }


    /*
     * Demo Ping
     */

    if(

      u.pathname ===
      '/api/demo/ping'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            await api(

              'GET',

              '/fapi/v1/ping'

            )

        }

      );

    }


    /*
     * Demo Account
     */

    if(

      u.pathname ===
      '/api/demo/account'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          data:
            await syncAccount()

        }

      );

    }


    /*
     * Demo Open Orders
     */

    if(

      u.pathname ===
      '/api/demo/openOrders'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            await api(

              'GET',

              '/fapi/v1/openOrders',

              {

                symbol:

                  u.searchParams.get(
                    'symbol'
                  ) ||

                  undefined

              },

              true

            )

        }

      );

    }


    /*
     * Funding
     *
     * 三个入口全部指向同一个
     * Public Data Funding Archive。
     */

    if(

      u.pathname ===
      '/api/funding' ||

      u.pathname ===
      '/api/funding-rate' ||

      u.pathname ===
      '/api/market/funding'

    ){

      return await handleFunding(

        req,

        res,

        u

      );

    }


    /*
     * Historical Market
     */

    if(

      u.pathname ===
      '/api/market'

    ){

      return await handleMarket(

        req,

        res,

        u

      );

    }


    /*
     * Live Klines
     */

    if(

      u.pathname ===
      '/api/live/klines'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            await getKlines(

              u.searchParams.get(
                'symbol'
              ),

              u.searchParams.get(
                'interval'
              ) ||

              '15m',

              Math.min(

                500,

                Number(

                  u.searchParams.get(
                    'limit'
                  ) ||

                  200

                )

              )

            )

        }

      );

    }


    /*
     * Exchange Info
     */

    if(

      u.pathname ===
      '/api/demo/exchangeInfo'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            state.exchangeInfo ||

            await loadExchangeInfo()

        }

      );

    }


    /*
     * State
     */

    if(

      u.pathname ===
      '/api/state'

    ){

      return json(

        res,

        200,

        {

          ok:
            true,

          state:{

            ...state,

            exchangeInfo:
              undefined

          }

        }

      );

    }


    /*
     * Demo Order
     */

    if(

      u.pathname ===
      '/api/demo/order' &&

      req.method ===
      'POST'

    ){

      let b =
        '';


      for await(
        const c of req
      ){

        b += c;

      }


      const p =
        JSON.parse(
          b || '{}'
        );


      if(

        !p.symbol ||

        !p.side

      ){

        throw new Error(
          'symbol/side required'
        );

      }


      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            await postForm(

              '/fapi/v1/order',

              p,

              true

            )

        }

      );

    }


    /*
     * Demo Cancel
     */

    if(

      u.pathname ===
      '/api/demo/cancel' &&

      req.method ===
      'POST'

    ){

      let b =
        '';


      for await(
        const c of req
      ){

        b += c;

      }


      const p =
        JSON.parse(
          b || '{}'
        );


      return json(

        res,

        200,

        {

          ok:
            true,

          data:

            await api(

              'DELETE',

              '/fapi/v1/order',

              p,

              true

            )

        }

      );

    }


    /*
     * Frontend
     */

    if(
      u.pathname === '/'
    ){

      return sendFile(

        res,

        path.join(

          __dirname,

          'Quant_V3.7.18.10.html'

        ),

        'text/html; charset=utf-8'

      );

    }


    /*
     * README
     */

    if(

      u.pathname ===
      '/README.md'

    ){

      return sendFile(

        res,

        path.join(
          __dirname,
          'README.md'
        ),

        'text/plain; charset=utf-8'

      );

    }


    return json(

      res,

      404,

      {

        ok:
          false,

        error:
          'not found'

      }

    );

  }catch(e){

    return json(

      res,

      500,

      {

        ok:
          false,

        error:
          e.message

      }

    );

  }

}


/*
 * ============================================================
 * Send File
 * ============================================================
 */

function sendFile(

  res,

  p,

  type

){

  try{

    const b =
      fs.readFileSync(
        p
      );


    res.writeHead(

      200,

      {

        'Content-Type':
          type

      }

    );


    res.end(
      b
    );

  }catch(e){

    res.writeHead(
      404
    );


    res.end(
      'not found'
    );

  }

}


/*
 * ============================================================
 * HTTP Server
 * ============================================================
 */

http

  .createServer(
    route
  )

  .listen(

    PORT,

    () => {

      log(

        'HTTP_READY',

        {

          url:
            `http://127.0.0.1:${PORT}`,

          autoTrade:
            AUTO_TRADE

        }

      );

    }

  );


/*
 * ============================================================
 * Start
 * ============================================================
 */

init()

  .catch(

    e => {

      log(

        'INIT_FATAL',

        {

          error:
            e.message

        }

      );


      process.exitCode =
        1;

    }

  );
