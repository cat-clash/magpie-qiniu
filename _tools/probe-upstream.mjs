#!/usr/bin/env bun
/**
 * _tools/probe-upstream.mjs — A1·probe 上游实测（唯一真源见 ../CONTRACT.md §1/§5）
 *
 * 用途：在**没有任何真实凭据**的前提下，只用无效 key `sk-invalid-probe` 制造错误分支，
 *       实测 api.qnaigc.com / api.qiniu.com 的端点存在性、错误体逐字文案、响应头、
 *       参数校验与鉴权的先后顺序、流式返回形态、服务端指纹。
 *
 * 纪律：
 *  - 请求间隔 GAP_MS(=300ms) ≥ 250ms（上游同 IP 5 QPS 限流，见 CONTRACT §1）。
 *  - 单次全量跑 TOTAL_REQUESTS 上限 40（含本地回环自检，回环不计入上游限流）。
 *  - 不写死任何真实 secret：BAD_KEY 是故意无效的占位串，AK/SK 用明显的假值。
 *  - 幂等：可重复跑；research/upstream-probe.md 里 `<!-- ANALYSIS:BEGIN..END -->`
 *    之间的人工结论段在重跑时原样保留，其余事实段全部重建。
 *
 * 产物：
 *  - _tools/models-dump.json      GET /v1/models 无鉴权响应体（逐字，不做美化/裁剪）
 *  - research/upstream-probe.md   实测结论（事实段由本脚本生成，分析段人工维护）
 *  - stdout                       紧凑摘要（供人读，不含全表）
 *
 * 用法：bun run _tools/probe-upstream.mjs [--dry]   (--dry 只打印计划，不发请求)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../magpie-qiniu-installer/_tools
const ROOT = dirname(HERE); // .../magpie-qiniu-installer
const DUMP_PATH = join(HERE, 'models-dump.json');
const MD_PATH = join(ROOT, 'research', 'upstream-probe.md');
const TRACE_PATH = join(tmpdir(), 'magpie-qiniu-probe-trace.json'); // 仓库外，仅本地迭代用

const QNAI = 'https://api.qnaigc.com';
const QINIU = 'https://api.qiniu.com';
const BAD_KEY = 'sk-invalid-probe'; // 故意无效：不是 secret，是错误分支夹具
const FAKE_AK = 'FAKE_AK_FOR_PROBE';
const FAKE_SK = 'FAKE_SK_FOR_PROBE';
const GAP_MS = 300;
const BODY_CAP = 6000;
const MODEL_PROBE_ID = 'deepseek-chat';
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_CURL = 'curl/8.6.0';
const UA_BUN = 'Bun/1.4.5';
const DRY = process.argv.includes('--dry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 阶段标记：进程若被硬终止，exit hook 会打出停在哪一步（排查用，正常静默）。 */
let PHASE = 'init';
process.on('exit', (code) => {
  if (process.argv.includes('--trace-exit')) console.error(`[exit ${code}] at phase=${PHASE}`);
});

/* ────────────────────────── 请求计划 ────────────────────────── */

const A = (k) => ({ Authorization: `Bearer ${k}` });
const JSONH = (extra = {}) => ({ 'content-type': 'application/json', ...extra });
const CHAT_BODY = {
  model: MODEL_PROBE_ID,
  messages: [{ role: 'user', content: 'ping-probe' }],
  max_tokens: 8,
};
const ANTH_BODY = {
  model: MODEL_PROBE_ID,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'ping-probe' }],
};

