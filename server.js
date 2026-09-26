const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));

/*
 * ============================================================
 * Quant V2 · Binance USD-M Futures 数据服务器
 *
 * 功能：
 *
 * 1. Binance Public Data
 * 2. USD-M Futures
 * 3. 4H / 1H / 15M
 * 4. 最近 6 个完整月份正式回测
 * 5. 额外 2 个月指标预热
 * 6. 不读取当前未完成月份
 * 7. 不下单
 * 8. 只提供历史K线
 *
 * 正式回测：
 *
 * 2026-03-01
 * →
 * 2026-09-01
 *
 * 如果当前月份发生变化，
 * 系统自动滚动到最近6个完整月份。
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
 * 回测参数
 * ============================================================
 */

const BACKTEST_MONTHS = 6;

const WARMUP_MONTHS = 2;


/*
 * ============================================================
 * 缓存
 *
 * key:
 *
 * SYMBOL_INTERVAL
 *
 * 例如：
 *
 * SOLUSDT_15m
 * ============================================================
 */

const cache = new Map();


/*
 * ============================================================
 * 当前月份开始时间
 *
 * 注意：
 *
 * 使用 UTC。
 *
 * Binance 数据时间也是 UTC。
 * ============================================================
 */

function getCurrentMonthStart(){

  const now =
    new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    1
  );

}


/*
 * ============================================================
 * 正式回测开始时间
 *
 * 最近6个完整月份。
 *
 * 例如当前：
 *
 * 2026-09
 *
 * 正式回测：
 *
 * 2026-03-01
 *
 * 到：
 *
 * 2026-09-01
 *
 * 不包含9月份。
 * ============================================================
 */

function getBacktestStart(){

  const now =
    new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() -
      BACKTEST_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 数据开始时间
 *
 * 正式回测开始之前，
 * 再增加2个月预热。
 *
 * 例如：
 *
 * 正式：
 * 2026-03-01
 *
 * 预热：
 * 2026-01-01
 *
 * 数据：
 * 2026-01-01
 * →
 * 2026-09-01
 * ============================================================
 */

function getDataStart(){

  const now =
    new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() -
      BACKTEST_MONTHS -
      WARMUP_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 获取月份
 *
 * offset = 1
 * 上个月
 *
 * offset = 2
 * 上上个月
 *
 * ...
 * ============================================================
 */

function getMonthInfo(offset){

  const now =
    new Date();

  const date =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() -
          offset,
        1
      )
    );

  return {

    year:
      date.getUTCFullYear(),

    month:
      String(
        date.getUTCMonth() + 1
      ).padStart(2, "0")

  };

}


/*
 * ============================================================
 * 构造 Binance 月度K线地址
 *
 * 例如：
 *
 * SOLUSDT
 * 15m
 * 2026
 * 08
 *
 * =>
 *
 * https://data.binance.vision/
 * data/futures/um/monthly/klines/
 * SOLUSDT/15m/
 * SOLUSDT-15m-2026-08.zip
 * ============================================================
 */

function buildUrl(
  symbol,
  interval,
  year,
  month
){

  const fileName =
    `${symbol}-${interval}-${year}-${month}.zip`;

  return (
    BINANCE_DATA_BASE +
    "/data/futures/um/monthly/klines/" +
    symbol +
    "/" +
    interval +
    "/" +
    fileName
  );

}


