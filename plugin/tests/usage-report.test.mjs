// plugin/tests/usage-report.test.mjs —— 用量展示层（usage-report.mjs）单测，不联网、不碰 IO。
// 覆盖：kToken→token 只换算一次、缺 buckets 的退化、share 归一、中文等宽排版、总结行口径，
//       以及一份自造的 3 天 /v3/stat/usage 响应走 normalizeUsageSeries → dailyRows 的实链路。
// 跑法：node --test plugin/tests/usage-report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsageSeries } from "../src/usage-api.mjs";
import {
  dailyRows,
  formatTokens,
  modelRows,
  renderTable,
  summaryLine,
  tokenTotal,
} from "../src/usage-report.mjs";

// 上游 normalizeUsageSeries 的形状：input/output/cached 都是 kToken（千 token）。
const SERIES_2D = [
  {
    model: "deepseek/deepseek-v4-flash",
    input: 300,
    output: 60,
    cached: 0,
    points: 0,
    buckets: [
      { time: "2026-11-25T00:00:00+08:00", input: 100, output: 20 },
      { time: "2026-11-26T00:00:00+08:00", input: 200, output: 40 },
    ],
  },
  {
    model: "qwen/qwen3.8-max",
    input: 12,
    output: 3,
    cached: 0,
    points: 0,
    buckets: [
      { time: "2026-11-25T00:00:00+08:00", input: 10, output: 2 },
      { time: "2026-11-26T00:00:00+08:00", input: 2, output: 1 },
    ],
  },
];

// ── dailyRows ──────────────────────────────────────────────────────────────

test("dailyRows 把多模型多桶按天汇总，并按日期升序", () => {
  const rows = dailyRows(SERIES_2D);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2026-11-25", "2026-11-26"],
  );
  // 11-25：(100+10) k = 110000 token 输入，(20+2) k = 22000 输出
  assert.equal(rows[0].input, 110_000);
  assert.equal(rows[0].output, 22_000);
  assert.equal(rows[0].total, 132_000);
  // 11-26：(200+2) k / (40+1) k
  assert.equal(rows[1].input, 202_000);
  assert.equal(rows[1].output, 41_000);
  assert.equal(rows[1].total, 243_000);
});