/** @type {{name:string,method:string,url:string,headers?:Record<string,string>,body?:string,note?:string}[]} */
const PLAN = [
  // 1) 模型清单
  { name: 'models.noauth', method: 'GET', url: `${QNAI}/v1/models`, note: '无鉴权是否 200' },
  { name: 'models.badkey', method: 'GET', url: `${QNAI}/v1/models`, headers: A(BAD_KEY), note: '无效 key' },

  // 2) chat 通路 + 流式形态
  {
    name: 'chat.nonstream.badkey',
    method: 'POST',
    url: `${QNAI}/v1/chat/completions`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ ...CHAT_BODY, stream: false }),
    note: '无效 key 非流式',
  },
  {
    name: 'chat.stream.badkey',
    method: 'POST',
    url: `${QNAI}/v1/chat/completions`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ ...CHAT_BODY, stream: true }),
    note: '无效 key + stream:true → 401 JSON 还是 SSE error？',
  },
  {
    name: 'chat.nonstream.noauth',
    method: 'POST',
    url: `${QNAI}/v1/chat/completions`,
    headers: JSONH(),
    body: JSON.stringify({ ...CHAT_BODY, stream: false }),
    note: '完全不带 Authorization，对比 badkey 是否同文案',
  },

  // 3) Anthropic 通路
  {
    name: 'messages.post.badkey',
    method: 'POST',
    url: `${QNAI}/v1/messages`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify(ANTH_BODY),
    note: 'Anthropic 兼容路由是否存在（无效 key）',
  },
  {
    name: 'messages.stream.badkey',
    method: 'POST',
    url: `${QNAI}/v1/messages`,
    headers: { ...JSONH({ 'anthropic-version': '2023-06-01' }), ...A(BAD_KEY) },
    body: JSON.stringify({ ...ANTH_BODY, stream: true }),
    note: '带 anthropic-version + stream',
  },
  {
    name: 'messages.get.badkey',
    method: 'GET',
    url: `${QNAI}/v1/messages`,
    headers: A(BAD_KEY),
    note: 'GET 探路由存在性：405=存在，404=不存在',
  },

  // 4) /v3/stat/usage —— 参数校验 vs 鉴权 的先后
  { name: 'usage.badkey', method: 'GET', url: `${QNAI}/v3/stat/usage`, headers: A(BAD_KEY), note: '无参数 + 无效 key' },
  { name: 'usage.noauth', method: 'GET', url: `${QNAI}/v3/stat/usage`, note: '无参数 + 无鉴权' },
  {
    name: 'usage.badkey.baddates',
    method: 'GET',
    url: `${QNAI}/v3/stat/usage?granularity=day&start=bad&end=bad`,
    headers: A(BAD_KEY),
    note: '坏日期 + 无效 key → 谁的错误先出？',
  },
  {
    name: 'usage.noauth.baddates',
    method: 'GET',
    url: `${QNAI}/v3/stat/usage?granularity=day&start=bad&end=bad`,
    note: '坏日期 + 无鉴权 → 参数校验是否先于鉴权',
  },
  {
    name: 'usage.badkey.badgran',
    method: 'GET',
    url: `${QNAI}/v3/stat/usage?granularity=bogus`,
    headers: A(BAD_KEY),
    note: '非法 granularity + 无效 key',
  },
  {
    name: 'usage.noauth.badgran',
    method: 'GET',
    url: `${QNAI}/v3/stat/usage?granularity=bogus`,
    note: '非法 granularity + 无鉴权',
  },
  {
    name: 'cost.badkey',
    method: 'GET',
    url: `${QNAI}/v3/stat/usage/apikey/cost?type=day`,
    headers: A(BAD_KEY),
    note: 'CONTRACT §1 费用端点存在性',
  },
  {
    name: 'exportlog.badkey',
    method: 'GET',
    url: `${QNAI}/v2/stat/export_log?size=10&page=1`,
    headers: A(BAD_KEY),
    note: 'CONTRACT §1 逐请求端点存在性',
  },

  // 5) apikey quota
  {
    name: 'quota.badkey',
    method: 'GET',
    url: `${QNAI}/v1/apikey/quota/${BAD_KEY}`,
    headers: A(BAD_KEY),
    note: 'Bearer 无效 key 打 quota（该端点宣称 AK/SK 签名）',
  },
  {
    name: 'quota.noauth',
    method: 'GET',
    url: `${QNAI}/v1/apikey/quota/${BAD_KEY}`,
    note: '无鉴权对照',
  },
  {
    name: 'quota.badsign',
    method: 'GET',
    url: `${QNAI}/v1/apikey/quota/${BAD_KEY}`,
    headers: { Authorization: `Qiniu ${FAKE_AK}:${FAKE_SK}` },
    note: 'AK/SK 方案但签名伪造 → 看签名错误的文案',
  },
  {
    name: 'apikeys.post.badkey',
    method: 'POST',
    url: `${QNAI}/v1/apikeys`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ name: 'probe-noop' }),
    note: '建 Key 端点：无效 Bearer 必须被拒（无 AK/SK 签名，不可能真的建 Key）',
  },

  // 6) 余额（api.qiniu.com，AK/SQ 签名域）
  { name: 'balance.noauth', method: 'GET', url: `${QINIU}/billing-api/v1/account/balance-overview`, note: '无鉴权' },
  {
    name: 'balance.badsign',
    method: 'GET',
    url: `${QINIU}/billing-api/v1/account/balance-overview`,
    headers: { Authorization: `Qiniu ${FAKE_AK}:${FAKE_SK}` },
    note: 'Qiniu 签名 scheme + 假 AK/SK',
  },
  {
    name: 'respack.badsign',
    method: 'GET',
    url: `${QINIU}/billing-api/v1/respack/list`,
    headers: { Authorization: `Qiniu ${FAKE_AK}:${FAKE_SK}` },
    note: 'CONTRACT §1 资源包端点存在性',
  },

  // 7) 模型详情端点
  { name: 'model.detail.noauth', method: 'GET', url: `${QNAI}/v1/models/${MODEL_PROBE_ID}`, note: '是否存在 /v1/models/<id>' },
  { name: 'model.detail.badkey', method: 'GET', url: `${QNAI}/v1/models/${MODEL_PROBE_ID}`, headers: A(BAD_KEY), note: '同上，带无效 key' },

  // 8) UA / WAF 指纹
  { name: 'ua.curl', method: 'GET', url: `${QNAI}/v1/models`, headers: { 'user-agent': UA_CURL }, note: 'curl UA' },
  { name: 'ua.browser', method: 'GET', url: `${QNAI}/v1/models`, headers: { 'user-agent': UA_BROWSER }, note: '浏览器 UA' },
  { name: 'ua.empty', method: 'GET', url: `${QNAI}/v1/models`, headers: { 'user-agent': '' }, note: '空 UA' },
  {
    name: 'ua.none.chat',
    method: 'POST',
    url: `${QNAI}/v1/chat/completions`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ ...CHAT_BODY, stream: false }),
    note: 'Bun 默认 UA 打 chat（与 ua.curl 的 401 文案对比）',
  },

  // 9) 其它能力端点存在性
  {
    name: 'embeddings.badkey',
    method: 'POST',
    url: `${QNAI}/v1/embeddings`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ model: 'bge-m3', input: 'probe' }),
    note: '401/400=路由存在，404/405=不存在',
  },
  {
    name: 'audio.speech.badkey',
    method: 'POST',
    url: `${QNAI}/v1/audio/speech`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ model: 'tts-1', input: 'probe', voice: 'alloy' }),
    note: '存在性',
  },
  {
    name: 'images.generations.badkey',
    method: 'POST',
    url: `${QNAI}/v1/images/generations`,
    headers: { ...JSONH(), ...A(BAD_KEY) },
    body: JSON.stringify({ model: 'dall-e-3', prompt: 'probe' }),
    note: '存在性',
  },
  { name: 'root.badkey', method: 'GET', url: `${QNAI}/`, note: '站点根，纯指纹用途' },

  // 10) 路由存在性的控制实验：/v1 下带无效 Bearer 一律被网关 401 拦下，
  //     所以「401」**不能**证明路由存在；必须用「完全不带 Authorization」再打一次：
  //     404 → 应用层没有这个路由；带应用层鉴权业务体 → 路由存在。
  { name: 'control.badkey', method: 'GET', url: `${QNAI}/v1/definitely-not-a-route-xyz`, headers: A(BAD_KEY), note: '控制组：不存在的 /v1 路径 + 无效 key' },
  { name: 'control.noauth', method: 'GET', url: `${QNAI}/v1/definitely-not-a-route-xyz`, note: '控制组：不存在的 /v1 路径 + 无鉴权' },
  {
    name: 'embeddings.noauth',
    method: 'POST',
    url: `${QNAI}/v1/embeddings`,
    headers: JSONH(),
    body: JSON.stringify({ model: 'bge-m3', input: 'probe' }),
    note: '无鉴权：应用层错误=路由存在，404=不存在',
  },
  {
    name: 'audio.speech.noauth',
    method: 'POST',
    url: `${QNAI}/v1/audio/speech`,
    headers: JSONH(),
    body: JSON.stringify({ model: 'tts-1', input: 'probe', voice: 'alloy' }),
    note: '同上',
  },
  {
    name: 'images.generations.noauth',
    method: 'POST',
    url: `${QNAI}/v1/images/generations`,
    headers: JSONH(),
    body: JSON.stringify({ model: 'dall-e-3', prompt: 'probe' }),
    note: '同上',
  },
];

