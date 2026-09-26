const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));


/*
 * Binance USDT 永续公开行情
 */
const BINANCE_BASE =
  "https://fapi.binance.com";


/*
 * 每个周期最多读取 1000 根。
 *
 * 注意：
 * 这里没有使用 3000 根。
 */
const LIMIT = 1000;


/*
 * 把 Binance K线转换成前端需要的格式
 */
function parseKlines(rows){

  return rows.map(row => ({

    openTime: Number(row[0]),

    open: Number(row[1]),

    high: Number(row[2]),

    low: Number(row[3]),

    close: Number(row[4]),

    volume: Number(row[5]),

    closeTime: Number(row[6])

  }));

}


/*
 * 获取 Binance K线
 */
async function fetchKlines(
  symbol,
  interval
){

  const url =
    BINANCE_BASE +
    "/fapi/v1/klines" +
    "?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    interval +
    "&limit=" +
    LIMIT;


  const response =
    await fetch(url);


  let data;


  try{

    data =
      await response.json();

  }catch{

    throw new Error(
      symbol +
      " " +
      interval +
      "：Binance返回格式错误"
    );

  }


  if(!response.ok){

    throw new Error(
      symbol +
      " " +
      interval +
      "：" +
      (
        data &&
        data.msg
          ? data.msg
          : "HTTP " +
            response.status
      )
    );

  }


  if(!Array.isArray(data)){

    throw new Error(
      symbol +
      " " +
      interval +
      "：没有K线数据"
    );

  }


  return parseKlines(data);

}


/*
 * 多周期行情接口
 *
 * 前端访问：
 *
 * /api/market?symbol=SOLUSDT
 *
 * 返回：
 *
 * 4H
 * 1H
 * 15M
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
       * 三个周期同时读取
       */

      const [
        data4h,
        data1h,
        data15m
      ] =
        await Promise.all([

          fetchKlines(
            symbol,
            "4h"
          ),

          fetchKlines(
            symbol,
            "1h"
          ),

          fetchKlines(
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
            "获取行情失败"

        });

    }

  }
);


/*
 * 前端页面
 *
 * 使用正则写法，
 * 避免 Express 新版本
 * 对 "*" 路由的兼容问题。
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
 * Render 会提供 PORT。
 *
 * 本地运行则使用 3000。
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
