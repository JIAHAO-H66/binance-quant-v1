const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V3.7.4 · OOS 数据服务器
 *
 * Binance USD-M Futures
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
 * 版本
 * ============================================================
 */

const SERVER_VERSION =
  "V3.7.4";


/*
 * ============================================================
 * 固定 OOS 区间
 *
 * 本测试阶段：
 *
 * OOS：
 *
 * 2026-09-01
 * →
 * 2026-09-26
 *
 * 注意：
 *
 * backtestEnd 为排他时间。
 *
 * 所以实际上使用：
 *
 * 2026-09-01 00:00
 * →
 * 2026-09-25 23:59...
 *
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
 *
 * 2026-07-01
 * →
 * 2026-09-01
 *
 * ============================================================
 */

const DEFAULT_WARMUP_START =
  Date.parse(
    "2026-07-01T00:00:00.000Z"
  );


/*
 * ============================================================
 * 下载控制
 *
 * 非常重要：
 *
 * V3.5.1 会一次性发送大量 Daily ZIP 请求。
 *
 * 现在改成全局下载队列。
 *
 * 同时最多：
 *
 *     4 个 ZIP
 *
 * 防止 Render：
 *
 *     CPU / RAM / Socket
 *
 * 被大量并发请求拖死。
 *
 * ============================================================
 */

const DOWNLOAD_CONCURRENCY =
  4;


/*
 * 下载超时时间：
 *
 * 60 秒
 *
 * 如果 Binance 某个请求长时间没有响应，
 * 自动中止并重试。
 *
 * ============================================================
 */

const DOWNLOAD_TIMEOUT =
  60 * 1000;


/*
 * 最大重试次数
 *
 * 总共最多尝试：
 *
 *     1 + 2 = 3 次
 *
 * ============================================================
 */

const MAX_RETRIES =
  2;


/*
 * ============================================================
 * 下载队列状态
 * ============================================================
 */

let activeDownloads =
  0;


const downloadQueue =
  [];


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
 * 缓存
 * ============================================================
 */

const cache =
  new Map();


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
 * 获取月份列表
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
 * 获取日期列表
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
 * OOS / Warmup
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
 * Monthly ZIP URL
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
 * Daily ZIP URL
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
 * CSV 解析
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


    /*
     * Binance Futures CSV 第一列：
     *
     * Open time
     */

    let openTime =
      Number(
        row[0]
      );


    /*
     * 如果第一列不是数字，
     * 认为是 CSV 表头。
     */

    if(
      !Number.isFinite(
        openTime
      )
    ){

      continue;

    }


    /*
     * 兼容微秒时间戳。
     *
     * Futures 通常为毫秒，
     * 但这里做兼容处理。
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


    const closeTime =
      Number(
        row[6]
      );


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


    if(

      open <= 0 ||

      high <= 0 ||

      low <= 0 ||

      close <= 0 ||

      high < low ||

      low > high

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


  if(!csvEntry){

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
 * 下载单个 ZIP
 *
 * 增加：
 *
 * 1. 超时
 * 2. 自动重试
 * 3. 429 / 5xx 重试
 * 4. 下载队列
 *
 * ============================================================
 */

async function downloadZip(

  url,

  description

){

  return enqueueDownload(

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


        let timeout =
          null;


        try{

          console.log(

            `[DOWNLOAD ${attempt + 1}/${MAX_RETRIES + 1}]`,

            description

          );


          controller =
            new AbortController();


          timeout =
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
                  controller.signal

              }

            );


          clearTimeout(
            timeout
          );


          /*
           * ==================================================
           * 404
           *
           * 代表文件不存在。
           *
           * 例如：
           *
           * 某币种当时还没有上市
           *
           * 或当天 archive 尚未存在。
           *
           * ==================================================
           */

          if(
            response.status === 404
          ){

            console.log(

              `[404]`,

              description

            );


            return [];

          }


          /*
           * ==================================================
           * 429 / 5xx
           *
           * 重试。
           * ==================================================
           */

          if(

            response.status === 429 ||

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


          const arrayBuffer =
            await response.arrayBuffer();


          const buffer =
            Buffer.from(
              arrayBuffer
            );


          const rows =
            extractZipCsv(
              buffer
            );


          console.log(

            `[OK]`,

            description,

            `candles=${rows.length}`

          );


          return rows;

        }catch(error){

          if(
            timeout
          ){

            clearTimeout(
              timeout
            );

          }


          lastError =
            error;


          console.error(

            `[DOWNLOAD ERROR]`,

            description,

            error.message

          );


          if(
            attempt >= MAX_RETRIES
          ){

            break;

          }


          /*
           * 指数退避：
           *
           * 第一次：
           * 2 秒
           *
           * 第二次：
           * 4 秒
           */

          const waitMs =
            2000 *
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


      throw new Error(

        `${description} 下载失败：` +

        `${lastError?.message || "未知错误"}`

      );

    }

  );

}


