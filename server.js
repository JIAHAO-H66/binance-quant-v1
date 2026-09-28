const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V3.7.6 · OOS 数据服务器
 *
 * Binance USD-M Futures
 *
 * K线数据：
 * Binance Public Data
 *
 * Funding：
 * Binance USD-M Futures
 * /fapi/v1/fundingRate
 *
 * ============================================================
 */


/*
 * ============================================================
 * Server Version
 * ============================================================
 */

const SERVER_VERSION =
  "V3.7.6";


/*
 * ============================================================
 * Binance 数据源
 * ============================================================
 */

const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * ============================================================
 * Binance Funding API
 * ============================================================
 */

const BINANCE_FUNDING_BASE =
  "https://fapi.binance.com";


/*
 * ============================================================
 * 固定 OOS
 * ============================================================
 */

const DEFAULT_OOS_START =
  Date.parse(
    "2026-09-01T00:00:00.000Z"
  );


const DEFAULT_OOS_END =
  Date.parse(
    "2026-09-26T00:00:00.000Z"
  );


/*
 * ============================================================
 * Warmup
 * ============================================================
 */

const DEFAULT_WARMUP_START =
  Date.parse(
    "2026-07-01T00:00:00.000Z"
  );


/*
 * ============================================================
 * 下载控制
 * ============================================================
 */

const DOWNLOAD_CONCURRENCY =
  4;


const DOWNLOAD_TIMEOUT =
  45 * 1000;


const MAX_RETRIES =
  2;


const RETRY_BASE_DELAY =
  1500;


/*
 * ============================================================
 * Funding 控制
 * ============================================================
 */

const FUNDING_TIMEOUT =
  30 * 1000;


const FUNDING_LIMIT =
  1000;


/*
 * ============================================================
 * 下载队列
 * ============================================================
 */

let activeDownloads =
  0;


const downloadQueue =
  [];


/*
 * ============================================================
 * Cache
 * ============================================================
 */

const zipCache =
  new Map();


const historicalCache =
  new Map();


const marketRequestCache =
  new Map();


const fundingCache =
  new Map();


const fundingRequestCache =
  new Map();


const progressState =
  new Map();


/*
 * ============================================================
 * 下载统计
 * ============================================================
 */

const downloadStats = {

  totalRequested:
    0,

  queueAdded:
    0,

  cacheHits:
    0,

  promiseHits:
    0,

  completed:
    0,

  notFound:
    0,

  failed:
    0,

  retried:
    0

};


/*
 * ============================================================
 * 时间
 * ============================================================
 */

function nowIso(){

  return new Date()
    .toISOString();

}


/*
 * ============================================================
 * 日期参数
 * ============================================================
 */

function parseDateParam(

  value,

  fallback

){

  if(

    value === undefined ||

    value === null ||

    value === ""

  ){

    return fallback;

  }


  const n =
    Number(value);


  if(
    Number.isFinite(n)
  ){

    return n < 1e12
      ? n * 1000
      : n;

  }


  const t =
    Date.parse(
      String(value)
    );


  return Number.isFinite(t)
    ? t
    : NaN;

}


/*
 * ============================================================
 * UTC 月初
 * ============================================================
 */

function floorUtcMonth(
  timestamp
){

  const date =
    new Date(timestamp);


  return Date.UTC(

    date.getUTCFullYear(),

    date.getUTCMonth(),

    1

  );

}


/*
 * ============================================================
 * UTC 月份增加
 * ============================================================
 */

function addUtcMonths(

  timestamp,

  delta

){

  const date =
    new Date(timestamp);


  return Date.UTC(

    date.getUTCFullYear(),

    date.getUTCMonth() + delta,

    1

  );

}


/*
 * ============================================================
 * 月份范围
 * ============================================================
 */

function monthRange(

  startMs,

  endMs

){

  const start =
    floorUtcMonth(
      startMs
    );


  const last =
    floorUtcMonth(

      Math.max(

        startMs,

        endMs - 1

      )

    );


  const out = [];


  for(

    let t = start;

    t <= last;

    t =
      addUtcMonths(
        t,
        1
      )

  ){

    const date =
      new Date(t);


    out.push({

      start:
        t,

      end:
        addUtcMonths(
          t,
          1
        ),

      year:
        date.getUTCFullYear(),

      month:
        String(

          date.getUTCMonth() + 1

        ).padStart(

          2,

          "0"

        )

    });

  }


  return out;

}


