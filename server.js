const express = require("express");
const path = require("path");
const https = require("https");
const AdmZip = require("adm-zip");

const app = express();

app.use(express.static(__dirname));

/*
 * 回测币种
 */
const symbols = [
  "SOLUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
  "APTUSDT",
  "NEARUSDT",
  "INJUSDT"
];


/*
 * 下载 HTTPS 文件
 */
function download(url) {
  return new Promise((resolve, reject) => {

    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {

      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        return download(res.headers.location)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(
          new Error(
            "HTTP " + res.statusCode
          )
        );
        res.resume();
        return;
      }

      const chunks = [];

      res.on("data", chunk => {
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve(Buffer.concat(chunks));
      });

    }).on("error", reject);
  });
}


/*
 * 获取指定月份的 USD-M Futures 4H K线
 *
 * Binance 官方公开历史数据：
 *
 * data.binance.vision
 *
 * 文件格式：
 *
 * /data/futures/um/monthly/klines/
 * SYMBOL/4h/
 * SYMBOL-4h-YYYY-MM.zip
 */
async function getMonth(symbol, year, month) {

  const mm =
    String(month).padStart(2, "0");

  const ym =
    year + "-" + mm;

  const url =
    "https://data.binance.vision/data/futures/um/monthly/klines/" +
    symbol +
    "/4h/" +
    symbol +
    "-4h-" +
    ym +
    ".zip";

  const zipBuffer =
    await download(url);

  const zip =
    new AdmZip(zipBuffer);

  const entries =
    zip.getEntries();

  if (!entries.length) {
    throw new Error(
      symbol + " " + ym + "：ZIP为空"
    );
  }

  const csv =
    entries[0]
      .getData()
      .toString("utf8");

  const lines =
    csv
      .split(/\r?\n/)
      .filter(Boolean);

  const data = [];

  for (const line of lines) {

    /*
     * 跳过表头
     */
    if (
      line.toLowerCase().startsWith("open time")
    ) {
      continue;
    }

    const p =
      line.split(",");

    if (p.length < 6) {
      continue;
    }

    const open =
      Number(p[1]);

    const high =
      Number(p[2]);

    const low =
      Number(p[3]);

    const close =
      Number(p[4]);

    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    data.push({
      time: Number(p[0]),
      open,
      high,
      low,
      close
    });
  }

  return data;
}


/*
 * 获取最近约1000根4H K线
 *
 * 1000根4H ≈ 166天
 *
 * 所以读取最近7个月，
 * 再截取最后1000根。
 */
async function get(symbol) {

  const now =
    new Date();

  const months = [];

  /*
   * 当前月份往前取7个月
   */
  for (let i = 7; i >= 0; i--) {

    const d =
      new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() - i,
          1
        )
      );

    months.push({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1
    });
  }

  const all = [];

  /*
   * 一个一个月份下载
   */
  for (const m of months) {

    try {

      const rows =
        await getMonth(
          symbol,
          m.year,
          m.month
        );

      all.push(...rows);

    } catch (err) {

      /*
       * 当前月份可能还没有月度文件。
       * 这种情况直接跳过。
       */
      console.log(
        "跳过 " +
        symbol +
        " " +
        m.year +
        "-" +
        String(m.month).padStart(2, "0") +
        ": " +
        err.message
      );
    }
  }

  /*
   * 按时间排序
   */
  all.sort(
    (a, b) =>
      a.time - b.time
  );

  /*
   * 删除重复K线
   */
  const unique = [];

  let lastTime = null;

  for (const row of all) {

    if (row.time === lastTime) {
      continue;
    }

    unique.push(row);

    lastTime = row.time;
  }

  /*
   * 只取最后1000根
   */
  return unique.slice(-1000);
}


/*
 * EMA
 */
function ema(a, n) {

  if (!a.length) {
    return [];
  }

  const k =
    2 / (n + 1);

  let e = a[0];

  const out = [e];

  for (
    let i = 1;
    i < a.length;
    i++
  ) {

    e =
      a[i] * k +
      e * (1 - k);

    out.push(e);
  }

  return out;
}


