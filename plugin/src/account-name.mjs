// src/account-name.mjs — 账号可读标签 + 使用优先级 + 稳定排序比较器（纯函数、零依赖、无 IO）。
//
// 为什么要有这个模块：宿主的 CLI `magpie accounts alias <agent> <email> <name>` 把别名存进
// providers.json 的 accountNames，并在插件拿到的 `auth` 上合并出一个 `alias` 字段；
// `magpie accounts --json` 也能看到每个账号多一个 `alias`。插件以前在 plan 里用 email 拼账号名，
// 同一邮箱挂多把 Key 时完全分不清谁是谁，也没有「哪个号先用」的概念。
// 这里只做四件事：解析 label、解析 priority、给 compose 用的描述对象、给稳定排序比较器。
// 全部是纯函数：不 import（连 node: 都不用）、不读环境、不写文件，方便单测和到处复用。
//
// 规则（集成方依赖这些语义，改动请同步 tests/account-name.test.mjs）：
//
// 1) label 取值优先级：
//      alias（宿主别名）
//      → metadata.alias
//      → email
//      → metadata.email
//      → accountId
//      → metadata.accountId
//      → uid
//      → metadata.uid
//      → `API key <前6>…<后4>`（脱敏，绝不整串输出；Key 太短则只留 `API key …`）
//      → "七牛云账号"（兜底，label 永不为空）
//    同邮箱多把 Key 时宿主会给 user 加 `(<6位hash>)` 后缀（如 `someone@example.com(1a2b3c)`），
//    这里原样保留 —— 那个后缀是区分同邮箱多 Key 的唯一信息，不要做任何清洗/去重。
//    label 统一 trim 后按码点截断到 60 字符（超长不影响可比性，只影响显示）。
//
// 2) priority 取值优先级：
//      metadata.priority（有限数字，原样使用）
//      → alias 里的 `p<数字>` 前缀（如 `p0-main` → 解析出 0）→ 取负：priority = -数字
//      → 默认 0
//    方向约定很容易看反，写清楚：本模块定义「数值越大 = 越优先」；而 alias 前缀 `p0` 表示
//    「第一优先」（数字越小越优先）。所以从 alias 前缀解析时必须取负，让 p0 > p1 > p2。
//    两个方向相反的规则不要合并，否则 p0/p1 的先后会整体反转。
//    例外：-0 语义上就是 0，这里归一成 0（否则 Object.is(-0, 0) 在断言里会咬人）。
//    非法值 / NaN / Infinity / 数字字符串 一律回落 0（字符串不是数字，别偷偷转换）。
//
// 3) compareAccounts：priority 降序 → label 升序（localeCompare("zh-CN")）。
// 4) sortAccounts：返回新数组，不修改入参。
// 5) describeAccount：{ label, priority, id, source }；
//    source 如实说明 label 来自哪一层（alias / metadata.email / key / fallback …），便于 diagnostics 排查；
//    id 只取 accountId / uid / email 系字段，Key 绝不进 id；取不到时回落 label，保证永不为空。

const LABEL_MAX = 60;
const FALLBACK_LABEL = "七牛云账号";
/** 短于这个长度的 Key 连「前6后4」都不给，只显示省略号，避免变相整串泄露。 */
const KEY_MIN_FOR_PEEK = 12;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 字符串字段：trim 后返回，非字符串一律空串。 */
const text = (v) => (typeof v === "string" ? v.trim() : "");

/** id 类字段：字符串或有限数字都认（uid 有时是数字），其余空串。 */
const idText = (v) => {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
};

/** metadata 可能缺失、为 null、甚至是个数组，一律降级成空对象。 */
const meta = (auth) => (isObject(auth) && isObject(auth.metadata) ? auth.metadata : {});

const asAuth = (auth) => (isObject(auth) ? auth : {});

/** 按码点截断，避免把 emoji / 代理对切成半个字符。 */
function truncate(str) {
  const chars = Array.from(str);
  if (chars.length <= LABEL_MAX) return str;
  return chars.slice(0, LABEL_MAX).join("");
}

/** Key 脱敏：`API key sk-abc…wxyz`；太短就只给 `API key …`。 */
function maskKey(value) {
  const s = idText(value);
  if (!s) return "";
  if (s.length < KEY_MIN_FOR_PEEK) return "API key …";
  return "API key " + s.slice(0, 6) + "…" + s.slice(-4);
}

/**
 * 逐层挑出 label 与来源层。
 * @returns {{ value: string, source: string }}
 */
function pickLabel(auth) {
  const a = asAuth(auth);
  const m = meta(a);
  const layers = [
    ["alias", text(a.alias)],
    ["metadata.alias", text(m.alias)],
    ["email", text(a.email)],
    ["metadata.email", text(m.email)],
    ["accountId", idText(a.accountId)],
    ["metadata.accountId", idText(m.accountId)],
    ["uid", idText(a.uid)],
    ["metadata.uid", idText(m.uid)],
  ];
  for (const [source, value] of layers) {
    if (value) return { value, source };
  }
  const masked = maskKey(a.key ?? a.apiKey ?? m.key ?? m.apiKey);
  if (masked) return { value: masked, source: "key" };
  return { value: FALLBACK_LABEL, source: "fallback" };
}

/** 从 alias 前缀 `p<数字>` 解析优先级；解析不出返回 null。取负，见模块头规则 2。 */
function priorityFromAlias(alias) {
  const hit = /^p(\d+)/i.exec(text(alias));
  if (!hit) return null;
  const n = Number(hit[1]);
  if (!Number.isFinite(n)) return null;
  return n === 0 ? 0 : -n;
}

/** 账号可读标签：永不返回空串，最长 60 字符。 */
export function accountLabel(auth) {
  return truncate(pickLabel(auth).value);
}

/** 账号优先级：数值越大越优先，默认 0。见模块头规则 2 的方向说明。 */
export function accountPriority(auth) {
  const a = asAuth(auth);
  const m = meta(a);

  const raw = m.priority;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw === 0 ? 0 : raw;

  const fromAlias = priorityFromAlias(a.alias) ?? priorityFromAlias(m.alias);
  if (fromAlias !== null) return fromAlias;

  return 0;
}

/** 排序比较器：priority 降序，同 priority 按 label 升序（localeCompare("zh-CN")）。 */
export function compareAccounts(a, b) {
  const diff = accountPriority(b) - accountPriority(a);
  if (diff !== 0) return diff;
  return accountLabel(a).localeCompare(accountLabel(b), "zh-CN");
}

/** 排序副本：不改入参。 */
export function sortAccounts(list) {
  const arr = Array.isArray(list) ? list : [];
  return [...arr].sort(compareAccounts);
}

/**
 * GUI / diagnostics 用的描述对象。
 * @returns {{ label: string, priority: number, id: string, source: string }}
 */
export function describeAccount(auth) {
  const a = asAuth(auth);
  const m = meta(a);
  const { value, source } = pickLabel(a);
  const label = truncate(value);

  const id =
    idText(a.accountId) ||
    idText(m.accountId) ||
    idText(a.uid) ||
    idText(m.uid) ||
    text(a.email) ||
    text(m.email) ||
    label;

  return { label, priority: accountPriority(a), id, source };
}
