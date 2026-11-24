// 通用 HTTP / 错误 / 脱敏工具测试（离线；node:test + node:assert/strict，Bun 亦可直接跑）
//
// 期望值来源：全部按 ../src/http.mjs 的**实际实现**手工推演写死在此
//   （maskTail：len<=keep+2 时整串打星，否则 前keep + … + 后2；
//    redact 规则顺序：sk-/tk- → Qiniu AK:SIG → 裸 AK:SK → JWT → 长hex → key=value）。
// 全程不联网：fetch 一律用假的 fetchImpl，Response/Headers 用宿主 Web 标准库。
// 固定假密钥：sk-abcdefghij1234567890 之类占位符是刻意写进测试里的假值。
import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  abortError,
  isAbort,
  sleep,
  numberOrNull,
  parseJson,
  jsonResponse,
  errorResponse,
  redact,
  maskKey,
  classifyAuthError,
  apiFetch,
  deepFind,
} from "../src/http.mjs";
import { USER_AGENT } from "../src/config.mjs";

// ── 1. errorResponse：体是 {error:{message,type,code}}，状态码与自定义头正确 ──────
test("errorResponse 外壳与自定义头/状态码；默认 type/code 与 null message", async () => {
  const res = errorResponse(429, "调用太频繁", "rate_limit_error", "rate_limited", { "x-test": "1" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-test"), "1");
  assert.deepEqual(await res.json(), {
    error: { message: "调用太频繁", type: "rate_limit_error", code: "rate_limited" },
  });

  const def = errorResponse(500, "服务端炸了");
  assert.equal(def.status, 500);
  assert.deepEqual((await def.json()).error, { message: "服务端炸了", type: "api_error", code: "" });

  const nul = errorResponse(400, null);
  assert.equal((await nul.json()).error.message, "");
});

// ── 2. jsonResponse：content-type 默认 json；init.headers 能覆盖 ─────────────────
test("jsonResponse 默认 content-type 可被 init.headers 覆盖", async () => {
  const d = jsonResponse({ x: [1, 2] });
  assert.equal(d.status, 200);
  assert.equal(d.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(await d.text(), '{"x":[1,2]}');

  const o = jsonResponse({ a: 1 }, { status: 201, headers: { "content-type": "text/plain" } });
  assert.equal(o.status, 201);
  assert.equal(o.headers.get("content-type"), "text/plain");
  assert.equal(await o.text(), '{"a":1}');
});

// ── 3. redact：sk-/tk- Key 遮蔽（含占位符花括号形态）─────────────────────────────
test("redact 遮蔽 sk-/tk- 密钥（含花括号形态）", () => {
  const fakeKey = "sk-" + "abcdefghij1234567890";
  const out = redact("key " + fakeKey + " ok");
  assert.equal(out, "key sk-abcd…90 ok");
  assert.ok(!out.includes("abcdefghij1234567890"));

  const tk = redact("token tk-1234567890abcdef 请保密");
  assert.equal(tk, "token tk-1234…ef 请保密");
  assert.ok(!tk.includes("1234567890abcdef"));

  const brace = "sk-" + "{{ABCDEF}}";
  const ph = redact(brace);
  assert.equal(ph, "sk-" + "{{AB…EF}}");
});

// ── 4. redact：sk-/tk- 阈值与 \b 保护 —— 普通文本不误伤 ─────────────────────────
test("redact 不误伤：短后缀、task-/risk-/ask- 等普通文本原样保留", () => {
  assert.equal(redact("sk-abc"), "sk-abc"); // 后缀 3 位 < 4，不命中规则
  assert.equal(redact("The quick brown fox jumps over the lazy dog"), "The quick brown fox jumps over the lazy dog");
  assert.equal(redact("task-1234 risk-free ask-me-anything"), "task-1234 risk-free ask-me-anything"); // \b 挡住 sk-
});

// ── 5. redact：Qiniu AK:SIG 形态 ────────────────────────────────────────────────
test("redact 遮蔽 Qiniu AK:SIG", () => {
  const out = redact("签名头 Qiniu myAccessKey012345:hmacsigbase64==");
  assert.ok(out.includes("Qiniu myA…45:****"));
  assert.ok(!out.includes("myAccessKey012345"));
  assert.ok(!out.includes("hmacsigbase64=="));
});

// ── 6. redact：裸 AK:SK 形态 ────────────────────────────────────────────────────
test("redact 遮蔽裸 AK:SK", () => {
  const out = redact("AKIDEXAMPLE123456:SuperSecretKey0987654321");
  assert.equal(out, "AKI…56:****");
  assert.ok(!out.includes("SuperSecretKey0987654321"));
});

// ── 7. redact：JWT（三段点分）───────────────────────────────────────────────────
test("redact 遮蔽 JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const out = redact(`携带 ${jwt} 完成请求`);
  assert.ok(out.includes("jwt:****"));
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.ok(!out.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"));
});

// ── 8. redact：长 hex（>=28 位）────────────────────────────────────────────────
test("redact 遮蔽长 hex，短 hex 不动", () => {
  const out = redact("digest: 0123456789abcdef0123456789abcdef end");
  assert.ok(out.includes("012345…ef"));
  assert.ok(!out.includes("0123456789abcdef0123456789abcdef"));

  const short = "short 0123456789abcdef0123456789a end"; // 25 位，不到 28 不遮蔽
  assert.equal(redact(short), short);
});

// ── 9. redact：key=value / token: xxx 机密字段；非机密字段与短值不动 ─────────────
test("redact 遮蔽机密字段，保留普通字段与过短的值", () => {
  assert.equal(redact("token: abc123xyz"), "token: ****");
  assert.equal(redact("api_key=supersecret123"), "api_key=****");
  assert.equal(redact("apikey:xyz1234"), "apikey:****");
  assert.equal(redact("password: p@ss-word"), "password: ****");

  // 非机密字段、key=value、值过短（<4）都不动
  assert.equal(redact("note: hi there"), "note: hi there");
  assert.equal(redact("key=value"), "key=value");
  assert.equal(redact("token: ab"), "token: ab");
});

// ── 10. redact：非字符串输入（对象/空值）───────────────────────────────────────
test("redact 对象输入与空值", () => {
  assert.equal(redact({ token: "mytoken12345678" }), '{"token":"****"}');
  assert.equal(redact(null), "");
  assert.equal(redact(42), "42");
});

// ── 11. maskKey：前 6 后 4；短串不泄露全文 ─────────────────────────────────────
test("maskKey 前6后4，短串整串打星不泄露", () => {
  assert.equal(maskKey("qiniu-access-key-0001"), "qiniu-…0001");
  assert.equal(maskKey("1234567890"), "**********"); // 10 = 6+4，整串打星
  assert.equal(maskKey("short"), "*****");
  assert.equal(maskKey(""), "****");
  assert.equal(maskKey(null), "****");
  assert.equal(maskKey("abcdefghijklmnop", 3, 3), "abc…nop");
});

// ── 12. classifyAuthError：401 双向 ─────────────────────────────────────────────
test("classifyAuthError 401 默认 expired；欠费/限额/价格文案不标", () => {
  assert.equal(classifyAuthError(401, { message: "invalid api key" }, null), "expired");
  assert.equal(classifyAuthError(401, { code: "unauthorized" }, null), "expired");
  assert.equal(classifyAuthError(401, { message: "Invalid API Key" }, null), "expired"); // 大小写不敏感
  assert.equal(classifyAuthError(401, {}, { error: "unauthorized" }), "expired"); // body.error 字符串形态
  assert.equal(classifyAuthError(401, {}, { error: { code: "auth_api_key_invalid" } }), "expired");

  for (const msg of [
    "quota exceeded for model g1",
    "balance insufficient",
    "欠费请充值",
    "price plan limited",
    "model groups not allowed",
    "model not available in region",
  ]) {
    assert.equal(classifyAuthError(401, { message: msg }, null), "", `不应误标：${msg}`);
  }

  // 边界：欠费提示与鉴权提示并存时仍以凭据问题为准
  assert.equal(classifyAuthError(401, { message: "quota exceeded but invalid api key" }, null), "expired");
});

// ── 13. classifyAuthError：403 双向与其他状态码 ────────────────────────────────
test("classifyAuthError 403 命中鉴权提示 expired；not available/quota 不标；其他状态不标", () => {
  assert.equal(classifyAuthError(403, { message: "签名错误，密钥不对" }, null), "expired");
  assert.equal(classifyAuthError(403, { message: "model not available in your region" }, null), "");
  assert.equal(classifyAuthError(403, { message: "quota limit reached" }, null), "");
  assert.equal(classifyAuthError(403, { message: "forbidden" }, null), "");
  assert.equal(classifyAuthError(500, { message: "invalid api key" }, null), "");
  assert.equal(classifyAuthError(400, { message: "签名错误" }, null), "");
});

// ── 14. numberOrNull ───────────────────────────────────────────────────────────
test("numberOrNull 各种输入", () => {
  assert.equal(numberOrNull(42), 42);
  assert.equal(numberOrNull(-3.5), -3.5);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull("42"), 42);
  assert.equal(numberOrNull(" 42 "), 42);
  assert.equal(numberOrNull("1,234.5"), 1234.5);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull("abc"), null);
  assert.equal(numberOrNull(Infinity), null);
});

// ── 15. parseJson ──────────────────────────────────────────────────────────────
test("parseJson 正反例", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson("[1,2,3]"), [1, 2, 3]);
  assert.equal(parseJson("nope"), null);
  assert.equal(parseJson(""), null);
  assert.equal(parseJson(42), null);
  assert.equal(parseJson(null), null);
});

