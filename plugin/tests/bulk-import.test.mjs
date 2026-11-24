// 批量导入解析与受控并发测试：全部本地数据，不联网。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCredentialBlob, mapLimit, dedupeKeyOf, isValidProviderId } from "../src/bulk-import.mjs";

const L = String.fromCharCode(123);
const R = String.fromCharCode(125);

const KEY_A = "sk-" + "A1b2C3d4E5f6G7h8";
const KEY_B = "sk-" + "Z9y8X7w6V5u4T3s2";
const KEY_C = "sk-" + "C4d5E6f7G8h9I0j1";
const KEY_D = "sk-" + "Q1w2E3r4T5y6U7i8";
const AK_A = "AK" + "0000000000000001";
const SK_A = "SC" + "1111111111111111";
const AK_B = "AK" + "2222222222222222";
const SK_B = "SC" + "3333333333333333";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("解析凭据：单把 Key、备注在前或后、注释行与重复项", () => {
  const text = [
    "# 井号注释应忽略",
    "// 双斜杠注释应忽略",
    KEY_A,
    "主力, " + KEY_B,
    KEY_A + ", 重复的那把",
  ].join("\n");

  const got = parseCredentialBlob(text);
  assert.deepEqual(Object.keys(got), ["entries", "errors"]);
  assert.deepEqual(got.entries, [
    { apiKey: KEY_A },
    { apiKey: KEY_B, label: "主力" },
  ]);
  assert.deepEqual(got.errors, []);
});

test("解析凭据：AK:SK、AK SK、AK SK 备注三种写法并对同一对去重", () => {
  const text = [
    AK_A + ":" + SK_A,
    AK_B + " " + SK_B + " 备用账号",
    AK_A + " " + SK_A + " 重复账号",
  ].join("\n");

  const got = parseCredentialBlob(text);
  assert.deepEqual(got.entries, [
    { accessKey: AK_A, secretKey: SK_A },
    { accessKey: AK_B, secretKey: SK_B, label: "备用账号" },
  ]);
  assert.deepEqual(got.errors, []);
});

test("解析凭据：整段 JSON 数组与 keys 包装对象", () => {
  const arrayText =
    "[" +
    L + "\"key\":\"" + KEY_A + "\",\"label\":\"主力\"" + R + "," +
    L + "\"accessKey\":\"" + AK_A + "\",\"secretKey\":\"" + SK_A + "\",\"note\":\"备用\"" + R +
    "]";
  const wrappedText = L + "\"keys\":[" + L + "\"apiKey\":\"" + KEY_B + "\"" + R + "]" + R;

  const arrayResult = parseCredentialBlob(arrayText);
  assert.deepEqual(arrayResult.entries, [
    { apiKey: KEY_A, label: "主力" },
    { accessKey: AK_A, secretKey: SK_A, label: "备用" },
  ]);
  assert.deepEqual(arrayResult.errors, []);

  const wrappedResult = parseCredentialBlob(wrappedText);
  assert.deepEqual(wrappedResult.entries, [{ apiKey: KEY_B }]);
  assert.deepEqual(wrappedResult.errors, []);
});

test("解析凭据：逐行错误带行号、原因和预览，空内容也有固定形状", () => {
  const got = parseCredentialBlob("这不是凭据\n" + KEY_A + "\n" + AK_A + "\n");
  assert.deepEqual(got.entries, [{ apiKey: KEY_A }]);
  assert.deepEqual(got.errors, [
    { line: 1, reason: "看不出是 sk-/tk- Key，也不是 AK:SK", preview: "这不是凭据" },
    { line: 3, reason: "看不出是 sk-/tk- Key，也不是 AK:SK", preview: AK_A },
  ]);

  const jsonError = parseCredentialBlob(
    "[" + L + "\"key\":\"" + KEY_A + "\"" + R + "," + L + "\"foo\":\"bar\"" + R + "]",
  );
  assert.deepEqual(jsonError.entries, [{ apiKey: KEY_A }]);
  assert.deepEqual(jsonError.errors, [
    {
      line: 2,
      reason: "JSON 里这条既没有 sk-/tk- Key，也没有成对的 AK/SK",
      preview: L + "\"foo\":\"bar\"" + R,
    },
  ]);

  assert.deepEqual(parseCredentialBlob("   "), {
    entries: [],
    errors: [{ line: 0, reason: "内容是空的", preview: "" }],
  });
});

test("解析凭据：max 截断多余条目并回传上限错误", () => {
  const got = parseCredentialBlob([KEY_A, KEY_B, KEY_C, KEY_D].join("\n"), { max: 2 });
  assert.deepEqual(got.entries, [
    { apiKey: KEY_A },
    { apiKey: KEY_B },
  ]);
  assert.deepEqual(got.errors, [
    { line: 0, reason: "超过单次导入上限 2 条，多余的已忽略", preview: "" },
  ]);
});

test("受控并发：同时运行数不超过 limit 且结果顺序与输入一致", async () => {
  const items = [1, 2, 3, 4, 5];
  const started = [];
  const releases = new Map();
  const pending = mapLimit(items, 2, async (item) => {
    started.push(item);
    await new Promise((resolve) => releases.set(item, resolve));
    return item * 10;
  });

  assert.deepEqual(started, [1, 2]);
  releases.get(1)();
  await tick();
  assert.deepEqual(started, [1, 2, 3]);
  releases.get(2)();
  await tick();
  assert.deepEqual(started, [1, 2, 3, 4]);
  releases.get(3)();
  await tick();
  assert.deepEqual(started, [1, 2, 3, 4, 5]);

  for (const item of started) releases.get(item)();
  assert.deepEqual(await pending, [10, 20, 30, 40, 50]);
});

test("受控并发：fn 抛错时整体 Promise 以原错误拒绝", async () => {
  const boom = new Error("并发任务炸了");
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async (item) => {
      if (item === 2) throw boom;
      return item;
    }),
    (error) => error === boom,
  );
});

test("凭据指纹：同 Key 或同 AK/SK 的不同字段形态归为同一账号", () => {
  const keyFp = dedupeKeyOf({ apiKey: KEY_A });
  assert.equal(keyFp, dedupeKeyOf({ key: KEY_A }));
  assert.equal(keyFp, dedupeKeyOf({ apiKey: KEY_A, accessKey: AK_A, secretKey: SK_A }));
  assert.notEqual(keyFp, dedupeKeyOf({ apiKey: KEY_B }));

  const pairFp = dedupeKeyOf({ accessKey: AK_A, secretKey: SK_A });
  assert.equal(pairFp, dedupeKeyOf({ accessKey: AK_A, secretKey: SK_A, label: "任意备注" }));
  assert.notEqual(pairFp, dedupeKeyOf({ accessKey: AK_B, secretKey: SK_A }));

  assert.equal(dedupeKeyOf(null), "");
  assert.equal(dedupeKeyOf({}), "");
  assert.equal(dedupeKeyOf({ key: " " }), "");
});

test("供应商 id 校验：只接受小写字母、数字和连字符", () => {
  assert.equal(isValidProviderId("qiniu-ai"), true);
  for (const value of ["Qiniu", "qiniu_ai", "qiniu ai", "qiniu-ai ", "", "a", "a".repeat(42)]) {
    assert.equal(isValidProviderId(value), false, value);
  }
});
