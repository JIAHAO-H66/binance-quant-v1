const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V2 数据服务器
 *
 * Binance USD-M Futures
 *
 * 数据来源：
 * https://data.binance.vision
 *
 * 正式回测：
 * 最近 6 个完整月份
 *
 * 指标预热：
 * 额外 2 个月
 *
 * 不下单
 * 只做历史回测
 * ============================================================
 */

const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * 正式回测月份
 */

const BACKTEST_MONTHS = 6;


/*
 * 指标预热月份
 */

const WARMUP_MONTHS = 2;


/*
 * 缓存
 */

const cache = new Map();


/*
 * ============================================================
 * 当前月份开始时间
 * ============================================================
 */

function getCurrentMonthStart(){

  const now = new Date();

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
 * 当前月份往前 6 个完整月份
 *
 * 例如当前：
 *
 * 2026-09
 *
 * 正式回测：
 *
 * 2026-03-01
 * 到
 * 2026-09-01
 *
 * ============================================================
 */

function getBacktestStart(){

  const now = new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - BACKTEST_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 数据开始时间
 *
 * 正式回测开始之前，
 * 再额外取 2 个月指标预热。
 *
 * ============================================================
 */

function getDataStart(){

  const now = new Date();

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
 * 根据 offset 获取月份
 *
 * offset 1 = 上个月
 * offset 2 = 上上个月
 * ============================================================
 */

function getMonthInfo(offset){

  const now = new Date();

  const date = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - offset,
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
 * 构造 Binance 月度 K 线 URL
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

  const lines =
    text
      .trim()
      .split(/\r?\n/);

  const result = [];


  for(const line of lines){

    if(
      !line ||
      !line.trim()
    ){

      continue;

    }


    const row =
      line.split(",");


    const openTime =
      Number(row[0]);


    /*
     * 跳过 CSV 标题
     */

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
    await fetch(url);


  /*
   * 币种当时尚未上市，
   * 或该月份没有文件。
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
      `${symbol} ${interval} ${year}-${month} ` +
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
 * 获取历史数据
 *
 * 包含：
 *
 * 2个月预热
 * +
 * 6个月正式回测
 *
 * 当前未完成月份不进入数据。
 * ============================================================
 */

async function fetchHistoricalKlines(
  symbol,
  interval
){

  const cacheKey =
    `${symbol}_${interval}`;


  if(
    cache.has(cacheKey)
  ){

    return cache.get(cacheKey);

  }


  const dataStart =
    getDataStart();


  const currentMonthStart =
    getCurrentMonthStart();


  let all = [];


  const totalMonths =
    BACKTEST_MONTHS +
    WARMUP_MONTHS;


  /*
   * 从最近完整月份向过去读取。
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
        all.concat(rows);

    }

  }


  /*
   * 排序
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
      seen.has(row.openTime)
    ){

      continue;

    }


    seen.add(
      row.openTime
    );


    unique.push(row);

  }


  /*
   * 保留：
   *
   * 预热开始
   * 到
   * 当前月份开始
   */

  const result =
    unique.filter(
      row =>
        row.openTime >= dataStart &&
        row.openTime < currentMonthStart
    );


  if(
    result.length === 0
  ){

    throw new Error(
      `${symbol} ${interval}：没有历史K线`
    );

  }


  cache.set(
    cacheKey,
    result
  );


  console.log(
    `${symbol} ${interval}: ` +
    `${result.length} candles`
  );


  return result;

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
          req.query.symbol || ""
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


      console.log(
        "Market request:",
        symbol
      );


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

          backtestMonths:
            BACKTEST_MONTHS,

          warmupMonths:
            WARMUP_MONTHS,

          dataStart:
            getDataStart(),

          backtestStart:
            getBacktestStart(),

          backtestEnd:
            getCurrentMonthStart()

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


    return res.json({

      ok:true,

      message:
        "行情缓存已清除"

    });

  }
);


/*
 * ============================================================
 * 状态
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

  }
);
