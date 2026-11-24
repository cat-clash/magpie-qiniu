import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promptCacheKey, keyFingerprint, contentToText } from "../src/cache-key.mjs";

// 假凭据用字符串拼接，文件里不写双花括号占位符形态。
const SECRET = "sk-" + "A1b2C3d4E5f6";
const NL = String.fromCharCode(10);

// ---------------------------------------------------------------------------
// 内容提取
// ---------------------------------------------------------------------------

test("提取文本内容：字符串原样返回", () => {
  assert.strictEqual(contentToText("hello"), "hello");
  assert.strictEqual(contentToText(""), "");
});

test("提取文本内容：只取 text 段与图片地址并用空格拼接", () => {
  const got = contentToText([
    { type: "text", text: "甲" },
    { type: "text", text: "乙" },
    { type: "image_url", image_url: { url: "http://img/abc" } },
    { type: "image_url", image_url: {} },
    { role: "user", content: "忽略我" },
  ]);
  assert.strictEqual(got, "甲 乙 http://img/abc");
});

test("提取文本内容：非数组、空数组与 null 都返回空串", () => {
  assert.strictEqual(contentToText(null), "");
  assert.strictEqual(contentToText(undefined), "");
  assert.strictEqual(contentToText(123), "");
  assert.strictEqual(contentToText([]), "");
});

test("提取文本内容：图片地址截断到 256 字符", () => {
  const long = "u".repeat(400);
  const out = contentToText([{ type: "image_url", image_url: { url: long } }]);
  assert.strictEqual(out.length, 256);
  assert.strictEqual(out, long.slice(0, 256));
});

// ---------------------------------------------------------------------------
// 提示缓存键
// ---------------------------------------------------------------------------

test("提示缓存键：相同模型、系统提示与首条用户消息得到相同键", () => {
  const a = {
    model: "m1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  };
  const b = {
    model: "m1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "later" },
    ],
  };
  assert.strictEqual(promptCacheKey(a), promptCacheKey(b));
});

test("提示缓存键：只差后续消息得到相同键", () => {
  const make = (tail) => ({
    model: "m1",
    messages: [
      { role: "user", content: "first" },
      ...tail,
    ],
  });
  const base = make([]);
  const withMore = make([
    { role: "assistant", content: "a1" },
    { role: "user", content: "second" },
  ]);
  assert.strictEqual(promptCacheKey(base), promptCacheKey(withMore));
});

test("提示缓存键：不同首条用户消息得到不同键", () => {
  const make = (u) => ({
    model: "m1",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: u },
    ],
  });
  assert.notStrictEqual(promptCacheKey(make("one")), promptCacheKey(make("two")));
});

test("提示缓存键：不同模型或不同系统提示得到不同键", () => {
  const withModel = (m) => ({ model: m, messages: [{ role: "user", content: "hi" }] });
  const withSystem = (s) => ({
    model: "m1",
    messages: [
      { role: "system", content: s },
      { role: "user", content: "hi" },
    ],
  });
  assert.notStrictEqual(promptCacheKey(withModel("m1")), promptCacheKey(withModel("m2")));
  assert.notStrictEqual(promptCacheKey(withSystem("s1")), promptCacheKey(withSystem("s2")));
});

test("提示缓存键：developer 角色等同 system，首条用户内容截到 1024", () => {
  const a = {
    model: "m",
    messages: [
      { role: "developer", content: "rule" },
      { role: "user", content: "q" },
    ],
  };
  const b = {
    model: "m",
    messages: [
      { role: "system", content: "rule" },
      { role: "user", content: "q" },
    ],
  };
  assert.strictEqual(promptCacheKey(a), promptCacheKey(b));

  const long = "x".repeat(2000);
  const c = { model: "m", messages: [{ role: "user", content: long }] };
  const d = { model: "m", messages: [{ role: "user", content: long.slice(0, 1024) }] };
  assert.strictEqual(promptCacheKey(c), promptCacheKey(d));
});

test("提示缓存键：按换行符分隔拼接并产出 40 位十六进制", () => {
  // 真实实现用 String.fromCharCode(10) 作分隔符，system 段前带一个空格。
  const body = {
    model: "m",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  };
  const joined = ["m", " sys", "hi"].join(NL);
  const expected = createHash("sha1").update(joined).digest("hex");
  const got = promptCacheKey(body);
  assert.strictEqual(got, expected);
  assert.match(got, /^[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------------------
// 凭据指纹
// ---------------------------------------------------------------------------

test("凭据指纹稳定为 12 位十六进制", () => {
  const fp = keyFingerprint(SECRET);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.strictEqual(fp, keyFingerprint(SECRET));
  assert.strictEqual(fp, keyFingerprint("  " + SECRET + "  "));
  assert.strictEqual(fp, createHash("sha1").update(SECRET).digest("hex").slice(0, 12));
});

test("凭据指纹：空值与空白返回空串，不同值得到不同指纹", () => {
  assert.strictEqual(keyFingerprint(""), "");
  assert.strictEqual(keyFingerprint("   "), "");
  assert.strictEqual(keyFingerprint(null), "");
  assert.strictEqual(keyFingerprint(undefined), "");
  assert.notStrictEqual(keyFingerprint(SECRET), keyFingerprint("sk-" + "Z9y8X7w6"));
});
