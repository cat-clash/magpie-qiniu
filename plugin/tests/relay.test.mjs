import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRequest,
  tailOf,
  isChatPath,
  isModelsPath,
  targetOf,
  filterHeaders,
  modelsResponse,
  notImplemented,
  classifyResponse,
  forwardChat,
  apiKeyOf,
  nextDayStartMs,
  rateLimitBackoff,
  PASS_HEADERS,
} from "../src/relay.mjs";
import { USER_AGENT, INFER_BASE } from "../src/config.mjs";

// 假凭据一律用字符串拼接生成，文件里不写任何双花括号占位符形态。
const SECRET = "sk-" + "A1b2C3d4E5f6";

// ---------------------------------------------------------------------------
// 请求归一
// ---------------------------------------------------------------------------

test("归一化请求只产出 url、method、headers，不处理 body", () => {
  const got = normalizeRequest("https://api.qnaigc.com/v1/chat/completions", {
    method: "post",
    headers: { "content-type": "application/json", "x-empty": undefined },
  });
  // 真实实现只有三个字段：body 归一不在本函数里（见交付报告的源码差异）。
  assert.deepStrictEqual(Object.keys(got).sort(), ["headers", "method", "url"]);
  assert.strictEqual(got.url, "https://api.qnaigc.com/v1/chat/completions");
  assert.strictEqual(got.method, "POST");
  assert.ok(got.headers instanceof Headers);
  assert.strictEqual(got.headers.get("content-type"), "application/json");
  assert.strictEqual(got.headers.has("x-empty"), false);
});

test("归一化请求接受 URL 对象与 input 上的 method/headers", () => {
  const a = normalizeRequest(new URL("https://api.qnaigc.com/v1/messages"), { method: "GET" });
  assert.strictEqual(a.url, "https://api.qnaigc.com/v1/messages");
  assert.strictEqual(a.method, "GET");

  const b = normalizeRequest({
    url: "https://api.qnaigc.com/v1/chat/completions",
    method: "delete",
    headers: { "x-a": "b" },
  });
  assert.strictEqual(b.method, "DELETE");
  assert.strictEqual(b.headers.get("x-a"), "b");
});

test("归一化请求把 Headers 实例复制成新对象", () => {
  const src = new Headers({ "x-a": "b" });
  const got = normalizeRequest("https://api.qnaigc.com", { headers: src });
  assert.strictEqual(got.headers.get("x-a"), "b");
  assert.notStrictEqual(got.headers, src);
  assert.strictEqual(got.method, "GET");
});

// ---------------------------------------------------------------------------
// 路径归一
// ---------------------------------------------------------------------------

test("从完整地址提取相对尾巴", () => {
  assert.strictEqual(tailOf("https://api.qnaigc.com/v1/chat/completions"), "/chat/completions");
  assert.strictEqual(tailOf("/v1/messages"), "/messages");
  assert.strictEqual(tailOf("https://api.qnaigc.com/v1/models"), "/models");
  assert.strictEqual(tailOf("/v1"), "/");
});

test("bypass 透传路径优先于 /v1/ 截取，整段原样保留", () => {
  assert.strictEqual(tailOf("/bypass/anthropic/messages"), "/bypass/anthropic/messages");
  // bypass 自带 /v1/ 段；必须先判 bypass 再判 /v1/，否则会被截成 /messages，
  // 令 targetOf 的 bypass 分支成死代码、Anthropic 透传走错域。
  assert.strictEqual(tailOf("/bypass/anthropic/v1/messages"), "/bypass/anthropic/v1/messages");
});

test("聊天与模型路径识别覆盖斜杠与查询串变体", () => {
  assert.strictEqual(isChatPath("/chat/completions"), true);
  assert.strictEqual(isChatPath("/chat/completions/"), true);
  assert.strictEqual(isChatPath("/chat/completions?x=1"), true);
  assert.strictEqual(isChatPath("/messages"), false);
  assert.strictEqual(isModelsPath("/models"), true);
  assert.strictEqual(isModelsPath("/models/"), true);
  assert.strictEqual(isModelsPath("/models?a=1"), true);
  assert.strictEqual(isModelsPath("/chat/completions"), false);
});

test("目标地址不出现双 v1 且透传路径走根域", () => {
  const chat = targetOf("/chat/completions");
  assert.strictEqual(chat, "https://api.qnaigc.com/v1/chat/completions");
  assert.strictEqual(chat.includes("/v1/v1"), false);
  assert.strictEqual(targetOf("chat/completions"), "https://api.qnaigc.com/v1/chat/completions");
  assert.strictEqual(targetOf("/messages"), "https://api.qnaigc.com/v1/messages");
  assert.strictEqual(
    targetOf("/bypass/anthropic/v1/messages"),
    "https://api.qnaigc.com/bypass/anthropic/v1/messages"
  );
  assert.strictEqual(
    targetOf("/chat/completions", "https://custom.test/v1/"),
    "https://custom.test/v1/chat/completions"
  );
  assert.strictEqual(INFER_BASE, "https://api.qnaigc.com/v1");
});

