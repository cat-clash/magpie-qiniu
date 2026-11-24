// 七牛 AK/SK 签名模块测试（离线；node:test + node:assert/strict，Bun 亦可直接跑）
//
// 期望值来源：全部由一次性独立脚本用 node:crypto 现场算好后写死在此
//   （算法：encodedSign = urlsafe_base64(hmac_sha1(secretKey, signingString))，
//    见 research/sign-spec.md；测试内不再调用被测函数来推导期望值）。
// 固定假密钥：accessKey="test-ak" secretKey="test-sk"（黄金样例用官方文档的 MY_ACCESS_KEY/MY_SECRET_KEY）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  signingString,
  qiniuAuthHeader,
  splitAksk,
  canonicalXQiniuKey,
  nowXQiniuDate,
  urlSafeBase64Encode,
  splitUrl,
} from "../src/sign.mjs";

const AK = "test-ak";
const SK = "test-sk";
const USAGE_Q =
  "granularity=day&start=2026-11-18T00:00:00%2B08:00&end=2026-11-24T23:59:59%2B08:00&timezone=Asia%2FShanghai";

/** 假密钥固定签名（真实 AK/SK 请自行重算，勿写进仓库） */
const authFor = (sig) => `Qiniu ${AK}:${sig}`;

// ── 1. 官方文档黄金样例（developer.qiniu.com/kodo/1201/access-token 第 4 步）──────
test("golden: 文档样例逐字复现", () => {
  const url =
    "http://rs.qiniu.com/move/bmV3ZG9jczpmaW5kX21hbi50eHQ=/bmV3ZG9jczpmaW5kLm1hbi50eHQ=";
  const expectSS =
    "POST /move/bmV3ZG9jczpmaW5kX21hbi50eHQ=/bmV3ZG9jczpmaW5kLm1hbi50eHQ=\nHost: rs.qiniu.com\n\n";
  assert.equal(
    signingString({ method: "post", url, accessKey: "MY_ACCESS_KEY" }),
    expectSS,
  );
  const got = qiniuAuthHeader({
    method: "POST",
    url,
    accessKey: "MY_ACCESS_KEY",
    secretKey: "MY_SECRET_KEY",
  });
  assert.ok(got.startsWith("Qiniu MY_ACCESS_KEY:"));
  // 文档给出的 hmac_sha1 十六进制 = d6e2efb9933a97aa02cd916a909ea8238a053154
  assert.equal(
    Buffer.from(got.slice("Qiniu MY_ACCESS_KEY:".length), "base64url").toString("hex"),
    "d6e2efb9933a97aa02cd916a909ea8238a053154",
  );
});

// ── 2. GET 带 query（qnaigc 用量接口，query 已百分号编码，+ 必须写成 %2B）────────
test("GET /v3/stat/usage 带编码 query", () => {
  const o = { method: "GET", url: `https://api.qnaigc.com/v3/stat/usage?${USAGE_Q}`, accessKey: AK };
  assert.equal(
    signingString(o),
    "GET /v3/stat/usage?granularity=day&start=2026-11-18T00:00:00%2B08:00&end=2026-11-24T23:59:59%2B08:00&timezone=Asia%2FShanghai\nHost: api.qnaigc.com\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("kislHibkMCbM-BXOZmbBpNzURCU="));
});

// ── 3. GET 不带 query ──────────────────────────────────────────────────────────
test("GET /v1/apikey/quota/:api_key 无 query", () => {
  const o = { method: "GET", url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001", accessKey: AK };
  assert.equal(signingString(o), "GET /v1/apikey/quota/sk-demo0001\nHost: api.qnaigc.com\n\n");
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("h6ogipX6Dri_uV2jZUE1k0F4j9M="));
});

// ── 4. POST json 带 body（含中文）─────────────────────────────────────────────
test("POST application/json 附 body", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: '{"count":2,"names":["测试key1","测试key2"]}',
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    'POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\n\n{"count":2,"names":["测试key1","测试key2"]}',
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("XDAJe2erNfcTGPNCmnxnKbn_EAk="));
});

// ── 5. POST form-urlencoded 不附 body ─────────────────────────────────────────
test("form-urlencoded 不签 body", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/x-www-form-urlencoded",
    body: "count=2&names=a",
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    "POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/x-www-form-urlencoded\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("TzwOM7rJsEylMcWK8yFz_tpuGHk="));
});