/*
 * ============================================================
 * 日期范围
 * ============================================================
 */

function dayRange(

  startMs,

  endMs

){

  const out = [];


  const DAY =
    86400000;


  const date =
    new Date(
      startMs
    );


  let t =
    Date.UTC(

      date.getUTCFullYear(),

      date.getUTCMonth(),

      date.getUTCDate()

    );


  while(
    t < endMs
  ){

    const x =
      new Date(t);


    out.push({

      start:
        t,

      end:
        t + DAY,

      year:
        x.getUTCFullYear(),

      month:
        String(

          x.getUTCMonth() + 1

        ).padStart(

          2,

          "0"

        ),

      day:
        String(

          x.getUTCDate()

        ).padStart(

          2,

          "0"

        )

    });


    t += DAY;

  }


  return out;

}


/*
 * ============================================================
 * Resolve Range
 * ============================================================
 */

function resolveRange(req){

  const oosStart =
    parseDateParam(

      req.query.backtestStart ??
      req.query.start,

      DEFAULT_OOS_START

    );


  const oosEnd =
    parseDateParam(

      req.query.backtestEnd ??
      req.query.end,

      DEFAULT_OOS_END

    );


  let warmupStart =
    parseDateParam(

      req.query.warmupStart,

      DEFAULT_WARMUP_START

    );


  if(

    !Number.isFinite(oosStart) ||

    !Number.isFinite(oosEnd) ||

    oosEnd <= oosStart

  ){

    throw new Error(

      "日期范围错误：backtestStart/backtestEnd 无效。"

    );

  }


  if(
    !Number.isFinite(warmupStart)
  ){

    warmupStart =
      oosStart -
      62 *
      86400000;

  }


  if(
    warmupStart >= oosStart
  ){

    throw new Error(

      "日期范围错误：warmupStart 必须早于 backtestStart。"

    );

  }


  return {

    warmupStart,

    oosStart,

    oosEnd

  };

}


/*
 * ============================================================
 * Monthly URL
 * ============================================================
 */

function buildMonthlyUrl(

  symbol,

  interval,

  year,

  month

){

  return (

    `${BINANCE_DATA_BASE}` +

    `/data/futures/um/monthly/klines/` +

    `${symbol}/` +

    `${interval}/` +

    `${symbol}-${interval}-${year}-${month}.zip`

  );

}


/*
 * ============================================================
 * Daily URL
 * ============================================================
 */

function buildDailyUrl(

  symbol,

  interval,

  year,

  month,

  day

){

  return (

    `${BINANCE_DATA_BASE}` +

    `/data/futures/um/daily/klines/` +

    `${symbol}/` +

    `${interval}/` +

    `${symbol}-${interval}-${year}-${month}-${day}.zip`

  );

}


/*
 * ============================================================
 * 下载队列
 * ============================================================
 */

function processDownloadQueue(){

  while(

    activeDownloads <
      DOWNLOAD_CONCURRENCY &&

    downloadQueue.length

  ){

    const job =
      downloadQueue.shift();


    activeDownloads++;


    Promise.resolve()

      .then(
        job.task
      )

      .then(
        job.resolve
      )

      .catch(
        job.reject
      )

      .finally(

        () => {

          activeDownloads--;

          processDownloadQueue();

        }

      );

  }

}


/*
 * ============================================================
 * 加入下载队列
 * ============================================================
 */

function enqueueDownload(
  task
){

  return new Promise(

    (resolve, reject) => {

      downloadStats.queueAdded++;


      downloadQueue.push({

        task,

        resolve,

        reject

      });


      processDownloadQueue();

    }

  );

}


/*
 * ============================================================
 * Sleep
 * ============================================================
 */

function sleep(
  ms
){

  return new Promise(

    resolve =>

      setTimeout(

        resolve,

        ms

      )

  );

}


/*
 * ============================================================
 * CSV Parser
 * ============================================================
 */