/*
 * ATR
 */
function atr(data, n = 14) {

  const out =
    new Array(data.length)
      .fill(NaN);

  for (
    let i = 1;
    i < data.length;
    i++
  ) {

    const prevClose =
      data[i - 1].close;

    const tr =
      Math.max(
        data[i].high -
          data[i].low,

        Math.abs(
          data[i].high -
          prevClose
        ),

        Math.abs(
          data[i].low -
          prevClose
        )
      );

    data[i]._tr = tr;
  }

  for (
    let i = n;
    i < data.length;
    i++
  ) {

    let sum = 0;

    for (
      let j = i - n + 1;
      j <= i;
      j++
    ) {
      sum +=
        data[j]._tr || 0;
    }

    out[i] =
      sum / n;
  }

  return out;
}


/*
 * 单币种回测
 */
function calc(data) {

  if (
    !data ||
    data.length < 220
  ) {
    return [];
  }

  const c =
    data.map(
      x => x.close
    );

  const e50 =
    ema(c, 50);

  const e200 =
    ema(c, 200);

  const a =
    atr(data, 14);

  const trades = [];

  let pos = 0;

  let entry = 0;

  for (
    let i = 200;
    i < data.length;
    i++
  ) {

    if (
      !Number.isFinite(a[i])
    ) {
      continue;
    }

    const mom =
      c[i] /
      c[i - 20] -
      1;

    /*
     * 没有持仓
     */
    if (pos === 0) {

      /*
       * 多
       */
      if (
        e50[i] >
          e200[i] &&
        mom > 0
      ) {

        pos = 1;

        entry =
          c[i];

        continue;
      }

      /*
       * 空
       */
      if (
        e50[i] <
          e200[i] &&
        mom < 0
      ) {

        pos = -1;

        entry =
          c[i];

        continue;
      }
    }


    /*
     * 多单
     */
    if (pos === 1) {

      const stop =
        entry -
        1.5 * a[i];

      const trendBroken =
        !(
          e50[i] >
            e200[i] &&
          mom > 0
        );

      const stopHit =
        c[i] <= stop;

      if (
        stopHit ||
        trendBroken
      ) {

        const gross =
          (c[i] - entry) /
          entry;

        const net =
          gross - 0.001;

        trades.push({
          side: "LONG",
          entry,
          exit: c[i],
          ret: net
        });

        pos = 0;

        entry = 0;
      }
    }


    /*
     * 空单
     */
    else if (pos === -1) {

      const stop =
        entry +
        1.5 * a[i];

      const trendBroken =
        !(
          e50[i] <
            e200[i] &&
          mom < 0
        );

      const stopHit =
        c[i] >= stop;

      if (
        stopHit ||
        trendBroken
      ) {

        const gross =
          (entry - c[i]) /
          entry;

        const net =
          gross - 0.001;

        trades.push({
          side: "SHORT",
          entry,
          exit: c[i],
          ret: net
        });

        pos = 0;

        entry = 0;
      }
    }
  }

  return trades;
}


/*
 * API
 */
app.get(
  "/api/klines",
  async (req, res) => {

    const symbol =
      String(
        req.query.symbol || ""
      ).toUpperCase();

    if (
      !symbols.includes(symbol)
    ) {

      return res.status(400).json({
        ok: false,
        error:
          "不支持的币种：" +
          symbol
      });
    }

    try {

      console.log(
        "Loading public historical data:",
        symbol
      );

      const data =
        await get(symbol);

      if (
        !data.length
      ) {

        throw new Error(
          "没有获取到历史K线"
        );
      }

      console.log(
        symbol +
        ": loaded " +
        data.length +
        " candles"
      );

      res.json({
        ok: true,
        symbol,
        data
      });

    } catch (err) {

      console.error(
        symbol,
        err
      );

      res.status(500).json({
        ok: false,
        error:
          symbol +
          "：" +
          err.message
      });
    }
  }
);


/*
 * 首页
 */
app.get("*", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});


/*
 * Render 端口
 */
const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "Server running on port " +
      PORT
    );
  }
);
