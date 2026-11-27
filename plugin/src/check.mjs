// src/check.mjs — 宿主侧环境体检的**纯逻辑层**（无 I/O、无网络、无 console）。
//
// 为什么要有它：tools/doctor.mjs 查的是**账号侧**（Key 有效性 / 余额 / TPD / 模型矩阵 /
// options 自检）。但用户看到的「模型不出字」还有另外一整类成因，全在**宿主侧**：
//   · 插件压根没装进 plugins.json（或装了两份，宿主只认其中一份）
//   · providers.json 里这个 provider 被置了 off:true —— `plugin off/on` 或重启 magpie
//     都会把它置 off，请求直接 404，Key 再好也不出字
//   · plugin-auth.json 里有账号但没有 sk- Key（AK/SK 没签发），调用 401
//   · settings.json 的代理把国内端点也绕出去了，或者给海外端点留了 direct
//   · magpie 二进制不在 PATH 里，命令全都不存在
//   · clone 不全（plugin/src 被删了一半）
//   · Node 版本低于 engines.node
// 这些 doctor 一个都查不出来 —— 它的每一条都得先有账号、先有 Key 才跑得动。
//
// 判定规则全部做成纯函数，tools/check.mjs 只负责读文件、探测 PATH、打印。
// 测试直接喂构造好的现场数据，不需要 magpie 在场，也不联网。

/** 检查级别：ok 通过 / warn 能跑但要处理 / bad 现在跑不了 / info 只是告知。 */
export const CHECK_LEVELS = ["ok", "warn", "bad", "info"];

/** 仓库缺了就说明 clone 不全（或被删过），插件加载不起来。 */
export const REQUIRED_REPO_FILES = ["plugin/index.mjs", "plugin/src/config.mjs", "index.mjs", "package.json"];

/** 只影响「一条命令装好」，缺了不影响已装好的插件，所以只 warn。 */
export const OPTIONAL_REPO_FILES = ["install.ps1", "install.sh"];

/** engines.node 是 >=22.0.0；低于它 fs/promises 与 AbortSignal.timeout 的行为不一样。 */
export const MIN_NODE_MAJOR = 22;

const MARKS = { ok: "✓", warn: "⚠", bad: "✗", info: "ℹ" };
const COLORS = { ok: 32, warn: 33, bad: 31, info: 36 };

/**
 * 每条检查的统一结构。level 不在 CHECK_LEVELS 里时退化成 info（宁可少报也不炸）。
 * @param {{id:string, level:string, label:string, detail?:string, hint?:string}} parts
 * @returns {{id:string, level:string, label:string, detail:string, hint:string}}
 */
export function makeCheck({ id, level, label, detail = "", hint = "" } = {}) {
  return {
    id: String(id ?? ""),
    level: CHECK_LEVELS.includes(level) ? level : "info",
    label: String(label ?? ""),
    detail: String(detail ?? ""),
    hint: String(hint ?? ""),
  };
}

/** 把「读的是哪个文件」附在 detail 后面 —— 只给需要处理的那几条加，ok 的不加噪声。 */
function withSource(check, source) {
  if (!source || check.level === "ok" || check.level === "info") return check;
  return { ...check, detail: check.detail ? `${check.detail}（读的是 ${source}）` : `读的是 ${source}` };
}

/**
 * Node 版本。process.versions.node 形如 "22.14.0"。
 * >=22 → ok；<22 → bad（插件 package.json engines.node 就是 >=22.0.0）；解析不了 → warn。
 * @param {string} version 例如 process.versions.node
 */
export function checkNode(version) {
  const raw = String(version ?? "").trim();
  const m = raw.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) {
    return makeCheck({
      id: "node-version",
      level: "warn",
      label: "Node 版本",
      detail: `认不出版本号「${raw || "(空)"}」`,
      hint: `用 node -v 确认；插件 engines.node 要求 >=${MIN_NODE_MAJOR}`,
    });
  }
  const major = Number(m[1]);
  const shown = `v${raw.replace(/^v/, "")}`;
  if (major >= MIN_NODE_MAJOR) {
    return makeCheck({
      id: "node-version",
      level: "ok",
      label: "Node 版本",
      detail: `${shown} ≥ ${MIN_NODE_MAJOR}`,
    });
  }
  return makeCheck({
    id: "node-version",
    level: "bad",
    label: "Node 版本",
    detail: `${shown} < ${MIN_NODE_MAJOR}（engines.node 要求 >=${MIN_NODE_MAJOR}.0.0）`,
    hint: `换 Node ${MIN_NODE_MAJOR}+ 再跑；20.x 上插件加载与 AbortSignal.timeout 的行为都对不上`,
  });
}

