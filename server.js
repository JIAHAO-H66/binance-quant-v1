const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V3.5 OOS 数据服务器
 *
 * Binance USD-M Futures
 *
 * OOS：
 *
 * 2026-09-01 00:00 UTC
 * →
 * 2026-09-26 00:00 UTC
 *
 * 指标预热：
 *
 * 2026-07-01
 * →
 * 2026-09-01
 *
 *
 * 关键修复：
 *
 * 1.
 * 不再把“当前月份开始”
 * 当作回测结束时间。
 *
 *
 * 2.
 * 已完成月份：
 * 使用 Binance Public Data 月度 ZIP。
 *
 *
 * 3.
 * 当前未完成月份：
 * 使用 Binance Futures
 * /fapi/v1/klines
 * 直接读取。
 *
 *
 * 4.
 * 前端传入的：
 *
 * start
 * end
 * backtestStart
 * backtestEnd
 * warmupStart
 *
 * 会真正被使用。
 *
 * ============================================================
 */


const BINANCE_DATA_BASE =
  "https://data.binance.vision";


const BINANCE_FAPI_BASE =
  "https://fapi.binance.com";


/*
 * ============================================================
 * V3.5 默认 OOS 区间
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
 * 日期参数解析
 * ============================================================
 */


function parseDateParam(

  value,

  fallback

){

  if(
    value == null ||
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


  return Number.isFinite(time)
    ? time
    : NaN;

}


/*
 * ============================================================
 * 获取 UTC 月初
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
 * UTC 月份加减
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
 * 获取月份范围
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


  const endMonth =
    floorUtcMonth(

      Math.max(

        startMs,

        endMs - 1

      )

    );


  const result = [];


  for(

    let timestamp = start;

    timestamp <= endMonth;

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
 * 解析回测区间
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

      "日期范围错误：backtestStart/backtestEnd 必须是有效且 end > start 的日期。"

    );

  }


  let warmupStart =
    parseDateParam(

      req.query.warmupStart,

      DEFAULT_WARMUP_START

    );


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
 * Binance 月度 ZIP 地址
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

    `${symbol}/${interval}/` +

    `${symbol}-${interval}-${year}-${month}.zip`

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
 * Binance API K线解析
 * ============================================================
 */


function parseKlineRows(rows){

  if(
    !Array.isArray(rows)
  ){

    return [];

  }


  return rows

    .map(

      row => ({

        openTime:
          Number(row[0]),

        open:
          Number(row[1]),

        high:
          Number(row[2]),

        low:
          Number(row[3]),

        close:
          Number(row[4]),

        volume:
          Number(row[5]),

        closeTime:
          Number(row[6])

      })

    )

    .filter(

      row =>

        Number.isFinite(
          row.openTime
        ) &&

        Number.isFinite(
          row.open
        ) &&

        Number.isFinite(
          row.high
        ) &&

        Number.isFinite(
          row.low
        ) &&

        Number.isFinite(
          row.close
        ) &&

        Number.isFinite(
          row.volume
        ) &&

        Number.isFinite(
          row.closeTime
        ) &&

        row.open > 0 &&

        row.high > 0 &&

        row.low > 0 &&

        row.close > 0 &&

        row.high >= row.low

    );

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


  return parseCsv(

    csvEntry
      .getData()
      .toString("utf8")

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


  console.log(
    "Downloading monthly:",
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

      `${symbol} ${interval} ` +

      `${year}-${month} ` +

      `月度数据下载失败：` +

      `${error.message}`

    );

  }


  /*
   * 币种当月不存在
   */

  if(
    response.status === 404
  ){

    console.log(

      "Monthly not found:",

      symbol,

      interval,

      year,

      month

    );


    return [];

  }


  if(
    !response.ok
  ){

    throw new Error(

      `${symbol} ${interval} ` +

      `${year}-${month} ` +

      `HTTP ${response.status}`

    );

  }


  const arrayBuffer =
    await response.arrayBuffer();


  return extractZipCsv(

    Buffer.from(
      arrayBuffer
    )

  );

}


/*
 * ============================================================
 * 获取当前未完成月份 K线
 *
 * 使用 Binance USD-M Futures
 * /fapi/v1/klines
 *
 * 最大 1500 根 / 请求。
 * ============================================================
 */


async function fetchApiKlines(

  symbol,

  interval,

  startTime,

  endTime

){

  const limit =
    1500;


  const all = [];


  let cursor =
    startTime;


  let safety =
    0;


  while(

    cursor < endTime &&

    safety < 20

  ){

    safety++;


    const url =
      new URL(

        `${BINANCE_FAPI_BASE}` +

        `/fapi/v1/klines`

      );


    url.searchParams.set(

      "symbol",

      symbol

    );


    url.searchParams.set(

      "interval",

      interval

    );


    url.searchParams.set(

      "startTime",

      String(cursor)

    );


    url.searchParams.set(

      "endTime",

      String(

        endTime - 1

      )

    );


    url.searchParams.set(

      "limit",

      String(limit)

    );


    console.log(

      "Downloading API:",

      url.toString()

    );


    let response;


    try{

      response =
        await fetch(
          url
        );

    }catch(error){

      throw new Error(

        `${symbol} ${interval} ` +

        `API 下载失败：` +

        `${error.message}`

      );

    }


    if(
      !response.ok
    ){

      const text =
        await response
          .text()
          .catch(
            () => ""
          );


      throw new Error(

        `${symbol} ${interval} ` +

        `API HTTP ${response.status}` +

        (

          text

            ? `：${text.slice(0,200)}`

            : ""

        )

      );

    }


    const rows =
      await response.json();


    const candles =
      parseKlineRows(
        rows
      );


    if(
      !candles.length
    ){

      break;

    }


    all.push(
      ...candles
    );


    const last =
      candles[
        candles.length - 1
      ].openTime;


    if(
      last < cursor
    ){

      break;

    }


    cursor =
      last + 1;


    if(
      candles.length < limit
    ){

      break;

    }

  }


  return all;

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
 * 获取历史 K线
 *
 * 已完成月份：
 * monthly ZIP
 *
 * 当前未完成月份：
 * Futures API
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


      for(
        const month
        of months
      ){

        const monthEnd =
          Math.min(

            month.end,

            oosEnd

          );


        /*
         * 当前月份还没有完整月度归档。
         */

        const isCurrentMonth =

          month.end >
          Date.now();


        if(
          isCurrentMonth
        ){

          const start =
            Math.max(

              warmupStart,

              month.start

            );


          const rows =
            await fetchApiKlines(

              symbol,

              interval,

              start,

              monthEnd

            );


          all =
            all.concat(
              rows
            );

        }else{

          /*
           * 已完成月份使用月度 ZIP。
           */

          const rows =
            await downloadMonthly(

              symbol,

              interval,

              month.year,

              month.month

            );


          all =
            all.concat(
              rows
            );

        }

      }


      /*
       * 去重 + 时间过滤
       */

      const result =

        deduplicateKlines(
          all
        )

        .filter(

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

          `${symbol} ${interval}：` +

          `指定日期范围内没有历史K线`

        );

      }


      const first =
        result[0].openTime;


      const last =
        result[
          result.length - 1
        ].openTime;


      console.log(

        `${symbol} ${interval}: ` +

        `${result.length} candles, ` +

        `${new Date(first).toISOString()} ` +

        `→ ` +

        `${new Date(last).toISOString()}`

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

    oos:
      true,

    source:
      "Binance USD-M Futures Public Data + Futures Kline API",

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
 * 行情接口
 *
 * /api/market?symbol=SOLUSDT
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

            error:
              "symbol 参数错误"

          });

      }


      const range =
        resolveRange(
          req
        );


      console.log(

        "Market request:",

        symbol,

        getMeta(
          range
        )

      );


      /*
       * 三个周期并发
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
       * OOS 完整性检查
       *
       * 三个周期都必须有
       * 2026-09-01 之后的数据。
       */

      const datasets = [

        ["4h", data4h],

        ["1h", data1h],

        ["15m", data15m]

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
          !oosRows.length
        ){

          throw new Error(

            `${symbol} ${name}：` +

            `OOS 区间 ` +

            `${new Date(
              range.oosStart
            ).toISOString()} ` +

            `→ ` +

            `${new Date(
              range.oosEnd
            ).toISOString()} ` +

            `没有可用 K 线。`

          );

        }

      }


      return res.json({

        ok:true,

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
 *
 * /api/cache/clear
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
 *
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

        source:
          "Binance USD-M Futures Public Data + Futures Kline API",

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

      `Server running on port ${PORT}`

    );


    console.log(

      `V3.5 OOS：` +

      new Date(
        DEFAULT_OOS_START
      ).toISOString() +

      " → " +

      new Date(
        DEFAULT_OOS_END
      ).toISOString()

    );


    console.log(

      `指标预热：` +

      new Date(
        DEFAULT_WARMUP_START
      ).toISOString() +

      " → " +

      new Date(
        DEFAULT_OOS_START
      ).toISOString()

    );

  }

);