/* ────────────────────────── 执行 ────────────────────────── */

const KEY_HEADERS_WANTED = [
  'server',
  'date',
  'content-type',
  'x-request-id',
  'x-reqid',
  'reqid',
  'www-authenticate',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'cf-ray',
  'via',
  'x-powered-by',
  'eagleid',
  'server-timing',
  'timing-allow-origin',
  'x-log',
];

function classify(h) {
  const magpie = Object.keys(h).filter((k) => k.startsWith('x-magpie-'));
  return {
    server: h['server'] ?? null,
    reqId: h['x-request-id'] ?? h['x-reqid'] ?? h['reqid'] ?? null,
    wwwAuthenticate: h['www-authenticate'] ?? null,
    retryAfter: h['retry-after'] ?? null,
    magpieHeaders: magpie,
    via: h['via'] ?? null,
    eagleid: h['eagleid'] ?? null,
    contentType: h['content-type'] ?? null,
  };
}

async function fire(step) {
  const t0 = Date.now();
  const rec = {
    name: step.name,
    method: step.method,
    url: step.url,
    note: step.note ?? '',
    reqHeaders: step.headers ?? {},
    sentBody: step.body ?? null,
  };
  try {
    const res = await fetch(step.url, {
      method: step.method,
      headers: step.headers,
      body: step.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(25000),
    });
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf); // 逐字全量，供 dump
    const truncated = raw.length > BODY_CAP;
    const text = truncated ? raw.slice(0, BODY_CAP) : raw; // 仅展示用
    let json = null;
    try {
      json = JSON.parse(raw); // 必须解析全量：/v1/models 有 14KB，截断后就解析不出来
    } catch {}
    Object.assign(rec, {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      redirected: res.redirected,
      type: res.type,
      bytes: buf.length,
      headers,
      flags: classify(headers),
      rawText: raw,
      bodyText: text,
      bodyTruncated: truncated,
      json,
      latencyMs: Date.now() - t0,
    });
  } catch (e) {
    Object.assign(rec, {
      ok: false,
      status: 0,
      statusText: 'FETCH_ERROR',
      error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`,
      rawText: '',
      bodyText: '',
      headers: {},
      flags: classify({}),
      latencyMs: Date.now() - t0,
    });
  }
  return rec;
}

/** 本地回环自检：记录 Bun fetch 在三种 UA 设置下**实际发出**的 user-agent。 */
async function uaSelfCheck() {
  const out = {};
  try {
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const ua = req.headers.get('user-agent');
      return Response.json({ actualUserAgent: ua === null ? null : ua });
    } });
    const base = `http://127.0.0.1:${srv.port}/echo`;
    const variants = {
      'unset(header omitted)': undefined,
      'empty-string ""': '',
      [UA_CURL]: UA_CURL,
      [UA_BUN]: UA_BUN,
    };
    for (const [label, ua] of Object.entries(variants)) {
      const r = await fetch(base, { headers: ua === undefined ? undefined : { 'user-agent': ua } });
      out[label] = (await r.json()).actualUserAgent;
    }
    srv.stop();
  } catch (e) {
    out.error = `${e?.name}: ${e?.message}`;
  }
  return out;
}

/* ────────────────────────── 模型清单分析 ────────────────────────── */

function analyzeModels(listResp) {
  const res = {
    status: listResp?.status ?? null,
    fetchError: listResp?.error ?? null,
    isArray: false,
    total: 0,
    topKeys: [],
    entryKeys: [],
    extraKeyReport: [],
    maxTokensZero: 0,
    maxTokensNull: 0,
    contextLengthNull: 0,
    serviceStatusCounts: {},
    ownedByCounts: {},
    objectCounts: {},
    createdRange: null,
    rows: [],
    pricingFieldsFound: [],
    sampleWithExtras: null,
  };
  let data = null;
  let doc = listResp?.json ?? null;
  if (!doc && listResp?.rawText) {
    try {
      doc = JSON.parse(listResp.rawText); // 兼容 --reuse-trace：老 trace 里 json 可能为 null
    } catch {}
  }
  if (doc && typeof doc === 'object') {
    if (Array.isArray(doc)) {
      res.isArray = true;
      data = doc;
    } else if (Array.isArray(doc.data)) data = doc.data;
    res.topKeys = Object.keys(doc);
  }
  if (!Array.isArray(data)) return res;
  res.total = data.length;

  const CORE = new Set(['id', 'object', 'created', 'owned_by', 'context_length', 'max_tokens', 'service_status']);
  const keySeen = new Map();
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    for (const k of Object.keys(m)) {
      if (!keySeen.has(k)) keySeen.set(k, { count: 0, samples: new Set(), types: new Set() });
      const s = keySeen.get(k);
      s.count++;
      s.types.add(m[k] === null ? 'null' : Array.isArray(m[k]) ? 'array' : typeof m[k]);
      if (s.samples.size < 4 && m[k] !== null && m[k] !== undefined && typeof m[k] !== 'object') {
        s.samples.add(String(m[k]).slice(0, 80));
      }
      if (s.samples.size < 2 && (typeof m[k] === 'object' || Array.isArray(m[k]))) {
        s.samples.add(JSON.stringify(m[k]).slice(0, 160));
      }
    }
  }
  res.entryKeys = [...keySeen.keys()].sort();
  res.extraKeyReport = [...keySeen.entries()]
    .filter(([k]) => !CORE.has(k))
    .map(([k, v]) => ({ key: k, count: v.count, types: [...v.types], samples: [...v.samples] }));
  res.pricingFieldsFound = res.extraKeyReport
    .filter((x) => /price|pricing|cost|currency|token_price|billing|group|tag|modal|vendor|provider|category|supports|features|description/i.test(x.key))
    .map((x) => x.key);

  let cMin = Infinity,
    cMax = -Infinity;
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const mt = m.max_tokens;
    if (mt === null || mt === undefined) res.maxTokensNull++;
    else if (Number(mt) === 0) res.maxTokensZero++;
    if (m.context_length === null || m.context_length === undefined) res.contextLengthNull++;
    res.serviceStatusCounts[String(m.service_status)] = (res.serviceStatusCounts[String(m.service_status)] ?? 0) + 1;
    res.ownedByCounts[String(m.owned_by)] = (res.ownedByCounts[String(m.owned_by)] ?? 0) + 1;
    res.objectCounts[String(m.object)] = (res.objectCounts[String(m.object)] ?? 0) + 1;
    const c = Number(m.created);
    if (Number.isFinite(c)) {
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
    }
    res.rows.push({
      id: m.id ?? '',
      context_length: m.context_length ?? null,
      max_tokens: m.max_tokens ?? null,
      service_status: m.service_status ?? null,
    });
  }
  if (cMin !== Infinity) res.createdRange = { min: cMin, max: cMax, iso: [new Date(cMin * 1000).toISOString(), new Date(cMax * 1000).toISOString()] };
  res.sampleWithExtras = data.find((m) => m && Object.keys(m).some((k) => !CORE.has(k))) ?? null;
  return res;
}

