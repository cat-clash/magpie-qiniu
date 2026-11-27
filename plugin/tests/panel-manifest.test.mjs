// tests/panel-manifest.test.mjs —— 出站闸面板（magpie.panels，slot: provider）的打包面与桥接锁
//
// 面板的每一种失败都是**静默的**，所以这里逐条写成断言：
//   · `file` 不在包的 files 白名单里 → npm 装出来没有 panel/，编辑器里一块空白，零报错；
//   · `slot` 写错 → 面板永远不出现；
//   · 忘了 `<script src="_magpie/bridge.js">` → 读不到 options，一片死白；
//   · options.set 整份替换却忘了展开 `...opts` → 把用户其它选项整批抹掉；
//   · 绑了输入事件边打边写 → 触发「一秒最多一次」被宿主丢弃，用户看到值没保存。
// 契约出处：magpie 插件运行时 P5，panels: [{slot, file, title, titles}]，
//   slot ∈ {agents, usage, settings, provider}，file 是插件目录里的 .html。

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

/** 每个面板的 HTML + 它自己的 JS（HTML 里除 _magpie/ 之外的第一个 script src） */
function panelFiles(panel) {
  const html = read(panel.file);
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const own = srcs.find((s) => !s.includes("_magpie/"));
  assert.ok(own, `${panel.file} 要引自己的脚本`);
  const js = read(dirname(panel.file), own);
  return { html, srcs, js, own };
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

test("保存的键名与本插件 options 一致（pacingMinMs / breakerThreshold / quotaFailover）", () => {
  const { js, html } = panelFiles(panels[0]);
  assert.ok(js.includes("pacingMinMs"), "JS 里要出现 pacingMinMs");
  assert.ok(js.includes("breakerThreshold"), "JS 里要出现 breakerThreshold");
  assert.ok(js.includes("quotaFailover"), "JS 里要出现 quotaFailover");
  // 逐个确认这三个键真的是 DEFAULTS 里的键，不是拼错的影子键
  for (const key of ["pacingMinMs", "breakerThreshold", "quotaFailover"]) {
    assert.equal(Object.hasOwn(DEFAULTS, key), true, `src/config.mjs 的 DEFAULTS 里没有 ${key}`);
    assert.ok(html.includes(key), `HTML 里的控件 id 要用键名 ${key}`);
  }
  // 默认值与插件一致，空值回落时才不会写出偏差
  assert.match(js, new RegExp(`pacingMinMs:\\s*${DEFAULTS.pacingMinMs}\\b`));
  assert.match(js, new RegExp(`breakerThreshold:\\s*${DEFAULTS.breakerThreshold}\\b`));
});

test("前端夹紧的范围与 src/config.mjs 的 CLAMP 一致", () => {
  const { html } = panelFiles(panels[0]);
  const attr = (id, name) => {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`, "s"));
    assert.ok(tag, `找不到控件 ${id}`);
    const m = tag[0].match(new RegExp(`${name}="(-?\\d+)"`));
    assert.ok(m, `${id} 缺少 ${name}`);
    return Number(m[1]);
  };
  assert.equal(attr("pacingMinMs", "min"), CLAMP.pacingMinMs[0]);
  assert.equal(attr("pacingMinMs", "max"), CLAMP.pacingMinMs[1]);
  assert.equal(attr("breakerThreshold", "min"), CLAMP.breakerThreshold[0]);
  assert.equal(attr("breakerThreshold", "max"), CLAMP.breakerThreshold[1]);
  // 保存前转整数
  assert.match(read("panel", "gates.js"), /Math\.round/, "数值要取整后再写回");
});

test("保存 / 取消两个按钮都是 submit，且带 value=save / value=cancel", () => {
  const { html } = panelFiles(panels[0]);
  assert.match(html, /<button[^>]+type="submit"[^>]+value="save"/, "保存按钮必须是 type=submit + value=save");
  assert.match(html, /<button[^>]+type="submit"[^>]+value="cancel"/, "取消按钮必须是 type=submit + value=cancel");
  assert.equal(/type="button"/.test(html), false, "两个按钮都走 submit，不要用 click 绕过");
});