// ---------------------------------------------------------------------------
// 请求头过滤
// ---------------------------------------------------------------------------

test("透传白名单集合恰好是四个必需头", () => {
  assert.deepStrictEqual(
    [...PASS_HEADERS].sort(),
    ["accept", "anthropic-beta", "anthropic-version", "content-type"]
  );
});

test("请求头白名单透传、覆盖代理标识并丢弃危险头", () => {
  const src = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "tools-2024-04-04",
    authorization: "Bearer " + SECRET,
    cookie: "session=abc",
    host: "evil.example",
    "content-length": "999",
    "user-agent": "evil-agent",
    "x-secret": "leak",
  });
  const out = filterHeaders(src);
  assert.strictEqual(out.get("accept"), "application/json");
  assert.strictEqual(out.get("content-type"), "application/json");
  assert.strictEqual(out.get("anthropic-version"), "2023-06-01");
  assert.strictEqual(out.get("anthropic-beta"), "tools-2024-04-04");
  assert.strictEqual(out.get("user-agent"), USER_AGENT);
  for (const name of ["authorization", "cookie", "host", "content-length", "x-secret"]) {
    assert.strictEqual(out.has(name), false, name + " 不应透传");
  }
});

test("缺少请求头时补默认 accept 与 content-type", () => {
  const out = filterHeaders(null);
  assert.strictEqual(out.get("accept"), "text/event-stream");
  assert.strictEqual(out.get("content-type"), "application/json");
  assert.strictEqual(out.get("user-agent"), USER_AGENT);
});

// ---------------------------------------------------------------------------
// 本地响应
// ---------------------------------------------------------------------------

test("模型表响应形状与缓存头", async () => {
  const res = modelsResponse({ "model-a": {}, "model-b": {} });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("cache-control"), "no-store");
  assert.deepStrictEqual(await res.json(), {
    object: "list",
    data: [
      { id: "model-a", object: "model", owned_by: "qiniu", created: 0 },
      { id: "model-b", object: "model", owned_by: "qiniu", created: 0 },
    ],
  });
});

test("未实现接口返回 501 与 not_implemented 错误码", async () => {
  const res = notImplemented("/v1/images");
  assert.strictEqual(res.status, 501);
  const body = await res.json();
  assert.strictEqual(body.error.code, "not_implemented");
  assert.strictEqual(body.error.type, "invalid_request_error");
  assert.ok(body.error.message.includes("/v1/images"));
});

// ---------------------------------------------------------------------------
// 错误分档（按源码 RULES 顺序精确断言）
// ---------------------------------------------------------------------------

test("503 未标价改判 404 并保留账号状态", () => {
  assert.deepStrictEqual(classifyResponse(503, "the price of the model is not set"), {
    pass: false,
    status: 404,
    body: {
      error: {
        message: "这个模型在七牛侧没有标价（通常说明模型 id 写错或该模型未对你开通）",
        type: "not_available_error",
        code: "model_not_priced",
      },
    },
    headers: {},
    signIn: "kept",
  });
});

test("402 余额不足改判 429 并附带 900 秒重试", () => {
  assert.deepStrictEqual(classifyResponse(402, "insufficient balance"), {
    pass: false,
    status: 429,
    body: {
      error: {
        message: "七牛账户余额或资源包不足，充值后约 15 分钟恢复。原始错误：insufficient balance",
        type: "insufficient_quota",
        code: "balance_insufficient",
      },
    },
    headers: { "retry-after": "900" },
    signIn: undefined,
  });
});

test("403 欠费改判 429 arrears", () => {
  assert.deepStrictEqual(classifyResponse(403, "Request not allowed"), {
    pass: false,
    status: 429,
    body: {
      error: {
        message: "七牛账户处于欠费受限状态，结清后约 20 分钟自动解除。原始错误：Request not allowed",
        type: "insufficient_quota",
        code: "arrears",
      },
    },
    headers: { "retry-after": "1200" },
    signIn: undefined,
  });
});