/** 名字归一：反斜杠 → 正斜杠、去掉开头的 ./、小写（Windows 路径不区分大小写）。 */
function normPath(p) {
  return String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * 仓库完整性。list 是「已检测到的仓库文件/目录名数组」（tools/check.mjs 用 existsSync 探出来的）。
 * 缺 REQUIRED_REPO_FILES 里任何一个 → bad（clone 不全或被删，插件加载不起来）；
 * 只缺 install 脚本 → warn（已装好的插件不受影响）。
 * @param {string[]} list 例如 ["plugin/index.mjs", "index.mjs", "package.json", ...]
 */
export function checkRepoFiles(list) {
  const have = new Set((Array.isArray(list) ? list : []).map(normPath));
  const missingRequired = REQUIRED_REPO_FILES.filter((f) => !have.has(normPath(f)));
  const missingOptional = OPTIONAL_REPO_FILES.filter((f) => !have.has(normPath(f)));

  if (missingRequired.length) {
    return makeCheck({
      id: "repo-files",
      level: "bad",
      label: "仓库完整性",
      detail: `缺少 ${missingRequired.join("、")}`,
      hint: "重新 clone 整个仓库（插件入口与 plugin/src 都在里面），别只拷 index.mjs",
    });
  }
  if (missingOptional.length) {
    return makeCheck({
      id: "repo-files",
      level: "warn",
      label: "仓库完整性",
      detail: `关键文件齐全，缺 ${missingOptional.join("、")}`,
      hint: "install.ps1 / install.sh 只影响「一条命令装好」，已经装好的插件不需要它们",
    });
  }
  return makeCheck({
    id: "repo-files",
    level: "ok",
    label: "仓库完整性",
    detail: `${REQUIRED_REPO_FILES.length} 个关键文件齐全`,
  });
}

/** 取 super 里 `spec` 包含 key（不分大小写）的条目。 */
function matchSpecs(pluginsJson, key) {
  const list = Array.isArray(pluginsJson) ? pluginsJson : Array.isArray(pluginsJson?.plugins) ? pluginsJson.plugins : [];
  const needle = String(key ?? "").toLowerCase();
  return list
    .map((entry) => (typeof entry === "string" ? entry : String(entry?.spec ?? entry?.name ?? "")))
    .filter((s) => s && s.toLowerCase().includes(needle));
}

/**
 * 插件装没装。plugins.json 形状是 { "plugins": [ { "spec": "..." } ] }。
 * 没找到 → bad（宿主根本不会加载它）；找到多条 → warn（重复安装，宿主只认一份，
 * 而且两份 spec 指向不同版本时会互相盖住）。
 * @param {object|Array} pluginsJson plugins.json 的内容
 * @param {{spec?:string, source?:string}} [opts]
 */
export function checkPluginInstalled(pluginsJson, { spec = "qiniu", source = "" } = {}) {
  const hits = matchSpecs(pluginsJson, spec);
  if (!hits.length) {
    return withSource(
      makeCheck({
        id: "plugin-installed",
        level: "bad",
        label: "插件安装",
        detail: `plugins.json 里没有 spec 含「${spec}」的条目`,
        hint: "装插件：magpie plugin add github:cat-clash/magpie-qiniu（或 npm 包名）",
      }),
      source,
    );
  }
  if (hits.length > 1) {
    return withSource(
      makeCheck({
        id: "plugin-installed",
        level: "warn",
        label: "插件安装",
        detail: `找到 ${hits.length} 条：${hits.join("、")}`,
        hint: "重复安装会让宿主只认其中一份、且两份会互相盖配置；magpie plugin remove 掉多余的那个",
      }),
      source,
    );
  }
  return makeCheck({
    id: "plugin-installed",
    level: "ok",
    label: "插件安装",
    detail: hits[0],
  });
}

/**
 * provider 有没有被置 off。这是最容易误判的一条：
 * `magpie plugin off/on` 或重启 magpie 会把 provider 置 off，请求全 404，
 * 现象和「Key 失效」一模一样，但 doctor 查不出（Key 是好的）。
 * off === true → bad；找不到 provider → bad（插件没注册上）；off 缺省/false → ok。
 * @param {object|Array} providersJson providers.json 的内容
 * @param {{id?:string, source?:string}} [opts]
 */
export function checkProviderSwitched(providersJson, { id = "qiniu-ai", source = "" } = {}) {
  const list = Array.isArray(providersJson) ? providersJson : Array.isArray(providersJson?.providers) ? providersJson.providers : [];
  const hit = list.find((p) => String(p?.id ?? "") === String(id));
  if (!hit) {
    return withSource(
      makeCheck({
        id: "provider-switched",
        level: "bad",
        label: "provider 开关",
        detail: `providers.json 里没有 id=${id} 的条目`,
        hint: `插件没注册上或 id 被改过：magpie provider ls 看看实际 id，必要时 magpie provider on ${id}`,
      }),
      source,
    );
  }
  if (hit.off === true) {
    return withSource(
      makeCheck({
        id: "provider-switched",
        level: "bad",
        label: "provider 开关",
        detail: `${id} 是 off:true（模型选不到它，请求直接 404）`,
        hint: `magpie provider on ${id} 打开；plugin off/on 之后要重新开一次`,
      }),
      source,
    );
  }
  return makeCheck({
    id: "provider-switched",
    level: "ok",
    label: "provider 开关",
    detail: `${id} 已开启${hit.off === false ? "（off:false）" : ""}`,
  });
}

/**
 * 账号数量与 sk- Key。plugin-auth.json 的键是 `qiniu-ai` 或 `qiniu-ai@<email>`（多账号时宿主加后缀）。
 * 0 条 → bad（没登录）；有但都没 key 字段 → bad（AK/SK 没签发 sk- Key，调用 401）；
 * ≥1 条有 key → ok。注意：这条只说「本地有凭据」，Key 有没有效是 tools/doctor.mjs 的事。
 * @param {object} pluginAuthJson plugin-auth.json 的内容
 * @param {{id?:string, source?:string}} [opts]
 */
export function checkAccounts(pluginAuthJson, { id = "qiniu-ai", source = "" } = {}) {
  const store = pluginAuthJson && typeof pluginAuthJson === "object" && !Array.isArray(pluginAuthJson) ? pluginAuthJson : {};
  const prefix = `${id}@`;
  const entries = Object.entries(store).filter(([k]) => k === id || k.startsWith(prefix));
  if (!entries.length) {
    return withSource(
      makeCheck({
        id: "accounts",
        level: "bad",
        label: "账号",
        detail: `plugin-auth.json 里没有 ${id} 或 ${id}@... 的条目`,
        hint: `登录一次：magpie plugin login ${id}`,
      }),
      source,
    );
  }
  const withKey = entries.filter(([, v]) => String(v?.key ?? "").trim().length > 0);
  if (!withKey.length) {
    return withSource(
      makeCheck({
        id: "accounts",
        level: "bad",
        label: "账号",
        detail: `${entries.length} 个账号，但都没有 key 字段`,
        hint: "AK/SK 登录后要签发 sk- Key 才能调推理：magpie plugin login 重新走一遍（或控制台建 Key 再贴进来）",
      }),
      source,
    );
  }
  if (withKey.length < entries.length) {
    return withSource(
      makeCheck({
        id: "accounts",
        level: "ok",
        label: "账号",
        detail: `${entries.length} 个账号，其中 ${withKey.length} 个有 sk- Key`,
        hint: `${entries.length - withKey.length} 个账号缺 key，不会参与轮询；不影响能用`,
      }),
      source,
    );
  }
  return makeCheck({
    id: "accounts",
    level: "ok",
    label: "账号",
    detail: `${entries.length} 个账号都有 sk- Key`,
  });
}

/** proxy 值 → host:port（**绝不回显完整 URL**：里面可能有用户名密码）。 */
export function maskProxy(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return port ? `${u.hostname}:${port}` : u.hostname;
  } catch {
    const m = s.match(/^(?:[A-Za-z][\w+.-]*:\/\/)?(?:[^@/]*@)?([^/:?#]+)(?::(\d+))?/);
    return m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]) : "（无法解析）";
  }
}

/**
 * 代理设置。settings.json 的 proxy 字段：
 *   http(s)://... → ok（回显只到 host:port）
 *   "direct"      → warn（七牛 api.qnaigc.com 在国内直连没问题，但配了 direct 就走不了
 *                        需要出站代理的海外端点，那类请求会一直超时）
 *   缺失/空       → info（跟随系统/宿主默认，通常能用）
 * @param {object} settingsJson settings.json 的内容
 */
export function checkProxy(settingsJson) {
  const raw = settingsJson && typeof settingsJson === "object" ? settingsJson.proxy : undefined;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    return makeCheck({
      id: "proxy",
      level: "info",
      label: "代理",
      detail: "settings.json 没有 proxy 字段（跟随系统/宿主默认）",
      hint: "七牛国内端点直连可用；只在需要出站代理时才填 http://host:port",
    });
  }
  if (/^direct$/i.test(value)) {
    return makeCheck({
      id: "proxy",
      level: "warn",
      label: "代理",
      detail: "proxy = direct（不走代理）",
      hint: "七牛 api.qnaigc.com 国内直连没问题；但本机若靠代理访问海外端点，那些请求会一直超时",
    });
  }
  if (/^https?:\/\//i.test(value)) {
    return makeCheck({
      id: "proxy",
      level: "ok",
      label: "代理",
      detail: maskProxy(value),
    });
  }
  return makeCheck({
    id: "proxy",
    level: "warn",
    label: "代理",
    detail: `${maskProxy(value)}（不认识的写法）`,
    hint: "proxy 只认 http://host:port、https://host:port 或 direct",
  });
}