// ── 16. deepFind 正反例 ───────────────────────────────────────────────────────
test("deepFind 深度查找", () => {
  assert.equal(deepFind({ usage: { errcode: 401 } }, ["errcode", "msg"]), 401);
  assert.equal(deepFind({ a: { b: { quota: 5 } } }, ["missing", "quota"]), 5);
  assert.equal(deepFind({ errcode: "E1", n: { errcode: 2 } }, ["errcode"]), "E1"); // 顶层先命中
  assert.equal(deepFind({ a: { ok: true } }, ["ok"]), true);
  assert.equal(deepFind({ x: 1 }, ["errcode"]), null);
  assert.equal(deepFind(null, ["k"]), null);
});

// ── 17. sleep：0 秒解析、预 abort、中途 abort ──────────────────────────────────
test("sleep(0) 立即解析；signal 已 abort 与中途 abort 都 reject AbortError", async () => {
  assert.equal(await sleep(0), 0);

  const done = new AbortController();
  done.abort();
  await assert.rejects(sleep(10, done.signal), (e) => e.name === "AbortError");

  const mid = new AbortController();
  setTimeout(() => mid.abort(), 5);
  await assert.rejects(sleep(50, mid.signal), (e) => e.name === "AbortError");
});

// ── 18. ApiError 字段、instanceof 与默认值 ─────────────────────────────────────
test("ApiError 字段与 instanceof；缺省值", () => {
  const e = new ApiError("boom", {
    status: "404",
    code: "nf",
    type: "t",
    body: { x: 1 },
    signIn: "expired",
    cause: new Error("root"),
  });
  assert.ok(e instanceof ApiError);
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ApiError");
  assert.equal(e.message, "boom");
  assert.equal(e.status, 404); // 字符串数字会被 Number() 转换
  assert.equal(e.code, "nf");
  assert.equal(e.type, "t");
  assert.deepEqual(e.body, { x: 1 });
  assert.equal(e.signIn, "expired");
  assert.equal(e.cause.message, "root");

  const d = new ApiError();
  assert.equal(d.message, "请求失败");
  assert.equal(d.status, 0);
  assert.equal(d.code, "");
  assert.equal(d.type, "");
  assert.equal(d.body, null);
  assert.equal(d.signIn, "");
});

