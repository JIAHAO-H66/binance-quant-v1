const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

/*
 * Binance USDT 永续 4H K线代理
 *
 * 前端请求：
 * /api/klines?symbol=SOLUSDT&interval=4h&limit=3000
 *
 * Binance 单次最多取 1500 根，
 * 所以这里自动分批读取，再合并返回。
 */
app.get("/api/klines", async (req, res) => {

  try {

    const symbol =
      String(req.query.symbol || "").toUpperCase();

    const interval =
      String(req.query.interval || "4h");

    let limit =
      Number(req.query.limit || 3000);

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "缺少 symbol"
      });
    }

    if (!Number.isFinite(limit)) {
      limit = 3000;
    }

    limit = Math.max(1, Math.min(limit, 5000));

    const all = [];

    let endTime = Date.now();

    while (all.length < limit) {

      const batchLimit =
        Math.min(1500, limit - all.length);

      const url =
        "https://fapi.binance.com/fapi/v1/klines" +
        "?symbol=" +
        encodeURIComponent(symbol) +
        "&interval=" +
        encodeURIComponent(interval) +
        "&limit=" +
        batchLimit +
        "&endTime=" +
        endTime;

      const response =
        await fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

      const text =
        await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          "Binance 返回的不是 JSON：" +
          text.slice(0, 200)
        );
      }

      if (!response.ok) {

        throw new Error(
          data && data.msg
            ? data.msg
            : "Binance HTTP " + response.status
        );
      }

      if (!Array.isArray(data)) {

        throw new Error(
          "Binance 返回格式错误"
        );
      }

      if (data.length === 0) {
        break;
      }

      /*
       * Binance 返回：
       *
       * [
       *   openTime,
       *   open,
       *   high,
       *   low,
       *   close,
       *   volume,
       *   ...
       * ]
       */

      const converted =
        data.map(k => ({
          time: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5])
        }));

      all.push(...converted);

      /*
       * 下一批向更早的数据继续读取。
       */
      const oldest =
        converted[0].time;

      endTime =
        oldest - 1;

      if (data.length < batchLimit) {
        break;
      }

      /*
       * 防止异常情况下死循环。
       */
      if (all.length >= limit) {
        break;
      }
    }

    /*
     * 去重
     */
    const unique =
      Array.from(
        new Map(
          all.map(x => [x.time, x])
        ).values()
      );

    /*
     * 从旧到新排序。
     */
    unique.sort(
      (a, b) => a.time - b.time
    );

    /*
     * 最后只保留要求的数量。
     */
    const result =
      unique.slice(-limit);

    return res.json({
      ok: true,
      symbol,
      interval,
      count: result.length,
      data: result
    });

  } catch (err) {

    console.error(
      "Kline error:",
      err
    );

    return res.status(500).json({
      ok: false,
      error:
        err.message ||
        "服务器读取行情失败"
    });
  }
});


/*
 * 首页
 */
app.get("*", (req, res) => {

  res.sendFile(
    path.join(__dirname, "index.html")
  );

});


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