function parseCsv(text){

  if(

    typeof text !== "string" ||

    !text.trim()

  ){

    return [];

  }


  const result = [];


  for(

    const line
    of text.trim().split(/\r?\n/)

  ){

    if(
      !line.trim()
    ){

      continue;

    }


    const row =
      line.split(",");


    let openTime =
      Number(
        row[0]
      );


    if(
      !Number.isFinite(openTime)
    ){

      continue;

    }


    if(
      openTime > 1e15
    ){

      openTime =
        Math.floor(
          openTime / 1000
        );

    }


    const open =
      Number(
        row[1]
      );


    const high =
      Number(
        row[2]
      );


    const low =
      Number(
        row[3]
      );


    const close =
      Number(
        row[4]
      );


    const volume =
      Number(
        row[5]
      );


    let closeTime =
      Number(
        row[6]
      );


    if(
      closeTime > 1e15
    ){

      closeTime =
        Math.floor(
          closeTime / 1000
        );

    }


    if(

      ![

        open,

        high,

        low,

        close,

        volume,

        closeTime

      ].every(
        Number.isFinite
      )

    ){

      continue;

    }


    if(

      open <= 0 ||

      high <= 0 ||

      low <= 0 ||

      close <= 0 ||

      high < low

    ){

      continue;

    }


    if(

      open < low ||

      open > high ||

      close < low ||

      close > high

    ){

      continue;

    }


    result.push({

      openTime,

      open,

      high,

      low,

      close,

      volume,

      closeTime

    });

  }


  return result;

}


/*
 * ============================================================
 * ZIP 解压
 * ============================================================
 */

function extractZipCsv(
  buffer
){

  if(

    !Buffer.isBuffer(buffer) ||

    !buffer.length

  ){

    throw new Error(
      "ZIP 数据为空或无效"
    );

  }


  const zip =
    new AdmZip(
      buffer
    );


  const entry =
    zip
      .getEntries()
      .find(

        e =>

          !e.isDirectory &&

          e.entryName
            .toLowerCase()
            .endsWith(".csv")

      );


  if(
    !entry
  ){

    throw new Error(
      "ZIP 中没有 CSV 文件"
    );

  }


  return parseCsv(

    entry
      .getData()
      .toString("utf8")

  );

}


/*
 * ============================================================
 * ZIP 下载
 * ============================================================
 */

function downloadZip(

  url,

  description

){

  downloadStats.totalRequested++;


  const cached =
    zipCache.get(
      url
    );


  if(
    cached
  ){

    if(
      typeof cached.then ===
      "function"
    ){

      downloadStats.promiseHits++;


      return cached;

    }


    downloadStats.cacheHits++;


    return Promise.resolve(
      cached
    );

  }


  const promise =
    enqueueDownload(

      async() => {

        let lastError =
          null;


        for(

          let attempt = 0;

          attempt <= MAX_RETRIES;

          attempt++

        ){

          let timeoutId =
            null;


          try{

            const controller =
              new AbortController();


            timeoutId =
              setTimeout(

                () =>

                  controller.abort(),

                DOWNLOAD_TIMEOUT

              );


            const response =
              await fetch(

                url,

                {

                  signal:
                    controller.signal,

                  headers:{

                    "User-Agent":
                      "Quant-V3.7.6"

                  }

                }

              );


            clearTimeout(
              timeoutId
            );


            timeoutId =
              null;


            if(
              response.status === 404
            ){

              downloadStats.notFound++;


              return [];

            }


            if(

              response.status === 429 ||

              response.status >= 500 ||

              !response.ok

            ){

              throw new Error(

                `HTTP ${response.status}`

              );

            }


            const buffer =
              Buffer.from(

                await response
                  .arrayBuffer()

              );


            const rows =
              extractZipCsv(
                buffer
              );


            downloadStats.completed++;


            console.log(

              `[DOWNLOAD OK] ${description} candles=${rows.length}`

            );


            return rows;

          }catch(error){

            if(
              timeoutId
            ){

              clearTimeout(
                timeoutId
              );

            }


            lastError =
              error;


            if(
              attempt >= MAX_RETRIES
            ){

              break;

            }


            downloadStats.retried++;


            await sleep(

              RETRY_BASE_DELAY *

              Math.pow(
                2,
                attempt
              )

            );

          }

        }


        downloadStats.failed++;


        throw new Error(

          `${description} 下载失败：` +

          `${lastError?.message || "未知错误"}`

        );

      }

    );


  zipCache.set(

    url,

    promise

  );


  promise

    .then(

      rows => {

        zipCache.set(

          url,

          rows

        );

      }

    )

    .catch(

      () => {

        zipCache.delete(
          url
        );

      }

    );


  return promise;

}


