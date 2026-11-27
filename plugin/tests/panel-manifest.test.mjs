// tests/panel-manifest.test.mjs —— 出站闸面板（magpie.panels，slot: provider）的打包面与桥接锁
//
// 面板的每一种失败都是**静默的**，所以这里逐条写成断言：
//   · `file` 不在包的 files 白名单里 → npm 装出来没有 panel/，编辑器里一块空白，零报错；
//   · `slot` 写错 → 面板永远不出现；
//   · 忘了 `<script src="_magpie/bridge.js">` → 读不到 options，一片死白；
//   · options.set 整份替换却忘了展开 `...opts` → 把用户其它选项整批抹掉；
//   · 绑了输入事件边打边写 → 触发「一秒最多一次」被宿主丢弃，用户看到值没保存；
//   · 面板的 DEFAULTS / CLAMP 与 src/config.mjs 漂移 → 空值回落和夹紧都写成另一个数。
// 契约出处：magpie 插件运行时 P5，panels: [{slot, file, title, titles}]，
//   slot ∈ {agents, usage, settings, provider}，file 是插件目录里的 .html。
//
// 这版面板管六个键（键名与 src/config.mjs 的 DEFAULTS 逐字一致）：
//   pacingMinMs / pacingJitterMs / breakerThreshold / breakerCooldownMs / quotaFailover / usageCacheMs
// 其中 breakerCooldownMs 按分钟展示、usageCacheMs 按秒展示，但写回一律毫秒。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULTS, CLAMP } from "../src/config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const pkg = JSON.parse(read("package.json"));
const panels = pkg.magpie?.panels ?? [];
const SLOTS = new Set(["agents", "usage", "settings", "provider"]);

/** 面板管理的六个键 —— 顺序与分组一致，别处一律引用这一份 */
const SIX_KEYS = [
  "pacingMinMs",
  "pacingJitterMs",
  "breakerThreshold",
  "breakerCooldownMs",
  "quotaFailover",
  "usageCacheMs",
];

/** 展示单位 → 毫秒基数：分钟 / 秒两个控件在 HTML 里写的是人话单位 */
const UNIT_MS = { breakerCooldownMs: 60 * 1000, usageCacheMs: 1000 };

/** 每个面板的 HTML + 它自己的 JS（HTML 里除 _magpie/ 之外的第一个 script src） */
function panelFiles(panel) {
  const html = read(panel.file);
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const own = srcs.find((s) => !s.includes("_magpie/"));
  assert.ok(own, `${panel.file} 要引自己的脚本`);
  const js = read(dirname(panel.file), own);
  return { html, srcs, js, own };
}

/** 从 gates.js 里抽 `const CLAMP = { key: [lo, hi], ... }`，用于和 src/config.mjs 比对 */
function extractJsClamp(js) {
  const block = js.match(/const CLAMP = \{([\s\S]*?)\n {2}\};/);
  assert.ok(block, "gates.js 里找不到 `const CLAMP = { ... };`");
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    const nums = m[2]
      .split(",")
      .map((s) => Number(s.trim().replace(/_/g, "")));
    assert.equal(nums.length, 2, `gates.js 的 CLAMP.${m[1]} 应该是 [min, max]`);
    assert.equal(nums.every(Number.isFinite), true, `gates.js 的 CLAMP.${m[1]} 有非数字`);
    out[m[1]] = nums;
  }
  return out;
}

test("magpie.panels 声明存在：slot 合法、file 指向的 HTML 存在、中英标题齐备", () => {
  assert.equal(Array.isArray(panels), true, "magpie.panels 必须是数组");
  assert.equal(panels.length >= 1, true, "至少要声明出站闸面板");
  assert.equal(panels.length <= 8, true, "magpie 一个插件最多 8 个面板");

  for (const p of panels) {
    assert.ok(SLOTS.has(p.slot), `slot 必须是 ${[...SLOTS].join(" / ")}，收到 ${p.slot}`);
    assert.equal(typeof p.title, "string");
    assert.ok(p.title.trim(), "要有 title");
    assert.ok(p.file.endsWith(".html"), "file 必须是 .html");
    assert.equal(existsSync(join(ROOT, p.file)), true, `面板文件不存在：${p.file}`);
    assert.equal(typeof p.titles?.zh, "string", "要有中文 titles");
    assert.equal(typeof p.titles?.en, "string", "要有英文 titles");
  }

  const gates = panels.find((p) => p.file === "panel/gates.html");
  assert.ok(gates, "出站闸面板要挂在 panel/gates.html");
  assert.equal(gates.slot, "provider", "出站闸要出现在供应商卡片里");
});