test("403 账户欠费停用（实测 account_billing_suspended）也走 arrears 改写", () => {
  // 2026-11-27 实测：sk- Key 直连 api.qnaigc.com 返回 403 + code=account_billing_suspended。
  // 改写前 classifyResponse 返回 { pass: true } —— 裸 403 会让宿主把账号当"被拒"。
  const raw =
    '{"error":{"message":"Account is suspended due to billing status (request_id: chatcmpl-1b588dd88b9f41f4a6768aeb63d006c2)","type":"access_denied_error","code":"account_billing_suspended"}}';
  const got = classifyResponse(403, raw);
  assert.strictEqual(got.pass, false);
  assert.strictEqual(got.status, 429);
  assert.strictEqual(got.body.error.code, "arrears");
  assert.strictEqual(got.body.error.type, "insufficient_quota");
  assert.strictEqual(got.headers["retry-after"], "1200");
  assert.ok(got.body.error.message.includes("Account is suspended due to billing status"));
  assert.strictEqual(got.signIn, undefined);
});

test("429 TPD 补 retry-after 到下一个 +08 零点（上游没有这个头）", () => {
  const now = Date.parse("2026-11-27T14:01:39+08:00");
  const got = classifyResponse(429, "UID rate limit reached for TPD (domestic) for UID (request_id: chatcmpl-6ddfd60b)", { now });
  assert.strictEqual(got.pass, false);
  assert.strictEqual(got.status, 429);
  assert.strictEqual(got.body.error.code, "account_daily_quota");
  assert.strictEqual(got.body.error.type, "rate_limit_error");
  // 14:01:39 → 次日 00:00 = 9h58m21s
  assert.strictEqual(got.headers["retry-after"], "35901");
  assert.strictEqual(got.headers["retry-after"], String((nextDayStartMs(now) - now) / 1000));
  assert.ok(got.body.error.message.includes("chatcmpl-6ddfd60b"));
  assert.strictEqual(got.signIn, undefined);
});

test("429 RPM / TPM 只退避 60 秒", () => {
  const now = Date.parse("2026-11-27T14:01:39+08:00");
  for (const kind of ["RPM", "TPM"]) {
    const got = classifyResponse(429, `UID rate limit reached for ${kind} for UID`, { now });
    assert.strictEqual(got.body.error.code, "account_rate_limited");
    assert.strictEqual(got.headers["retry-after"], "60");
  }
});

test("TPD 退避夹在 [60, 86400] 内，绝不吐 0", () => {
  assert.strictEqual(rateLimitBackoff(Date.parse("2026-11-27T23:59:30+08:00"), "TPD"), 60);
  assert.strictEqual(rateLimitBackoff(Date.parse("2026-11-27T00:00:01+08:00"), "TPD"), 86_399);
});

test("403 额度超限改判 429 quota_exceeded", () => {
  assert.deepStrictEqual(classifyResponse(403, "apikey monthly quota exceeded"), {
    pass: false,
    status: 429,
    body: {
      error: {
        message: "这把 Key 的额度已用尽，可在七牛控制台调整或换一把 Key。原始错误：apikey monthly quota exceeded",
        type: "insufficient_quota",
        code: "quota_exceeded",
      },
    },
    headers: { "retry-after": "1200" },
    signIn: undefined,
  });
});

test("400 额度超限同样命中 quota_exceeded 规则", () => {
  const got = classifyResponse(400, "quota exceeded");
  assert.strictEqual(got.status, 429);
  assert.strictEqual(got.body.error.code, "quota_exceeded");
  assert.strictEqual(got.headers["retry-after"], "1200");
});

test("订阅组不可用改判 404 model_out_of_scope 且优先于模型不存在规则", () => {
  const text = "model X is not available in your assigned model groups";
  assert.deepStrictEqual(classifyResponse(403, text), {
    pass: false,
    status: 404,
    body: {
      error: {
        message: "该模型不在你这个账号/订阅的范围内。原始错误：" + text,
        type: "not_available_error",
        code: "model_out_of_scope",
      },
    },
    headers: {},
    signIn: "kept",
  });
});

test("模型不支持改判 404 model_not_found 并保留账号状态", () => {
  assert.deepStrictEqual(classifyResponse(404, "模型不支持"), {
    pass: false,
    status: 404,
    body: {
      error: {
        message: "上游没有这个模型或暂不可用。原始错误：模型不支持",
        type: "not_available_error",
        code: "model_not_found",
      },
    },
    headers: {},
    signIn: "kept",
  });
});

test("401 缺少凭据改判 500 missing_credential 且不污染账号", () => {
  // 真实实现这个分支的返回对象没有 signIn 字段。
  assert.deepStrictEqual(classifyResponse(401, "auth_api_key_missing"), {
    pass: false,
    status: 500,
    body: {
      error: {
        message: "插件没能把 Key 附到请求上（auth_api_key_missing）",
        type: "magpie_error",
        code: "missing_credential",
      },
    },
    headers: {},
  });
});