/**
 * magpie 可执行文件。「没找到」只 warn —— 很可能只是没在 PATH 里，
 * 设 MAGPIE_BIN 指绝对路径即可，插件本身还能用。
 * @param {string|{path?:string, note?:string}|null|undefined} found 路径或探测结果
 */
export function checkMagpieBinary(found) {
  let path = "";
  let note = "";
  if (typeof found === "string") {
    path = found.trim();
  } else if (found && typeof found === "object") {
    path = String(found.path ?? "").trim();
    note = String(found.note ?? "").trim();
  }
  if (path) {
    return makeCheck({ id: "magpie-binary", level: "ok", label: "magpie 可执行文件", detail: path });
  }
  return makeCheck({
    id: "magpie-binary",
    level: "warn",
    label: "magpie 可执行文件",
    detail: note || "PATH 里没找到 magpie / magpie.exe / magpie.com",
    hint: "设环境变量 MAGPIE_BIN 为 magpie 的绝对路径；只是没在 PATH 里时不影响已装好的插件",
  });
}

/** 汇总：有任何 bad → "bad"；否则有 warn → "warn"；否则 "ok"。info 不参与定级。 */
function describe(check) {
  return check.detail ? `${check.label}：${check.detail}` : check.label;
}

/**
 * @param {Array} checks makeCheck 的数组
 * @returns {{level:string, ok:boolean, bads:string[], warns:string[], checks:Array}}
 */
