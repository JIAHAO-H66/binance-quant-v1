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
 * 注意：
 *
 * 预热数据只用于计算 EMA / ATR 等指标，
 * 不允许在预热期间产生交易。
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

const BACKTEST_MONTHS = 6;

const WARMUP_MONTHS = 2;


/*
 * ============================================================
 * 缓存
 * ============================================================
 */

const cache = new Map();


/*
 * ============================================================
 * 当前月份开始时间
 *
 * 例如当前月份：
 *
 * 2026-09
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
 * 正式回测：
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
    now.getUTCMonth() - BACKTEST_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 数据开始时间
 *
 * 正式回测开始之前，
 * 再额外提供 2 个月指标预热。
 *
 * 例如：
 *
 * 正式回测：
 *
 * 2026-03-01
 *
 * 预热：
 *
 * 2026-01-01
 *
 * 所以数据从：
 *
 * 2026-01-01
 *
 * 开始。
 *
 * ============================================================
 */

function getDataStart(){

  const now =
    new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth()
      - BACKTEST_MONTHS
      - WARMUP_MONTHS,
    1
  );

}


/*
 * ============================================================
 * 根据 offset 获取月份
 *
 * offset = 0
 * 当前月份
 *
 * offset = 1
 * 上个月
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
 * 构造 Binance 月度 K线 URL
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
     * Binance CSV：
     *
     * 0 open time
     * 1 open
     * 2 high
     * 3 low
     * 4 close
     * 5 volume
     * 6 close time
     */

    const openTime =
      Number(row[0]);


    /*
     * 跳过标题
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


  const response =
    await fetch(url);


  /*
   * 该币种当时还没有上市，
   * 或 Binance 没有这个月份的数据。
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
 * 获取历史 K线
 *
 * 返回的数据包括：
 *
 * 预热：
 * 2个月
 *
 * 正式回测：
 * 6个月
 *
 * 但是前端只允许正式回测区间产生交易。
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
   * 已经缓存
   */

  if(
    cache.has(cacheKey)
  ){

    return cache.get(cacheKey);

  }


  const dataStart =
    getDataStart();


  const currentMonthStart =
    getCurrentMonthStart();


  /*
   * 总月份：
   *
   * 6个月正式回测
   * +
   * 2个月预热
   *
   * = 8个月
   */

  const totalMonths =
    BACKTEST_MONTHS +
    WARMUP_MONTHS;


  let all = [];


  /*
   * 从上个月开始向过去读取。
   *
   * 当前未完成月份不读取。
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
        rows.length
      ){

        all =
          all.concat(rows);

      }

    }catch(error){

      /*
       * 单个月份下载失败，
       * 不影响其它月份。
       */

      console.error(
        "Month download error:",
        error.message
      );

    }

  }


  /*
   * ==========================================================
   * 排序
   * ==========================================================
   */

  all.sort(
    (a,b) =>
      a.openTime -
      b.openTime
  );


  /*
   * ==========================================================
   * 去重
   * ==========================================================
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
   * 最终时间范围
   *
   * 必须满足：
   *
   * dataStart <= K线 < currentMonthStart
   *
   * ==========================================================
   */

  const result =
    unique.filter(
      row =>
        row.openTime >= dataStart &&
        row.openTime < currentMonthStart
    );


  /*
   * 没有数据
   */

  if(
    result.length === 0
  ){

    throw new Error(
      `${symbol} ${interval}：没有历史K线`
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
    `${result.length} candles`
  );


  return result;

}


/*
 * ============================================================
 * 行情接口
 *
 * /api/market?symbol=SOLUSDT
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
        ).toUpperCase();


      /*
       * 基础 symbol 验证
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
       * 同时下载三个周期
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

        meta:{

          /*
           * 正式回测月份
           */

          backtestMonths:
            BACKTEST_MONTHS,


          /*
           * 预热月份
           */

          warmupMonths:
            WARMUP_MONTHS,


          /*
           * 正式回测开始
           */

          backtestStart:
            getBacktestStart(),


          /*
           * 正式回测结束
           */

          backtestEnd:
            getCurrentMonthStart(),


          /*
           * 数据开始
           */

          dataStart:
            getDataStart(),

          /*
           * 明确告诉前端：
           *
           * 这个区间才允许交易
           */

          tradingStart:
            getBacktestStart(),

          tradingEnd:
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
 * 状态接口
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


      /*
       * 正式回测
       */

      backtestMonths:
        BACKTEST_MONTHS,


      /*
       * 指标预热
       */

      warmupMonths:
        WARMUP_MONTHS,


      /*
       * 正式回测开始
       */

      backtestStart:
        new Date(
          getBacktestStart()
        ).toISOString(),


      /*
       * 正式回测结束
       */

      backtestEnd:
        new Date(
          getCurrentMonthStart()
        ).toISOString(),


      /*
       * 数据开始
       */

      dataStart:
        new Date(
          getDataStart()
        ).toISOString(),


      /*
       * 周期
       */

      intervals:[
        "4h",
        "1h",
        "15m"
      ],


      /*
       * 当前缓存数量
       */

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
