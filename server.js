const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V2 数据服务器
 *
 * 数据来源：
 *
 * Binance Public Data
 * https://data.binance.vision
 *
 * 数据：
 *
 * USD-M Futures
 * 4H
 * 1H
 * 15M
 *
 * 用途：
 *
 * 历史回测
 * 不下单
 * ============================================================
 */

const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * ============================================================
 * 回测周期
 *
 * 最近 6 个月
 *
 * 注意：
 *
 * 这里的 6 个月是实际回测周期，
 * 不是只下载 6 个月。
 *
 * 为了让 EMA200 / EMA50 / ATR 等指标
 * 在回测开始位置能够正常计算，
 * 会额外读取一部分更早的历史数据
 * 作为指标预热数据。
 * ============================================================
 */

const BACKTEST_MONTHS = 6;


/*
 * ============================================================
 * 指标预热
 *
 * 4H：
 * EMA200
 *
 * 1H：
 * EMA50
 *
 * 15M：
 * EMA50 + ATR14
 *
 * 为了安全，统一额外读取更多历史月份。
 * ============================================================
 */

const WARMUP_MONTHS = 2;


/*
 * ============================================================
 * 内存缓存
 * ============================================================
 */

const cache = new Map();


/*
 * ============================================================
 * 日期工具
 *
 * offset = 0
 * 当前月份
 *
 * offset = 1
 * 上个月
 *
 * 依此类推。
 * ============================================================
 */

function getMonthInfo(offset){

  const now =
    new Date();


  const date =
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - offset,
        1
      )
    );


  const year =
    date.getUTCFullYear();


  const month =
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");


  return {
    year,
    month
  };

}


/*
 * ============================================================
 * 获取当前月份开始时间
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
 * 获取六个月前的月份开始时间
 *
 * 例如：
 *
 * 当前是 2026-09
 *
 * 则回测开始月份为：
 *
 * 2026-03
 *
 * ============================================================
 */

function getBacktestStartTime(){

  const now =
    new Date();


  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - BACKTEST_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 构造 Binance Public Data URL
 *
 * 官方 USD-M Futures：
 *
 * /data/futures/um/monthly/klines/
 *
 * SYMBOL
 *
 * INTERVAL
 *
 * FILE.zip
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
 * CSV → K线
 * ============================================================
 */

function parseCsv(text){

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


    const openTime =
      Number(
        row[0]
      );


    /*
     * 如果有标题行，
     * 直接跳过。
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
 * 解压 ZIP
 * ============================================================
 */

function extractZipCsv(buffer){

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
      "ZIP 中没有找到 CSV 文件"
    );

  }


  const csvBuffer =
    csvEntry.getData();


  const text =
    csvBuffer.toString(
      "utf8"
    );


  return parseCsv(
    text
  );

}


/*
 * ============================================================
 * 下载一个月
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


  const response =
    await fetch(
      url,
      {
        method:"GET"
      }
    );


  /*
   * 某个月份没有数据：
   *
   * 例如币种尚未上市。
   *
   * 不让整个回测失败。
   */

  if(
    response.status === 404
  ){

    console.log(
      "File not found:",
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
      `${symbol} ${interval} ${year}-${month}：` +
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
 * 获取历史数据
 *
 * 这里和原来的最大区别：
 *
 * 不再使用 LIMIT = 1000。
 *
 * 而是完整读取：
 *
 * 指标预热月份
 * +
 * 最近 6 个月
 *
 * ============================================================
 */

async function fetchHistoricalKlines(
  symbol,
  interval
){

  const cacheKey =
    `${symbol}_${interval}`;


  /*
   * 缓存
   */

  if(
    cache.has(cacheKey)
  ){

    return cache.get(
      cacheKey
    );

  }


  let all = [];


  /*
   * 需要读取的月份数量：
   *
   * 最近 6 个月
   * +
   * 额外 2 个月预热
   *
   * 总共读取最近 8 个月。
   */

  const totalMonths =
    BACKTEST_MONTHS +
    WARMUP_MONTHS;


  /*
   * 从当前月份往过去读取。
   */

  for(
    let offset = 0;
    offset < totalMonths;
    offset++
  ){

    const {
      year,
      month
    } =
      getMonthInfo(
        offset
      );


    try{

      const rows =
        await downloadMonth(
          symbol,
          interval,
          year,
          month
        );


      if(
        rows.length
      ){

        all =
          all.concat(
            rows
          );

      }

    }catch(error){

      console.error(
        "Download month error:",
        error.message
      );

    }

  }


  /*
   * 按时间排序
   */

  all.sort(
    (a,b) =>
      a.openTime -
      b.openTime
  );


  /*
   * 去重
   */

  const unique = [];


  const seen =
    new Set();


  for(
    const row of all
  ){

    if(
      seen.has(
        row.openTime
      )
    ){

      continue;

    }


    seen.add(
      row.openTime
    );


    unique.push(
      row
    );

  }


  /*
   * ==========================================================
   * 只保留：
   *
   * 六个月回测
   * +
   * 前面的指标预热
   *
   * 因为我们已经读取了
   * BACKTEST_MONTHS + WARMUP_MONTHS，
   * 所以这里不再进行 1000 根限制。
   * ==========================================================
   */

  const backtestStart =
    getBacktestStartTime();


  const result =
    unique.filter(
      row =>
        row.closeTime >=
        backtestStart
    );


  /*
   * 如果没有数据，
   * 返回错误。
   */

  if(
    result.length === 0
  ){

    throw new Error(
      `${symbol} ${interval}：没有找到历史K线`
    );

  }


  /*
   * 缓存
   */

  cache.set(
    cacheKey,
    result
  );


  console.log(
    `${symbol} ${interval}: ` +
    `${result.length} candles cached`
  );


  return result;

}


/*
 * ============================================================
 * 多周期行情接口
 *
 * /api/market?symbol=SOLUSDT
 *
 * 返回：
 *
 * 4H
 * 1H
 * 15M
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
        ).toUpperCase();


      /*
       * 基本检查
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
       * 三个周期同时读取
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
       * 返回
       */

      return res.json({

        ok:true,

        symbol,

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


    return res.json({

      ok:true,

      message:
        "行情缓存已清除"

    });

  }
);


/*
 * ============================================================
 * 查看服务器状态
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

      type:
        "USD-M Futures historical data",

      backtestMonths:
        BACKTEST_MONTHS,

      warmupMonths:
        WARMUP_MONTHS,

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
 * 前端页面
 *
 * Express 5 使用正则路由。
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
 * Render PORT
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

  }
);