test("面板文件必须在 npm 的 files 白名单里（否则装出来面板空白且零报错）", () => {
  const files = pkg.files ?? [];
  assert.equal(files.includes("panel"), true, "files 里没有 panel，npm 打包会漏掉整个面板目录");
  for (const p of panels) {
    const top = p.file.split("/")[0];
    assert.ok(files.includes(top) || files.includes(p.file), `files 里没有 ${top}`);
  }
  // 只加目录不够时要连具体文件也在，这里逐个确认确实存在
  for (const p of panels) assert.equal(existsSync(join(ROOT, p.file)), true);
});

test("HTML 引了宿主 bridge，并引本面板自己的 css 与 js", () => {
  for (const panel of panels) {
    const { html, own } = panelFiles(panel);
    assert.ok(html.includes("_magpie/bridge.js"), "必须引 _magpie/bridge.js，否则读不到 options");
    assert.equal(own, "gates.js", "面板脚本应为同目录的 gates.js");
    assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="gates\.css"/, "要引同目录的 gates.css");
    assert.match(html, /<script[^>]+src="gates\.js"/, "要引同目录的 gates.js");
    // 离线可用：不许出现任何 http(s):// 引用
    assert.equal(/https?:\/\//.test(html), false, "面板不能引外部资源");
    // bridge 必须排在面板脚本**之前**（同步脚本），否则读 options 时 bridge 还没就绪
    assert.ok(
      html.indexOf("_magpie/bridge.js") < html.indexOf('src="gates.js"'),
      "_magpie/bridge.js 必须在 gates.js 之前引入",
    );
  }
});