export function summarize(checks) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && typeof c === "object");
  const bads = list.filter((c) => c.level === "bad").map(describe);
  const warns = list.filter((c) => c.level === "warn").map(describe);
  const level = bads.length ? "bad" : warns.length ? "warn" : "ok";
  return { level, ok: level === "ok", bads, warns, checks: list };
}

/**
 * → 要打印的行（纯函数，方便快照测试）。
 * 前缀用符号（✓/⚠/✗/ℹ）而不是 [ok] 这类方括号 —— doctor 已经占了方括号风格，靠符号区分两份报告。
 * @param {object} result summarize 的返回值
 * @param {{json?:boolean, color?:boolean}} [opts]
 */
export function renderChecks(result, { json = false, color = false } = {}) {
  if (json) return [JSON.stringify(result)];
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const lines = [];
  for (const c of checks) {
    const mark = MARKS[c.level] ?? "?";
    const head = color ? `\x1b[${COLORS[c.level] ?? 0}m${mark}\x1b[0m` : mark;
    lines.push(`${head} ${c.label}${c.detail ? `：${c.detail}` : ""}`);
    if (c.hint) lines.push(`  → 修复：${c.hint}`);
  }
  return lines;
}

// ── 自愈计划（tools/check.mjs 的 --fix / --apply 用）──────────────────────────
//
// 安全口径照抄仓库已有模型（plugin/src/fix.mjs + tools/doctor.mjs 的 --fix/--apply）：
//   · 纯逻辑层不碰 fs、不 spawn —— 这里只产出「要做哪些命令」，执行全在 CLI 里；
//   · 默认 dry-run，只有 --apply 才真跑；执行前备份、逐条打印输出；
//   · **只**自动修两类，其余一律进 manual 让人处理（宁可不动，也不能替用户瞎猜）。
//
// 可自动修的两类（且只有这两类）：
//   1) provider 开关被置 off → magpie provider on <id>
//   2) 同一插件装了多条 spec  → magpie plugin rm <多余的那条>
//
// 绝不自动修的：账号为空 / 账号没 sk- Key / 仓库文件缺失 / Node 版本过低 /
// 代理缺失或写法不认识 / magpie 不在 PATH / 插件压根没装 / provider 条目不存在。
// 它们一律不进 actions，只进 plan.manual（人话 + hint），由 CLI 打印成「以下要人工处理」。
// 这样做是因为这些要么需要用户交互（登录、签发 Key、换 Node），要么改错一步就会把
// 能用的现场搞坏（比如把唯一那条插件 spec rm 掉）。