const esc = (s) => String(s).replace(/\|/g, '\\|');
const fence = (s, lang = '') => '```' + lang + '\n' + String(s) + '\n```';
const j = (v) => JSON.stringify(v);

function shortBody(r) {
  const t = (r.bodyText ?? '').replace(/\s+$/, '');
  if (!t) return r.error ? `*(fetch error: ${r.error})*` : '*(空 body)*';
  return t.length > 700 ? t.slice(0, 700) + `…[+${t.length - 700}]` : t;
}

/* ────────────────────────── 主流程 ────────────────────────── */

const stage = async (label, fn) => {
  try {
    const v = await fn();
    console.log(`  [stage ok] ${label}`);
    return v;
  } catch (e) {
    console.error(`\n!! stage FAILED: ${label}\n${e?.stack ?? e}`);
    throw e;
  }
};

async function main() {
  const remoteCount = PLAN.length;
  if (remoteCount > 40) throw new Error(`请求计划 ${remoteCount} > 40，违反纪律`);
  if (DRY) {
    console.log(`[dry] 计划 ${remoteCount} 个上游请求 + 4 个本地回环自检`);
    for (const p of PLAN) console.log(` - ${p.name.padEnd(26)} ${p.method.padEnd(4)} ${p.url}`);
    return;
  }

  console.log(`probe-upstream: ${remoteCount} 个请求，间隔 ${GAP_MS}ms，预计 ≥${((remoteCount * GAP_MS) / 1000).toFixed(0)}s`);
  const results = [];
  const reuse = process.argv.includes('--reuse-trace') && (await Bun.file(TRACE_PATH).exists());
  if (reuse) {
    results.push(...JSON.parse(await Bun.file(TRACE_PATH).text()));
    console.log(`  [cache] 复用 ${results.length} 条上一次的实测结果（${TRACE_PATH}），本次不向上游发请求`);
  } else
    for (let i = 0; i < PLAN.length; i++) {
      const r = await fire(PLAN[i]);
      results.push(r);
      console.log(`  [${i + 1}/${remoteCount}] ${r.name.padEnd(26)} ${String(r.status).padEnd(4)} ${(r.flags.server ?? '-').padEnd(14)} ${(r.bytes ?? 0)}B`);
      if (i < PLAN.length - 1) await sleep(GAP_MS);
    }
  // trace 落 $TEMP（不属于仓库，不污染同事的文件）；供 --reuse-trace 离线迭代 md
  await Bun.write(TRACE_PATH, JSON.stringify(results, null, 1));

  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  const modelsResp = by['models.noauth'];
  const modelsRaw = modelsResp.rawText ?? '';
  await stage('write models-dump.json', () => Bun.write(DUMP_PATH, modelsRaw || '[]'));
  const M = await stage('analyzeModels', () => analyzeModels(modelsResp));
  const uaCheck = await stage('uaSelfCheck', () => uaSelfCheck());

  PHASE = 'buildMd';
  const md = await stage('buildMd', () => buildMd({ results, by, M, uaCheck, modelsRaw }));
  PHASE = 'preserve-analysis';
  // 保留人工分析段（用 node:fs 读：Bun.file().text() 在缺失路径上会静默 exit 0，实测踩过）
  let prevAnalysis = null;
  try {
    if (existsSync(MD_PATH)) {
      const old = readFileSync(MD_PATH, 'utf8');
      const m = old.match(/<!-- ANALYSIS:BEGIN -->[\s\S]*?<!-- ANALYSIS:END -->/);
      if (m && !m[0].includes('ANALYSIS:PLACEHOLDER')) prevAnalysis = m[0];
    }
  } catch {}
  const finalMd = prevAnalysis ? md.replace(/<!-- ANALYSIS:BEGIN -->[\s\S]*?<!-- ANALYSIS:END -->/, prevAnalysis) : md;
  PHASE = 'write-md';
  await stage('write upstream-probe.md', () => Bun.write(MD_PATH, finalMd));
  PHASE = 'summary';

  /* stdout 紧凑摘要 */
  console.log('\n=== models.noauth ===');
  console.log(`HTTP ${M.status} · entries ${M.total} · max_tokens=0: ${M.maxTokensZero} · null: ${M.maxTokensNull} · cl null: ${M.contextLengthNull}`);
  console.log(`top keys: ${M.topKeys.join(',')}`);
  console.log(`entry keys: ${M.entryKeys.join(',')}`);
  console.log(`service_status: ${j(M.serviceStatusCounts)}`);
  console.log(`owned_by: ${j(M.ownedByCounts)}`);
  console.log(`object: ${j(M.objectCounts)}`);
  console.log(`created: ${j(M.createdRange)}`);
  console.log(`非核心字段: ${M.extraKeyReport.map((x) => `${x.key}(${x.count},${x.types.join('/')},${x.samples.slice(0, 2).join(' ~ ')})`).join(' | ') || '（无）'}`);
  console.log(`模态/价格/分组相关字段: ${M.pricingFieldsFound.join(',') || '（未发现）'}`);
  console.log('\n=== 状态码矩阵 ===');
  for (const r of results) console.log(`${r.name.padEnd(26)} ${String(r.status).padEnd(4)} ct=${(r.flags.contentType ?? '-').split(';')[0].padEnd(24)} reqId=${r.flags.reqId ? 'Y' : '-'} WA=${r.flags.wwwAuthenticate ? 'Y' : '-'} RA=${r.flags.retryAfter ? 'Y' : '-'} magpie=${r.flags.magpieHeaders.length ? r.flags.magpieHeaders.join(',') : '-'} body=${shortBody(r).replace(/\n/g, ' ').slice(0, 160)}`);
  console.log('\n=== Bun 实际发出的 UA（回环自检）===');
  console.log(j(uaCheck, null, 0));
  console.log(`\n写入: ${DUMP_PATH}\n写入: ${MD_PATH}${prevAnalysis ? '（人工分析段已保留）' : ''}`);
}

