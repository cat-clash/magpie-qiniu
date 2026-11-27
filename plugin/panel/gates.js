// panel/gates.js —— 出站闸面板（magpie.panels，slot: provider）
//
// 本面板只管理六个键，键名与 src/config.mjs 的 DEFAULTS 逐字一致（测试会直接比对）：
//   pacingMinMs       0..60000        默认 800      展示单位 ms
//   pacingJitterMs    0..60000        默认 400      展示单位 ms
//   breakerThreshold  0..100          默认 5        展示单位 次
//   breakerCooldownMs 60000..28800000 默认 1800000  展示单位 分钟（1..480，默认 30），写回毫秒
//   quotaFailover     true / false    默认 true     勾选框
//   usageCacheMs      10000..600000   默认 30000    展示单位 秒（10..600，默认 30），写回毫秒
//
// ⚠ magpie.options.set 的两条硬约束（bridge 契约，写错了会静默丢数据）：
//   1) **整份替换**：传进去的对象就是新的全量选项，没带上的键会被抹掉。
//      → 写回必须先展开 magpie.options.get() 读到的整份 opts（...opts），再覆盖这六个键。
//   2) **一秒最多一次**：连写会被宿主丢弃或直接报错。
//      → 只在用户按「保存」那一下写一次；输入框改了不落盘，取消就按磁盘值重画。
//        所以这里**不**监听输入事件做即时写回。
//
// 其它契约（tests/panel-manifest.test.mjs 会逐条断言）：
//   · gates.html 里 _magpie/bridge.js 必须排在本脚本**之前**（同步脚本，不是 defer）
//   · 毫秒 / 分钟 / 秒的换算只发生在展示层，写回一律毫秒；
//     换算锚点只有 MS_PER_SECOND 一处字面量，其它单位都从它推出来
//   · 纯前端：不发任何请求、不引任何外部资源，离线可用