// ── 19. apiFetch：200 正常返回 ────────────────────────────────────────────────
test("apiFetch 200 正常返回 {status,headers,data,text}", async () => {
  const res = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fake = () => Promise.resolve(res);
  const r = await apiFetch("https://fake.local/api/ping", { fetchImpl: fake, timeoutMs: 1000 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal(r.text, '{"ok":true}');
  assert.ok(r.headers instanceof Headers);
  assert.equal(r.headers.get("content-type"), "application/json");
});

// ── 20. apiFetch：默认带 user-agent/accept 头；自定义头覆盖默认头 ───────────────
test("apiFetch 默认头与自定义头覆盖", async () => {
  let seen;
  const fake = (_url, init) => {
    seen = init;
    return Promise.resolve(new Response("{}"));
  };
  await apiFetch("https://fake.local/a", { fetchImpl: fake, timeoutMs: 1000 });
  assert.equal(seen.method, "GET");
  assert.equal(seen.headers.accept, "application/json");
  assert.equal(seen.headers["user-agent"], USER_AGENT);

  await apiFetch("https://fake.local/b", {
    fetchImpl: fake,
    timeoutMs: 1000,
    headers: { "user-agent": "ua-9/1", accept: "text/plain", "x-magic": "yes" },
  });
  assert.equal(seen.headers["user-agent"], "ua-9/1");
  assert.equal(seen.headers.accept, "text/plain");
  assert.equal(seen.headers["x-magic"], "yes");
});

// ── 21. apiFetch：HTTP 200 但体是七牛 {status:false,error} 外壳 → 必须抛 ApiError ──
test("apiFetch 七牛 200 外壳 {status:false} 抛 ApiError（errcode 坑）", async () => {
  const body = { status: false, error: "UNAUTHENTICATED", errcode: 401 };
  const fake = () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  await assert.rejects(
    apiFetch("https://fake.local/v3/stat/usage", { fetchImpl: fake, timeoutMs: 1000 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.message, "UNAUTHENTICATED");
      assert.equal(e.status, 200);
      assert.deepEqual(e.body, body);
      return true;
    },
  );
});

// ── 22. apiFetch：非 2xx OpenAI 外壳 → ApiError 带 status/code/type/signIn ───────
test("apiFetch 非 2xx OpenAI 外壳抛 ApiError（status/code/type/signIn 齐全）", async () => {
  const fake = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { message: "invalid api key", type: "authentication_error", code: "invalid_api_key" } }),
        { status: 401 },
      ),
    );
  await assert.rejects(
    apiFetch("https://fake.local/v1/models", { fetchImpl: fake, timeoutMs: 1000 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 401);
      assert.equal(e.code, "invalid_api_key");
      assert.equal(e.type, "authentication_error");
      assert.equal(e.message, "invalid api key");
      assert.equal(e.signIn, "expired");
      return true;
    },
  );
});

