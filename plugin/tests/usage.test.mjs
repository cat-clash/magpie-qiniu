// plugin/tests/usage.test.mjs —— 用量映射层单测（node:test，不联网）
// 覆盖：七牛真实资源包字段（total_amount/used_amount + k/tokens 单位）解析、
//       现金余额 0 不再伪装成 used:100 导致 magpie 判定账号耗尽。
// 跑法：bun test plugin/tests/usage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRespack, buildUsage } from "../src/usage.mjs";

// 复刻七牛 billing-api/v1/respack/list 的真实返回（已脱敏），单位 k/tokens。
const LIVE_RESPACK = {
  data: [
    {
      respack_name: "实时推理全系列模型 300W (新用户体验包)",
      effective_start: "2026-11-01T00:00:00+08:00",
      effective_end: "2027-02-01T00:00:00+08:00",
      carry_over_policy: 2,
      status: 2,
      used_amount: 990,
      total_amount: 3000,
      respack_unit: "k/tokens",
      data_update_time: "2026-11-25T06:32:43+08:00",
      order_hash: "aaa",
      po_id: 3912162,
    },
    {
      respack_name: "【新用户】体验奖励",
      effective_start: "2026-11-01T00:00:00+08:00",
      effective_end: "2027-11-01T00:00:00+08:00",
      status: 2,
      used_amount: 0,
      total_amount: 3000,
      respack_unit: "k/tokens",
      order_hash: "bbb",
      po_id: 3912165,
    },
    {
      respack_name: "【新用户】个人实名认证奖励",
      effective_start: "2026-11-01T00:00:00+08:00",
      effective_end: "2027-11-01T00:00:00+08:00",
      status: 2,
      used_amount: 0,
      total_amount: 2000,
      respack_unit: "k/tokens",
      order_hash: "ccc",
      po_id: 3915286,
    },
  ],
};

const ZERO_BALANCE = { available: 0, cash: 0, present: 0, creditLine: 0, unpaid: null, currency: "CNY", email: "u@example.com", accountId: "1001" };

test("readRespack 解析七牛真实字段 total_amount/used_amount 并换算 k/tokens", () => {
  const pack = readRespack(LIVE_RESPACK);
  assert.ok(pack, "应解析出资源包而非 undefined");
  assert.equal(pack.aggregated, true);
  assert.equal(pack.packCount, 3);
  assert.equal(pack.allTotal, 8_000_000, "三个包总量 800万 tokens（3000+3000+2000 k → ×1000）");
  assert.equal(pack.totalUsed, 990_000, "990 k/tokens → 990000 tokens（聚合已用）");
  assert.equal(pack.totalRest, 7_010_000, "剩余合计 201万+300万+200万");
  assert.equal(pack.total, 3_000_000, "top 包单包总量换算 3000 k → 300万");
});

test("readRespack 把剩余最多的包排第一，并过滤已失效包", () => {
  const withExpired = {
    data: [
      { ...LIVE_RESPACK.data[0], respack_name: "大额已过期", total_amount: 9999, status: 3 },
      LIVE_RESPACK.data[1],
    ],
  };
  const pack = readRespack(withExpired);
  assert.equal(pack.name, "【新用户】体验奖励", "status 3 的包应被过滤");
  assert.equal(pack.packCount, 1);
});

test("readRespack 兼容旧字段 total/used（裸 token 不换算）", () => {
  const pack = readRespack({ data: [{ name: "旧包", total: 5000, used: 100 }] });
  assert.equal(pack.total, 5000);
  assert.equal(pack.used, 100);
});

test("buildUsage：现金余额 0 时资源包是唯一主窗口，余额窗口 aside 不判耗尽", () => {
  const usage = buildUsage({
    account: { accessKey: "AK", secretKey: "SK" },
    respack: LIVE_RESPACK.data,
    balance: ZERO_BALANCE,
  });
  const main = usage.windows.filter((w) => !w.aside && w.unit === "tokens");
  assert.equal(main.length, 1, "只有一个 token 主窗口参与路由");
  assert.equal(main[0].amount, 7_010_000, "主窗口展示三个包剩余合计 701万 tokens");
  assert.equal(main[0].limit, 8_000_000, "分母为三包总量 800万");
  assert.equal(main[0].used, 12, "已用 99万/总量 800万 ≈ 12%");
  const cash = usage.windows.find((w) => /现金余额|账户余额/.test(w.name));
  assert.ok(cash, "仍展示现金余额窗口");
  assert.equal(cash.aside, true, "余额窗口必须 aside，不能参与路由");
  assert.notEqual(cash.used, 100, "绝不能出现 used:100（会被判额度耗尽）");
  assert.match(cash.display, /资源包可正常调用/);
});

test("buildUsage：无资源包且余额 0 时也绝不出现 used:100 的非 aside 窗口", () => {
  const usage = buildUsage({
    account: { accessKey: "AK", secretKey: "SK" },
    balance: ZERO_BALANCE,
  });
  const exhaust = usage.windows.filter((w) => !w.aside && w.remaining === 0);
  assert.equal(exhaust.length, 0, "不能有任何非 aside 且剩余为 0 的窗口");
  const cash = usage.windows.find((w) => /现金余额|账户余额/.test(w.name));
  assert.equal(cash.aside, true);
  assert.match(cash.display, /请充值/);
});
