const express = require("express");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));


/*
 * ============================================================
 * Quant V2 数据服务器
 *
 * 不再访问：
 *
 * https://fapi.binance.com
 *
 * 改为读取 Binance 官方公开历史数据：
 *
 * https://data.binance.vision
 *
 * 数据：
 *
 * USD-M Futures
 * 4H
 * 1H
 * 15M
 *
 * 只用于历史回测。
 * 不下单。
 * ============================================================
 */


/*
 * Binance Public Data
 */
const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * 每个周期最终最多返回多少根。
 *
 * 注意：
 *
 * 不是 3000。
 *
 * 我们保持原来的 1000 根左右的数据规模。
 */
const LIMIT = 1000;


/*
 * ============================================================
 * 内存缓存
 *
 * Render 服务器启动以后，
 * 第一次读取会下载历史 ZIP。
 *
 * 后面的请求直接使用缓存，
 * 不需要重复下载。
 * ============================================================
 */

const cache = new Map();


/*
 * ============================================================
 * interval 对应需要回溯多少个月
 *
 * 4H：
 * 1000 根约需要 167 天
 * 所以读取最近几个月。
 *
 * 1H：
 * 1000 根约需要 42 天。
 *
 * 15M：
 * 1000 根约需要 10.5 天。
 *
 * 我们统一最多向前找 6 个月。
 * ============================================================
 */

const MAX_MONTHS_BACK = 6;


/*
 * ============================================================
 * 日期工具
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
 * 构造 Binance Public Data URL
 *
 * 官方 USD-M Futures 路径：
 *
 * /data/futures/um/monthly/klines/
 * SYMBOL/
 * INTERVAL/
 * FILE.zip
 *
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
 *
 * Binance K线前 7 列：
 *
 * 0 Open time
 * 1 Open
 * 2 High
 * 3 Low
 * 4 Close
 * 5 Volume
 * 6 Close time
 * ============================================================
 */

function parseCsv(
  text
){

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
     * 有些公开数据文件可能带标题。
     *
     * 如果第一列不是数字，
     * 直接跳过。
     */

    const openTime =
      Number(
        row[0]
      );


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
      !Number.isFinite(volume)
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

function extractZipCsv(
  buffer
){

  const zip =
    new AdmZip(
      buffer
    );


  const entries =
    zip.getEntries();


  /*
   * 找 CSV 文件
   */
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


  /*
   * Binance CSV 是普通文本。
   */
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
 * 下载一个月的历史数据
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
   * 当前月份文件可能还没有，
   * 也可能某个币种当时还没有上市。
   *
   * 404 不直接让整个程序崩溃。
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
 * 获取最近历史 K线
 *
 * 从当前月份开始向过去寻找。
 *
 * 一旦拿到足够的数据，
 * 就停止继续下载。
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

    return cache.get(
      cacheKey
    );

  }


  let all = [];


  /*
   * 从当前月份开始，
   * 向过去寻找。
   */
  for(
    let offset = 0;
    offset < MAX_MONTHS_BACK;
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


      /*
       * 如果已经超过 LIMIT，
       * 可以停止下载。
       *
       * 后面统一排序 + 截取。
       */
      if(
        all.length >= LIMIT
      ){

        break;

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
   * 去重。
   *
   * 以 openTime 作为 K线唯一标识。
   */
  const unique =
    [];


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
   * 只保留最近 LIMIT 根。
   */
  const result =
    unique.length > LIMIT
      ? unique.slice(
          unique.length - LIMIT
        )
      : unique;


  /*
   * 如果数据太少，
   * 不要让前端误以为正常。
   */
  if(
    result.length === 0
  ){

    throw new Error(
      `${symbol} ${interval}：没有找到历史K线`
    );

  }


  /*
   * 放入缓存。
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
 * 前端调用：
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
       * 三个周期同时读取。
       *
       * 4H：
       * 大方向
       *
       * 1H：
       * 趋势确认
       *
       * 15M：
       * 交易
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
 * 如果以后想让 Render 重新下载数据，
 * 可以访问：
 *
 * /api/cache/clear
 *
 * ============================================================
 */

app.get(
  "/api/cache/clear",
  (req,res) => {

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
 * 方便我们以后排错。
 *
 * /api/status
 * ============================================================
 */

app.get(
  "/api/status",
  (req,res) => {

    return res.json({

      ok:true,

      source:
        "Binance Public Data",

      type:
        "USD-M Futures historical data",

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
 * Express 5 使用正则路由，
 * 避免 "*" 路由兼容问题。
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
