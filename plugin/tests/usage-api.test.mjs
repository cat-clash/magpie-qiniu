// plugin/tests/usage-api.test.mjs —— A3 用量接口层单测（node:test，全部不联网）
// 跑法：bun test plugin/tests/usage-api.test.mjs   （或 node --test）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  UsageApiError,
  usageEndpoints,
  fetchUsageSeries,
  fetchApiKeyCost,
  fetchCostDetail,
  fetchExportLog,
  fetchKeyQuota,
  fetchBalanceOverview,
  fetchRespackList,
  createInferenceKey,
  normalizeUsageSeries,
  normalizeCost,
  normalizeBalance,
  mask,
  scrub,
} from "../src/usage-api.mjs";

const SRC = fileURLToPath(new URL("../src/usage-api.mjs", import.meta.url));

// 测试用假凭证（不联网，不含真实密钥）
const FAKE_SK = "sk-TESTKEY0123456789";
const FAKE_AK = "AKTEST0123456789";
const FAKE_SK_SEC = "SKTEST0123456789";
const NEW_SK = "sk-NEWKEY0123456789";
const PATH_SK = "sk-abc/def=12345678"; // 含 / 与 =，验证 path 编码

const KEY_ACCOUNT = { mode: "key", apiKey: FAKE_SK, accessKey: "", secretKey: "", accountId: "acc-1", uid: "uid-1" };
const AKSK_ACCOUNT = { mode: "aksk", apiKey: "", accessKey: FAKE_AK, secretKey: FAKE_SK_SEC, accountId: "acc-2", uid: "uid-2" };
const NOW = Date.parse("2026-11-25T02:00:00Z"); // +08:00 → 本地 10:00
const FAKE_AUTH = `Qiniu ${FAKE_AK}:SIGVALUE0123456789`;

function respond({ status = 200, body, text, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    async text() {
      if (text !== undefined) return text;
      return body === undefined ? "" : JSON.stringify(body);
    },
  };
}

function fakeFetch(make) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, headers: init.headers || {} });
    return typeof make === "function" ? make(url, init, calls.length - 1) : make;
  };
  fn.calls = calls;
  return fn;
}

function queryOf(url) {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

// ── 模块自洽性 ────────────────────────────────────────────────

test("usage-api.mjs 零 import 自洽（不依赖 sign.mjs / http.mjs）", () => {
  const raw = readFileSync(SRC, "utf8");
  const src = raw
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.equal(/^\s*import\s/m.test(src), false, "不应出现 import 语句");
  assert.equal(/\brequire\s*\(/.test(src), false, "不应出现 require()");
  assert.equal(/\bfrom\s+["']/.test(src), false, "不应出现任何模块说明符");
  assert.equal(/import\w*\s*\(\s*["'].*(sign|http)\.mjs/.test(src), false, "不得动态引用 A2/主控模块");
});

test("CONTRACT §0：不存在任何签到钩子/导出", async () => {
  const src = readFileSync(SRC, "utf8");
  assert.equal(/checkin|check_in|sign_in_bonus/i.test(src), false, "源码不得出现签到字样");
  const mod = await import("../src/usage-api.mjs");
  for (const k of Object.keys(mod)) assert.equal(/checkin|signin/i.test(k), false, `导出 ${k} 违规`);
});

test("usageEndpoints 端点表精确", () => {
  const EP = usageEndpoints();
  assert.equal(EP.usage, "https://api.qnaigc.com/v3/stat/usage");
  assert.equal(EP.apiKeyCost, "https://api.qnaigc.com/v3/stat/usage/apikey/cost");
  assert.equal(EP.costDetail, "https://api.qnaigc.com/v3/stat/usage/cost-detail");
  assert.equal(EP.exportLog, "https://api.qnaigc.com/v2/stat/export_log");
  assert.equal(EP.keyQuota, "https://api.qnaigc.com/v1/apikey/quota");
  assert.equal(EP.apikeys, "https://api.qnaigc.com/v1/apikeys");
  assert.equal(EP.balanceOverview, "https://api.qiniu.com/billing-api/v1/account/balance-overview");
  assert.equal(EP.respackList, "https://api.qiniu.com/billing-api/v1/respack/list");
  const custom = usageEndpoints({ inferOrigin: "https://proxy.test/", billingOrigin: "http://127.0.0.1:8080" });
  assert.equal(custom.usage, "https://proxy.test/v3/stat/usage");
  assert.equal(custom.balanceOverview, "http://127.0.0.1:8080/billing-api/v1/account/balance-overview");
});

// ── fetchUsageSeries ─────────────────────────────────────────

test("fetchUsageSeries：Bearer 头 + RFC3399 +08:00 精确 query", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: { usage: [] } } }));
  const r = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, days: 7, now: NOW });
  const u = new URL(r.url);
  assert.equal(`${u.protocol}//${u.host}${u.pathname}`, "https://api.qnaigc.com/v3/stat/usage");
  assert.deepEqual(queryOf(r.url), {
    from: "2026-11-19T00:00:00+08:00",
    to: "2026-11-25T23:59:59+08:00",
    granularity: "day",
    timezone: "Asia/Shanghai",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].headers.authorization, `Bearer ${FAKE_SK}`);
  assert.equal(f.calls[0].headers["content-type"], undefined, "GET 不应带 content-type");
  assert.deepEqual(r.data, { usage: [] });
});