/*
 * ============================================================
 * Monthly
 * ============================================================
 */

function downloadMonthly(

  symbol,

  interval,

  year,

  month

){

  return downloadZip(

    buildMonthlyUrl(

      symbol,

      interval,

      year,

      month

    ),

    `${symbol} ${interval} ${year}-${month} Monthly`

  );

}


/*
 * ============================================================
 * Daily
 * ============================================================
 */

function downloadDaily(

  symbol,

  interval,

  year,

  month,

  day

){

  return downloadZip(

    buildDailyUrl(

      symbol,

      interval,

      year,

      month,

      day

    ),

    `${symbol} ${interval} ${year}-${month}-${day} Daily`

  );

}


/*
 * ============================================================
 * K线去重
 * ============================================================
 */

function deduplicateKlines(
  data
){

  const map =
    new Map();


  for(
    const row
    of data
  ){

    if(
      !map.has(
        row.openTime
      )
    ){

      map.set(

        row.openTime,

        row

      );

    }

  }


  return Array.from(
    map.values()
  )
  .sort(

    (a,b) =>

      a.openTime -
      b.openTime

  );

}


/*
 * ============================================================
 * 判断月份是否完成
 * ============================================================
 */

function isCompletedMonth(
  month
){

  return (

    month.end <=

    floorUtcMonth(
      Date.now()
    )

  );

}


/*
 * ============================================================
 * Progress
 * ============================================================
 */

function createProgress(

  symbol,

  interval

){

  const key =
    `${symbol}:${interval}`;


  const p = {

    key,

    symbol,

    interval,

    status:
      "starting",

    startedAt:
      nowIso(),

    finishedAt:
      null,

    monthlyTotal:
      0,

    monthlyDone:
      0,

    dailyTotal:
      0,

    dailyDone:
      0,

    candles:
      0,

    error:
      null

  };


  progressState.set(
    key,
    p
  );


  return p;

}


function getProgress(

  symbol,

  interval

){

  return (

    progressState.get(

      `${symbol}:${interval}`

    ) || null

  );

}


/*
 * ============================================================
 * Historical Klines
 * ============================================================
 */

async function fetchHistoricalKlines(

  symbol,

  interval,

  range

){

  const {

    warmupStart,

    oosStart,

    oosEnd

  } =
    range;


  const cacheKey =

    `${SERVER_VERSION}:` +

    `${symbol}:` +

    `${interval}:` +

    `${warmupStart}:` +

    `${oosStart}:` +

    `${oosEnd}`;


  const cached =
    historicalCache.get(
      cacheKey
    );


  if(
    cached
  ){

    return cached;

  }


  const progress =
    createProgress(

      symbol,

      interval

    );


  const promise =
    (async() => {

      try{

        progress.status =
          "loading";


        const months =
          monthRange(

            warmupStart,

            oosEnd

          );


        let all = [];


        /*
         * 统计任务
         */

        for(
          const month
          of months
        ){

          const monthStart =
            Math.max(

              warmupStart,

              month.start

            );


          const monthEnd =
            Math.min(

              oosEnd,

              month.end

            );


          if(
            monthStart >= monthEnd
          ){

            continue;

          }


          if(

            isCompletedMonth(
              month
            ) &&

            monthStart ===
              month.start &&

            monthEnd ===
              month.end

          ){

            progress.monthlyTotal++;

          }else{

            progress.dailyTotal +=

              dayRange(

                monthStart,

                monthEnd

              ).length;

          }

        }


        /*
         * 下载
         */

        for(
          const month
          of months
        ){

          const monthStart =
            Math.max(

              warmupStart,

              month.start

            );


          const monthEnd =
            Math.min(

              oosEnd,

              month.end

            );


          if(
            monthStart >= monthEnd
          ){

            continue;

          }


          if(

            isCompletedMonth(
              month
            ) &&

            monthStart ===
              month.start &&

            monthEnd ===
              month.end

          ){

            const rows =
              await downloadMonthly(

                symbol,

                interval,

                month.year,

                month.month

              );


            progress.monthlyDone++;


            all.push(
              ...rows
            );

          }else{

            const jobs =

              dayRange(

                monthStart,

                monthEnd

              ).map(

                day =>

                  downloadDaily(

                    symbol,

                    interval,

                    day.year,

                    day.month,

                    day.day

                  )

                  .then(

                    rows => {

                      progress.dailyDone++;


                      return rows;

                    }

                  )

              );


            const daily =
              await Promise.all(
                jobs
              );


            for(
              const rows
              of daily
            ){

              all.push(
                ...rows
              );

            }

          }

        }


        const unique =
          deduplicateKlines(
            all
          );


        const result =
          unique.filter(

            row =>

              row.openTime >=
                warmupStart &&

              row.openTime <
                oosEnd

          );


        if(
          !result.length
        ){

          throw new Error(

            `${symbol} ${interval}：指定时间范围没有历史K线`

          );

        }


        const oosRows =
          result.filter(

            row =>

              row.openTime >=
                oosStart &&

              row.openTime <
                oosEnd

          );


        if(
          !oosRows.length
        ){

          throw new Error(

            `${symbol} ${interval}：OOS 区间没有数据`

          );

        }


        progress.candles =
          result.length;


        progress.status =
          "ready";


        progress.finishedAt =
          nowIso();


        return result;

      }catch(error){

        progress.status =
          "error";


        progress.error =
          error.message;


        progress.finishedAt =
          nowIso();


        throw error;

      }

    })();


  historicalCache.set(

    cacheKey,

    promise

  );


  promise.catch(

    () => {

      historicalCache.delete(
        cacheKey
      );

    }

  );


  return promise;

}


