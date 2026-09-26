const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V3.7.5 · OOS 数据服务器
 *
 * Binance USD-M Futures
 *
 * 本版本重点：
 *
 * 1. ZIP 文件级缓存
 * 2. 正在下载的 ZIP Promise 共享
 * 3. 全局下载并发限制
 * 4. 下载超时
 * 5. 自动重试
 * 6. Market 请求 Promise 复用
 * 7. 下载状态监控
 *
 * 数据源：
 *
 *     Binance Public Data
 *     https://data.binance.vision
 *
 * 数据方式：
 *
 *     完整月份 → Monthly ZIP
 *     不完整月份 → Daily ZIP
 *
 * 不使用：
 *
 *     fapi.binance.com
 *
 * ============================================================
 */


/*
 * ============================================================
 * Binance Public Data
 * ============================================================
 */

const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * ============================================================
 * Server Version
 * ============================================================
 */

const SERVER_VERSION =
  "V3.7.5";


/*
 * ============================================================
 * 固定 OOS
 *
 * OOS：
 *
 * 2026-09-01 00:00 UTC
 * →
 * 2026-09-26 00:00 UTC
 *
 * backtestEnd 为排他时间。
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
 *
 * 同时最多 4 个网络下载。
 *
 * ============================================================
 */

const DOWNLOAD_CONCURRENCY =
  4;


/*
 * ============================================================
 * 单个 ZIP 超时时间
 *
 * 45 秒。
 *
 * ============================================================
 */

const DOWNLOAD_TIMEOUT =
  45 * 1000;


/*
 * ============================================================
 * 最大重试次数
 *
 * attempt：
 *
 * 1
 * 2
 * 3
 *
 * ============================================================
 */

const MAX_RETRIES =
  2;


/*
 * ============================================================
 * 重试等待
 * ============================================================
 */

const RETRY_BASE_DELAY =
  1500;


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
 * ZIP 数据缓存
 *
 * key：
 *
 * URL
 *
 * value：
 *
 * Promise 或已经解析好的 rows
 *
 * ============================================================
 */

const zipCache =
  new Map();


/*
 * ============================================================
 * Market 请求缓存
 *
 * 防止用户连续点击回测，
 * 同一个 market 请求被重复执行。
 *
 * ============================================================
 */

const marketRequestCache =
  new Map();


/*
 * ============================================================
 * 历史 K 线缓存
 *
 * ============================================================
 */

const historicalCache =
  new Map();


/*
 * ============================================================
 * 下载统计
 * ============================================================
 */

const downloadStats = {

  totalRequested: 0,

  queueAdded: 0,

  cacheHits: 0,

  promiseHits: 0,

  completed: 0,

  notFound: 0,

  failed: 0,

  retried: 0

};


/*
 * ============================================================
 * 当前数据准备状态
 * ============================================================
 */