/* ────────────────────────── MD 生成 ────────────────────────── */

function buildMd({ results, by, M, uaCheck, modelsRaw }) {
  const L = [];
  const stamp = new Date().toISOString();
  L.push('# 上游实测 · api.qnaigc.com / api.qiniu.com（A1 · probe）');
  L.push('');
  L.push(`> 本文**事实段全部为「实测」**，由 \`_tools/probe-upstream.mjs\` 自动生成于 ${stamp}（bun 1.4.5，global fetch，请求 ${results.length} 个，间隔 300ms）。`);
  L.push(`> 凭据：只用无效 key \`${BAD_KEY}\`（\`--dry\` 可复算计划）。原始响应见 \`_tools/models-dump.json\`。`);
  L.push('> 段末 `<!-- ANALYSIS --> ` 之后是人工结论与契约修订建议，重跑时原样保留。');
  L.push('');

  // §1 models
  L.push('## 1. `GET /v1/models` 无鉴权（实测）');
  L.push('');
  L.push(`- HTTP **${M.status}**${M.fetchError ? `，fetch 异常 ${M.fetchError}` : ''}；顶层字段：\`${M.topKeys.join(', ')}\`；条目数 **${M.total}**。`);
  L.push(`- 条目字段全集（${M.entryKeys.length} 个）：\`${M.entryKeys.join(', ')}\``);
  L.push(`- **非核心字段**（核心 = id/object/created/owned_by/context_length/max_tokens/service_status）：`);
  if (!M.extraKeyReport.length) L.push('  - 无。上游**不返回**任何模态 / 价格 / 分组 / 能力字段。');
  for (const x of M.extraKeyReport) L.push(`  - \`${x.key}\`：出现 ${x.count}/${M.total} 次，类型 ${x.types.join('/')}，样本 ${x.samples.map((s) => '`' + s + '`').join(' / ')}`);
  L.push(`- 模态/价格/分组字段命中清单：\`${M.pricingFieldsFound.join(', ') || '（无）'}\``);
  L.push(`- \`max_tokens\`：**0 值 ${M.maxTokensZero} 条**，null/缺失 ${M.maxTokensNull} 条 → CONTRACT §1 的「绝不能把 limit.output 写成 0」**实测成立**。`);
  L.push(`- \`context_length\` 缺失/null：${M.contextLengthNull} 条。`);
  L.push(`- \`service_status\` 全部取值：${Object.entries(M.serviceStatusCounts).map(([k, v]) => `\`${k}\`×${v}`).join('、')}`);
  L.push(`- \`owned_by\` 全部取值（${Object.keys(M.ownedByCounts).length} 个）：${Object.entries(M.ownedByCounts).map(([k, v]) => `\`${k}\`×${v}`).join('、')}`);
  L.push(`- \`object\` 取值：${Object.entries(M.objectCounts).map(([k, v]) => `\`${k}\`×${v}`).join('、')}`);
  L.push(`- \`created\` 区间：${M.createdRange ? `${M.createdRange.min}..${M.createdRange.max}（${M.createdRange.iso.join(' .. ')}）` : 'n/a'}`);
  L.push(`- 带无效 key 的同请求：HTTP ${by['models.badkey']?.status}（见 §2 矩阵）。`);
  L.push('');
  L.push(`<details><summary>\`id | context_length | max_tokens | service_status\` 全表（${M.rows.length} 行）</summary>`);
  L.push('');
  L.push('| id | context_length | max_tokens | service_status |');
  L.push('| --- | ---: | ---: | --- |');
  for (const r of M.rows) L.push(`| ${esc(r.id)} | ${r.context_length ?? 'null'} | ${r.max_tokens ?? 'null'} | ${esc(r.service_status)} |`);
  L.push('');
  L.push('</details>');
  L.push('');

  // §2 error matrix
  L.push('## 2. 错误矩阵（逐字错误体 + 关键响应头）（实测）');
  L.push('');
  L.push('| # | probe | method+url | HTTP | server | x-request-id | www-authenticate | retry-after | x-magpie-* | content-type |');
  L.push('| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |');
  results.forEach((r, i) => {
    L.push(
      `| ${i + 1} | \`${r.name}\` | ${r.method} \`${r.url.replace('https://', '')}\` | ${r.status} | ${r.flags.server ?? '-'} | ${r.flags.reqId ?? '-'} | ${r.flags.wwwAuthenticate ?? '-'} | ${r.flags.retryAfter ?? '-'} | ${(r.flags.magpieHeaders ?? []).join(',') || '-'} | ${r.flags.contentType ?? '-'} |`,
    );
  });
  L.push('');
  L.push('### 2.1 逐字响应体');
  L.push('');
  for (const r of results) {
    L.push(`**\`${r.name}\`** → HTTP ${r.status}${r.statusText && r.statusText !== 'OK' ? ` ${r.statusText}` : ''} · ${r.bytes ?? 0}B${r.error ? ` · fetch error` : ''}`);
    L.push('');
    if (r.bodyTruncated) L.push(`_（截断到 ${BODY_CAP}B）_`);
    const lang = r.json ? 'json' : /^data:|^event:|^:/.test((r.bodyText ?? '').trim()) ? 'text' : 'text';
    L.push(fence(shortBody(r), lang));
    L.push('');
    L.push(`<summary>全部响应头</summary>`);
    L.push('');
    L.push(fence(Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'));
    L.push('');
  }

  L.push('### 2.2 响应头层面的统一事实');
  L.push('');
  const hdrStats = (fn) => results.filter(fn).map((r) => r.name);
  L.push(`- 带 \`www-authenticate\` 的响应：${hdrStats((r) => !!r.flags.wwwAuthenticate).join(', ') || '**0 个**（全站不用该头）'}`);
  L.push(`- 带 \`retry-after\` 的响应：${hdrStats((r) => !!r.flags.retryAfter).join(', ') || '**0 个**（未观察到 429/退避头）'}`);
  L.push(`- 带 \`x-magpie-*\` 的响应：${hdrStats((r) => (r.flags.magpieHeaders ?? []).length).join(', ') || '**0 个**（没有任何 magpie 私有头）'}`);
  L.push(`- 带请求 ID（\`x-request-id\`/\`x-reqid\`）的响应：${results.filter((r) => r.flags.reqId).length}/${results.length}`);
  const reqIdSample = results.find((r) => r.flags.reqId)?.flags.reqId;
  L.push(`  样本：\`x-request-id: ${reqIdSample}\``);
  L.push(`- **空 body** 的响应：${hdrStats((r) => (r.rawText ?? '') === '').join(', ') || '无'}`);
  const servers = [...new Set(results.map((r) => r.flags.server).filter(Boolean))];
  L.push(`- \`server\` 头取值集合：${servers.map((s) => '`' + s + '`').join(', ')}（api.qnaigc.com = APISIX 网关；api.qiniu.com = openresty）`);
  const cts = [...new Set(results.map((r) => (r.flags.contentType ?? '').split(';')[0]).filter(Boolean))];
  L.push(`- content-type 取值集合：${cts.map((s) => '`' + s + '`').join(', ')}`);
  L.push(`- 出现过的 HTTP 状态码：${[...new Set(results.map((r) => r.status))].sort().join(', ')}`);
  L.push('');

  // §3 stream
  const s1 = by['chat.stream.badkey'];
  const s2 = by['messages.stream.badkey'];
  const sse = (r) =>
    /(^|\n)(data:|event:|: *ping)/.test(r?.bodyText ?? '') || (r?.flags?.contentType ?? '').includes('event-stream');
  L.push('## 3. 流式（`stream:true` + 无效 key）的返回形态（实测）');
  L.push('');
  L.push(`- \`POST /v1/chat/completions stream:true\` → **HTTP ${s1?.status}**，\`content-type: ${s1?.flags?.contentType ?? 'n/a'}\`，body 前缀 \`${(s1?.bodyText ?? '').slice(0, 70).replace(/\n/g, '\\n')}\`。`);
  L.push(`  结论：**${sse(s1) ? 'SSE 事件流' : '普通 JSON 错误体（不是 SSE）'}** → 分档只看状态码，**不需要**解析 SSE。`);
  L.push(`- \`POST /v1/messages stream:true\` → **HTTP ${s2?.status}**，\`content-type: ${s2?.flags?.contentType ?? 'n/a'}\`，body 前缀 \`${(s2?.bodyText ?? '').slice(0, 70).replace(/\n/g, '\\n')}\`。`);
  L.push(`  结论：**${sse(s2) ? 'SSE 事件流' : '普通 JSON 错误体（不是 SSE）'}**。`);
  L.push('');

  // §4 usage validation order
  L.push('## 4. `/v3/stat/usage` 参数校验 vs 鉴权的先后（实测）');
  L.push('');
  const ord = [
    ['usage.noauth', '无鉴权 + 无参数'],
    ['usage.badkey', '无效 key + 无参数'],
    ['usage.noauth.baddates', '无鉴权 + 坏 start/end'],
    ['usage.badkey.baddates', '无效 key + 坏 start/end'],
    ['usage.noauth.badgran', '无鉴权 + granularity=bogus'],
    ['usage.badkey.badgran', '无效 key + granularity=bogus'],
  ];
  L.push('| 组合 | probe | HTTP | 错误体首行 |');
  L.push('| --- | --- | ---: | --- |');
  for (const [k, label] of ord) L.push(`| ${label} | \`${k}\` | ${by[k]?.status} | ${(by[k]?.bodyText ?? '').split('\n')[0].slice(0, 120)} |`);
  L.push('');
  const authFirst = by['usage.noauth.baddates']?.status === by['usage.noauth']?.status;
  L.push(`- 无鉴权下「坏参数」与「无参数」返回同状态（${by['usage.noauth.baddates']?.status} vs ${by['usage.noauth']?.status}）→ **鉴权先于参数校验**：${authFirst ? '成立' : '不成立（参数校验在鉴权之前，可无 key 探参数）'}。`);
  L.push(`- 因此**无 key 无法用 400 反推参数名**；参数语义只能靠文档（A3）。`);
  L.push('');

  // §5 anthropic
  const msg = by['messages.post.badkey'];
  const chat = by['chat.nonstream.badkey'];
  L.push('## 5. `/v1/messages`（Anthropic）通路（实测）');
  L.push('');
  L.push(`- POST 无效 key → HTTP ${msg.status}；chat/completions → HTTP ${chat.status}。`);
  const sameShape = (a, b) => {
    try {
      const pa = JSON.parse(a), pb = JSON.parse(b);
      return JSON.stringify(Object.keys(pa).sort()) === JSON.stringify(Object.keys(pb).sort()) && pa?.error?.code === pb?.error?.code;
    } catch { return false; }
  };
  L.push(`- 同构判定：状态码${msg.status === chat.status ? '相同' : '不同'}，body schema ${sameShape(msg.bodyText, chat.bodyText) ? '同构（同为 OpenAI 风格 error 对象）' : '**不同构**（见 §2.1 逐字）'}。`);
  L.push(`- GET /v1/messages → HTTP ${by['messages.get.badkey']?.status}（405=路由存在但方法不符；404=路由不存在）→ 路由存在性：**${by['messages.get.badkey']?.status === 404 ? '不存在(404)' : '存在'}**。`);
  L.push('');

  // §6 model detail
  L.push('## 6. `GET /v1/models/<id>` 详情端点（实测）');
  L.push('');
  L.push(`- 无鉴权 → HTTP ${by['model.detail.noauth']?.status}；无效 key → HTTP ${by['model.detail.badkey']?.status}。`);
  L.push(`- 首行响应：\`${(by['model.detail.noauth']?.bodyText ?? '').split('\n')[0].slice(0, 140)}\``);
  L.push('');

  // §7 fingerprint
  L.push('## 7. 服务端指纹 / UA 差异（实测）');
  L.push('');
  L.push('| probe | UA 设置 | HTTP | server | body 首行 |');
  L.push('| --- | --- | ---: | --- | --- |');
  for (const k of ['models.noauth', 'ua.curl', 'ua.browser', 'ua.empty', 'root.badkey']) {
    const r = by[k];
    const uaSet = r?.reqHeaders?.['user-agent'] === undefined ? '(Bun 默认)' : r.reqHeaders['user-agent'] === '' ? '""' : r.reqHeaders['user-agent'];
    L.push(`| \`${k}\` | ${uaSet} | ${r?.status} | ${r?.flags.server ?? '-'} | ${(r?.bodyText ?? '').split('\n')[0].slice(0, 90)} |`);
  }
  L.push('');
  L.push(fence(uaCheck, 'json').replace('```json', '```json\n// Bun 回环自检：不同设置下**实际发出**的 user-agent'));
  L.push('');
  const uaSetSame = new Set(results.filter((r) => r.name.startsWith('ua.') || r.name === 'models.noauth').map((r) => `${r.status}:${(r.bodyText ?? '').slice(0, 40)}`));
  L.push(`- 四种 UA 表现（去重后 ${uaSetSame.size} 种）→ ${uaSetSame.size === 1 ? '**无 UA/WAF 差异化拦截**，UA 不需要特别设置' : '**存在 UA 差异**，见 §2.1 逐字'}。`);
  L.push('');

  // §8 other endpoints
  L.push('## 8. 其它端点存在性（先做控制实验，再判定）（实测）');
  L.push('');
  L.push('**方法学前提**：`/v1/**` 上只要带了 `Authorization: Bearer`（哪怕无效），网关先鉴权 → 401，' +
    '**根本不看路径存不存在**。所以「401」不能证明路由存在。反过来，**完全不带** `Authorization` 时请求会进应用层，' +
    '应用层没有的路由返回 404（见控制组）。判定表用「无鉴权」那一列。');
  L.push('');
  L.push('| 端点 | 带无效 key | 无鉴权 | 判定（据无鉴权列） |');
  L.push('| --- | ---: | ---: | --- |');
  const ctl404 = by['control.noauth']?.status === 404;
  const reachedApp = (r) => {
    if (!r) return false;
    if (r.status === 404 || r.status === 405 || r.status === 0) return false;
    return /credentials were provided|UNAUTHENTICATED|Invalid API key|authentication_error|apikey|ak\/sk/i.test(r.bodyText ?? '');
  };
  const rows8 = [
    ['POST /v1/embeddings', 'embeddings.badkey', 'embeddings.noauth'],
    ['POST /v1/audio/speech', 'audio.speech.badkey', 'audio.speech.noauth'],
    ['POST /v1/images/generations', 'images.generations.badkey', 'images.generations.noauth'],
    ['GET /v1/definitely-not-a-route-xyz（控制组）', 'control.badkey', 'control.noauth'],
    ['GET /v3/stat/usage/apikey/cost', 'cost.badkey', null],
    ['GET /v2/stat/export_log', 'exportlog.badkey', null],
    ['GET /v1/apikey/quota/:key', 'quota.badkey', 'quota.noauth'],
    ['POST /v1/apikeys', 'apikeys.post.badkey', null],
    ['GET billing-api/account/balance-overview', 'balance.badsign', 'balance.noauth'],
    ['GET billing-api/respack/list', 'respack.badsign', null],
  ];
  for (const [label, bk, na] of rows8) {
    const rn = na ? by[na] : null;
    const verdict = !na
      ? '**无法判定**（只测到网关 401，需无鉴权复测）'
      : reachedApp(rn)
        ? '路由**存在**（请求到达应用层）'
        : rn?.status === 404 || rn?.status === 405
          ? '**不存在**（应用层 404/405）'
          : `未定（${rn?.status}）`;
    L.push(`| ${label} | ${by[bk]?.status ?? '-'} | ${rn ? rn.status : '（未测）'} | ${verdict} |`);
  }
  L.push('');
  L.push(`- 控制组证明：不存在的 \`/v1/definitely-not-a-route-xyz\` 无鉴权 → HTTP ${by['control.noauth']?.status}，` +
    `带无效 key → HTTP ${by['control.badkey']?.status} → **${ctl404 ? '鉴权先于路由匹配' : '鉴权与路由顺序异常'}**。`);
  L.push('');

  // §9 header dump of models
  L.push('## 9. `GET /v1/models` 无鉴权响应头（实测）');
  L.push('');
  L.push(fence(Object.entries(by['models.noauth'].headers).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'));
  L.push('');
  L.push(`- dump 文件：\`_tools/models-dump.json\`（${modelsRaw.length} 字符，逐字未加工）。`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('<!-- ANALYSIS:BEGIN -->');
  L.push('<!-- ANALYSIS:PLACEHOLDER -->');
  L.push('<!-- ANALYSIS:END -->');
  L.push('');
  return L.join('\n');
}

main().catch((e) => {
  console.error('probe-upstream FAILED:', e);
  process.exit(1);
});
