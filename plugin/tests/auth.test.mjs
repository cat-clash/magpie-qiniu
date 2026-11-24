// 七牛 auth 模块测试（离线：node:test + node:assert/strict，Bun 亦可直接跑）。
// 所有涉及 api.qnaigc.com 的校验一律注入假 fetchImpl，不联网。
import test from "node:test";
import assert from "node:assert/strict";

import {
  looksApiKey,
  accountLabelOf,
  uidOf,
  successAuth,
  verifyApiKey,
  verifyAksk,
  keyOnlyLogin,
  login,
  applyCredentialPatch,
  isUsableAuth,
} from "../src/auth.mjs";

const OK_KEY = "sk-test0001abcde12345fghi"; // sk- + 20 位，过 KEY_RE
const AK = "qiniu-test-accesskey-0001"; // 16 位以上
const SK = "qiniu-test-secretkey-000001"; // 16 位以上

/** 假 Response：apiFetch 只读 status / ok / headers / text()。 */
function fakeRes(status, data) {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: new Headers(),
    async text() {
      return JSON.stringify(data);
    },
    async json() {
      return data;
    },
  };
}

// ── 1. looksApiKey 边界 ────────────────────────────────────────────────
test("looksApiKey：sk-/tk- 带 8 位以上字符通过，容许首尾空白", () => {
  assert.equal(looksApiKey("sk-abcdefgh12345678"), true);
  assert.equal(looksApiKey("  sk-abcdefgh1234  "), true); // trim
  assert.equal(looksApiKey("tk-abcdefgh1234"), true); // tk- 也认
  assert.equal(looksApiKey("sk-abcdefgh-_ABC123"), true); // 下划线/连字符
});

test("looksApiKey：短 Key / 乱码 / 非串一律拒绝", () => {
  assert.equal(looksApiKey("sk-abc"), false); // 前缀后不足 8 位
  assert.equal(looksApiKey("sk-"), false);
  assert.equal(looksApiKey("sk-abc!defgh"), false); // 非法字符
  assert.equal(looksApiKey("sk-中文乱码ab"), false);
  assert.equal(looksApiKey("skc0defgh1234"), false); // 前缀不是 sk- / tk-
  assert.equal(looksApiKey("Bearer sk-abcdefgh"), false); // 带多余前缀
  assert.equal(looksApiKey(12345), false);
  assert.equal(looksApiKey(null), false);
  assert.equal(looksApiKey(undefined), false);
});

// ── 2. successAuth 输出形状 ────────────────────────────────────────────
test("successAuth：access/refresh 空串、expires 0、必备字段齐全", () => {
  const s = successAuth({ provider: "qiniu-ai", apiKey: OK_KEY, label: "我的账号" });
  assert.equal(s.type, "success");
  assert.equal(s.access, "");
  assert.equal(s.refresh, "");
  assert.equal(s.expires, 0);
  assert.equal(s.provider, "qiniu-ai");
  assert.equal(s.mode, "key");
  assert.equal(s.apiKey, OK_KEY);
  assert.equal(s.accountId, "我的账号");
  assert.match(s.uid, /^key_[0-9a-f]{12}$/);
  assert.equal(typeof s.verifiedAt, "number");
  // aksk 形态：mode 缺省为 aksk，accessKey/secretKey 透出
  const a = successAuth({ provider: "qiniu-ai", accessKey: AK, secretKey: SK });
  assert.equal(a.mode, "aksk");
  assert.equal(a.accessKey, AK);
  assert.equal(a.secretKey, SK);
});

test("successAuth：空字段也保持稳定形状（accountId 兜底、mode:key）", () => {
  const s = successAuth({});
  assert.equal(s.access, "");
  assert.equal(s.refresh, "");
  assert.equal(s.expires, 0);
  assert.equal(s.mode, "key");
  assert.equal(s.accountId, "七牛云账号");
  assert.match(s.uid, /^acc_[0-9a-z]{8}$/);
});

// ── 3. keyOnlyLogin（假 fetch 拦 api.qnaigc.com）────────────────────────
test("keyOnlyLogin：假 fetch 对 GET /v1/models 200 → success", async () => {
  let calledUrl = "";
  const fetchImpl = async (url) => {
    calledUrl = String(url);
    return fakeRes(200, { data: [{ id: "m1" }] });
  };
  const r = await keyOnlyLogin(
    { apiKey: OK_KEY, label: "主号" },
    { provider: "qiniu-ai", inferOrigin: "https://api.qnaigc.com", fetchImpl },
  );
  assert.ok(calledUrl.endsWith("/v1/models"), calledUrl);
  assert.ok(calledUrl.startsWith("https://api.qnaigc.com"), calledUrl);
  assert.equal(r.type, "success");
  assert.equal(r.mode, "key");
  assert.equal(r.apiKey, OK_KEY);
  assert.equal(r.provider, "qiniu-ai");
  assert.equal(r.expires, 0);
  assert.equal(r.accountId, "主号");
  assert.match(r.uid, /^key_[0-9a-f]{12}$/);
});

test("keyOnlyLogin：401 auth_api_key_invalid → failed 且 error 含「无效」", async () => {
  const fetchImpl = async () =>
    fakeRes(401, { error: { message: "Key 无效", code: "auth_api_key_invalid" } });
  const r = await keyOnlyLogin(
    { apiKey: OK_KEY },
    { inferOrigin: "https://api.qnaigc.com", fetchImpl },
  );
  assert.equal(r.type, "failed");
  assert.ok(r.error.includes("无效"), r.error);
});