(async () => {
  // 面板自身的版本号：document.title 里只有供应商名，没有可靠版本，所以在这里定常量。
  // 发版时与 plugin/package.json 的 version 一起改，CHANGELOG 也写这个号。
  const PANEL_VERSION = "1.4.0";

  // 与 src/config.mjs 的 DEFAULTS / CLAMP 逐项对齐（测试会拿 config.mjs 直接比，改一处要两处同步）
  const DEFAULTS = {
    pacingMinMs: 800,
    pacingJitterMs: 400,
    breakerThreshold: 5,
    breakerCooldownMs: 1800000, // 30 分钟，对应 config.mjs 的 30 * 60_000
    quotaFailover: true,
    usageCacheMs: 30000, // 对应 config.mjs 的 USAGE_TTL_MS
  };

  const CLAMP = {
    pacingMinMs: [0, 60000],
    pacingJitterMs: [0, 60000],
    breakerThreshold: [0, 100],
    breakerCooldownMs: [60000, 28800000],
    usageCacheMs: [10000, 600000],
  };

  // 展示层换算：整个文件里唯一的毫秒基数，分钟由它乘出来。
  const MS_PER_SECOND = 1000;
  const MS_PER_MINUTE = MS_PER_SECOND * 60;

  // 以「分钟 / 秒」为单位的那两个控件，夹紧与默认值都从毫秒值推出来，不另立一套数字
  const DISPLAY = {
    breakerCooldownMin: {
      clamp: [CLAMP.breakerCooldownMs[0] / MS_PER_MINUTE, CLAMP.breakerCooldownMs[1] / MS_PER_MINUTE],
      def: DEFAULTS.breakerCooldownMs / MS_PER_MINUTE,
    },
    usageCacheSec: {
      clamp: [CLAMP.usageCacheMs[0] / MS_PER_SECOND, CLAMP.usageCacheMs[1] / MS_PER_SECOND],
      def: DEFAULTS.usageCacheMs / MS_PER_SECOND,
    },
  };

  const STRINGS = {
    zh: {
      title: "出站闸",
      version: "版本",
      groupPacing: "节奏闸",
      groupBreaker: "熔断",
      groupFailover: "账号切换",
      groupCache: "缓存",
      pacing: "最小间隔 pacingMinMs",
      jitter: "抖动上限 pacingJitterMs",
      breaker: "熔断阈值 breakerThreshold",
      cooldown: "熔断冷却 breakerCooldownMs（按分钟填）",
      failover: "额度用尽即换号 quotaFailover",
      cache: "用量缓存 usageCacheMs（按秒填）",
      effectiveTitle: "当前生效值",
      effective: "当前生效值",
      hint: "options.set 是整份替换：本面板只管理这六个键，其余选项请直接改 plugins.json 里的插件选项。",
      note:
        "pacingMinMs 设 0 且 pacingJitterMs 也设 0 才是完全直通；breakerThreshold 设 0 = 禁用熔断。" +
        "冷却按分钟、缓存按秒填写，写回一律是毫秒。保存后下一个请求起生效。",
      on: "开",
      off: "关",
      save: "保存",
      cancel: "取消",
      loading: "读取中…",
      saved: "已保存 · 下一个请求起生效",
      cancelled: "已取消，按磁盘值还原",
      fail: "保存失败：",
      readFail: "读取选项失败，先按默认值显示：",
      unitMs: "ms",
      unitTimes: "次",
      unitMin: "分钟",
      unitSec: "秒",
    },
    en: {
      title: "Outbound gates",
      version: "Version",
      groupPacing: "Pacing",
      groupBreaker: "Breaker",
      groupFailover: "Account switch",
      groupCache: "Cache",
      pacing: "Min interval pacingMinMs",
      jitter: "Max jitter pacingJitterMs",
      breaker: "Breaker threshold breakerThreshold",
      cooldown: "Breaker cooldown breakerCooldownMs (in minutes)",
      failover: "Switch account when quota runs out quotaFailover",
      cache: "Usage cache usageCacheMs (in seconds)",
      effectiveTitle: "Effective now",
      effective: "Effective now",
      hint:
        "options.set replaces the whole option object: this panel owns only these six keys, " +
        "edit every other option directly in plugins.json.",
      note:
        "Only pacingMinMs = 0 together with pacingJitterMs = 0 means full pass-through; " +
        "breakerThreshold = 0 disables the breaker. Cooldown is edited in minutes and cache in " +
        "seconds, both are written back in milliseconds. Applies from the next request.",
      on: "on",
      off: "off",
      save: "Save",
      cancel: "Cancel",
      loading: "Reading…",
      saved: "Saved · applies from the next request",
      cancelled: "Cancelled, restored from disk",
      fail: "Could not save: ",
      readFail: "Could not read the options, showing defaults: ",
      unitMs: "ms",
      unitTimes: "fails",
      unitMin: "min",
      unitSec: "s",
    },
  };

  const $ = (id) => document.getElementById(id);
  const form = $("gates-form");
  const fPacing = $("pacingMinMs");
  const fJitter = $("pacingJitterMs");
  const fBreaker = $("breakerThreshold");
  const fCooldown = $("breakerCooldownMs"); // 展示单位：分钟
  const fFailover = $("quotaFailover");
  const fCache = $("usageCacheMs"); // 展示单位：秒
  const statusEl = $("gates-status");
  const effectiveEl = $("gates-effective");
  const versionLineEl = $("gates-versionline");
  const versionEl = $("gates-version");
  const saveBtn = $("gates-save");

  await magpie.ready;

  // 语言：主题说 en 才用英文，其余（含缺省）一律中文
  const lang = String(magpie.theme?.lang || document.documentElement.lang || "zh").toLowerCase();
  const t = lang === "en" ? STRINGS.en : STRINGS.zh;

  // 深色主题：宿主给 <html> 打 .dark，CSS 只用来调兜底色
  if (magpie.theme?.dark) document.documentElement.classList.add("dark");

  $("gates-title").textContent = t.title;
  $("gates-group-pacing").textContent = t.groupPacing;
  $("gates-group-breaker").textContent = t.groupBreaker;
  $("gates-group-failover").textContent = t.groupFailover;
  $("gates-group-cache").textContent = t.groupCache;
  $("gates-label-pacing").textContent = t.pacing;
  $("gates-label-jitter").textContent = t.jitter;
  $("gates-label-breaker").textContent = t.breaker;
  $("gates-label-cooldown").textContent = t.cooldown;
  $("gates-label-failover").textContent = t.failover;
  $("gates-label-cache").textContent = t.cache;
  $("gates-unit-pacing").textContent = t.unitMs;
  $("gates-unit-jitter").textContent = t.unitMs;
  $("gates-unit-breaker").textContent = t.unitTimes;
  $("gates-unit-cooldown").textContent = t.unitMin;
  $("gates-unit-cache").textContent = t.unitSec;
  $("gates-effective-title").textContent = t.effectiveTitle;
  $("gates-hint").textContent = t.hint;
  $("gates-note").textContent = t.note;
  $("gates-cancel").textContent = t.cancel;
  saveBtn.textContent = t.save;
  statusEl.textContent = t.loading;

  // 只读状态区里的版本号：来自本文件顶部的 PANEL_VERSION
  versionEl.textContent = `qiniu-ai · ${PANEL_VERSION}`;
  versionLineEl.textContent = `${t.version}: PANEL_VERSION ${PANEL_VERSION}`;

  /** 读到的整份选项 —— 写回时必须原样展开带上，否则别的键会被 options.set 抹掉 */
  let opts = {};

  const readOpts = async () => {
    try {
      const got = await magpie.options.get();
      if (got && typeof got === "object" && !Array.isArray(got)) opts = got;
    } catch (err) {
      statusEl.textContent = t.readFail + (err?.message || err);
    }
    return opts;
  };

  /** 前端夹紧：空值 / 非数字回落到默认，然后取整并夹到 [min, max] */
  const clampInt = (raw, [lo, hi], fallback) => {
    if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };

  const boolOf = (value, fallback) => (typeof value === "boolean" ? value : fallback);

  /** 毫秒值 → 展示值（分钟 / 秒）。只在这里除，写回时乘回去 */
  const toDisplay = (ms, unit) => Math.round(ms / unit);
  const toMs = (shown, unit) => shown * unit;

  /** 把选项画进控件（控件永远是夹紧后的整数值，和插件内部实际生效值同源） */
  const paint = () => {
    const pacingMinMs = clampInt(opts.pacingMinMs, CLAMP.pacingMinMs, DEFAULTS.pacingMinMs);
    const pacingJitterMs = clampInt(opts.pacingJitterMs, CLAMP.pacingJitterMs, DEFAULTS.pacingJitterMs);
    const breakerThreshold = clampInt(opts.breakerThreshold, CLAMP.breakerThreshold, DEFAULTS.breakerThreshold);
    const breakerCooldownMs = clampInt(
      opts.breakerCooldownMs,
      CLAMP.breakerCooldownMs,
      DEFAULTS.breakerCooldownMs,
    );
    const quotaFailover = boolOf(opts.quotaFailover, DEFAULTS.quotaFailover);
    const usageCacheMs = clampInt(opts.usageCacheMs, CLAMP.usageCacheMs, DEFAULTS.usageCacheMs);

    fPacing.value = String(pacingMinMs);
    fJitter.value = String(pacingJitterMs);
    fBreaker.value = String(breakerThreshold);
    fCooldown.value = String(toDisplay(breakerCooldownMs, MS_PER_MINUTE));
    fFailover.checked = quotaFailover;
    fCache.value = String(toDisplay(usageCacheMs, MS_PER_SECOND));

    effectiveEl.textContent =
      `${t.effective} · pacingMinMs=${pacingMinMs} · pacingJitterMs=${pacingJitterMs} · ` +
      `breakerThreshold=${breakerThreshold} · breakerCooldownMs=${breakerCooldownMs} · ` +
      `quotaFailover=${quotaFailover ? t.on : t.off} · usageCacheMs=${usageCacheMs}`;
  };

  await readOpts();
  paint();

  // 只有一个入口：form 的 submit。用 submitter 的 value 区分「保存」和「取消」，
  // 这样回车键走默认按钮也不会误写。
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const action = ev.submitter?.value || "cancel";

    if (action !== "save") {
      // 取消：丢掉控件里的改动，重新按磁盘上的值渲染，不写 options
      await readOpts();
      paint();
      statusEl.textContent = t.cancelled;
      return;
    }

    // 保存：先夹紧再取整（空值回落默认），展示单位的先乘回毫秒并再夹一次，
    // 最后整份展开写回 —— options.set 是整份替换，漏掉 ...opts 会抹掉用户别的选项。
    const pacingMinMs = clampInt(fPacing.value, CLAMP.pacingMinMs, DEFAULTS.pacingMinMs);
    const pacingJitterMs = clampInt(fJitter.value, CLAMP.pacingJitterMs, DEFAULTS.pacingJitterMs);
    const breakerThreshold = clampInt(fBreaker.value, CLAMP.breakerThreshold, DEFAULTS.breakerThreshold);
    const breakerCooldownMs = clampInt(
      toMs(clampInt(fCooldown.value, DISPLAY.breakerCooldownMin.clamp, DISPLAY.breakerCooldownMin.def), MS_PER_MINUTE),
      CLAMP.breakerCooldownMs,
      DEFAULTS.breakerCooldownMs,
    );
    const quotaFailover = !!fFailover.checked;
    const usageCacheMs = clampInt(
      toMs(clampInt(fCache.value, DISPLAY.usageCacheSec.clamp, DISPLAY.usageCacheSec.def), MS_PER_SECOND),
      CLAMP.usageCacheMs,
      DEFAULTS.usageCacheMs,
    );

    const next = { ...opts, pacingMinMs, pacingJitterMs, breakerThreshold, breakerCooldownMs, quotaFailover, usageCacheMs };

    saveBtn.disabled = true;
    try {
      const back = await magpie.options.set(next);
      opts = back && typeof back === "object" && !Array.isArray(back) ? back : next;
      paint();
      statusEl.textContent = t.saved;
    } catch (err) {
      statusEl.textContent = t.fail + (err?.message || err);
    } finally {
      saveBtn.disabled = false;
    }
  });
})();
