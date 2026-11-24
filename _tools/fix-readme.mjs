// 一次性修 README 遗留：模型条数占位、批量导入未写、环境变量不全、/v1/messages 措辞、错误分档与实现对齐。
// 所有花括号用 String.fromCharCode 拼，避免宿主把 {{...}} 当占位符替换。
import { readFileSync, writeFileSync } from "node:fs";

const p = "README.md";
let lines = readFileSync(p, "utf8").split(String.fromCharCode(10));
const LB = String.fromCharCode(123);
const RB = String.fromCharCode(125);

function sub(pred, next) {
  const i = lines.findIndex(pred);
  if (i < 0) throw new Error("未找到目标行: " + pred.toString());
  lines[i] = next;
  return i;
}

// 1. /v1/messages 状态与边界：已实测端点存在（POST 401 / GET 405），未做有效 Key 端到端
sub((l) => l.includes("**状态**") && l.includes("按上游文档支持"),
  "**状态**：**上游实测端点存在（POST 返回 401、GET 405），但未用有效 Key 做过端到端聊天验证。**");
sub((l) => l.includes("本仓库尚未拿到该端点的本机实测"),
  "**边界**：本机探测确认端点存在（POST 401、GET 405），但没有拿到有效 Key 做一次真实聊天调用，所以这里只承诺「按上游文档转发，不做协议改写」；若实测发现不可用，本节会改成「不支持」并从能力清单里删掉。在此之前也不要把它当成 Claude Code 之类客户端的替代品 —— 推理能力取决于所选模型本身。");

// 2. 错误分档表：与 relay.mjs 的真实实现对齐
sub((l) => l.includes("`402` 余额 / 资源包不足") && l.includes("insufficient_quota"),
  "| `402` 余额 / 资源包不足 | 重写成 `429` + `retry-after: 900`，type `balance_insufficient` | `kept` |");
sub((l) => l.includes("403` 且正文含 `is not available"),
  "| `403` 且正文含 `is not available` / `model_not_found` / `模型不支持` | 改成 **`404`**，type `model_not_found` | `kept` |\n| `503` + `price of the model is not set` | 改成 **`404`**，type `model_not_priced` | `kept` |");
sub((l) => l.includes("403` 欠费 / `Request not allowed"),
  "| `403` 欠费 / `Request not allowed` / `apikey monthly quota exceeded` | 改成 `429` + `retry-after: 1200`，type `arrears` / `quota_exceeded` | `kept` |");
sub((l) => l.includes("`429`、`5xx`") && l.includes("原样交回宿主"),
  "| `429`、`5xx` | 原样交回宿主；402/403 的 429 改写可用 `quotaFailover:false` 关掉 | 不设 |");
sub((l) => l.includes("其它路径") && l.includes("not_implemented"),
  "| `401` + `auth_api_key_missing` | 改 `500` `missing_credential`（配置缺失，不标记账号） | 不设 |\n| 其它路径 | `501` + `not_implemented` | 不设 |");
// 3. 快速开始里的 Key 示例：不写占位符形态，用文字描述
const iLogin = lines.findIndex((l) => l.includes("终端里选") && l.includes("AK/SK"));
if (iLogin >= 0) {
  lines[iLogin] = "    `-Login` / `--login` 会在装完后直接进入 `magpie plugin login qiniu-ai`，终端里选 `sk-` Key 或 AK/SK 方式（`sk-` 值填你在控制台创建的正式 Key，形如 `sk-` 后跟一长串字母数字）。";
}

// 4. 模型条数占位 `<N>` → 87（active 数）
let nCount = 0;
lines = lines.map((l) => {
  if (l.includes("<N> models")) { nCount++; return l.replace("<N> models", "87 models"); }
  return l;
});

// 5. 环境变量表补 BUN_BIN（验收脚本用），并修正"没有环境变量开关"的说法
const iEnv = lines.findIndex((l) => l.includes("`MAGPIE_BIN`") && l.includes("可执行文件路径"));
if (iEnv >= 0) {
  lines.splice(iEnv + 1, 0, "| `BUN_BIN` | 验收脚本 `_tools/verify.mjs` 用；本机只有 bun 时指到 `bun.exe`（可选） |");
}
sub((l) => l.includes("本插件**没有环境变量开关**"),
  "插件运行时没有环境变量开关：`promptCache` 等行为全部走下面的 options。上表两个变量只影响安装脚本与验收脚本。");

// 6. 批量导入：在「两种登录」节后补一段
const iMethods = lines.findIndex((l) => l.includes("### 两种登录：`sk-` Key 与 AK/SK"));
if (iMethods >= 0) {
  const importDoc = [
    "",
    "### 批量导入 Key",
    "",
    "**机制**：`auth.import` 接受一段文本，一次粘多个凭证 —— 每行一个 `sk-` Key，或 `AK:SK` / `AK SK`（可带备注，形如 `备注, AK SK`），也接受整段 JSON 数组或 `{keys:[…]}`；`#` / `//` 开头的注释行会被忽略，重复凭证自动去重。",
    "",
    "**开销**：纯本地解析，不联网；导入时按 `sk-` 打 `/v1/models` 验证一把（最多并发 4 条），失败的行逐条给出原因，不阻断其他行。",
    "",
    "**边界**：AK/SK 行会走与手动登录相同的 AK/SK 路径（签名打余额接口 + 自动签发 `sk-`），失败那一行只记 note、不影响其余 Key 的导入。",
  ];
  // 插到「模型目录」标题之前
  const iModels = lines.findIndex((l) => l.includes("### 模型目录："));
  lines.splice(iModels, 0, ...importDoc);
}

writeFileSync(p, lines.join(String.fromCharCode(10)));
console.log("README.md 已修复（" + lines.length + " 行，替换 <N> " + nCount + " 处）");