test("fetchUsageSeries：day 夹紧到 31、hour 夹紧到 7", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: {} } }));
  const d = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, granularity: "day", days: 90, now: NOW });
  assert.equal(d.days, 31);
  assert.equal(d.clampedDays, true);
  assert.equal(queryOf(d.url).from, "2026-10-26T00:00:00+08:00");

  const h = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, granularity: "hour", days: 30, now: NOW });
  assert.equal(h.days, 7);
  assert.equal(queryOf(h.url).from, "2026-11-19T00:00:00+08:00");
  assert.equal(queryOf(h.url).granularity, "hour");

  const bad = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, granularity: "hour", days: 0, now: NOW });
  assert.equal(bad.days, 1);
});

test("fetchUsageSeries：origin 传推理 base（带 /v1 尾巴）也能落到 /v3", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: {} } }));
  const r = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, origin: "https://api.qnaigc.com/v1", now: NOW });
  assert.equal(new URL(r.url).pathname, "/v3/stat/usage");
  const direct = fakeFetch(respond({ body: { status: true, data: {} } }));
  const r2 = await fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: direct, origin: "http://127.0.0.1:9/api/v3/stat/usage", now: NOW });
  assert.equal(`${new URL(r2.url).origin}${new URL(r2.url).pathname}`, "http://127.0.0.1:9/api/v3/stat/usage");
});

// ── 其它用量端点 ─────────────────────────────────────────────

test("fetchApiKeyCost：type 枚举夹紧", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: { list: [] } } }));
  const ok = await fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: f, type: "week" });
  assert.deepEqual(queryOf(ok.url), { type: "week" });
  assert.equal(new URL(ok.url).pathname, "/v3/stat/usage/apikey/cost");
  const bad = await fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: f, type: "year" });
  assert.equal(bad.type, "month");
  assert.deepEqual(queryOf(bad.url), { type: "month" });
});

test("fetchCostDetail：start_date/end_date 精确且跨度夹紧 ≤31 天", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: [] } }));
  const r = await fetchCostDetail({ account: KEY_ACCOUNT, fetchImpl: f, startDate: "2026-01-01", endDate: "2026-11-25", grain: "day" });
  assert.equal(r.startDate, "2026-10-26");
  assert.equal(r.endDate, "2026-11-25");
  assert.equal(r.clamped, true);
  assert.deepEqual(queryOf(r.url), { start_date: "2026-10-26", end_date: "2026-11-25", granularity: "day", timezone: "Asia/Shanghai" });
  const short = await fetchCostDetail({ account: KEY_ACCOUNT, fetchImpl: f, startDate: "2026-11-20", endDate: "2026-11-25" });
  assert.equal(short.clamped, false);
  assert.equal(short.startDate, "2026-11-20");
});

test("fetchExportLog：size 1..500、page ≥1 夹紧", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: { list: [] } } }));
  const r = await fetchExportLog({ account: KEY_ACCOUNT, fetchImpl: f, size: 5000, page: 0 });
  assert.deepEqual(queryOf(r.url), { size: "500", page: "1" });
  assert.equal(new URL(r.url).pathname, "/v2/stat/export_log");
  const r2 = await fetchExportLog({ account: KEY_ACCOUNT, fetchImpl: f, size: "abc", page: -3 });
  assert.deepEqual(queryOf(r2.url), { size: "100", page: "1" });
});

test("fetchKeyQuota：key 模式走 Bearer，path 参数编码", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: { rpm: 60 } } }));
  const r = await fetchKeyQuota({ account: { mode: "key", apiKey: PATH_SK }, fetchImpl: f });
  assert.equal(new URL(r.url).pathname, "/v1/apikey/quota/sk-abc%2Fdef%3D12345678");
  assert.equal(f.calls[0].headers.authorization, `Bearer ${PATH_SK}`);
  assert.equal(r.apiKeyMasked, mask(PATH_SK));
  assert.equal(r.apiKeyMasked.includes("def=12345678"), false, "返回值不得带完整 key");
});

