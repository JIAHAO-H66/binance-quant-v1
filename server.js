const express = require("express");
const path = require("path");

const app = express();

app.use(express.json());

/*
 * 静态网页
 */
app.use(express.static(__dirname));


/*
 * Binance USDT 永续合约 K 线接口
 *
 * 例如：
 * /api/klines?symbol=SOLUSDT&interval=4h&limit=1000
 */
app.get("/api/klines", async (req, res) => {

  const symbol = String(req.query.symbol || "").toUpperCase();

  const interval = String(
    req.query.interval || "4h"
  );

  let limit = Number(
    req.query.limit || 1000
  );


  /*
   * 基本检查
   */
  if (!/^[A-Z0-9_]+$/.test(symbol)) {

    return res.status(400).json({
      ok: false,
      error: "无效的 symbol"
    });

  }


  /*
   * Binance K线接口最多允许 1500 条。
   */
  if (!Number.isFinite(limit)) {
    limit = 1000;
  }

  limit = Math.max(
    1,
    Math.min(
      Math.floor(limit),
      1500
    )
  );


  /*
   * 只允许我们的策略使用的周期。
   */
  const allowedIntervals = [
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "6h",
    "8h",
    "12h",
    "1d"
  ];

  if (!allowedIntervals.includes(interval)) {

    return res.status(400).json({
      ok: false,
      error: "不支持的 K 线周期: " + interval
    });

  }


  /*
   * Binance USDⓈ-M Futures 公共行情接口。
   *
   * 不需要 API Key。
   */
  const url =
    "https://fapi.binance.com/fapi/v1/klines" +
    "?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    encodeURIComponent(limit);


  try {

    console.log(
      `[KLINES] ${symbol} ${interval} limit=${limit}`
    );


    /*
     * 请求 Binance
     */
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Quant-V1/1.0"
      }
    });


    /*
     * 先读取原始文本。
     *
     * 这样即使 Binance 返回错误页面，
     * 我们也不会因为 response.json()
     * 失败而再次出现“服务器返回格式错误”。
     */
    const text = await response.text();


    let result;

    try {

      result = JSON.parse(text);

    } catch (e) {

      console.error(
        "[BINANCE] 返回的不是 JSON:",
        text.slice(0, 500)
      );

      return res.status(502).json({
        ok: false,
        error:
          `${symbol}：Binance 返回的不是 JSON`
      });

    }


    /*
     * Binance HTTP 错误
     */
    if (!response.ok) {

      console.error(
        "[BINANCE ERROR]",
        response.status,
        result
      );

      return res.status(response.status).json({
        ok: false,
        error:
          result.msg ||
          result.message ||
          `${symbol}：Binance HTTP ${response.status}`
      });

    }


    /*
     * Binance 正常 K 线应该是数组。
     */
    if (!Array.isArray(result)) {

      console.error(
        "[BINANCE] K线格式异常:",
        result
      );

      return res.status(502).json({
        ok: false,
        error:
          `${symbol}：Binance 返回的 K 线格式异常`
      });

    }


    /*
     * 转换成前端 calc() 使用的格式：
     *
     * {
     *   openTime,
     *   open,
     *   high,
     *   low,
     *   close,
     *   volume
     * }
     */
    const data = result
      .filter(row =>
        Array.isArray(row) &&
        row.length >= 6
      )
      .map(row => ({

        openTime: Number(row[0]),

        open: Number(row[1]),

        high: Number(row[2]),

        low: Number(row[3]),

        close: Number(row[4]),

        volume: Number(row[5]),

        closeTime: Number(row[6])

      }))
      .filter(row =>
        Number.isFinite(row.open) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low) &&
        Number.isFinite(row.close)
      );


    /*
     * 没有有效行情
     */
    if (data.length === 0) {

      return res.status(502).json({
        ok: false,
        error:
          `${symbol}：没有获得有效 K 线数据`
      });

    }


    console.log(
      `[KLINES OK] ${symbol}: ${data.length} candles`
    );


    /*
     * 返回给 index.html
     *
     * 这正好对应你前端的：
     *
     * result.ok
     * result.data
     */
    return res.json({
      ok: true,
      symbol: symbol,
      interval: interval,
      data: data
    });


  } catch (error) {

    console.error(
      `[KLINES FAILED] ${symbol}`,
      error
    );


    return res.status(500).json({
      ok: false,
      error:
        `${symbol}：服务器请求 Binance 失败：` +
        (error.message || "未知错误")
    });

  }

});


/*
 * 健康检查
 *
 * 以后打开：
 * /health
 *
 * 如果看到 {"ok":true}
 * 就说明 Render 后端正常。
 */
app.get("/health", (req, res) => {

  res.json({
    ok: true,
    service: "Quant V1",
    time: new Date().toISOString()
  });

});


/*
 * 注意：
 *
 * /api/klines 和 /health
 * 必须放在下面这个通配页面之前。
 *
 * 否则 Express 会先返回 index.html。
 */
app.get("*", (req, res) => {

  res.sendFile(
    path.join(__dirname, "index.html")
  );

});


/*
 * Render 会自动提供 PORT。
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