// ── 23. apiFetch：非 2xx 纯文本 → 兜底消息 上游返回 HTTP xxx ─────────────────────
test("apiFetch 非 2xx 纯文本兜底消息", async () => {
  const fake = () => Promise.resolve(new Response("boom", { status: 500 }));
  await assert.rejects(
    apiFetch("https://fake.local/x", { fetchImpl: fake, timeoutMs: 1000 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 500);
      assert.equal(e.code, "");
      assert.equal(e.message, "上游返回 HTTP 500");
      return true;
    },
  );
});

// ── 24. apiFetch：外部 signal abort → 抛出原生 AbortError ───────────────────────
test("apiFetch 外部 signal abort 抛原生 AbortError", async () => {
  const ctl = new AbortController();
  const fake = (_url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener?.("abort", () => reject(abortError("已取消")), { once: true });
    });
  setTimeout(() => ctl.abort(), 5);
  await assert.rejects(
    apiFetch("https://fake.local/verify", { fetchImpl: fake, signal: ctl.signal, timeoutMs: 2000 }),
    (e) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, "AbortError");
      return true;
    },
  );
});

// ── 25. apiFetch：纯超时（无外部 signal）→ ApiError 包裹 abort cause ────────────
test("apiFetch 超时被包成 ApiError（cause 为 abort）", async () => {
  const fake = (_url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener?.("abort", () => reject(abortError("The operation was aborted")), { once: true });
    });
  await assert.rejects(
    apiFetch("https://fake.local/slow", { fetchImpl: fake, timeoutMs: 20 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 0);
      assert.ok(isAbort(e.cause), "cause 应是 abort 错误");
      return true;
    },
  );
});

// ── 26. apiFetch：fetch 直接失败（非 abort）→ ApiError 网络错误 ─────────────────
test("apiFetch fetch 失败抛 ApiError（status 0，message 含原因）", async () => {
  const fake = () => Promise.reject(new TypeError("fetch failed"));
  await assert.rejects(
    apiFetch("https://fake.local/y", { fetchImpl: fake, timeoutMs: 1000 }),
    (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 0);
      assert.ok(e.message.includes("fetch failed"));
      return true;
    },
  );
});