/** 计划里允许出现的动作类型；别的一律不生成。 */
export const REPAIR_KINDS = ["provider-on", "plugin-rm"];

/** 「像官方」的判据：spec 里含这段就优先保留（cat-clash 是仓库所有者的 GitHub 账号）。 */
const OFFICIAL_SPEC_NEEDLE = "cat-clash/magpie-qiniu";

/**
 * 从 checkProviderSwitched 的 detail 里取回 provider id。
 * detail 形如 `qiniu-ai 是 off:true（模型选不到它，请求直接 404）`；
 * 认不出来就返回空串 —— 宁可不修，也不拿默认 id 乱开。
 */
function providerOffIdFromDetail(detail) {
  const m = String(detail ?? "").match(/^(\S+)\s*是\s*off\s*[:=]\s*true/i);
  return m ? m[1] : "";
}

/**
 * 从 checkPluginInstalled 的 detail 里取回 spec 列表。
 * detail 形如 `找到 2 条：github:a/x、github:cat-clash/magpie-qiniu`；解析不了返回 []。
 */
function specsFromDetail(detail) {
  const m = String(detail ?? "").match(/^找到\s*\d+\s*条[：:]\s*(.+)$/);
  if (!m) return [];
  return m[1]
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 重复安装该保留哪一条、该 rm 哪几条（规则写在返回值 reason 里，也写进注释）。
 *
 * 保留规则（顺序即优先级）：
 *   1. 恰好一条 spec 含 `cat-clash/magpie-qiniu` → 留它，其余全 rm；
 *   2. 超过一条都含 → 判断不出谁才是正主 → **不产生任何 rm**；
 *   3. 一条都不含 → 保留**最后一条**（后装的通常是想用的那份），其余 rm；
 *   4. 条目不足两条（或根本解析不出 spec）→ 无事可做。
 *
 * @param {string[]} specs
 * @returns {{keep:string, remove:string[], reason:string}}
 */
function planDuplicateRemoval(specs) {
  const list = [...new Set((Array.isArray(specs) ? specs : []).map((s) => String(s ?? "").trim()).filter(Boolean))];
  if (list.length < 2) return { keep: list[0] ?? "", remove: [], reason: "不足两条，无可移除" };

  const official = list.filter((s) => s.toLowerCase().includes(OFFICIAL_SPEC_NEEDLE));
  if (official.length === 1) {
    return {
      keep: official[0],
      remove: list.filter((s) => s !== official[0]),
      reason: `保留含 ${OFFICIAL_SPEC_NEEDLE} 的那条（像官方仓库）`,
    };
  }
  if (official.length > 1) {
    // 两条都像官方（比如一个 @latest 一个带 tag）：分不清真身，宁可不动
    return { keep: "", remove: [], reason: `有 ${official.length} 条都含 ${OFFICIAL_SPEC_NEEDLE}，判断不出该保留哪条` };
  }
  const keep = list[list.length - 1];
  return { keep, remove: list.slice(0, -1), reason: "都不像官方 spec → 保留最后一条（后装的通常是想用的那份）" };
}

/**
 * 把宿主侧体检结论翻译成「要跑哪些命令、哪些要人工处理」。
 *
 * 动作顺序（重要）：plugin-rm 全部排在 provider-on 之前 —— `magpie plugin rm`
 * 有可能把 provider 置 off，把 provider on 放最后才能保证最终状态是「开着」。
 *
 * @param {{checks?: Array}} [input] summarize().checks 或原始 checks 数组
 * @returns {{
 *   actions: {id:string, kind:string, command:string, args:string[], why:string}[],
 *   empty: boolean,
 *   manual: string[]
 * }}  actions 为空的判定用 empty / isEmptyRepair，不要自己数长度
 */
export function planRepair({ checks } = {}) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && typeof c === "object");
  const actions = [];
  const manual = [];
  const handled = new Set();

  // ① 重复安装 → plugin rm
  const dupCheck = list.find((c) => c.id === "plugin-installed" && c.level === "warn");
  if (dupCheck) {
    handled.add(dupCheck.id);
    const dup = planDuplicateRemoval(specsFromDetail(dupCheck.detail));
    for (const spec of dup.remove) {
      actions.push({
        id: `plugin-rm:${spec}`,
        kind: "plugin-rm",
        command: "magpie",
        args: ["plugin", "rm", spec],
        why: `同一插件装了多条：${dup.reason}，移除 ${spec}`,
      });
    }
    if (!dup.remove.length) {
      manual.push(`插件安装：${dupCheck.detail || "装重了"} —— 判断不出该保留哪一条（${dup.reason}），先 magpie plugin ls 人工确认再 magpie plugin rm <spec>`);
    }
  }

  // ② provider off:true → provider on（放最后）
  const provCheck = list.find((c) => c.id === "provider-switched" && c.level === "bad");
  if (provCheck) {
    const pid = providerOffIdFromDetail(provCheck.detail);
    if (pid) {
      handled.add(provCheck.id);
      actions.push({
        id: `provider-on:${pid}`,
        kind: "provider-on",
        command: "magpie",
        args: ["provider", "on", pid],
        why: `${pid} 当前是 off:true（模型选不到它，请求直接 404）；provider on 打开，不用重启 magpie`,
      });
    } else {
      // detail 认不出 id（比如「providers.json 里没有 id=... 的条目」）：这不是开关问题，不修
      manual.push(`provider 开关：${provCheck.detail || "状态异常"} —— 没有可开的 id，先 magpie provider ls 人工确认`);
      handled.add(provCheck.id);
    }
  }

  // ③ 其余 bad/warn：一律人工（账号、Key、仓库文件、Node、代理、magpie 路径、插件没装）
  for (const c of list) {
    if (c.level !== "bad" && c.level !== "warn") continue;
    if (handled.has(c.id)) continue;
    manual.push(`${c.label}：${c.detail || "（无细节）"} —— 要人工处理：${c.hint || "见 node tools/check.mjs 的提示"}`);
  }

  return { actions, empty: actions.length === 0, manual };
}