/*
 * ============================================================
 * Meta
 * ============================================================
 */

function getMeta(
  range
){

  return {

    version:
      SERVER_VERSION,

    oos:
      true,

    source:
      "Binance USD-M Futures Public Data",

    dataMode:
      "Monthly archive + Daily archive",

    dataStart:
      range.warmupStart,

    backtestStart:
      range.oosStart,

    backtestEnd:
      range.oosEnd,

    dataStartISO:
      new Date(
        range.warmupStart
      ).toISOString(),

    backtestStartISO:
      new Date(
        range.oosStart
      ).toISOString(),

    backtestEndISO:
      new Date(
        range.oosEnd
      ).toISOString(),

    intervals:[

      "4h",

      "1h",

      "15m"

    ],

    downloadConcurrency:
      DOWNLOAD_CONCURRENCY,

    downloadTimeoutMs:
      DOWNLOAD_TIMEOUT,

    maxRetries:
      MAX_RETRIES,

    zipCacheSize:
      zipCache.size,

    historicalCacheSize:
      historicalCache.size,

    marketRequestCacheSize:
      marketRequestCache.size,

    fundingCacheSize:
      fundingCache.size,

    fundingRequestCacheSize:
      fundingRequestCache.size

  };

}


/*
 * ============================================================
 * Market Request
 * ============================================================
 */

async function executeMarketRequest(

  symbol,

  range

){

  const requestKey =

    `${SERVER_VERSION}:` +

    `${symbol}:` +

    `${range.warmupStart}:` +

    `${range.oosStart}:` +

    `${range.oosEnd}`;


  const existing =
    marketRequestCache.get(
      requestKey
    );


  if(
    existing
  ){

    return existing;

  }


  const promise =
    (async() => {

      const [

        data4h,

        data1h,

        data15m

      ] =

        await Promise.all([

          fetchHistoricalKlines(

            symbol,

            "4h",

            range

          ),

          fetchHistoricalKlines(

            symbol,

            "1h",

            range

          ),

          fetchHistoricalKlines(

            symbol,

            "15m",

            range

          )

        ]);


      for(

        const [

          name,

          data

        ]

        of [

          [
            "4h",
            data4h
          ],

          [
            "1h",
            data1h
          ],

          [
            "15m",
            data15m
          ]

        ]

      ){

        const oosRows =
          data.filter(

            row =>

              row.openTime >=
                range.oosStart &&

              row.openTime <
                range.oosEnd

          );


        if(
          !oosRows.length
        ){

          throw new Error(

            `${symbol} ${name}：OOS 区间没有数据`

          );

        }

      }


      return {

        data4h,

        data1h,

        data15m

      };

    })();


  marketRequestCache.set(

    requestKey,

    promise

  );


  promise.catch(

    () => {

      marketRequestCache.delete(
        requestKey
      );

    }

  );


  return promise;

}


/*
 * ============================================================
 * Funding Rate
 *
 * Binance USD-M Futures
 *
 * /fapi/v1/fundingRate
 * ============================================================
 */

