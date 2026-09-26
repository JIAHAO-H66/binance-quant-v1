const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V2 · 数据服务器
 *
 * Binance USD-M Futures
 *
 * 数据来源：
 * Binance Public Data
 *
 * 正式回测：
 * 最近 6 个完整月份
 *
 * 指标预热：
 * 额外 2 个完整月份
 *
 * 例如当前是：
 * 2026-09
 *
 * 正式回测：
 * 2026-03-01
 * →
 * 2026-09-01
 *
 * 指标预热：
 * 2026-01-01
 * →
 * 2026-03-01
 *
 * 当前未完成月份不会进入回测。
 *
 * ============================================================
 */


const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * ============================================================
 * 回测参数
 * ============================================================
 */


/*
 * 正式回测月份
 */

const BACKTEST_MONTHS = 6;


/*
 * 指标预热月份
 */

const WARMUP_MONTHS = 2;


/*
 * 总数据月份
 */

const TOTAL_MONTHS =
  BACKTEST_MONTHS +
  WARMUP_MONTHS;


/*
 * ============================================================
 * 缓存
 *
 * 缓存的不只是最终数据，
 * 也缓存正在进行中的 Promise。
 *
 * 防止同一个币种同时发起多个重复下载。
 * ============================================================
 */

const cache = new Map();


/*
 * ============================================================
 * 获取当前月份开始时间
 *
 * 例如：
 *
 * 2026-09-26
 *
 * 返回：
 *
 * 2026-09-01 00:00:00 UTC
 *
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
 * 当前月份往前 6 个完整月份。
 *
 * 例如：
 *
 * 当前：
 * 2026-09
 *
 * 回测：
 *
 * 2026-03-01
 *
 * 到：
 *
 * 2026-09-01
 *
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
 * 再额外预热 2 个月。
 *
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
 * offset：
 *
 * 1 = 上一个完整月份
 * 2 = 上上个完整月份
 *
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
      ).padStart(2,"0")

  };

}


/*
 * ============================================================
 * 构造 Binance 月度 K 线地址
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
     * Binance CSV 第一行可能是表头。
     *
     * 第一列不是数字时直接跳过。
     */

    const openTime =
      Number(row[0]);


    if(
      !Number.isFinite(openTime)
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
     * 基本数据合法性检查
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
 * 解压 Binance ZIP
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
 * 下载一个月数据
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
    "Downloading:",
    url
  );


  let response;


  try{

    response =
      await fetch(url);

  }catch(error){

    throw new Error(

      `${symbol} ${interval} ` +
      `${year}-${month} 下载失败：` +
      `${error.message}`

    );

  }


  /*
   * 404：
   *
   * 代表这个币种当月没有数据，
   * 比如尚未上市。
   *
   * 不应该让整个回测失败。
   */

  if(
    response.status === 404
  ){

    console.log(

      "Not found:",

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


  const buffer =
    Buffer.from(arrayBuffer);


  return extractZipCsv(
    buffer
  );

}


/*
 * ============================================================
 * 去重
 *
 * Binance K 线使用 openTime 作为唯一时间。
 * ============================================================
 */

function deduplicateKlines(data){

  const map =
    new Map();


  for(
    const row of data
  ){

    if(
      !map.has(row.openTime)
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
 * 获取历史 K 线
 *
 * 结构：
 *
 * 预热 2 个月
 * +
 * 正式回测 6 个月
 *
 * 总共 8 个完整月份。
 *
 * 当前月份不参与。
 * ============================================================
 */

async function fetchHistoricalKlines(

  symbol,

  interval

){

  const cacheKey =
    `${symbol}_${interval}`;


  /*
   * 已经存在缓存。
   */

  if(
    cache.has(cacheKey)
  ){

    return cache.get(cacheKey);

  }


  /*
   * 先创建 Promise 放入缓存。
   *
   * 这样即使同时请求同一个数据，
   * 也不会重复下载。
   */

  const promise =
    (async() => {

      const dataStart =
        getDataStart();


      const currentMonthStart =
        getCurrentMonthStart();


      /*
       * 每个月单独下载。
       *
       * 使用 Promise.all 并发下载，
       * 加快速度。
       */

      const jobs = [];


      for(

        let offset = 1;

        offset <= TOTAL_MONTHS;

        offset++

      ){

        const {
          year,
          month
        } =
          getMonthInfo(offset);


        jobs.push(

          downloadMonth(

            symbol,

            interval,

            year,

            month

          )

        );

      }


      const monthlyData =
        await Promise.all(
          jobs
        );


      /*
       * 合并所有月份。
       */

      let all = [];


      for(
        const rows
        of monthlyData
      ){

        if(
          rows.length
        ){

          all =
            all.concat(rows);

        }

      }


      /*
       * 排序 + 去重。
       */

      const unique =
        deduplicateKlines(
          all
        );


      /*
       * 最终时间过滤。
       *
       * 必须满足：
       *
       * >= 数据开始时间
       *
       * <
       * 当前月份开始
       *
       */

      const result =
        unique.filter(

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

          `${symbol} ${interval}：` +
          `没有历史K线`

        );

      }


      /*
       * 最后再做一次时间排序。
       */

      result.sort(

        (a,b) =>
          a.openTime -
          b.openTime

      );


      console.log(

        `${symbol} ${interval}: ` +

        `${result.length} candles`

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


    /*
     * 下载完成以后，
     * 将 Promise 换成真正的数据。
     */

    cache.set(
      cacheKey,
      result
    );


    return result;

  }catch(error){

    /*
     * 如果下载失败，
     * 不要把失败的 Promise 永久留在缓存。
     */

    cache.delete(
      cacheKey
    );


    throw error;

  }

}


/*
 * ============================================================
 * 时间信息
 * ============================================================
 */

function getMeta(){

  const dataStart =
    getDataStart();


  const backtestStart =
    getBacktestStart();


  const backtestEnd =
    getCurrentMonthStart();


  return {

    backtestMonths:
      BACKTEST_MONTHS,

    warmupMonths:
      WARMUP_MONTHS,

    totalDataMonths:
      TOTAL_MONTHS,

    dataStart,

    backtestStart,

    backtestEnd,

    dataStartISO:
      new Date(
        dataStart
      ).toISOString(),

    backtestStartISO:
      new Date(
        backtestStart
      ).toISOString(),

    backtestEndISO:
      new Date(
        backtestEnd
      ).toISOString()

  };

}


/*
 * ============================================================
 * 行情接口
 *
 * GET
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

          req.query.symbol || ""

        ).toUpperCase();


      /*
       * 基础 symbol 检查。
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
        "Market request:",
        symbol
      );


      /*
       * 三个周期并发读取。
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


      /*
       * 返回。
       */

      return res.json({

        ok:true,

        symbol,

        meta:
          getMeta(),

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

    const meta =
      getMeta();


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

      totalDataMonths:
        TOTAL_MONTHS,

      dataStart:
        meta.dataStartISO,

      backtestStart:
        meta.backtestStartISO,

      backtestEnd:
        meta.backtestEndISO,

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

      `正式回测：` +

      new Date(
        getBacktestStart()
      ).toISOString() +

      " → " +

      new Date(
        getCurrentMonthStart()
      ).toISOString()

    );

    console.log(

      `指标预热：` +

      new Date(
        getDataStart()
      ).toISOString() +

      " → " +

      new Date(
        getBacktestStart()
      ).toISOString()

    );

  }

);
