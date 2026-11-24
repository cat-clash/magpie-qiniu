// 一次性修复：subagent 写的测试里用了 `{{NAME_hash}}` 形态占位符，
// 写盘时被宿主替换成真实值，导致输入变了但断言没变 → 测试失败。
// 这里所有花括号都用 String.fromCharCode 拼，避免再次触发占位符替换。
import { readFileSync, writeFileSync } from "node:fs";

const LB = String.fromCharCode(123);
const RB = String.fromCharCode(125);
const L2 = LB + LB;
const R2 = RB + RB;
const p = "plugin/tests/http.test.mjs";
let lines = readFileSync(p, "utf8").split(String.fromCharCode(10));

function replaceBlock(start1, end1, newLines) {
  lines.splice(start1 - 1, end1 - start1 + 1, ...newLines);
}

// 第 59-71 行：redact sk-/tk- 密钥（含花括号形态）
// 用确定的假 key：sk-abcdefghij1234567890 → maskTail 保留前4后2 = sk-abcd…90
replaceBlock(59, 71, [
  'test("redact 遮蔽 sk-/tk- 密钥（含花括号形态）", () => {',
  '  const fakeKey = "sk-" + "abcdefghij1234567890";',
  '  const out = redact("key " + fakeKey + " ok");',
  '  assert.equal(out, "key sk-abcd…90 ok");',
  '  assert.ok(!out.includes("abcdefghij1234567890"));',
  "",
  '  const tk = redact("token tk-1234567890abcdef 请保密");',
  '  assert.equal(tk, "token tk-1234…ef 请保密");',
  '  assert.ok(!tk.includes("1234567890abcdef"));',
  "",
  // sk-{{ABCDEF}} → maskTail 保留 {{AB 与 EF}} → sk-{{AB…EF}}
  '  const brace = "sk-" + ' + JSON.stringify(L2 + "ABCDEF" + R2) + ";",
  "  const ph = redact(brace);",
  '  assert.equal(ph, "sk-" + ' + JSON.stringify(L2 + "AB…EF" + R2) + ");",
  "});",
]);

// splice 后行号前移，改用内容定位。
const idxShort = lines.findIndex((l) => l.includes("const short =") && l.includes("0123456789abcdef"));
if (idxShort >= 0) {
  lines[idxShort] = '  const short = "short 0123456789abcdef0123456789a end"; // 25 位，不到 28 不遮蔽';
}

// 对象输入：用不含花括号的假 token，规则 token["']?[:=] 会遮蔽成 ****
const idxObj = lines.findIndex((l) => l.includes("redact({ token:"));
if (idxObj >= 0) {
  lines[idxObj] =
    '  assert.equal(redact({ token: "mytoken12345678" }), \'{"token":"****"}\');';
}

writeFileSync(p, lines.join(String.fromCharCode(10)));
console.log("http.test.mjs 占位符已修复（" + lines.length + " 行）");
