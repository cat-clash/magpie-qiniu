// panel/gates.js —— 出站闸面板（magpie.panels，slot: provider）
//
// 只暴露三个最常调的键：
//   pacingMinMs      0..60000   默认 800   节奏闸：按账号拉开的最小间隔
//   breakerThreshold 0..100     默认 5     账号级熔断阈值，0 = 禁用熔断
//   quotaFailover    true/false 默认 true  402 / 欠费 403 改写为 429，让宿主换号
//
// ⚠ magpie.options.set 的两条硬约束（bridge 契约，写错了会静默丢数据）：
//   1) **整份替换**：传进去的对象就是新的全量选项，没带上的键会被抹掉。
//      → 写回必须先把 magpie.options.get() 读到的整份 opts 展开（...opts），再覆盖这三个键。
//   2) **一秒最多一次**：连写会被宿主丢弃或直接报错。
//      → 只在用户按「保存」那一下写一次；输入框改了不落盘，取消就按磁盘值重画。
//        所以这里**不**监听输入事件做即时写回。
//
// 面板是纯前端：不发任何请求、不引任何外部资源，离线可用。

(async () => {
  // 与 src/config.mjs 的 DEFAULTS / CLAMP 逐项对齐（测试里有断言，改一处要三处同步）
  const DEFAULTS = { pacingMinMs: 800, breakerThreshold: 5, quotaFailover: true };
  const CLAMP = { pacingMinMs: [0, 60_000], breakerThreshold: [0, 100] };

  const STRINGS = {
    zh: {
      title: "出站闸",
      pacing: "最小间隔 pacingMinMs",
      breaker: "熔断阈值 breakerThreshold",
      failover: "额度用尽即换号 quotaFailover",
      note:
        "三个值只影响本插件的出站行为，保存后下一个请求起生效。pacingMinMs 设 0 且 pacingJitterMs 也设 0 才是完全直通；breakerThreshold 设 0 = 禁用熔断。其余选项直接改 plugins.json 里的插件选项。",
      effective: "当前生效值",
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
    },
    en: {
      title: "Outbound gates",
      pacing: "Min interval pacingMinMs",
      breaker: "Breaker threshold breakerThreshold",
      failover: "Switch account when quota runs out quotaFailover",
      note:
        "These three values only shape this plugin's outbound traffic and apply from the next request. Only pacingMinMs = 0 together with pacingJitterMs = 0 means full pass-through; breakerThreshold = 0 disables the breaker. Edit every other option in the plugin options inside plugins.json.",
      effective: "Effective now",
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
    },
  };

  const $ = (id) => document.getElementById(id);
  const form = $("gates-form");
  const fPacing = $("pacingMinMs");
  const fBreaker = $("breakerThreshold");
  const fFailover = $("quotaFailover");
  const statusEl = $("gates-status");
  const effectiveEl = $("gates-effective");
  const saveBtn = $("gates-save");

  await magpie.ready;

  // 语言：主题说 en 才用英文，其余（含缺省）一律中文
  const lang = String(magpie.theme?.lang || document.documentElement.lang || "zh").toLowerCase();
  const t = lang === "en" ? STRINGS.en : STRINGS.zh;

  // 深色主题：宿主给 <html> 打 .dark，CSS 只用来调兜底色
  if (magpie.theme?.dark) document.documentElement.classList.add("dark");

  $("gates-title").textContent = t.title;
  $("gates-label-pacing").textContent = t.pacing;
  $("gates-label-breaker").textContent = t.breaker;
  $("gates-label-failover").textContent = t.failover;
  $("gates-note").textContent = t.note;
  $("gates-cancel").textContent = t.cancel;
  saveBtn.textContent = t.save;
  document.querySelectorAll(".gates-unit")[0].textContent = t.unitMs;
  document.querySelectorAll(".gates-unit")[1].textContent = t.unitTimes;
  statusEl.textContent = t.loading;

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

  const numOf = (value, clamp, fallback) => clampInt(value, clamp, fallback);
  const boolOf = (value, fallback) => (typeof value === "boolean" ? value : fallback);

  /** 把选项画进控件（控件永远是夹紧后的整数值，和插件内部实际生效值一致） */
  const paint = () => {
    const pacing = numOf(opts.pacingMinMs, CLAMP.pacingMinMs, DEFAULTS.pacingMinMs);
    const breaker = numOf(opts.breakerThreshold, CLAMP.breakerThreshold, DEFAULTS.breakerThreshold);
    const failover = boolOf(opts.quotaFailover, DEFAULTS.quotaFailover);
    fPacing.value = String(pacing);
    fBreaker.value = String(breaker);
    fFailover.checked = failover;
    effectiveEl.textContent =
      `${t.effective} · pacingMinMs=${pacing} · breakerThreshold=${breaker} · ` +
      `quotaFailover=${failover ? t.on : t.off}`;
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

    // 保存：先夹紧再转整数，空值回落默认；然后整份展开写回
    const pacingMinMs = numOf(fPacing.value, CLAMP.pacingMinMs, DEFAULTS.pacingMinMs);
    const breakerThreshold = numOf(fBreaker.value, CLAMP.breakerThreshold, DEFAULTS.breakerThreshold);
    const quotaFailover = !!fFailover.checked;

    const next = { ...opts, pacingMinMs, breakerThreshold, quotaFailover };

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
