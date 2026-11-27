import test from "node:test";
import assert from "node:assert/strict";
import {
  accountLabel,
  accountPriority,
  compareAccounts,
  sortAccounts,
  describeAccount,
} from "../src/account-name.mjs";

// 假凭据一律字符串拼接，文件里不出现完整的 Key 形态。
const KEY = "sk-" + "LIVE1234567890abcdef";
const KEY_SHORT = "sk-" + "abc";
const AT = String.fromCharCode(64); // "@"，避免写成字形里的占位符

// ---------------------------------------------------------------------------
// label：各层回落
// ---------------------------------------------------------------------------

test("标签：alias 优先于邮箱、账号 id 和 uid", () => {
  const auth = {
    alias: "主力号",
    email: "a" + AT + "x.com",
    accountId: "acc-1",
    uid: "u-1",
    metadata: { alias: "备注别名", email: "b" + AT + "x.com" },
  };
  assert.strictEqual(accountLabel(auth), "主力号");
});

test("标签：没有 alias 时回落 metadata.alias，再回落 email", () => {
  assert.strictEqual(accountLabel({ metadata: { alias: "备注别名" } }), "备注别名");
  assert.strictEqual(
    accountLabel({ email: "a" + AT + "x.com", metadata: { alias: "备注别名" } }),
    "备注别名",
  );
  assert.strictEqual(accountLabel({ email: "a" + AT + "x.com" }), "a" + AT + "x.com");
});

test("标签：email 缺失时回落 metadata.email，再回落 accountId、metadata.accountId", () => {
  assert.strictEqual(accountLabel({ metadata: { email: "m" + AT + "x.com" } }), "m" + AT + "x.com");
  assert.strictEqual(accountLabel({ accountId: "acc-9" }), "acc-9");
  assert.strictEqual(accountLabel({ metadata: { accountId: "acc-8" } }), "acc-8");
});

test("标签：只剩 uid 时用 uid（数字也认）", () => {
  assert.strictEqual(accountLabel({ uid: "u-7" }), "u-7");
  assert.strictEqual(accountLabel({ metadata: { uid: 12345 } }), "12345");
});

test("标签：只有 Key 时脱敏成 前6…后4，且不泄露整串", () => {
  const label = accountLabel({ key: KEY });
  assert.strictEqual(label, "API key sk-LIV…cdef");
  assert.ok(!label.includes(KEY), "标签里不能出现完整 Key");
  assert.ok(label.includes("…"));
  // 太短的 Key 连前后缀都不给
  assert.strictEqual(accountLabel({ key: KEY_SHORT }), "API key …");
  assert.strictEqual(accountLabel({ metadata: { apiKey: KEY } }), "API key sk-LIV…cdef");
});

test("标签：什么都没有时兜底为「七牛云账号」，永不为空", () => {
  assert.strictEqual(accountLabel({}), "七牛云账号");
  assert.strictEqual(accountLabel(null), "七牛云账号");
  assert.strictEqual(accountLabel({ alias: "   ", email: "" }), "七牛云账号");
});

// ---------------------------------------------------------------------------
// label：同邮箱多 Key 的后缀
// ---------------------------------------------------------------------------

test("标签：同邮箱多 Key 的 (<hash>) 后缀原样保留，且两个号不重名", () => {
  const a = { email: "user" + AT + "x.com(1a2b3c)" };
  const b = { email: "user" + AT + "x.com(9f8e7d)" };
  assert.strictEqual(accountLabel(a), "user" + AT + "x.com(1a2b3c)");
  assert.strictEqual(accountLabel(b), "user" + AT + "x.com(9f8e7d)");
  assert.notStrictEqual(accountLabel(a), accountLabel(b));
});

// ---------------------------------------------------------------------------
// label：截断
// ---------------------------------------------------------------------------

test("标签：超长截断到 60 字符", () => {
  const long = "a".repeat(80) + AT + "x.com";
  const label = accountLabel({ email: long });
  assert.strictEqual(label.length, 60);
  assert.strictEqual(label, long.slice(0, 60));
  // 刚好 60 的不动
  const exact = "b".repeat(60);
  assert.strictEqual(accountLabel({ email: exact }), exact);
});

// ---------------------------------------------------------------------------
// priority
// ---------------------------------------------------------------------------

test("优先级：metadata.priority 优先于 alias 前缀", () => {
  assert.strictEqual(accountPriority({ metadata: { priority: 7 } }), 7);
  assert.strictEqual(accountPriority({ alias: "p2-x", metadata: { priority: 7 } }), 7);
});

test("优先级：alias 的 p0/p1/p2 解析后取负，让 p0 排最前", () => {
  assert.strictEqual(accountPriority({ alias: "p0-main" }), 0);
  assert.strictEqual(accountPriority({ alias: "p1-backup" }), -1);
  assert.strictEqual(accountPriority({ alias: "p2-third" }), -2);
  assert.strictEqual(accountPriority({ metadata: { alias: "p3-x" } }), -3);
  // 方向：p0 应排在 p1 前面
  assert.ok(accountPriority({ alias: "p0-main" }) > accountPriority({ alias: "p1-backup" }));
});

