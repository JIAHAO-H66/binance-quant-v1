const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V3.5.1 · OOS 数据服务器
 *
 * Binance USD-M Futures
 *
 *
 * 重要：
 *
 * 本版本完全不使用：
 *
 *     fapi.binance.com
 *
 *
 * 所有历史数据统一从：
 *
 *     data.binance.vision
 *
 * 获取。
 *
 *
 * 已完成月份：
 *
 *     monthly ZIP
 *
 *
 * 当前月份：
 *
 *     daily ZIP
 *
 *
 * OOS：
 *
 *     2026-09-01 00:00 UTC
 *     →
 *     2026-09-26 00:00 UTC
 *
 *
 * 指标预热：
 *
 *     2026-07-01
 *     →
 *     2026-09-01
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
 * 固定 OOS 区间
 *
 * V3.5.1 测试阶段冻结。
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


const DEFAULT_WARMUP_START =
  Date.parse(
    "2026-07-01T00:00:00.000Z"
  );


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
 * 获取某个月的日期列表
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


  let cursor =
    Date.UTC(

      new Date(
        startMs
      ).getUTCFullYear(),

      new Date(
        startMs
      ).getUTCMonth(),

      new Date(
        startMs
      ).getUTCDate()

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
 * OOS / Warmup 参数
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
 * 月度 ZIP URL
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
 * 每日 ZIP URL
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


    const openTime =
      Number(
        row[0]
      );


    /*
     * 跳过 CSV 表头
     */

    if(
      !Number.isFinite(
        openTime
      )
    ){

      continue;

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


    /*
     * 基础合法性
     */

    if(

      open <= 0 ||

      high <= 0 ||

      low <= 0 ||

      close <= 0 ||

      high < low

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
 * 下载 ZIP
 * ============================================================
 */

async function downloadZip(

  url,

  description

){

  console.log(

    "Downloading:",

    url

  );


  let response;


  try{

    response =
      await fetch(
        url
      );

  }catch(error){

    throw new Error(

      `${description} 下载失败：` +

      `${error.message}`

    );

  }


  /*
   * 404：
   *
   * 当前日期还没有归档，
   * 或该币种当时不存在。
   */

  if(
    response.status === 404
  ){

    console.log(

      "Not found:",

      description

    );


    return [];

  }


  if(
    !response.ok
  ){

    throw new Error(

      `${description} ` +

      `HTTP ${response.status}`

    );

  }


  const arrayBuffer =
    await response.arrayBuffer();


  const buffer =
    Buffer.from(
      arrayBuffer
    );


  return extractZipCsv(
    buffer
  );

}


/*
 * ============================================================
 * 下载已完成月份
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

    `${symbol} ${interval} ${year}-${month} 月度数据`

  );

}


/*
 * ============================================================
 * 下载一天
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

    `${symbol} ${interval} ${year}-${month}-${day} 每日数据`

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
 * 获取历史数据
 *
 *
 * 逻辑：
 *
 *
 * 2026-07
 *     ↓
 * monthly
 *
 * 2026-08
 *     ↓
 * monthly
 *
 * 2026-09
 *     ↓
 * daily
 *
 *
 * 不使用 Futures REST API。
 * ============================================================
 */

async function fetchHistoricalKlines(

  symbol,

  interval,

  range

){

  const {

    warmupStart,

    oosEnd

  } =
    range;


  const cacheKey =

    `${symbol}_` +

    `${interval}_` +

    `${warmupStart}_` +

    `${oosEnd}`;


  /*
   * 缓存
   */

  if(
    cache.has(
      cacheKey
    )
  ){

    return cache.get(
      cacheKey
    );

  }


  const promise =
    (async() => {

      const months =
        monthRange(

          warmupStart,

          oosEnd

        );


      let all = [];


      /*
       * ======================================================
       * 逐月处理
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


        /*
         * ====================================================
         * 当前测试区间的 2026-09
         *
         * 使用 daily ZIP
         *
         * 不使用 fapi API。
         * ====================================================
         */

        if(
          month.year === 2026 &&
          month.month === "09"
        ){

          console.log(

            `${symbol} ${interval}: ` +

            `使用 September daily archive`

          );


          const days =
            dayRange(

              monthStart,

              monthEnd

            );


          /*
           * 每天并发下载
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

        }else{

          /*
           * ==================================================
           * 已完成月份
           *
           * 使用 monthly ZIP
           * ==================================================
           */

          console.log(

            `${symbol} ${interval}: ` +

            `使用 monthly archive ` +

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
       * 最终时间过滤
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
       * 输出统计
       * ======================================================
       */

      const first =
        result[0].openTime;


      const last =
        result[
          result.length - 1
        ].openTime;


      console.log(

        `${symbol} ${interval}: ` +

        `${result.length} candles`

      );


      console.log(

        `${symbol} ${interval}: ` +

        `${new Date(
          first
        ).toISOString()} ` +

        `→ ` +

        `${new Date(
          last
        ).toISOString()}`

      );


      /*
       * ======================================================
       * OOS 数据检查
       * ======================================================
       */

      const oosRows =
        result.filter(

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

          `${symbol} ${interval}：` +

          `OOS 区间没有数据`

        );

      }


      console.log(

        `${symbol} ${interval}: ` +

        `OOS candles = ` +

        `${oosRows.length}`

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

    /*
     * 失败时删除缓存，
     * 防止下一次永远读取失败 Promise。
     */

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
      "V3.5.1",

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

    ]

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
       * Symbol 检查
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
        "================================"
      );


      console.log(

        "V3.5.1 Market request:",

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
        "================================"
      );


      /*
       * ======================================================
       * 三个周期并发
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

      }


      /*
       * ======================================================
       * 返回数据
       * ======================================================
       */

      return res.json({

        ok:true,

        version:
          "V3.5.1",

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

        "Market error:",

        error

      );


      return res

        .status(500)

        .json({

          ok:false,

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
          "V3.5.1",

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
          cache.size

      });

    }catch(error){

      return res

        .status(400)

        .json({

          ok:false,

          error:
            error.message

        });

    }

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
      "================================"
    );


    console.log(
      "Quant V3.5.1 Server"
    );


    console.log(

      `Server running on port ${PORT}`

    );


    console.log(

      "数据源：Binance Public Data"

    );


    console.log(

      "数据方式：Monthly + Daily"

    );


    console.log(

      "绝不使用 fapi.binance.com"

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
      "================================"
    );

  }

);