test("JS 走 bridge 读改写：magpie.ready / options.get( / options.set( / 写回展开整份 opts", () => {
  for (const panel of panels) {
    const { js } = panelFiles(panel);
    assert.match(js, /magpie\.ready/, "必须 await magpie.ready，否则 bridge 还没就绪");
    assert.match(js, /magpie\.options\.get\(\)/, "要读当前选项，否则面板打开是空的");
    assert.match(js, /magpie\.options\.set\(/, "要能写选项");
    assert.match(js, /\.\.\.opts/, "options.set 整份替换，写回必须展开读到的整份 opts");
    assert.match(js, /submitter/, "要按 submit 事件的 submitter 区分保存 / 取消");
    assert.match(js, /addEventListener\("submit"/, "写回要挂在 form 的 submit 上");
  }
});

test("JS 不发请求、不边打字边写（options.set 一秒最多一次）", () => {
  for (const panel of panels) {
    const { js } = panelFiles(panel);
    assert.equal(/fetch\s*\(/.test(js), false, "面板不该发请求：离线、也没有网络权限");
    assert.equal(/XMLHttpRequest|EventSource|WebSocket/.test(js), false, "面板不该有别的网络出口");
    assert.equal(/addEventListener\(\s*["']input["']/.test(js), false, "输入事件不得直接写回，会撞一秒一次的限制");
    assert.equal(/addEventListener\(\s*["']keyup["']/.test(js), false, "按键事件同样不得直接写回");
    assert.match(js, /options\.set\(next\)/, "只在保存时一次性写回");
  }
});

test("保存的键名与本插件 options 一致（六个键，键名一个字都不许差）", () => {
  const { js, html } = panelFiles(panels[0]);
  for (const key of SIX_KEYS) {
    assert.ok(js.includes(key), `JS 里要出现 ${key}`);
    // 逐个确认这六个键真的是 DEFAULTS 里的键，不是拼错的影子键
    assert.equal(Object.hasOwn(DEFAULTS, key), true, `src/config.mjs 的 DEFAULTS 里没有 ${key}`);
    assert.ok(html.includes(key), `HTML 里的控件 id / name 要用键名 ${key}`);
  }
  // 默认值与插件一致，空值回落时才不会写出偏差
  for (const key of SIX_KEYS) {
    if (typeof DEFAULTS[key] === "boolean") continue;
    assert.match(
      js,
      new RegExp(`${key}:\\s*${DEFAULTS[key]}\\b`),
      `gates.js 的 DEFAULTS.${key} 应与 src/config.mjs 一致（${DEFAULTS[key]}）`,
    );
  }
  assert.match(js, /quotaFailover:\s*true/, "quotaFailover 的默认值应为 true");
});

test("前端夹紧的范围与 src/config.mjs 的 CLAMP 一致", () => {
  const { html, js } = panelFiles(panels[0]);
  const attr = (id, name) => {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, "s"));
    assert.ok(tag, `找不到控件 ${id}`);
    const m = tag[0].match(new RegExp(`${name}="(-?\\d+)"`));
    assert.ok(m, `${id} 缺少 ${name}`);
    return Number(m[1]);
  };

  for (const key of SIX_KEYS) {
    if (UNIT_MS[key] || typeof DEFAULTS[key] === "boolean") continue;
    assert.equal(attr(key, "min"), CLAMP[key][0], `${key} 的 min 与 CLAMP 不一致`);
    assert.equal(attr(key, "max"), CLAMP[key][1], `${key} 的 max 与 CLAMP 不一致`);
  }

  // 按分钟 / 秒展示的控件：HTML 里写的是人话单位，等于 CLAMP 除以对应毫秒基数
  for (const [key, ms] of Object.entries(UNIT_MS)) {
    assert.equal(attr(key, "min"), CLAMP[key][0] / ms, `${key} 的 min 应按毫秒基数 ${ms} 换算`);
    assert.equal(attr(key, "max"), CLAMP[key][1] / ms, `${key} 的 max 应按毫秒基数 ${ms} 换算`);
  }

  // JS 里的 CLAMP 表逐项对齐（从 gates.js 抽出来比，避免字面量散落成两套）
  const jsClamp = extractJsClamp(js);
  for (const [key, range] of Object.entries(jsClamp)) {
    assert.deepEqual(range, CLAMP[key], `gates.js 的 CLAMP.${key} 与 src/config.mjs 不一致`);
  }
  for (const key of SIX_KEYS) {
    if (typeof DEFAULTS[key] === "boolean") continue;
    assert.ok(jsClamp[key], `gates.js 的 CLAMP 里缺 ${key}，保存时就夹不住`);
  }

  // 保存前转整数
  assert.match(js, /Math\.round/, "数值要取整后再写回");
});

test("写回是整份替换且一次性带上六个键", () => {
  const { js } = panelFiles(panels[0]);
  const nextLit = js.match(/const next = \{[^}]*\};/);
  assert.ok(nextLit, "写回对象要单独命名为 next（方便断言）");
  assert.match(nextLit[0], /\.\.\.opts/, "next 必须先展开读到的整份 opts");
  for (const key of SIX_KEYS) {
    assert.ok(nextLit[0].includes(key), `next 里必须带上 ${key}，否则这个键不会被写回`);
  }
});

test("只读状态区：当前生效值、PANEL_VERSION 版本号、options.set 整份替换提示", () => {
  const { html, js } = panelFiles(panels[0]);
  const section = html.match(/<section[^>]*id="gates-readonly"[\s\S]*?<\/section>/);
  assert.ok(section, "要有只读状态区 #gates-readonly");
  assert.match(section[0], /id="gates-effective"/, "要有一行当前生效值");
  assert.match(section[0], /id="gates-versionline"/, "要有一行版本号");
  assert.match(section[0], /plugins\.json/, "要提示其余选项直接改 plugins.json");
  assert.match(section[0], /options\.set/, "要说明 options.set 是整份替换");

  // 版本号来自 gates.js 顶部的常量，不依赖 document.title
  assert.match(js, /const PANEL_VERSION = "\d+\.\d+\.\d+"/, "gates.js 顶部要有 PANEL_VERSION 常量");
  assert.match(
    js,
    /versionLineEl\.textContent = [^;]*PANEL_VERSION/,
    "只读状态区要展示 PANEL_VERSION",
  );

  // 生效值一行要覆盖六个键，不能只写原来那三个
  for (const key of SIX_KEYS) {
    assert.ok(js.includes(`${key}=`), `生效值一行里要出现 ${key}=…`);
  }
});

test("毫秒换算只有一个锚点：gates.js 里 1000 这个字面量只出现一次", () => {
  const { js } = panelFiles(panels[0]);
  const hits = js.match(/\b1000\b/g) ?? [];
  assert.equal(hits.length, 1, `毫秒基数只该定义一处，实际出现 ${hits.length} 次；改换算请只改 MS_PER_SECOND`);
  assert.match(js, /const MS_PER_SECOND = 1000;/, "唯一的毫秒基数必须是具名常量 MS_PER_SECOND");
  assert.match(js, /const MS_PER_MINUTE = MS_PER_SECOND \* 60;/, "分钟基数要从 MS_PER_SECOND 推出来");
  // 展示层才除，写回一律乘回毫秒
  assert.match(js, /const toDisplay = \(ms, unit\) => Math\.round\(ms \/ unit\)/, "毫秒 → 展示单位只在一处换算");
});

test("保存 / 取消两个按钮都是 submit，且带 value=save / value=cancel", () => {
  const { html } = panelFiles(panels[0]);
  assert.match(html, /<button[^>]+type="submit"[^>]+value="save"/, "保存按钮必须是 type=submit + value=save");
  assert.match(html, /<button[^>]+type="submit"[^>]+value="cancel"/, "取消按钮必须是 type=submit + value=cancel");
  assert.equal(/type="button"/.test(html), false, "两个按钮都走 submit，不要用 click 绕过");
});