/*
 * ============================================================
 * 下载 Monthly
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
 * 下载 Daily
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
 * 判断一个月份是否已经完整结束
 *
 * 如果月份已经完整结束：
 *
 *     Monthly
 *
 * 如果月份仍然进行中：
 *
 *     Daily
 *
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
 * 获取历史 K 线
 *
 * 核心逻辑：
 *
 * 完整月份：
 *
 *     Monthly ZIP
 *
 * 当前 / 不完整月份：
 *
 *     Daily ZIP
 *
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

    `${SERVER_VERSION}_` +

    `${symbol}_` +

    `${interval}_` +

    `${warmupStart}_` +

    `${oosStart}_` +

    `${oosEnd}`;


  /*
   * ==========================================================
   * Cache
   * ==========================================================
   */

  if(
    cache.has(
      cacheKey
    )
  ){

    console.log(

      `[CACHE HIT]`,

      symbol,

      interval

    );


    return cache.get(
      cacheKey
    );

  }


  /*
   * ==========================================================
   * Promise Cache
   * ==========================================================
   */

  const promise =
    (async() => {

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
       * ======================================================
       * 每个月
       * ======================================================
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
         * ====================================================
         * 完整月份
         *
         * Monthly
         * ====================================================
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
         * ====================================================
         * 不完整月份
         *
         * Daily
         * ====================================================
         */

        console.log(

          `[DAILY]`,

          symbol,

          interval,

          `${month.year}-${month.month}`,

          new Date(
            monthStart
          ).toISOString(),

          "→",

          new Date(
            monthEnd
          ).toISOString()

        );


        const days =
          dayRange(

            monthStart,

            monthEnd

          );


        /*
         * ====================================================
         * 注意：
         *
         * 这里虽然创建多个任务，
         * 但真正的网络下载由全局 queue 控制。
         *
         * 不会再同时发送几十个请求。
         * ====================================================
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
       * ======================================================
       * 去重
       * ======================================================
       */

      const unique =
        deduplicateKlines(
          all
        );


      /*
       * ======================================================
       * 时间过滤
       * ======================================================
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
       * ======================================================
       * 第一根 / 最后一根
       * ======================================================
       */

      const first =
        result[0].openTime;


      const last =
        result[
          result.length - 1
        ].openTime;


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


      /*
       * ======================================================
       * OOS 检查
       * ======================================================
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


      console.log(

        `[OOS READY]`,

        symbol,

        interval,

        `candles=${oosRows.length}`

      );


      return result;

    })();


  cache.set(

    cacheKey,

    promise

  );


  try{

    const result =
      await promise;


    cache.set(

      cacheKey,

      result

    );


    return result;

  }catch(error){

    cache.delete(
      cacheKey
    );


    throw error;

  }

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
      MAX_RETRIES

  };

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
       * Symbol 检查
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

            error:
              "symbol 参数错误"

          });

      }


      const range =
        resolveRange(
          req
        );


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
       *
       * Promise.all 没问题。
       *
       * 真正网络下载由 queue 控制。
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


      /*
       * ======================================================
       * 返回
       * ======================================================
       */

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
 * 清除缓存
 * ============================================================
 */

app.get(

  "/api/cache/clear",

  (

    req,

    res

  ) => {

    cache.clear();


    console.log(
      "Market cache cleared"
    );


    return res.json({

      ok:true,

      version:
        SERVER_VERSION,

      message:
        "行情缓存已清除"

    });

  }

);


/*
 * ============================================================
 * 状态接口
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
          cache.size,

        activeDownloads:
          activeDownloads,

        queuedDownloads:
          downloadQueue.length

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
 * 调试接口
 *
 * 用来查看当前下载队列。
 *
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

      cacheSize:
        cache.size,

      activeDownloads:
        activeDownloads,

      queuedDownloads:
        downloadQueue.length,

      downloadConcurrency:
        DOWNLOAD_CONCURRENCY,

      downloadTimeoutMs:
        DOWNLOAD_TIMEOUT,

      maxRetries:
        MAX_RETRIES

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