// ── AK/SK 签名注入 ───────────────────────────────────────────

test("fetchBalanceOverview：sign 回调被以正确参数调用一次，Header 为 Qiniu 而非 Bearer", async () => {
  const f = fakeFetch(respond({ body: { available_balance: 706767000000 } }));
  const seen = [];
  const sign = async (args) => {
    seen.push(args);
    return FAKE_AUTH;
  };
  const r = await fetchBalanceOverview({ account: AKSK_ACCOUNT, fetchImpl: f, sign });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, r.url);
  assert.equal(seen[0].url, "https://api.qiniu.com/billing-api/v1/account/balance-overview");
  assert.equal(seen[0].contentType, "");
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].accessKey, FAKE_AK);
  assert.equal(seen[0].secretKey, FAKE_SK_SEC);
  assert.equal(f.calls[0].headers.authorization, FAKE_AUTH);
  assert.equal(f.calls[0].headers.accept, "application/json");
  assert.deepEqual(r.data, { available_balance: 706767000000 });
});

test("sign 返回 {authorization,headers} 时附加头被合并（X-Qiniu-Date 一类）", async () => {
  const f = fakeFetch(respond({ body: { list: [] } }));
  await fetchRespackList({
    account: AKSK_ACCOUNT,
    fetchImpl: f,
    sign: () => ({ authorization: FAKE_AUTH, headers: { "X-Qiniu-Date": "20261125T020000Z", authorization: "IGNORED" } }),
  });
  assert.equal(f.calls[0].headers["x-qiniu-date"], "20261125T020000Z");
  assert.equal(f.calls[0].headers.authorization, FAKE_AUTH);
});

test("缺 sign 回调：抛 UsageApiError 且不设 signIn（不误伤账号）", async () => {
  const f = fakeFetch(respond({ status: 401, body: { error: "should not reach" } }));
  await assert.rejects(() => fetchBalanceOverview({ account: AKSK_ACCOUNT, fetchImpl: f }), (err) => {
    assert.ok(err instanceof UsageApiError);
    assert.equal(err.code, "sign_callback_missing");
    assert.equal("signIn" in err, false);
    assert.equal(err.status, 0);
    return true;
  });
  assert.equal(f.calls.length, 0, "缺签名时不应发出请求");
});

test("createInferenceKey：POST + JSON 体 + 签名 contentType；缺 key 字段/非 AKSK 账号不泄露", async () => {
  const f = fakeFetch(respond({ body: { status: true, data: { key: NEW_SK, id: 42 } } }));
  const seen = [];
  const r = await createInferenceKey({ account: AKSK_ACCOUNT, name: "magpie-auto", fetchImpl: f, sign: (a) => (seen.push(a), FAKE_AUTH) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(seen[0].body), { name: "magpie-auto" });
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].headers["content-type"], "application/json");
  assert.equal(f.calls[0].headers.authorization, FAKE_AUTH);
  assert.equal(r.key, NEW_SK);
  assert.equal(r.apiKeyMasked, "sk-NEW***6789");

  const f2 = fakeFetch(respond({ body: { status: true, data: { id: 43 } } }));
  await assert.rejects(() => createInferenceKey({ account: AKSK_ACCOUNT, fetchImpl: f2, sign: () => FAKE_AUTH }), (err) => {
    assert.equal(err.code, "key_missing");
    assert.equal(err.message.includes(NEW_SK), false);
    assert.equal("signIn" in err, false);
    return true;
  });

  await assert.rejects(() => createInferenceKey({ account: KEY_ACCOUNT, fetchImpl: f2, sign: () => FAKE_AUTH }), (err) => {
    assert.equal(err.code, "aksk_required");
    assert.equal("signIn" in err, false);
    return true;
  });
});

// ── 剥壳 / 错误分档 ──────────────────────────────────────────

test('{"status":false,"error":"..."} 抛错且 message 含原文', async () => {
  const f = fakeFetch(respond({ body: { status: false, error: "apikey monthly quota exceeded" } }));
  await assert.rejects(() => fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: f }), (err) => {
    assert.ok(err instanceof UsageApiError);
    assert.match(err.message, /apikey monthly quota exceeded/);
    assert.equal("signIn" in err, false, "quota 类不算 key 失效");
    assert.equal(err.code, "status_false");
    return true;
  });
});

