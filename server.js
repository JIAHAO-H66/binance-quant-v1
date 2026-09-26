const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


/*
 * Binance Public Data
 *
 * 不再调用：
 *
 * https://fapi.binance.com
 *
 * 而是读取 Binance 官方公开历史数据。
 */
const BINANCE_DATA_BASE =
  "https://data.binance.vision";


/*
 * 我们只做历史回测。
 *
 * 不使用 3000 根。
 *
 * 每个周期最多读取 1000 根。
 */
const LIMIT = 1000;


/*
 * 将 Binance CSV 行
 * 转换成前端需要的格式。
 *
 * Binance K线格式：
 *
 * 0 open time
 * 1 open
 * 2 high
 * 3 low
 * 4 close
 * 5 volume
 * 6 close time
 */
function parseCsv(text){

  const lines =
    text
      .trim()
      .split(/\r?\n/);

  const result = [];


  for(const line of lines){

    if(!line.trim()){
      continue;
    }


    const row =
      line.split(",");


    if(row.length < 7){
      continue;
    }


    const openTime =
      Number(row[0]);


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


    /*
     * 排除标题行或坏数据
     */
    if(
      !Number.isFinite(openTime) ||
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


  /*
   * 按时间排序
   */
  result.sort(
    (a,b) =>
      a.openTime -
      b.openTime
  );


  return result;

}


/*
 * 获取 Binance 历史数据。
 *
 * 注意：
 *
 * Binance Public Data 的历史文件
 * 按月 / 日存放。
 *
 * 为了避免一次下载大量文件，
 * 这里优先读取最近的月度文件。
 */
async function fetchHistoricalKlines(
  symbol,
  interval
){

  /*
   * 当前 UTC 日期
   */
  const now =
    new Date();


  /*
   * 当前年月
   */
  const year =
    now.getUTCFullYear();


  const month =
    String(
      now.getUTCMonth() + 1
    ).padStart(2,"0");


  /*
   * Binance Futures
   * 月度 K线文件
   *
   * data/futures/um/monthly/klines/...
   */
  const url =
    BINANCE_DATA_BASE +
    "/data/futures/um/monthly/klines/" +
    symbol +
    "/" +
    interval +
    "/" +
    symbol +
    "-" +
    interval +
    "-" +
    year +
    "-" +
    month +
    ".zip";


  /*
   * 说明：
   *
   * 当前代码先尝试直接读取公开数据。
   *
   * 如果当前月份文件不存在，
   * 后面可以继续增加月份回溯。
   */


  const response =
    await fetch(url);


  if(!response.ok){

    throw new Error(
      symbol +
      " " +
      interval +
      "：历史数据文件不存在或暂时不可用（HTTP " +
      response.status +
      "）"
    );

  }


  /*
   * ZIP 数据不能直接当 CSV。
   *
   * 这里明确告诉前端：
   * 当前服务器需要 ZIP 解压能力。
   */
  throw new Error(
    symbol +
    " " +
    interval +
    "：历史数据为 ZIP 文件，需要服务器解压后读取"
  );

}


/*
 * 多周期行情接口
 *
 * 前端：
 *
 * /api/market?symbol=SOLUSDT
 *
 * 返回：
 *
 * 4h
 * 1h
 * 15m
 */
app.get(
  "/api/market",
  async (req,res) => {

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


      /*
       * 三个周期
       *
       * 4H
       * 1H
       * 15M
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
       * 返回给前端
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
        "Historical market error:",
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
 * 前端页面
 *
 * Express 新版本使用正则，
 * 避免 "*" 路由兼容问题。
 */
app.get(
  /.*/,
  (req,res) => {

    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );

  }
);


/*
 * Render PORT
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