async function fetchFundingPage({

  symbol,

  startTime,

  endTime,

  limit = FUNDING_LIMIT

}){

  const url =
    new URL(

      "/fapi/v1/fundingRate",

      BINANCE_FUNDING_BASE

    );


  url.searchParams.set(

    "symbol",

    symbol

  );


  url.searchParams.set(

    "startTime",

    String(
      startTime
    )

  );


  url.searchParams.set(

    "endTime",

    String(
      endTime
    )

  );


  url.searchParams.set(

    "limit",

    String(

      Math.min(

        limit,

        FUNDING_LIMIT

      )

    )

  );


  const controller =
    new AbortController();


  const timeoutId =
    setTimeout(

      () =>

        controller.abort(),

      FUNDING_TIMEOUT

    );


  try{

    const response =
      await fetch(

        url,

        {

          signal:
            controller.signal,

          headers:{

            "User-Agent":
              "Quant-V3.7.6",

            "Accept":
              "application/json"

          }

        }

      );


    const text =
      await response.text();


    const contentType =
      response.headers.get(

        "content-type"

      ) || "";


    if(
      !response.ok
    ){

      throw new Error(

        `Funding API HTTP ${response.status}: ` +

        `${text.slice(0,300)}`

      );

    }


    let json;


    try{

      json =
        JSON.parse(
          text
        );

    }catch(error){

      throw new Error(

        "Funding API 返回的不是 JSON：" +

        `content-type=${contentType}; ` +

        `body=${text.slice(0,300)}`

      );

    }


    if(
      !Array.isArray(json)
    ){

      throw new Error(

        "Funding API 返回结构不是数组"

      );

    }


    return {

      url:
        url.toString(),

      status:
        response.status,

      contentType,

      bytes:
        Buffer.byteLength(

          text,

          "utf8"

        ),

      rows:
        json

    };

  }finally{

    clearTimeout(
      timeoutId
    );

  }

}


/*
 * ============================================================
 * Funding History
 *
 * 自动分页。
 * ============================================================
 */

async function fetchFundingHistory({

  symbol,

  startTime,

  endTime

}){

  const cacheKey =

    `${SERVER_VERSION}:funding:` +

    `${symbol}:` +

    `${startTime}:` +

    `${endTime}`;


  const cached =
    fundingCache.get(
      cacheKey
    );


  if(
    cached
  ){

    return cached;

  }


  const existing =
    fundingRequestCache.get(
      cacheKey
    );


  if(
    existing
  ){

    return existing;

  }


  const promise =
    (async() => {

      const all = [];


      let cursor =
        startTime;


      let requestCount =
        0;


      let lastFundingTime =
        null;


      while(
        cursor <= endTime
      ){

        requestCount++;


        const page =
          await fetchFundingPage({

            symbol,

            startTime:
              cursor,

            endTime,

            limit:
              FUNDING_LIMIT

          });


        const rows =
          page.rows

            .filter(

              row =>

                row &&

                row.symbol ===
                  symbol &&

                Number.isFinite(

                  Number(
                    row.fundingTime
                  )

                ) &&

                Number.isFinite(

                  Number(
                    row.fundingRate
                  )

                )

            )

            .sort(

              (a,b) =>

                Number(
                  a.fundingTime
                ) -

                Number(
                  b.fundingTime
                )

            );


        for(
          const row
          of rows
        ){

          const fundingTime =
            Number(
              row.fundingTime
            );


          if(

            fundingTime >=
              startTime &&

            fundingTime <=
              endTime

          ){

            all.push({

              symbol:
                row.symbol,

              fundingRate:
                Number(
                  row.fundingRate
                ),

              fundingTime,

              markPrice:

                Number.isFinite(

                  Number(
                    row.markPrice
                  )

                )

                  ?

                Number(
                  row.markPrice
                )

                  :

                null,

              rateType:
                row.rateType ||
                "Regular"

            });

          }

        }


        if(
          !rows.length
        ){

          break;

        }


        const pageLastTime =
          Number(

            rows[
              rows.length - 1
            ].fundingTime

          );


        if(

          lastFundingTime !== null &&

          pageLastTime <=
            lastFundingTime

        ){

          break;

        }


        lastFundingTime =
          pageLastTime;


        if(
          pageLastTime >= endTime
        ){

          break;

        }


        cursor =
          pageLastTime + 1;


        if(
          rows.length <
          FUNDING_LIMIT
        ){

          break;

        }


        if(
          requestCount > 100
        ){

          throw new Error(

            "Funding API 分页超过 100 次，已停止"

          );

        }

      }


      const map =
        new Map();


      for(
        const row
        of all
      ){

        map.set(

          `${row.symbol}:${row.fundingTime}`,

          row

        );

      }


      const rows =
        Array.from(
          map.values()
        )
        .sort(

          (a,b) =>

            a.fundingTime -
            b.fundingTime

        );


      const output = {

        symbol,

        startTime,

        endTime,

        startTimeISO:
          new Date(
            startTime
          ).toISOString(),

        endTimeISO:
          new Date(
            endTime
          ).toISOString(),

        rows,

        count:
          rows.length,

        requestCount,

        source:
          `${BINANCE_FUNDING_BASE}/fapi/v1/fundingRate`

      };


      fundingCache.set(

        cacheKey,

        output

      );


      return output;

    })();


  fundingRequestCache.set(

    cacheKey,

    promise

  );


  promise.catch(

    () => {

      fundingRequestCache.delete(
        cacheKey
      );

    }

  );


  return promise;

}