test("401 + auth_api_key_invalid → signIn=expired", async () => {
  const f = fakeFetch(respond({ status: 401, body: { error: { message: "Invalid API key", type: "authentication_error", code: "auth_api_key_invalid" } } }));
  await assert.rejects(() => fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, now: NOW }), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.signIn, "expired");
    assert.equal(err.code, "auth_api_key_invalid");
    assert.match(err.message, /Invalid API key/);
    return true;
  });
});

test("403 Request not allowed（欠费）→ 不设 signIn，保留 code", async () => {
  const f = fakeFetch(respond({ status: 403, body: { error: { message: "Request not allowed", code: "access_denied" } } }));
  await assert.rejects(() => fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f, now: NOW }), (err) => {
    assert.equal(err.status, 403);
    assert.equal("signIn" in err, false);
    assert.equal(err.code, "access_denied");
    assert.match(err.message, /Request not allowed/);
    return true;
  });
});

test("429 retry-after / 坏 JSON / 网络错误 / abort 分档", async () => {
  const f429 = fakeFetch(respond({ status: 429, body: { error: "UID rate limit reached for TPD (oversea) for UID" }, headers: { "retry-after": "3" } }));
  await assert.rejects(() => fetchUsageSeries({ account: KEY_ACCOUNT, fetchImpl: f429, now: NOW }), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, "http_429");
    assert.equal("signIn" in err, false);
    assert.equal(err.retryAfterMs, 3000);
    assert.match(err.message, /rate limit reached/);
    return true;
  });

  const fBad = fakeFetch(respond({ status: 200, text: "<html>gateway</html>" }));
  await assert.rejects(() => fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: fBad }), (err) => {
    assert.equal(err.code, "bad_response");
    assert.equal(err.status, 200);
    return true;
  });

  const boom = async () => {
    throw Object.assign(new Error("fetch failed: ECONNREFUSED"), { name: "TypeError" });
  };
  await assert.rejects(() => fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: boom }), (err) => {
    assert.equal(err.status, 0);
    assert.equal(err.code, "network_error");
    assert.equal("signIn" in err, false);
    return true;
  });

  const aborted = async () => {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  };
  await assert.rejects(() => fetchApiKeyCost({ account: KEY_ACCOUNT, fetchImpl: aborted }), (err) => {
    assert.equal(err.code, "aborted");
    return true;
  });
});

test("缺凭证：api_key_required / aksk_required，均不设 signIn", async () => {
  await assert.rejects(
    () => fetchApiKeyCost({ account: { mode: "key", apiKey: "" }, fetchImpl: async () => respond({}) }),
    (err) => {
      assert.equal(err.code, "api_key_required");
      assert.equal("signIn" in err, false);
      return true;
    },
  );
  await assert.rejects(
    () => fetchBalanceOverview({ account: { mode: "aksk", accessKey: "", secretKey: "" }, fetchImpl: async () => respond({}), sign: () => FAKE_AUTH }),
    (err) => {
      assert.equal(err.code, "aksk_required");
      assert.equal("signIn" in err, false);
      return true;
    },
  );
});

test("mask/scrub：错误 message 不泄露完整 key 或签名", async () => {
  assert.equal(mask(NEW_SK), "sk-NEW***6789");
  assert.equal(mask("short"), "***");
  assert.equal(mask(""), "");
  const s = scrub(`upstream said: Bearer ${NEW_SK} rejected; raw ${NEW_SK}`);
  assert.equal(s.includes(NEW_SK), false);
  assert.match(s, new RegExp(`Bearer sk-NEW\\*\\*\\*6789`));

  const leaky = "{{APIKEY_6f1f081e}}";
  const f = fakeFetch(respond({ status: 401, body: { error: { message: `Invalid API key ${leaky}`, code: "auth_api_key_invalid" } } }));
  await assert.rejects(() => fetchUsageSeries({ account: { mode: "key", apiKey: leaky }, fetchImpl: f, now: NOW }), (err) => {
    assert.equal(err.message.includes(leaky), false, "message 不得含完整 key");
    assert.equal(err.signIn, "expired");
    return true;
  });
});

// ── normalize* ───────────────────────────────────────────────

test("normalizeBalance：元×1e8 除回元", () => {
  const b = normalizeBalance({
    status: true,
    data: {
      available_balance: 706767000000,
      cash_balance: 500000000,
      present_balance: 206767000000,
      credit_line: 0,
      unpaid_balance: 1500000000,
      currency: "CNY",
      email: "dev@example.com",
      account_id: "ACC123",
    },
  });
  assert.deepEqual(b, {
    available: 7067.67,
    cash: 5,
    present: 2067.67,
    creditLine: 0,
    unpaid: 15,
    currency: "CNY",
    email: "dev@example.com",
    accountId: "ACC123",
  });
  const direct = normalizeBalance({ available_balance: 123456789, account: { email: "x@y.z", uid: "U9" } });
  assert.equal(direct.available, 1.2346);
  assert.equal(direct.email, "x@y.z");
  assert.equal(direct.accountId, "U9");
  const empty = normalizeBalance({});
  assert.equal(empty.available, null);
  assert.equal(empty.currency, "CNY");
  assert.equal(empty.email, "");
});