test("dailyRows 单位是 kToken×1000：单个桶 1 kToken = 1000 token", () => {
  const rows = dailyRows([{ model: "m", buckets: [{ time: "2026-11-25T08:00:00+08:00", input: 1, output: 0.5 }] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 1000);
  assert.equal(rows[0].output, 500, "0.5 kToken 也要换回 500 token，而不是截断成 0");
  assert.equal(rows[0].total, 1500);
});

test("dailyRows 没有 buckets 时退化成「全部算一天」，date 为空串且不抛", () => {
  const rows = dailyRows([{ model: "a", input: 3, output: 1, cached: 1 }, { model: "b", input: 2, output: 2 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "", "缺 buckets 时不猜日期，date 用空串");
  assert.equal(rows[0].input, 5000);
  assert.equal(rows[0].output, 3000);
  assert.equal(rows[0].cached, 1000);
  assert.equal(rows[0].total, 8000);
});

test("dailyRows 空数组 / 非数组都返回空表", () => {
  assert.deepEqual(dailyRows([]), []);
  assert.deepEqual(dailyRows(undefined), []);
  assert.deepEqual(dailyRows(null), []);
});

test("dailyRows 桶里没有 cached 时，按各桶 token 占比摊分行上的 cached", () => {
  const rows = dailyRows([
    {
      model: "m",
      cached: 10, // 10 kToken = 10000 token
      buckets: [
        { time: "2026-11-25T00:00:00+08:00", input: 75, output: 0 },
        { time: "2026-11-26T00:00:00+08:00", input: 25, output: 0 },
      ],
    },
  ]);
  assert.equal(rows[0].cached, 7500, "75/100 的占比");
  assert.equal(rows[1].cached, 2500, "25/100 的占比");
});

// ── modelRows ──────────────────────────────────────────────────────────────

test("modelRows 的 share 之和为 1，且 total 降序", () => {
  const rows = modelRows(SERIES_2D);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "deepseek/deepseek-v4-flash", "token 多的排前面");
  assert.equal(rows[0].total, 360_000); // (300+60) k
  assert.equal(rows[1].total, 15_000); // (12+3) k
  const sum = rows.reduce((a, r) => a + r.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `share 之和应为 1，实际 ${sum}`);
  assert.ok(rows[0].share > rows[1].share);
});

test("modelRows 总量为 0 时 share 全为 0（不做 0/0）", () => {
  const rows = modelRows([
    { model: "a", input: 0, output: 0, buckets: [] },
    { model: "b", input: 0, output: 0, buckets: [] },
  ]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.share, 0);
  assert.equal(rows[0].model, "a", "total 相同时按模型名升序，排序稳定");
});

// ── tokenTotal ─────────────────────────────────────────────────────────────

test("tokenTotal 汇总 dailyRows / modelRows 得到同一份合计", () => {
  const a = tokenTotal(dailyRows(SERIES_2D));
  const b = tokenTotal(modelRows(SERIES_2D));
  assert.deepEqual(a, b, "两条路径的合计必须一致（312000 输入 / 63000 输出）");
  assert.equal(a.input, 312_000);
  assert.equal(a.output, 63_000);
  assert.equal(a.total, 375_000);
  assert.equal(a.cached, 0);
});

test("tokenTotal 对空表给全 0 而不是 NaN", () => {
  assert.deepEqual(tokenTotal([]), { input: 0, output: 0, cached: 0, total: 0 });
  assert.deepEqual(tokenTotal(undefined), { input: 0, output: 0, cached: 0, total: 0 });
});

// ── formatTokens ───────────────────────────────────────────────────────────

test("formatTokens 边界：0 / 999 / 1e4 / 1e8", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(10_000), "1 万");
  assert.equal(formatTokens(45_000), "4.5 万");
  assert.equal(formatTokens(100_000_000), "1 亿");
  assert.equal(formatTokens(123_456_789), "1.23 亿");
  assert.equal(formatTokens(17_000_000), "1700 万");
  assert.equal(formatTokens(NaN), "0", "坏值不吐 NaN 字符串");
});

// ── renderTable ────────────────────────────────────────────────────────────

/** 测试用的显示宽度（与实现同口径：[^\x00-\xff] 记 2 列）。 */
function width(s) {
  let n = 0;
  for (const ch of String(s)) n += /[^\x00-\xff]/.test(ch) ? 2 : 1;
  return n;
}

test("renderTable 中文按 2 列宽对齐：表头与两行数据的第二列都从同一列开始", () => {
  const lines = renderTable({
    title: "按模型",
    headers: ["模型", "合计"],
    rows: [
      ["模型甲", "812"],
      ["模型乙长名字", "4.5 万"],
    ],
  });
  assert.equal(lines[0], "按模型");
  assert.equal(lines.length, 4, "title + 表头 + 2 行数据");
  // 第二列内容之前的显示宽度 = 第一列最宽值（"模型乙长名字" 6 字 = 12 列）+ 2 空格
  const values = ["合计", "812", "4.5 万"];
  const starts = lines.slice(1).map((line, i) => width(line.slice(0, line.indexOf(values[i]))));
  assert.deepEqual(starts, [14, 14, 14], `列边界应一致：${JSON.stringify(starts)}`);
  assert.equal(starts[0], width("模型乙长名字") + 2);
  for (const line of lines) assert.doesNotMatch(line, / +$/, `行尾不留多余空格：${JSON.stringify(line)}`);
});

test("renderTable 空 rows 也返回表头（只有 title + 表头两行）", () => {
  const lines = renderTable({ title: "按天", headers: ["日期", "输入", "输出", "合计"], rows: [], aligns: ["left", "right", "right", "right"] });
  assert.deepEqual(lines, ["按天", "日期  输入  输出  合计"], "空表也要给出可读表头");
});

test("renderTable 数字列右对齐、缺列用空串补齐，没给 aligns 时默认左对齐", () => {
  assert.deepEqual(renderTable({ headers: ["a", "b"], rows: [["x"]] }), ["a  b", "x"]);
  const right = renderTable({ headers: ["k", "v"], rows: [["x", "1"], ["yy", "22"]], aligns: ["left", "right"] });
  assert.deepEqual(right, ["k    v", "x    1", "yy  22"], "第二列右对齐：数字右边缘对齐在同一列");
});

// ── summaryLine ────────────────────────────────────────────────────────────

test("summaryLine 有花费：中文一句话，含天数 / token / 花费 / 日均", () => {
  // 119000000 token / 7 天 = 1700 万/天，正好对上「日均 1700 万」这个例子
  assert.equal(
    summaryLine({ days: 7, total: 119_000_000, cost: 3.45 }),
    "近 7 天 1.19 亿 tokens · 花费 ¥3.45 · 日均 1700 万",
  );
});

test("summaryLine 无花费：省掉花费段，不写 ¥0 骗人", () => {
  assert.equal(summaryLine({ days: 1, total: 812 }), "近 1 天 812 tokens · 日均 812");
  assert.equal(summaryLine({ days: 3, total: 3000, cost: null }), "近 3 天 3000 tokens · 日均 1000");
  // cost 允许传 normalizeCost() 的结果
  assert.equal(summaryLine({ days: 2, total: 2000, cost: { totalFee: 0.0005, currency: "CNY" } }), "近 2 天 2000 tokens · 花费 ¥0.0005 · 日均 1000");
});

// ── 真实夹具：/v3/stat/usage 响应 → normalizeUsageSeries → dailyRows ─────────

const LIVE_USAGE_3D = {
  status: true,
  data: {
    usage: [
      {
        model: "deepseek/deepseek-v4-flash",
        series: [
          { time: "2026-11-25T00:00:00+08:00", input: 100, output: 20 },
          { time: "2026-11-26T00:00:00+08:00", input: 50, output: 5 },
        ],
      },
      {
        model: "qwen/qwen3.8-max",
        series: [
          { time: "2026-11-25T00:00:00+08:00", input: 10, output: 2 },
          { time: "2026-11-27T00:00:00+08:00", input: 1, output: 1 },
        ],
      },
    ],
  },
};

test("真实夹具：3 天的 /v3/stat/usage 响应 → normalizeUsageSeries → dailyRows 合计正确", () => {
  const series = normalizeUsageSeries(LIVE_USAGE_3D);
  assert.equal(series.length, 2, "两个模型");

  const rows = dailyRows(series);
  assert.deepEqual(
    rows.map((r) => r.date),
    ["2026-11-25", "2026-11-26", "2026-11-27"],
    "三天各一行，升序",
  );
  assert.equal(rows[0].total, 132_000); // (100+20+10+2) k
  assert.equal(rows[1].total, 55_000); // (50+5) k
  assert.equal(rows[2].total, 2000); // (1+1) k

  const total = tokenTotal(rows);
  assert.equal(total.total, 189_000, "3 天合计 189000 token");
  assert.equal(total.input, 161_000);
  assert.equal(total.output, 28_000);
  // 与模型维度对齐（share 归一后仍能还原总量）
  const models = modelRows(series);
  assert.equal(tokenTotal(models).total, total.total);
  assert.ok(Math.abs(models.reduce((a, r) => a + r.share, 0) - 1) < 1e-12);
});

test("真实夹具：summaryLine 读 dailyRows 的合计，天数由调用方给", () => {
  const series = normalizeUsageSeries(LIVE_USAGE_3D);
  const total = tokenTotal(dailyRows(series));
  assert.equal(summaryLine({ days: 3, total: total.total }), "近 3 天 18.9 万 tokens · 日均 6.3 万");
});