/*
 * ============================================================
 * /api/market
 * ============================================================
 */

app.get(

  "/api/market",

  async(

    req,

    res

  ) => {

    try{

      const symbol =
        String(

          req.query.symbol ||
          ""

        ).toUpperCase();


      if(

        !/^[A-Z0-9]{5,20}$/.test(
          symbol
        )

      ){

        return res

          .status(400)

          .json({

            ok:false,

            version:
              SERVER_VERSION,

            error:
              "symbol 参数错误"

          });

      }


      const range =
        resolveRange(
          req
        );


      const {

        data4h,

        data1h,

        data15m

      } =

        await executeMarketRequest(

          symbol,

          range

        );


      return res.json({

        ok:true,

        version:
          SERVER_VERSION,

        symbol,

        meta:
          getMeta(
            range
          ),

        data:{

          "4h":
            data4h,

          "1h":
            data1h,

          "15m":
            data15m

        }

      });

    }catch(error){

      console.error(

        `${SERVER_VERSION} Market error:`,

        error

      );


      return res

        .status(500)

        .json({

          ok:false,

          version:
            SERVER_VERSION,

          error:

            error.message ||

            "获取历史行情失败"

        });

    }

  }

);


/*
 * ============================================================
 * /api/funding
 *
 * 这里必须在 SPA fallback 前面。
 * ============================================================
 */

app.get(

  "/api/funding",

  async(

    req,

    res

  ) => {

    try{

      const symbol =
        String(

          req.query.symbol ||
          ""

        ).toUpperCase();


      if(

        !/^[A-Z0-9]{5,20}$/.test(
          symbol
        )

      ){

        return res

          .status(400)

          .json({

            ok:false,

            version:
              SERVER_VERSION,

            error:
              "symbol 参数错误"

          });

      }


      const range =
        resolveRange(
          req
        );


      const result =
        await fetchFundingHistory({

          symbol,

          startTime:
            range.oosStart,

          endTime:
            range.oosEnd

        });


      return res.json({

        ok:true,

        version:
          SERVER_VERSION,

        symbol,

        source:
          result.source,

        startTime:
          result.startTime,

        endTime:
          result.endTime,

        startTimeISO:
          result.startTimeISO,

        endTimeISO:
          result.endTimeISO,

        count:
          result.count,

        requestCount:
          result.requestCount,

        data:
          result.rows,

        funding:
          result.rows

      });

    }catch(error){

      console.error(

        "[FUNDING ERROR]",

        error

      );


      return res

        .status(502)

        .json({

          ok:false,

          version:
            SERVER_VERSION,

          error:

            error.message ||

            "Funding API 获取失败"

        });

    }

  }

);


/*
 * ============================================================
 * /api/funding/cache/clear
 * ============================================================
 */

app.get(

  "/api/funding/cache/clear",

  (

    req,

    res

  ) => {

    fundingCache.clear();

    fundingRequestCache.clear();


    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      message:
        "Funding 缓存已清除"

    });

  }

);


/*
 * ============================================================
 * /api/cache/clear
 * ============================================================
 */