const progressState =
  new Map();


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


  const number =
    Number(value);


  if(
    Number.isFinite(number)
  ){

    return number < 1e12
      ? number * 1000
      : number;

  }


  const time =
    Date.parse(
      String(value)
    );


  if(
    Number.isFinite(time)
  ){

    return time;

  }


  return NaN;

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
 * 月份列表
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


  const lastMonth =
    floorUtcMonth(

      Math.max(

        startMs,

        endMs - 1

      )

    );


  const result = [];


  for(

    let timestamp = start;

    timestamp <= lastMonth;

    timestamp =
      addUtcMonths(

        timestamp,

        1

      )

  ){

    const date =
      new Date(timestamp);


    result.push({

      start:
        timestamp,

      end:
        addUtcMonths(

          timestamp,

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


  return result;

}


/*
 * ============================================================
 * 日期列表
 * ============================================================
 */

function dayRange(

  startMs,

  endMs

){

  const result = [];


  const ONE_DAY =
    24 *
    60 *
    60 *
    1000;


  const startDate =
    new Date(
      startMs
    );


  let cursor =
    Date.UTC(

      startDate.getUTCFullYear(),

      startDate.getUTCMonth(),

      startDate.getUTCDate()

    );


  while(
    cursor < endMs
  ){

    const date =
      new Date(cursor);


    result.push({

      start:
        cursor,

      end:
        cursor + ONE_DAY,

      year:
        date.getUTCFullYear(),

      month:
        String(

          date.getUTCMonth() + 1

        ).padStart(

          2,

          "0"

        ),

      day:
        String(

          date.getUTCDate()

        ).padStart(

          2,

          "0"

        )

    });


    cursor +=
      ONE_DAY;

  }


  return result;

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

    !Number.isFinite(
      oosStart
    ) ||

    !Number.isFinite(
      oosEnd
    ) ||

    oosEnd <= oosStart

  ){

    throw new Error(

      "日期范围错误：backtestStart/backtestEnd 无效。"

    );

  }


  if(
    !Number.isFinite(
      warmupStart
    )
  ){

    warmupStart =
      oosStart -
      62 *
      24 *
      60 *
      60 *
      1000;

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
 * 下载队列处理
 * ============================================================
 */

function processDownloadQueue(){

  while(

    activeDownloads <
      DOWNLOAD_CONCURRENCY &&

    downloadQueue.length > 0

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


  const lines =
    text
      .trim()
      .split(/\r?\n/);


  const result = [];


  for(
    const line
    of lines
  ){

    if(

      !line ||

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


    /*
     * CSV Header
     */

    if(
      !Number.isFinite(
        openTime
      )
    ){

      continue;

    }


    /*
     * 兼容微秒时间戳
     */

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

      !Number.isFinite(open) ||

      !Number.isFinite(high) ||

      !Number.isFinite(low) ||

      !Number.isFinite(close) ||

      !Number.isFinite(volume) ||

      !Number.isFinite(closeTime)

    ){

      continue;

    }


    /*
     * 基础合法性
     */

    if(

      open <= 0 ||

      high <= 0 ||

      low <= 0 ||

      close <= 0

    ){

      continue;

    }


    if(
      high < low
    ){

      continue;

    }


    if(
      open < low ||
      open > high
    ){

      continue;

    }


    if(
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
    !Buffer.isBuffer(buffer)
  ){

    throw new Error(
      "ZIP 数据不是有效 Buffer"
    );

  }


  if(
    buffer.length === 0
  ){

    throw new Error(
      "ZIP 数据为空"
    );

  }


  const zip =
    new AdmZip(
      buffer
    );


  const entries =
    zip.getEntries();


  const csvEntry =
    entries.find(

      entry =>

        !entry.isDirectory &&

        entry.entryName
          .toLowerCase()
          .endsWith(".csv")

    );


  if(
    !csvEntry
  ){

    throw new Error(
      "ZIP 中没有 CSV 文件"
    );

  }


  const text =
    csvEntry
      .getData()
      .toString("utf8");


  return parseCsv(
    text
  );

}


/*
 * ============================================================
 * ZIP 下载
 *
 * 这是 V3.7.5 最重要的修改。
 *
 * 同一个 URL：
 *
 * 第一次：
 *
 *     真正下载
 *
 * 第二次：
 *
 *     直接共享第一次 Promise
 *
 * 第三次：
 *
 *     继续共享
 *
 * 不会重复请求 Binance。
 *
 * ============================================================
 */

function downloadZip(

  url,

  description

){

  downloadStats.totalRequested++;


  /*
   * ==========================================================
   * 已完成缓存
   * ==========================================================
   */

  const cached =
    zipCache.get(
      url
    );


  if(
    cached
  ){

    /*
     * 如果是 Promise：
     *
     * 代表正在下载。
     */

    if(
      cached &&
      typeof cached.then === "function"
    ){

      downloadStats.promiseHits++;


      console.log(

        `[ZIP WAIT]`,

        description

      );


      return cached;

    }


    /*
     * 如果是数组：
     *
     * 代表已经下载完成。
     */

    downloadStats.cacheHits++;


    console.log(

      `[ZIP CACHE HIT]`,

      description

    );


    return Promise.resolve(
      cached
    );

  }


  /*
   * ==========================================================
   * 创建真正的下载 Promise
   * ==========================================================
   */

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

          let controller =
            null;


          let timeoutId =
            null;


          try{

            console.log(

              `[DOWNLOAD ${attempt + 1}/${MAX_RETRIES + 1}]`,

              description

            );


            controller =
              new AbortController();


            timeoutId =
              setTimeout(

                () => {

                  controller.abort();

                },

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
                      "Quant-V3.7.5"

                  }

                }

              );


            if(
              timeoutId
            ){

              clearTimeout(
                timeoutId
              );

              timeoutId =
                null;

            }


            /*
             * ==================================================
             * 404
             * ==================================================
             */

            if(
              response.status === 404
            ){

              downloadStats.notFound++;


              console.log(

                `[404]`,

                description

              );


              return [];

            }


            /*
             * ==================================================
             * 429
             *
             * 服务器限流。
             * ==================================================
             */

            if(
              response.status === 429
            ){

              throw new Error(
                "HTTP 429 Too Many Requests"
              );

            }


            /*
             * ==================================================
             * 5xx
             * ==================================================
             */

            if(
              response.status >= 500
            ){

              throw new Error(

                `HTTP ${response.status}`

              );

            }


            if(
              !response.ok
            ){

              throw new Error(

                `HTTP ${response.status}`

              );

            }


            /*
             * ==================================================
             * 下载
             * ==================================================
             */

            const arrayBuffer =
              await response.arrayBuffer();


            const buffer =
              Buffer.from(
                arrayBuffer
              );


            if(
              buffer.length === 0
            ){

              throw new Error(
                "服务器返回空文件"
              );

            }


            /*
             * ==================================================
             * ZIP 解析
             * ==================================================
             */

            const rows =
              extractZipCsv(
                buffer
              );


            console.log(

              `[DOWNLOAD OK]`,

              description,

              `candles=${rows.length}`

            );


            downloadStats.completed++;


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


            let message =
              error?.message ||
              "未知错误";


            if(
              error?.name ===
              "AbortError"
            ){

              message =
                "下载超时";

            }


            console.error(

              `[DOWNLOAD ERROR]`,

              description,

              message

            );


            /*
             * ==================================================
             * 是否重试
             * ==================================================
             */

            if(
              attempt >= MAX_RETRIES
            ){

              break;

            }


            downloadStats.retried++;


            const waitMs =
              RETRY_BASE_DELAY *
              Math.pow(
                2,
                attempt
              );


            console.log(

              `[RETRY]`,

              description,

              `${waitMs}ms`

            );


            await sleep(
              waitMs
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


  /*
   * ==========================================================
   * 立即放入 ZIP Promise Cache
   *
   * 注意：
   *
   * 必须在下载开始之前放进去。
   *
   * 这样其它周期看到同一个 URL，
   * 会直接共享这个 Promise。
   * ==========================================================
   */

  zipCache.set(

    url,

    promise

  );


  /*
   * ==========================================================
   * 下载成功：
   *
   * Promise → rows
   *
   * 下载失败：
   *
   * 删除缓存
   * ==========================================================
   */

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

async function downloadMonthly(

  symbol,

  interval,

  year,

  month

){

  const url =
    buildMonthlyUrl(

      symbol,

      interval,

      year,

      month

    );


  return downloadZip(

    url,

    `${symbol} ${interval} ${year}-${month} Monthly`

  );

}


/*
 * ============================================================
 * Daily
 * ============================================================
 */

async function downloadDaily(

  symbol,

  interval,

  year,

  month,

  day

){

  const url =
    buildDailyUrl(

      symbol,

      interval,

      year,

      month,

      day

    );


  return downloadZip(

    url,

    `${symbol} ${interval} ${year}-${month}-${day} Daily`

  );

}


/*
 * ============================================================
 * 去重
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
  ).sort(

    (a,b) =>

      a.openTime -
      b.openTime

  );

}


/*
 * ============================================================
 * 判断月份是否完整结束
 * ============================================================
 */

function isCompletedMonth(
  month
){

  const currentMonthStart =
    floorUtcMonth(
      Date.now()
    );


  return (
    month.end <=
    currentMonthStart
  );

}


/*
 * ============================================================
 * 创建进度对象
 * ============================================================
 */

function createProgress(

  symbol,

  interval

){

  const key =
    `${symbol}:${interval}`;


  const progress = {

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
    progress
  );


  return progress;

}


/*
 * ============================================================
 * 更新进度
 * ============================================================
 */

function getProgress(

  symbol,

  interval

){

  return progressState.get(

    `${symbol}:${interval}`

  ) || null;

}


/*
 * ============================================================
 * 获取历史 K 线
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


  /*
   * ==========================================================
   * Historical Cache
   * ==========================================================
   */

  const cached =
    historicalCache.get(
      cacheKey
    );


  if(
    cached
  ){

    console.log(

      `[HISTORICAL CACHE HIT]`,

      symbol,

      interval

    );


    return cached;

  }


  /*
   * ==========================================================
   * 创建进度
   * ==========================================================
   */

  const progress =
    createProgress(

      symbol,

      interval

    );


  /*
   * ==========================================================
   * Promise Cache
   * ==========================================================
   */

  const promise =
    (async() => {

      try{

        progress.status =
          "loading";


        console.log(

          `[DATA START]`,

          symbol,

          interval

        );


        const months =
          monthRange(

            warmupStart,

            oosEnd

          );


        let all = [];


        /*
         * ====================================================
         * 先统计任务
         * ====================================================
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
         * ====================================================
         * 开始下载
         * ====================================================
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


          /*
           * ==================================================
           * Monthly
           * ==================================================
           */

          if(

            isCompletedMonth(
              month
            ) &&

            monthStart ===
              month.start &&

            monthEnd ===
              month.end

          ){

            console.log(

              `[MONTHLY]`,

              symbol,

              interval,

              `${month.year}-${month.month}`

            );


            const rows =
              await downloadMonthly(

                symbol,

                interval,

                month.year,

                month.month

              );


            progress.monthlyDone++;


            if(
              rows.length
            ){

              all =
                all.concat(
                  rows
                );

            }


            continue;

          }


          /*
           * ==================================================
           * Daily
           * ==================================================
           */

          console.log(

            `[DAILY]`,

            symbol,

            interval,

            `${month.year}-${month.month}`

          );


          const days =
            dayRange(

              monthStart,

              monthEnd

            );


          /*
           * ==================================================
           * Daily 请求全部进入全局队列。
           *
           * Promise.all 不会造成同时发几十个网络请求，
           * 因为真正 fetch 在 downloadQueue 中。
           * ==================================================
           */

          const jobs =
            days.map(

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


          const dailyData =
            await Promise.all(
              jobs
            );


          for(
            const rows
            of dailyData
          ){

            if(
              rows.length
            ){

              all =
                all.concat(
                  rows
                );

            }

          }

        }


        /*
         * ====================================================
         * 去重
         * ====================================================
         */

        const unique =
          deduplicateKlines(
            all
          );


        /*
         * ====================================================
         * 最终过滤
         * ====================================================
 */

        const result =
          unique.filter(

            row =>

              row.openTime >=
                warmupStart &&

              row.openTime <
                oosEnd

          );


        if(
          result.length === 0
        ){

          throw new Error(

            `${symbol} ${interval}：` +

            `指定时间范围没有历史K线`

          );

        }


        /*
         * ====================================================
         * 第一根 / 最后一根
         * ====================================================
         */

        const first =
          result[0].openTime;


        const last =
          result[
            result.length - 1
          ].openTime;


        progress.candles =
          result.length;


        /*
         * ====================================================
         * OOS 检查
         * ====================================================
         */

        const oosRows =
          result.filter(

            row =>

              row.openTime >=
                oosStart &&

              row.openTime <
                oosEnd

          );


        if(
          oosRows.length === 0
        ){

          throw new Error(

            `${symbol} ${interval}：` +

            `OOS 区间没有数据`

          );

        }


        /*
         * ====================================================
         * 完成
         * ====================================================
         */

        progress.status =
          "ready";


        progress.finishedAt =
          nowIso();


        console.log(

          `[DATA READY]`,

          symbol,

          interval,

          `candles=${result.length}`

        );


        console.log(

          `[DATA RANGE]`,

          symbol,

          interval,

          `${new Date(
            first
          ).toISOString()}`,

          "→",

          `${new Date(
            last
          ).toISOString()}`

        );


        console.log(

          `[OOS READY]`,

          symbol,

          interval,

          `candles=${oosRows.length}`

        );


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


  /*
   * ==========================================================
   * 立即缓存 Promise
   * ==========================================================
   */

  historicalCache.set(

    cacheKey,

    promise

  );


  /*
   * ==========================================================
   * 成功保持缓存
   * 失败删除
   * ==========================================================
   */

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
      marketRequestCache.size

  };

}


/*
 * ============================================================
 * Market Request
 *
 * 这是第二层防重复。
 *
 * 用户连续点击：
 *
 *     第一次点击
 *     ↓
 *     开始准备数据
 *
 *     第二次点击
 *     ↓
 *     直接等待第一次
 *
 *     第三次点击
 *     ↓
 *     仍然等待第一次
 *
 * 不会重新建立整套数据任务。
 *
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

    console.log(

      `[MARKET REQUEST SHARED]`,

      symbol

    );


    return existing;

  }


  const promise =
    (async() => {

      console.log(
        "=============================================="
      );


      console.log(

        `${SERVER_VERSION} Market request:`,

        symbol

      );


      console.log(

        "OOS:",

        new Date(
          range.oosStart
        ).toISOString(),

        "→",

        new Date(
          range.oosEnd
        ).toISOString()

      );


      console.log(

        "Warmup:",

        new Date(
          range.warmupStart
        ).toISOString(),

        "→",

        new Date(
          range.oosStart
        ).toISOString()

      );


      console.log(

        "Download concurrency:",

        DOWNLOAD_CONCURRENCY

      );


      console.log(
        "=============================================="
      );


      /*
       * ======================================================
       * 三周期
       * ======================================================
       */

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


      /*
       * ======================================================
       * 完整性检查
       * ======================================================
       */

      const datasets = [

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

      ];


      for(
        const [
          name,
          data
        ]
        of datasets
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
          oosRows.length === 0
        ){

          throw new Error(

            `${symbol} ${name}：` +

            `OOS ` +

            `${new Date(
              range.oosStart
            ).toISOString()} ` +

            `→ ` +

            `${new Date(
              range.oosEnd
            ).toISOString()} ` +

            `没有数据`

          );

        }


        console.log(

          `[CHECK OK]`,

          symbol,

          name,

          `OOS candles=${oosRows.length}`

        );

      }


      console.log(

        `[MARKET READY]`,

        symbol

      );


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


      /*
       * ======================================================
       * Symbol
       * ======================================================
       */

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
        "=============================================="
      );


      console.error(

        `${SERVER_VERSION} Market error:`,

        error

      );


      console.error(
        "=============================================="
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
 * /api/cache/clear
 *
 * 清除所有缓存。
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


    progressState.clear();


    console.log(

      "=============================================="

    );


    console.log(

      "ALL MARKET CACHE CLEARED"

    );


    console.log(

      "=============================================="

    );


    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      message:
        "行情缓存、历史数据缓存、Market 请求缓存已清除"

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

        activeDownloads:
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
          marketRequestCache.size

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

      activeDownloads:
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
 *
 * 用于检查 Render 服务是否真的正常运行。
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

      memory:{

        rss:
          process.memoryUsage().rss,

        heapUsed:
          process.memoryUsage().heapUsed,

        heapTotal:
          process.memoryUsage().heapTotal

      }

    });

  }

);


/*
 * ============================================================
 * 前端
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

      "市场：Binance USD-M Futures"

    );


    console.log(

      "数据方式：Monthly + Daily"

    );


    console.log(

      "不使用 fapi.binance.com"

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

      "ZIP Promise Cache：启用"

    );


    console.log(

      "Market Request Sharing：启用"

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