test("其余 401 原样透传并标记登录过期", () => {
  assert.deepStrictEqual(classifyResponse(401, "Invalid API key"), {
    pass: true,
    signIn: "expired",
  });
});

test("未命中任何规则的错误原样透传", () => {
  assert.deepStrictEqual(classifyResponse(400, "bad request"), { pass: true });
  assert.deepStrictEqual(classifyResponse(500, "upstream boom"), { pass: true });
});

test("关闭额度切换时跳过 429 改写而原样透传", () => {
  assert.deepStrictEqual(classifyResponse(402, "insufficient balance", { quotaFailover: false }), {
    pass: true,
  });
  assert.deepStrictEqual(classifyResponse(403, "Request not allowed", { quotaFailover: false }), {
    pass: true,
  });
  // 非 429 的改写不受开关影响。
  const kept = classifyResponse(503, "the price of the model is not set", { quotaFailover: false });
  assert.strictEqual(kept.status, 404);
  assert.strictEqual(kept.code, undefined);
  assert.strictEqual(kept.body.error.code, "model_not_priced");
});

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------

test("转发成功时把原 Response 原样返回且不改写流", async () => {
  const original = new Response("stream-bytes", { status: 200 });
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return original;
  };
  const got = await forwardChat({
    url: "https://api.qnaigc.com/v1/chat/completions",
    method: "POST",
    headers: new Headers({
      authorization: "Bearer " + SECRET,
      cookie: "s=1",
      "content-type": "application/json",
    }),
    body: JSON.stringify({ model: "m" }),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.strictEqual(got, original);
  assert.strictEqual(await got.text(), "stream-bytes");
  assert.strictEqual(seen.url, "https://api.qnaigc.com/v1/chat/completions");
  assert.strictEqual(seen.init.method, "POST");
  assert.strictEqual(seen.init.headers.get("authorization"), "Bearer " + SECRET);
  assert.strictEqual(seen.init.headers.get("user-agent"), USER_AGENT);
  assert.strictEqual(seen.init.headers.has("cookie"), false);
});

test("转发失败时按分档重建响应且不泄露凭据", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: "insufficient balance" } }), { status: 402 });
  const got = await forwardChat({
    url: "https://api.qnaigc.com/v1/chat/completions",
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.strictEqual(got.status, 429);
  assert.strictEqual(got.headers.get("retry-after"), "900");
  const body = await got.json();
  assert.strictEqual(body.error.code, "balance_insufficient");
  assert.strictEqual(JSON.stringify(body).includes(SECRET), false);
});

test("转发遇到上游 401 时原样回传正文并标记过期", async () => {
  const fetchImpl = async () => new Response("Invalid API key", { status: 401 });
  const got = await forwardChat({
    url: "https://api.qnaigc.com/v1/chat/completions",
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.strictEqual(got.status, 401);
  assert.strictEqual(got.headers.get("x-magpie-sign-in"), "expired");
  assert.strictEqual(await got.text(), "Invalid API key");
});

test("转发遇到网络异常返回 502 且错误文案脱敏", async () => {
  const fetchImpl = async () => {
    throw new Error("boom " + SECRET);
  };
  const got = await forwardChat({
    url: "https://api.qnaigc.com/v1/chat/completions",
    headers: new Headers(),
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.strictEqual(got.status, 502);
  const body = await got.json();
  assert.strictEqual(body.error.code, "upstream_unreachable");
  assert.strictEqual(body.error.message.includes(SECRET), false);
});

test("转发被取消时返回 499", async () => {
  const fetchImpl = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const got = await forwardChat({
    url: "https://api.qnaigc.com/v1/chat/completions",
    headers: new Headers(),
    timeoutMs: 5000,
    fetchImpl,
  });
  assert.strictEqual(got.status, 499);
  assert.strictEqual((await got.json()).error.code, "client_closed_request");
});

// ---------------------------------------------------------------------------
// 凭据提取
// ---------------------------------------------------------------------------

test("从鉴权对象提取可用 Key", () => {
  assert.strictEqual(apiKeyOf({ key: SECRET }), SECRET);
  assert.strictEqual(apiKeyOf({ apiKey: SECRET, key: "other" }), SECRET);
  assert.strictEqual(apiKeyOf({ key: "  " + SECRET + "  " }), SECRET);
  assert.strictEqual(apiKeyOf({}), "");
  assert.strictEqual(apiKeyOf(null), "");
  assert.strictEqual(apiKeyOf({ key: "   " }), "");
});