test("keyOnlyLogin：Key 形态错 → 立即 failed，不发任何请求", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return fakeRes(200, {});
  };
  const r = await keyOnlyLogin(
    { apiKey: "not-a-key" },
    { inferOrigin: "https://api.qnaigc.com", fetchImpl },
  );
  assert.equal(r.type, "failed");
  assert.ok(r.error.includes("Key 形态不对"), r.error);
  assert.equal(calls, 0);
});

test("keyOnlyLogin：空 Key → failed 且不发请求", async () => {
  let calls = 0;
  const r = await keyOnlyLogin(
    { apiKey: "" },
    {
      inferOrigin: "https://api.qnaigc.com",
      fetchImpl: async () => {
        calls += 1;
        return fakeRes(200, {});
      },
    },
  );
  assert.equal(r.type, "failed");
  assert.ok(r.error.includes("请填写七牛云 API Key"), r.error);
  assert.equal(calls, 0);
});

test("keyOnlyLogin：fetchImpl 抛错（网络不通）→ failed", async () => {
  const r = await keyOnlyLogin(
    { apiKey: OK_KEY },
    {
      inferOrigin: "https://api.qnaigc.com",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  );
  assert.equal(r.type, "failed");
  assert.ok(r.error.includes("连不上七牛"), r.error);
});

// ── 3b. login 统一入口的免请求路径 ──────────────────────────────────────
test("login：什么都没填 → 立即 failed 不发请求（注释里「请填 sk- Key」路径）", async () => {
  let calls = 0;
  const r = await login(
    {},
    {
      inferOrigin: "https://api.qnaigc.com",
      fetchImpl: async () => {
        calls += 1;
        return fakeRes(200, {});
      },
    },
  );
  assert.equal(r.type, "failed");
  assert.ok(r.error.includes("sk- Key"), r.error);
  assert.equal(calls, 0);
});

// ── 4. accountLabelOf / uidOf 兜底 ─────────────────────────────────────
test("accountLabelOf：空输入兜底为「七牛云账号」", () => {
  assert.equal(accountLabelOf(), "七牛云账号");
  assert.equal(accountLabelOf({}), "七牛云账号");
  assert.equal(accountLabelOf({ label: "   " }), "七牛云账号");
});

test("accountLabelOf：取第一个非空候选并截断到 60", () => {
  assert.equal(accountLabelOf({ label: " 主账号 ", email: "a@b.c" }), "主账号");
  assert.equal(accountLabelOf({ email: "a@b.c" }), "a@b.c");
  assert.equal(accountLabelOf({ accountId: "acc-1" }), "acc-1");
  assert.equal(accountLabelOf({ name: "备用" }), "备用");
  assert.equal(accountLabelOf({ label: "x".repeat(80) }).length, 60);
});

test("uidOf：显式 uid 优先；key/aksk 走指纹；空输入回落随机 id", () => {
  assert.equal(uidOf({ uid: "u-1" }), "u-1");
  assert.equal(uidOf({ uid: "  u-2  " }), "u-2"); // trim
  assert.match(uidOf({ apiKey: OK_KEY }), /^key_[0-9a-f]{12}$/);
  assert.match(uidOf({ accessKey: AK, secretKey: SK }), /^aksk_[0-9a-f]{12}$/);
  assert.match(uidOf({}), /^acc_[0-9a-z]{8}$/);
});

// ── 5. applyCredentialPatch / isUsableAuth ─────────────────────────────
test("applyCredentialPatch：合并补丁 + 按凭据推导 mode，空串补丁跳过", () => {
  const p = applyCredentialPatch({ mode: "key", apiKey: "sk-old0001" }, { apiKey: "sk-new0001" });
  assert.equal(p.apiKey, "sk-new0001");
  assert.equal(p.mode, "key");
  assert.equal(typeof p.verifiedAt, "number");

  const a = applyCredentialPatch({}, { accessKey: AK, secretKey: SK });
  assert.equal(a.mode, "aksk");
  assert.equal(a.accessKey, AK);

  const empty = applyCredentialPatch({ apiKey: "sk-old0001" }, { keyLabel: "" });
  assert.equal(empty.keyLabel, undefined); // 空串补丁被忽略
  assert.equal(empty.apiKey, "sk-old0001");
});

test("isUsableAuth：有 Key 或有成对 AK/SK 才可用", () => {
  assert.equal(isUsableAuth({ apiKey: "sk-abc" }), true);
  assert.equal(isUsableAuth({ accessKey: "a", secretKey: "b" }), true);
  assert.equal(isUsableAuth({ accessKey: "a" }), false);
  assert.equal(isUsableAuth({}), false);
  assert.equal(isUsableAuth(null), false);
  assert.equal(isUsableAuth("x"), false);
});

// ── 6. verifyApiKey 的 network / abort 分支 ────────────────────────────
test("verifyApiKey：fetchImpl 抛错 → {ok:false, code:network}", async () => {
  const r = await verifyApiKey({
    apiKey: OK_KEY,
    timeoutMs: 50,
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "network");
  assert.ok(r.reason.includes("连不上七牛"), r.reason);
});

test("verifyApiKey：abort → {ok:false, code:aborted}", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await verifyApiKey({
    apiKey: OK_KEY,
    signal: ctrl.signal,
    timeoutMs: 50,
    fetchImpl: async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "aborted");
});

test("verifyAksk：AK/SK 形态错 → 不发请求直接 shape", async () => {
  let calls = 0;
  const r = await verifyAksk({
    accessKey: "a",
    secretKey: "b",
    fetchImpl: async () => {
      calls += 1;
      return fakeRes(200, {});
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "shape");
  assert.equal(calls, 0);
});