test("normalizeUsageSeries：缺 categories / 缺 buckets / 别名 都健壮", () => {
  const withBuckets = normalizeUsageSeries({
    status: true,
    data: [
      {
        model: "glm-4.6",
        input_tokens: 120,
        output_tokens: 48,
        cached_tokens: 30,
        total_points: 1.8,
        categories: [{ name: "chat" }],
        series: [
          { time: "2026-11-19", input: 20, output: 8 },
          { time: "2026-11-20", input: 100, output: 40 },
        ],
      },
    ],
  });
  assert.deepEqual(withBuckets, [
    {
      model: "glm-4.6",
      input: 120,
      output: 48,
      cached: 30,
      points: 1.8,
      buckets: [
        { time: "2026-11-19", input: 20, output: 8 },
        { time: "2026-11-20", input: 100, output: 40 },
      ],
    },
  ]);

  const noBuckets = normalizeUsageSeries({ usage: [{ model: "deepseek-v3.2", prompt_tokens: "1,000", completion_tokens: 200 }] });
  assert.deepEqual(noBuckets, [{ model: "deepseek-v3.2", input: 1000, output: 200, cached: 0, points: 0, buckets: [] }]);

  const onlyBuckets = normalizeUsageSeries({ data: { list: [{ name: "kimi-k2", series: [{ day: 1795046400, input: 7, out: 3 }] }] } });
  assert.equal(onlyBuckets.length, 1);
  assert.equal(onlyBuckets[0].model, "kimi-k2");
  assert.equal(onlyBuckets[0].input, 7);
  assert.equal(onlyBuckets[0].output, 3);
  assert.match(onlyBuckets[0].buckets[0].time, /^2026-11-19T00:00:00\.000Z$/);

  assert.deepEqual(normalizeUsageSeries({ status: true, data: { categories: [] } }), []);
  assert.deepEqual(normalizeUsageSeries({}), []);
  assert.deepEqual(normalizeUsageSeries(null), []);
  assert.deepEqual(normalizeUsageSeries([]), []);
  assert.deepEqual(normalizeUsageSeries({ data: [{ foo: 1 }] }), []);
});

test("normalizeCost：total_fee 与逐模型 items", () => {
  const c = normalizeCost({
    status: true,
    data: {
      currency: "CNY",
      total_fee: 12.5,
      list: [
        { name: "glm-4.6", fee: 7.5, items: [{ name: "input", unit: "1M tokens", usage: 2.5, fee: 5 }, { name: "output", unit: "1M tokens", usage: 0.5, fee: 2.5 }] },
        { name: "deepseek-v3.2", items: [{ name: "input", usage: 1, fee: 5 }] },
      ],
    },
  });
  assert.equal(c.totalFee, 12.5);
  assert.equal(c.currency, "CNY");
  assert.equal(c.models.length, 2);
  assert.deepEqual(c.models[0], {
    name: "glm-4.6",
    fee: 7.5,
    items: [
      { name: "input", unit: "1M tokens", usage: 2.5, fee: 5 },
      { name: "output", unit: "1M tokens", usage: 0.5, fee: 2.5 },
    ],
  });
  assert.equal(c.models[1].fee, 5);

  const summed = normalizeCost({ list: [{ name: "a", fee: 1.25 }, { name: "b", fee: 2 }] });
  assert.equal(summed.totalFee, 3.25);
  assert.deepEqual(normalizeCost({}), { totalFee: 0, currency: "CNY", models: [] });
  assert.deepEqual(normalizeCost(null), { totalFee: 0, currency: "CNY", models: [] });
});

// ── 导出面 ───────────────────────────────────────────────────

test("导出面与 CONTRACT §3 一致", async () => {
  const mod = await import("../src/usage-api.mjs");
  for (const name of [
    "usageEndpoints",
    "fetchUsageSeries",
    "fetchApiKeyCost",
    "fetchCostDetail",
    "fetchExportLog",
    "fetchKeyQuota",
    "fetchBalanceOverview",
    "fetchRespackList",
    "createInferenceKey",
    "normalizeUsageSeries",
    "normalizeCost",
    "normalizeBalance",
    "UsageApiError",
    "mask",
  ]) {
    assert.equal(typeof mod[name], "function", `缺少导出 ${name}`);
  }
});