app.get(

  "/api/cache/clear",

  (

    req,

    res

  ) => {

    zipCache.clear();

    historicalCache.clear();

    marketRequestCache.clear();

    fundingCache.clear();

    fundingRequestCache.clear();

    progressState.clear();


    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      message:
        "行情缓存、历史数据缓存、Market 请求缓存、Funding 缓存已清除"

    });

  }

);


/*
 * ============================================================
 * /api/status
 * ============================================================
 */

app.get(

  "/api/status",

  (

    req,

    res

  ) => {

    try{

      const range =
        resolveRange(
          req
        );


      return res.json({

        ok:true,

        version:
          SERVER_VERSION,

        source:
          "Binance USD-M Futures Public Data",

        dataMode:
          "Monthly + Daily",

        market:
          "USD-M Futures",

        ...getMeta(
          range
        ),

        cacheSize:
          historicalCache.size,

        activeDownloads,

        queuedDownloads:
          downloadQueue.length,

        downloadStats,

        serverTime:
          nowIso()

      });

    }catch(error){

      return res

        .status(400)

        .json({

          ok:false,

          version:
            SERVER_VERSION,

          error:
            error.message

        });

    }

  }

);


/*
 * ============================================================
 * /api/debug
 * ============================================================
 */

app.get(

  "/api/debug",

  (

    req,

    res

  ) => {

    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      serverTime:
        nowIso(),

      cache:{

        zipCache:
          zipCache.size,

        historicalCache:
          historicalCache.size,

        marketRequestCache:
          marketRequestCache.size,

        fundingCache:
          fundingCache.size,

        fundingRequestCache:
          fundingRequestCache.size

      },

      downloads:{

        active:
          activeDownloads,

        queued:
          downloadQueue.length,

        concurrency:
          DOWNLOAD_CONCURRENCY,

        timeoutMs:
          DOWNLOAD_TIMEOUT,

        maxRetries:
          MAX_RETRIES

      },

      funding:{

        base:
          BINANCE_FUNDING_BASE,

        timeoutMs:
          FUNDING_TIMEOUT,

        limit:
          FUNDING_LIMIT

      },

      stats:
        downloadStats,

      progress:
        Array.from(
          progressState.values()
        )

    });

  }

);


/*
 * ============================================================
 * /api/progress
 * ============================================================
 */

app.get(

  "/api/progress",

  (

    req,

    res

  ) => {

    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      serverTime:
        nowIso(),

      activeDownloads,

      queuedDownloads:
        downloadQueue.length,

      progress:
        Array.from(
          progressState.values()
        )

    });

  }

);


/*
 * ============================================================
 * /api/health
 * ============================================================
 */

app.get(

  "/api/health",

  (

    req,

    res

  ) => {

    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      serverTime:
        nowIso(),

      uptime:
        process.uptime(),

      memory:
        process.memoryUsage()

    });

  }

);


/*
 * ============================================================
 * SPA fallback
 *
 * 必须最后。
 * ============================================================
 */

app.get(

  /.*/,

  (

    req,

    res

  ) => {

    res.sendFile(

      path.join(

        __dirname,

        "index.html"

      )

    );

  }

);


/*
 * ============================================================
 * Render
 * ============================================================
 */

const PORT =
  process.env.PORT || 3000;


app.listen(

  PORT,

  "0.0.0.0",

  () => {

    console.log(
      "================================================"
    );


    console.log(

      `Quant ${SERVER_VERSION} Server`

    );


    console.log(

      `Server running on port ${PORT}`

    );


    console.log(

      "数据源：Binance Public Data"

    );


    console.log(

      "Funding：Binance USD-M Futures /fapi/v1/fundingRate"

    );


    console.log(

      "市场：Binance USD-M Futures"

    );


    console.log(

      "下载并发：",

      DOWNLOAD_CONCURRENCY

    );


    console.log(

      "下载超时：",

      `${DOWNLOAD_TIMEOUT / 1000}s`

    );


    console.log(

      "最大重试：",

      MAX_RETRIES

    );


    console.log(

      "OOS：",

      new Date(
        DEFAULT_OOS_START
      ).toISOString(),

      "→",

      new Date(
        DEFAULT_OOS_END
      ).toISOString()

    );


    console.log(

      "Warmup：",

      new Date(
        DEFAULT_WARMUP_START
      ).toISOString(),

      "→",

      new Date(
        DEFAULT_OOS_START
      ).toISOString()

    );


    console.log(
      "================================================"
    );

  }

);