// ── 6. multipart/form-data 不附 body ─────────────────────────────────────────
test("multipart 不签 body", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "multipart/form-data; boundary=abc123",
    body: '--abc123\r\ncontent-disposition: form-data; name="count"\r\n\r\n2\r\n--abc123--',
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    "POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: multipart/form-data; boundary=abc123\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("m6CMMq2EkC_USCx87sus7FfrgX0="));
});

// ── 7. 空 body（有 Content-Type）─────────────────────────────────────────────
test("空 body 仍保留 Content-Type 与空行", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: "",
    accessKey: AK,
  };
  assert.equal(signingString(o), "POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\n\n");
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("bp8HjwLn-KFq1aOdSm81Q7iIgcQ="));
});

// ── 8. octet-stream 不附 body ─────────────────────────────────────────────────
test("application/octet-stream 不签 body", () => {
  const o = {
    method: "PUT",
    url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001",
    contentType: "application/octet-stream",
    body: "binary-bytes",
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    "PUT /v1/apikey/quota/sk-demo0001\nHost: api.qnaigc.com\nContent-Type: application/octet-stream\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("9L8WOphNxmN8FMCbGco-J9hzpFk="));
});

// ── 9. PUT json 带 body ───────────────────────────────────────────────────────
test("PUT 限额带 json body", () => {
  const o = {
    method: "PUT",
    url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001",
    contentType: "application/json",
    body: '{"daily_quota":{"enabled":false,"limit":0,"alert_threshold":0}}',
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    'PUT /v1/apikey/quota/sk-demo0001\nHost: api.qnaigc.com\nContent-Type: application/json\n\n{"daily_quota":{"enabled":false,"limit":0,"alert_threshold":0}}',
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("sua5Nq_xpU4CYUgcpm-aYxFITbU="));
});

// ── 10. X-Qiniu-* 排序（全小写输入）───────────────────────────────────────────
test("X-Qiniu-Date 等头按 ASCII 升序", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: '{"count":1}',
    headers: { "x-qiniu-date": "2026-11-25T05:15:59Z", "x-qiniu-audit": "on" },
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    'POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\nX-Qiniu-Audit: on\nX-Qiniu-Date: 2026-11-25T05:15:59Z\n\n{"count":1}',
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("dF3xHpcYibhGQ4A1s5Ty-3wHutA="));
});

// ── 11. 大小写混乱的 X-Qiniu 头：按规范化后的 key 排序，非 X-Qiniu 头忽略 ──────
test("X-Qiniu 头大小写混乱（按规范化 key 排序，Authorization 不参与）", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: '{"count":1}',
    headers: {
      "X-QINIU-ZLIB": "3",
      "x-qiniu-audit": "on",
      Authorization: "Qiniu test-ak:notsigned",
    },
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    'POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\nX-Qiniu-Audit: on\nX-Qiniu-Zlib: 3\n\n{"count":1}',
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("dQSIkM8vnFyJERv1Y-99N9Y_5To="));
});

// ── 12. query + X-Qiniu-Date 同现 ─────────────────────────────────────────────
test("query 与 X-Qiniu-Date 同现", () => {
  const o = {
    method: "GET",
    url: "https://api.qnaigc.com/v3/stat/usage?granularity=day&start=2026-11-18T00:00:00%2B08:00&end=2026-11-24T23:59:59%2B08:00",
    headers: { "X-Qiniu-Date": "2026-11-25T05:15:59Z" },
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    "GET /v3/stat/usage?granularity=day&start=2026-11-18T00:00:00%2B08:00&end=2026-11-24T23:59:59%2B08:00\nHost: api.qnaigc.com\nX-Qiniu-Date: 2026-11-25T05:15:59Z\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("ANly5VutA1HHnPUSs_M4_QcA-aY="));
});

// ── 13. contentType 缺省时回退读 headers ─────────────────────────────────────
test("contentType 从 headers 取", () => {
  const o = {
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    headers: { "content-type": "application/json" },
    body: '{"a":1}',
    accessKey: AK,
  };
  assert.equal(signingString(o), 'POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\n\n{"a":1}');
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("MVq5x2ExizK8nsCXz5KGeSsGJZg="));
});

// ── 14. URL 尾斜杠 ────────────────────────────────────────────────────────────
test("URL 尾斜杠原样保留", () => {
  const o = { method: "GET", url: "https://api.qiniu.com/billing-api/v1/respack/list/", accessKey: AK };
  assert.equal(signingString(o), "GET /billing-api/v1/respack/list/\nHost: api.qiniu.com\n\n");
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("lBVCA_njtJeB8jIvE0884JrOU1I="));
});