test("优先级：非法值与缺省一律回落 0", () => {
  assert.strictEqual(accountPriority({}), 0);
  assert.strictEqual(accountPriority(null), 0);
  assert.strictEqual(accountPriority({ metadata: { priority: Number.NaN } }), 0);
  assert.strictEqual(accountPriority({ metadata: { priority: Infinity } }), 0);
  assert.strictEqual(accountPriority({ metadata: { priority: "5" } }), 0);
  assert.strictEqual(accountPriority({ metadata: { priority: null } }), 0);
  assert.strictEqual(accountPriority({ alias: "主号" }), 0);
});

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

test("比较器：priority 高的排前面", () => {
  const hot = { alias: "p0-hot", email: "z" + AT + "x.com" };
  const cold = { alias: "p1-cold", email: "a" + AT + "x.com" };
  assert.ok(compareAccounts(hot, cold) < 0);
  assert.ok(compareAccounts(cold, hot) > 0);
  assert.strictEqual(compareAccounts(hot, hot), 0);
});

test("比较器：priority 相同时按 label 升序（localeCompare zh-CN）", () => {
  const a = { email: "alpha" + AT + "x.com" };
  const b = { email: "beta" + AT + "x.com" };
  assert.ok(compareAccounts(a, b) < 0);
  assert.ok(compareAccounts(b, a) > 0);
  assert.strictEqual(compareAccounts({ email: "same" + AT + "x.com" }, { email: "same" + AT + "x.com" }), 0);
});

test("排序：sortAccounts 返回新数组，不改入参", () => {
  const input = [
    { alias: "p1-b", email: "b" + AT + "x.com" },
    { alias: "p0-a", email: "a" + AT + "x.com" },
    { email: "c" + AT + "x.com" },
  ];
  const snapshot = input.map((x) => x);
  const sorted = sortAccounts(input);

  assert.notStrictEqual(sorted, input);
  assert.deepStrictEqual(input, snapshot, "入参顺序必须保持不变");
  assert.strictEqual(accountLabel(input[0]), "p1-b");
  // 无 alias 的号 priority 是默认 0，比 p1(-1) 优先，只输给同 priority 里 label 更小的 p0-a；
  // 而 p0-a 的 label 以 "p" 开头、c 开头的排在它前面，所以顺序是 c → p0-a → p1-b。
  assert.deepStrictEqual(
    sorted.map((x) => accountLabel(x)),
    ["c" + AT + "x.com", "p0-a", "p1-b"],
  );
  // 非数组入参不抛错
  assert.deepStrictEqual(sortAccounts(null), []);
  assert.deepStrictEqual(sortAccounts(undefined), []);
});

// ---------------------------------------------------------------------------
// describeAccount
// ---------------------------------------------------------------------------

test("描述对象：source 如实反映标签来自哪一层", () => {
  assert.deepStrictEqual(describeAccount({ alias: "主力号", accountId: "acc-1", metadata: {} }), {
    label: "主力号",
    priority: 0,
    id: "acc-1",
    source: "alias",
  });
  assert.strictEqual(describeAccount({ metadata: { email: "m" + AT + "x.com" } }).source, "metadata.email");
  assert.strictEqual(describeAccount({ email: "e" + AT + "x.com" }).source, "email");
  assert.strictEqual(describeAccount({ accountId: "acc-2" }).source, "accountId");
  assert.strictEqual(describeAccount({ metadata: { accountId: "acc-3" } }).source, "metadata.accountId");
  assert.strictEqual(describeAccount({ uid: "u-1" }).source, "uid");
  assert.strictEqual(describeAccount({ metadata: { uid: "u-2" } }).source, "metadata.uid");
  assert.strictEqual(describeAccount({ key: KEY }).source, "key");
  assert.strictEqual(describeAccount({}).source, "fallback");
});

test("描述对象：priority 与 id 一并给出，Key 不进 id", () => {
  const d = describeAccount({ alias: "p1-backup", uid: "u-9", key: KEY });
  assert.strictEqual(d.priority, -1);
  assert.strictEqual(d.id, "u-9");
  assert.ok(!d.id.includes(KEY));

  // 完全没 id 时回落 label，保证非空
  const onlyKey = describeAccount({ key: KEY });
  assert.strictEqual(onlyKey.id, onlyKey.label);
  assert.ok(onlyKey.id.length > 0);
});

// ---------------------------------------------------------------------------
// 健壮性
// ---------------------------------------------------------------------------

test("空对象、null、非对象入参都不抛错", () => {
  for (const bad of [null, undefined, 0, 42, "", "str", [], [1, 2], true]) {
    assert.strictEqual(accountLabel(bad), "七牛云账号");
    assert.strictEqual(accountPriority(bad), 0);
    assert.strictEqual(describeAccount(bad).source, "fallback");
    assert.doesNotThrow(() => compareAccounts(bad, {}));
  }
  // metadata 是数组 / null 时按缺失处理
  assert.strictEqual(accountLabel({ metadata: null, email: "k" + AT + "x.com" }), "k" + AT + "x.com");
  assert.strictEqual(accountPriority({ metadata: [1, 2] }), 0);
});