/** 单条动作 → 一行命令（CLI 打印与测试共用同一口径）。 */
function commandOf(action) {
  const args = Array.isArray(action?.args) ? action.args.map((a) => String(a)) : [];
  return [String(action?.command ?? ""), ...args].filter(Boolean).join(" ");
}

/**
 * 计划 → 人话（一行一件事，每行都带完整命令，方便直接复制粘贴）。
 * 空计划返回空数组。注意：它只描述 actions，**人工项**在 plan.manual 里，
 * 由 CLI 加「以下要人工处理」表头打印（见 describeManual）。
 *
 * @param {object} plan planRepair 的返回值
 * @returns {string[]}
 */
export function describeRepair(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.map((a) => {
    const args = Array.isArray(a?.args) ? a.args.map((s) => String(s)) : [];
    const subject = args.length ? args[args.length - 1] : "";
    const cmd = commandOf(a);
    if (a?.kind === "provider-on") return `provider ${subject} 当前是 off → ${cmd}`;
    if (a?.kind === "plugin-rm") return `插件装重了，移除多余的 ${subject} → ${cmd}`;
    return `${String(a?.why || "执行")} → ${cmd}`;
  });
}

/**
 * 计划里「要人工处理」的那些 → 人话（一行一条，CLI 用「! 」前缀打印）。
 * 单独拆出来是为了让调用方想忽略人工项时能明确地忽略，而不是靠数 actions 长度。
 *
 * @param {object} plan planRepair 的返回值
 * @returns {string[]}
 */
export function describeManual(plan) {
  return (Array.isArray(plan?.manual) ? plan.manual : []).map((s) => String(s)).filter(Boolean);
}

/**
 * 计划是否为空（空 = CLI 说「没有能自动修的东西」、不备份、不跑任何命令）。
 * @param {object} plan planRepair 的返回值
 * @returns {boolean}
 */
export function isEmptyRepair(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return actions.length === 0;
}