/*
 * ============================================================
 * CSV解析
 *
 * Binance Futures Kline CSV：
 *
 * 0 open time
 * 1 open
 * 2 high
 * 3 low
 * 4 close
 * 5 volume
 * 6 close time
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
    const line of lines
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
     * 至少需要前7列。
     */

    if(
      row.length < 7
    ){

      continue;

    }


    const openTime =
      Number(row[0]);


    /*
     * 跳过标题。
     */

    if(
      !Number.isFinite(
        openTime
      )
    ){

      continue;

    }


    const open =
      Number(row[1]);

    const high =
      Number(row[2]);

    const low =
      Number(row[3]);

    const close =
      Number(row[4]);

    const volume =
      Number(row[5]);

    const closeTime =
      Number(row[6]);


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
     * 基本数据有效性检查。
     */

    if(
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      volume < 0
    ){

      continue;

    }


    if(
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
 * 解压ZIP
 * ============================================================
 */

function extractZipCsv(buffer){

  const zip =
    new AdmZip(buffer);


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


  return parseCsv(text);

}


/*
 * ============================================================
 * 下载单个月份
 * ============================================================
 */

async function downloadMonth(
  symbol,
  interval,
  year,
  month
){

  const url =
    buildUrl(
      symbol,
      interval,
      year,
      month
    );


  console.log(
    "[DOWNLOAD]",
    symbol,
    interval,
    `${year}-${month}`
  );


  const response =
    await fetch(url);


  /*
   * 404：
   *
   * 币种当时还没有上市，
   * 或者 Binance 没有该月份文件。
   *
   * 不视为整个回测失败。
   */

  if(
    response.status === 404
  ){

    console.log(
      "[NOT FOUND]",
      symbol,
      interval,
      `${year}-${month}`
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
    Buffer.from(arrayBuffer)
  );

}


/*
 * ============================================================
 * 去重
 *
 * 使用 openTime。
 * ============================================================
 */

function uniqueByOpenTime(rows){

  const map =
    new Map();


  for(
    const row of rows
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
  );

}


/*
 * ============================================================
 * 获取完整历史K线
 *
 * 注意：
 *
 * 这里只负责数据。
 *
 * 交易策略全部由 index.html
 * 的回测引擎负责。
 * ============================================================
 */

async function fetchHistoricalKlines(
  symbol,
  interval
){

  const cacheKey =
    `${symbol}_${interval}`;


  /*
   * 命中缓存。
   */

  if(
    cache.has(cacheKey)
  ){

    console.log(
      "[CACHE]",
      cacheKey
    );


    return cache.get(
      cacheKey
    );

  }


  const dataStart =
    getDataStart();


  const currentMonthStart =
    getCurrentMonthStart();


  /*
   * 总月份：
   *
   * 6正式
   * +
   * 2预热
   *
   * = 8个月
   */

  const totalMonths =
    BACKTEST_MONTHS +
    WARMUP_MONTHS;


  let all = [];


  /*
   * 从上个月开始，
   * 一直向过去读取。
   *
   * 当前月份永远不读取。
   */

  for(
    let offset = 1;
    offset <= totalMonths;
    offset++
  ){

    const {
      year,
      month
    } =
      getMonthInfo(offset);


    try{

      const rows =
        await downloadMonth(
          symbol,
          interval,
          year,
          month
        );


      if(
        rows.length > 0
      ){

        all =
          all.concat(
            rows
          );

      }

    }catch(error){

      /*
       * 单个月份失败，
       * 不直接让整个币种失败。
       */

      console.error(
        "[MONTH ERROR]",
        symbol,
        interval,
        `${year}-${month}`,
        error.message
      );

    }

  }


  /*
   * 时间排序。
   */

  all.sort(
    (a,b) =>
      a.openTime -
      b.openTime
  );


  /*
   * 去重。
   */

  all =
    uniqueByOpenTime(
      all
    );


  /*
   * 再次排序。
   */

  all.sort(
    (a,b) =>
      a.openTime -
      b.openTime
  );


  /*
   * 只保留：
   *
   * dataStart
   *
   * 到：
   *
   * currentMonthStart
   *
   * 不包含当前月份。
   */

  const result =
    all.filter(
      row =>
        row.openTime >=
          dataStart &&
        row.openTime <
          currentMonthStart
    );


  if(
    result.length === 0
  ){

    throw new Error(
      `${symbol} ${interval}：没有历史K线`
    );

  }


  /*
   * 最终再次检查时间顺序。
   */

  for(
    let i=1;
    i<result.length;
    i++
  ){

    if(
      result[i].openTime <=
      result[i-1].openTime
    ){

      throw new Error(
        `${symbol} ${interval}：K线时间顺序异常`
      );

    }

  }


  /*
   * 缓存。
   */

  cache.set(
    cacheKey,
    result
  );


  console.log(
    "[READY]",
    symbol,
    interval,
    result.length,
    "candles"
  );


  return result;

}


/*
 * ============================================================
 * /api/market
 *
 * 返回：
 *
 * 4H
 * 1H
 * 15M
 *
 * ============================================================
 */

app.get(
  "/api/market",
  async (
    req,
    res
  ) => {

    try{

      const symbol =
        String(
          req.query.symbol || ""
        )
        .trim()
        .toUpperCase();


      /*
       * Binance USDT Futures
       * 常规交易对格式。
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


      console.log(
        "[MARKET]",
        symbol
      );


      /*
       * 并行读取三个周期。
       */

      const [
        data4h,
        data1h,
        data15m
      ] =
        await Promise.all([

          fetchHistoricalKlines(
            symbol,
            "4h"
          ),

          fetchHistoricalKlines(
            symbol,
            "1h"
          ),

          fetchHistoricalKlines(
            symbol,
            "15m"
          )

        ]);


      return res.json({

        ok:true,

        symbol,

        meta:{

          source:
            "Binance Public Data",

          market:
            "USD-M Futures",

          backtestMonths:
            BACKTEST_MONTHS,

          warmupMonths:
            WARMUP_MONTHS,

          dataStart:
            new Date(
              getDataStart()
            ).toISOString(),

          backtestStart:
            new Date(
              getBacktestStart()
            ).toISOString(),

          backtestEnd:
            new Date(
              getCurrentMonthStart()
            ).toISOString(),

          /*
           * 当前月份不包含。
           */

          currentMonthExcluded:
            true

        },

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
        "[MARKET ERROR]",
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


    return res.json({

      ok:true,

      message:
        "行情缓存已清除",

      cacheSize:
        cache.size

    });

  }
);


/*
 * ============================================================
 * 状态
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

    return res.json({

      ok:true,

      source:
        "Binance Public Data",

      market:
        "USD-M Futures",

      backtestMonths:
        BACKTEST_MONTHS,

      warmupMonths:
        WARMUP_MONTHS,

      dataStart:
        new Date(
          getDataStart()
        ).toISOString(),

      backtestStart:
        new Date(
          getBacktestStart()
        ).toISOString(),

      backtestEnd:
        new Date(
          getCurrentMonthStart()
        ).toISOString(),

      currentMonthExcluded:
        true,

      intervals:[
        "4h",
        "1h",
        "15m"
      ],

      cacheSize:
        cache.size

    });

  }
);


/*
 * ============================================================
 * 前端
 *
 * 所有非API请求都返回 index.html。
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
      `Backtest: ` +
      `${new Date(
        getBacktestStart()
      ).toISOString()} ` +
      `→ ` +
      `${new Date(
        getCurrentMonthStart()
      ).toISOString()}`
    );

    console.log(
      `Warmup: ` +
      `${new Date(
        getDataStart()
      ).toISOString()}`
    );

  }
);