// ── 15. URL 带 hash（fragment 丢弃）──────────────────────────────────────────
test("URL 带 hash 时 fragment 不进签名", () => {
  const o = {
    method: "GET",
    url: "https://api.qiniu.com/billing-api/v1/account/balance-overview?page=1#top",
    accessKey: AK,
  };
  assert.equal(
    signingString(o),
    "GET /billing-api/v1/account/balance-overview?page=1\nHost: api.qiniu.com\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, secretKey: SK }), authFor("93qTQUAlx8c7ObVSyDgKRnVyYuM="));
});

// ── 16. Host 含端口 / 两个域名都能签 ─────────────────────────────────────────
test("Host 行含端口；api.qiniu.com 与 api.qnaigc.com 均可签", () => {
  const port = {
    method: "GET",
    url: "https://api.qiniu.com:8443/billing-api/v1/account/balance-overview",
    accessKey: AK,
  };
  assert.equal(
    signingString(port),
    "GET /billing-api/v1/account/balance-overview\nHost: api.qiniu.com:8443\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...port, secretKey: SK }), authFor("G9BcgSLJazs_Osc2v2tl-bQdG6U="));
  // 无端口时 = 纯域名（等于 WHATWG host）
  const plain = { method: "GET", url: "https://api.qiniu.com/billing-api/v1/account/balance-overview", accessKey: AK };
  assert.match(signingString(plain), /^GET [^\n]+\nHost: api\.qiniu\.com\n\n$/);
  // host 显式覆盖优先于 url
  assert.match(
    signingString({ ...plain, host: "api.qnaigc.com" }),
    /\nHost: api\.qnaigc\.com\n\n$/,
  );
});

// ── 17. 变体开关（默认口径之外，仅备用）──────────────────────────────────────
test('queryMode:"line" 与 style:"split-lines" 备用开关', () => {
  const o = { method: "GET", url: `https://api.qnaigc.com/v3/stat/usage?${USAGE_Q}`, accessKey: AK };
  assert.equal(
    signingString({ ...o, queryMode: "line" }),
    "GET /v3/stat/usage\n" + USAGE_Q + "\nHost: api.qnaigc.com\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, queryMode: "line", secretKey: SK }), authFor("yEHZ6bEz_6KnNZdpgM3GEEt4oRY="));
  assert.equal(
    signingString({ ...o, style: "split-lines" }),
    "GET\n/v3/stat/usage\n" + USAGE_Q + "\napi.qnaigc.com\n\n",
  );
  assert.equal(qiniuAuthHeader({ ...o, style: "split-lines", secretKey: SK }), authFor("HyRImtI_oEhtaH80tn6JWmjFinc="));
  assert.throws(() => signingString({ ...o, style: "nope" }), /未知 style/);
  assert.throws(() => signingString({ ...o, queryMode: "nope" }), /未知 queryMode/);
});

// ── 18. method 大小写 / Headers 容器 / 二进制与对象 body ──────────────────────
test("输入归一化", () => {
  const lower = signingString({ method: "get", url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001", accessKey: AK });
  assert.equal(lower, signingString({ method: "GET", url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001", accessKey: AK }));

  const viaMap = signingString({
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    headers: new Map([
      ["content-type", "application/json"],
      ["x-qiniu-date", "2026-11-25T05:15:59Z"],
    ]),
    body: '{"count":1}',
    accessKey: AK,
  });
  assert.equal(
    viaMap,
    'POST /v1/apikeys\nHost: api.qnaigc.com\nContent-Type: application/json\nX-Qiniu-Date: 2026-11-25T05:15:59Z\n\n{"count":1}',
  );

  const arr = signingString({
    method: "GET",
    url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001",
    headers: { "x-qiniu-audit": ["on", "off"] },
    accessKey: AK,
  });
  assert.match(arr, /X-Qiniu-Audit: on\n/);

  const bytes = signingString({
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: new TextEncoder().encode('{"count":1}'),
    accessKey: AK,
  });
  assert.match(bytes, /\n\n\{"count":1\}$/);

  const obj = signingString({
    method: "POST",
    url: "https://api.qnaigc.com/v1/apikeys",
    contentType: "application/json",
    body: { count: 1 },
    accessKey: AK,
  });
  assert.match(obj, /\n\n\{"count":1\}$/);
});

// ── 19. 工具函数 ──────────────────────────────────────────────────────────────
test("canonicalXQiniuKey / nowXQiniuDate / urlSafeBase64Encode / splitUrl", () => {
  assert.equal(canonicalXQiniuKey("x-qiniu-date"), "X-Qiniu-Date");
  assert.equal(canonicalXQiniuKey("X-QINIU-META-TAG"), "X-Qiniu-Meta-Tag");
  assert.equal(nowXQiniuDate(new Date("2026-11-25T05:15:59.000Z")), "2026-11-25T05:15:59Z");
  assert.equal(urlSafeBase64Encode(Buffer.from("i??")), "aT8_");
  const u = splitUrl("https://u:p@api.qnaigc.com:8443/v1/apikeys?a=1#frag");
  assert.deepEqual(u, { host: "api.qnaigc.com:8443", path: "/v1/apikeys", query: "a=1" });
  assert.equal(splitUrl("https://api.qiniu.com").path, "/");
  assert.throws(() => splitUrl(""), /url 不能为空/);
  assert.throws(() => signingString({ method: "GET", url: "/no-host", accessKey: AK }), /无法确定 Host/);
});

// ── 20. splitAksk ─────────────────────────────────────────────────────────────
test("splitAksk 合法输入", () => {
  assert.deepEqual(splitAksk("abcdef123456:SECRETVALUE9999"), {
    ok: true,
    accessKey: "abcdef123456",
    secretKey: "SECRETVALUE9999",
  });
  assert.deepEqual(splitAksk("  abcdef123456 , SECRETVALUE9999  "), {
    ok: true,
    accessKey: "abcdef123456",
    secretKey: "SECRETVALUE9999",
  });
  assert.deepEqual(splitAksk("abcdef123456 SECRETVALUE9999"), {
    ok: true,
    accessKey: "abcdef123456",
    secretKey: "SECRETVALUE9999",
  });
  assert.deepEqual(splitAksk("Qiniu abcdef123456:SECRETVALUE9999"), {
    ok: true,
    accessKey: "abcdef123456",
    secretKey: "SECRETVALUE9999",
  });
});

test("splitAksk 非法输入（含冒号的 AK、多分隔符、缺段、非串、过短）", () => {
  assert.equal(splitAksk("ak:with:colon:sk").error, "too_many_colons");
  assert.equal(splitAksk("ak,with,comma,sk").error, "too_many_commas");
  assert.equal(splitAksk("ak sk extra").error, "too_many_fields");
  assert.equal(splitAksk("sk-abcdefghij").error, "api_key_not_aksk");
  assert.equal(splitAksk("abcdefghij").error, "no_separator");
  assert.equal(splitAksk("abcdef123456:").error, "missing_part");
  assert.equal(splitAksk(":SECRETVALUE9999").error, "missing_part");
  assert.equal(splitAksk("ab:cd").error, "too_short");
  assert.equal(splitAksk("ak sk:abcdef123456").error, "space_in_part");
  assert.equal(splitAksk("ak中:sk文").error, "bad_chars");
  assert.equal(splitAksk("").error, "empty");
  assert.equal(splitAksk("   ").error, "empty");
  assert.equal(splitAksk(null).error, "not_string");
  assert.equal(splitAksk(undefined).error, "not_string");
  for (const bad of ["", null, undefined, "ak:with:colon:sk", "abcdefghij", "ab:cd", "ak中:sk文"]) {
    const r = splitAksk(bad);
    assert.equal(r.ok, false, JSON.stringify(String(bad)));
    assert.equal(r.accessKey, undefined, JSON.stringify(String(bad)));
    assert.equal(r.secretKey, undefined, JSON.stringify(String(bad)));
    assert.equal(typeof r.error, "string");
  }
});

// ── 21. 参数校验与不泄密 ──────────────────────────────────────────────────────
test("空 AK/SK 抛错；输出不含 secretKey", () => {
  const base = { method: "GET", url: "https://api.qnaigc.com/v1/apikey/quota/sk-demo0001" };
  assert.throws(() => qiniuAuthHeader({ ...base, accessKey: "", secretKey: SK }), TypeError);
  assert.throws(() => qiniuAuthHeader({ ...base, accessKey: AK, secretKey: "" }), TypeError);
  const header = qiniuAuthHeader({ ...base, accessKey: AK, secretKey: SK });
  assert.ok(!header.includes(SK), "Authorization 值里绝不能出现 secretKey");
  assert.ok(header.startsWith("Qiniu test-ak:"));
});
