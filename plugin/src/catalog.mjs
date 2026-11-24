// plugin/src/catalog.mjs · 七牛 AI 推理（api.qnaigc.com）模型静态目录
// 纯常量、零 import、零联网；判定与置信度全部在生成期完成（规则见 docs/model-catalog.md）。
//
// 数据来源（2026-11-25 Asia/Singapore 实测，A4）：
//   [上游] GET https://api.qnaigc.com/v1/models 无鉴权 200，data 共 91 条
//         → 原始响应另存 research/models-live.json；id/context_length/max_tokens/service_status 逐条照抄。
//   [文档] https://www.qiniu.com/ai/models 的 __NEXT_DATA__.props.pageProps.models（124 张卡片，
//         本目录 91/91 命中）→ architecture.input_modalities/reasoning.supported/
//         function_calling.supported、features 标签、hot_tags 免费标签、pricing_rules_v2 单价。
// 与主控 plugin/src/models.mjs 的字段约定：{id,name,context,output,vision,reasoning,free,rate,toolCall,note} —— 字段名不可改。

export const K = 1024;

// 上游 max_tokens=0 的语义是「未公布上限」，不是「不许输出」。直接抄成 limit.output=0 会让宿主把模型
// 判成 0 token 预算：列表里不可选，且每次请求都因剩余预算为 0 立刻中止（CONTRACT §1 明令禁止）。
// 为什么取 8192：① 它是上游实测出现过的真实档位（91 条里 max_tokens 的最小非零档是 4096，共 3 条，8192 档 1 条，
//   中位 128000），落在「不会大于任何已知档位太多」的安全区；② 写大了会让上游以 max_tokens 超限回 400，写小了
//   只截断输出，所以取小档而不用 DEFAULT 中位；③ 它只用于宿主算预算/显示，真正发请求时带 upstream-0 标记的条目
//   建议干脆不发 max_tokens，让服务端用自带默认（见 docs/model-catalog.md「上游字段与我们的映射」）。
// 受影响的 6 条：qwen-turbo / qwen-vl-max-2025-01-25 / qwen3-30b-a3b / z-ai/glm-4.5-air-free /
//   deepseek/deepseek-v4-flash-20260731 / qwen3-32b（文档卡片 max_completion_tokens 同为 0，无第二来源可校准）。
// context 同理：上游有 1 条 context_length=0（z-ai/glm-4.5-air-free），回退 128K，与七牛控制台口径一致。
export const DEFAULT_LIMITS = { context: 128 * K, output: 8192 };

// 上游实测计数（来源：research/models-live.json，2026-11-25 抓取）。测试用它做交叉校验，不要手改。
export const UPSTREAM_FACTS = {
  FETCHED_AT: "2026-11-25", SOURCE: "https://api.qnaigc.com/v1/models",
  TOTAL: 91, ZERO_MAX_TOKENS: 6, ZERO_CONTEXT_LENGTH: 1, UNAVAILABLE: 4, DOC_CARD_HITS: 91,
};

/** note 标记字典（供 models.mjs / 诊断页 regex；多个标记用 ; 连接）：
 *  upstream-0        上游 max_tokens=0，output 已用 DEFAULT_LIMITS.output 回退
 *  ctx-0             上游 context_length=0，context 已用 DEFAULT_LIMITS.context 回退
 *  status=<值>       上游 service_status≠available（同步进 HIDDEN_IDS）
 *  retiring=<日期>   文档退役时间在 2026-11-25 之后，现在还能用
 *  etd-past=<日期>   文档退役日期已过但上游仍 available —— 七牛没按文档下线，别据此隐藏
 *  out>ctx           上游 max_tokens > context_length，发请求前必须夹到 context 内
 *  free-no-id-mark   文档标「限时免费」但 id 里没有 free 字样（只靠 id regex 判免费会漏）
 *  name-vision-fp    id 里的 v\d+-pro 之类看着像视觉模型，文档证明只吃文本
 *  no-tools          文档 function_calling.supported=false 且无「工具调用」标签
 *  in:audio / in:file 输入模态含音频/文件，vision 位表达不了，modalities 要按文档另写 */
export const CATALOG = [
  {"id":"meituan/longcat-flash-lite","name":"LongCat Flash Lite","context":256000,"output":320000,"vision":false,"reasoning":true,"free":true,"rate":0,"toolCall":true,"note":"etd-past=2026-06-02;out>ctx;free-no-id-mark"},
  {"id":"qwen3-vl-30b-a3b-thinking","name":"Qwen3 VL 30B A3B Thinking","context":128000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"doubao-1.5-pro-32k","name":"Doubao 1.5 Pro 32K","context":128000,"output":12000,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-14"},
  {"id":"doubao-1.5-vision-pro","name":"Doubao 1.5 Vision Pro","context":128000,"output":16000,"vision":true,"reasoning":false,"free":false,"rate":1,"toolCall":false,"note":"etd-past=2026-03-31;no-tools"},
  {"id":"glm-4.5","name":"GLM 4.5","context":131072,"output":98304,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-02"},
  {"id":"kimi-k2","name":"Kimi K2","context":128000,"output":128000,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-05-27"},
  {"id":"qwen-turbo","name":"Qwen Turbo","context":1000000,"output":8192,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"upstream-0;etd-past=2026-07-08"},
  {"id":"qwen-vl-max-2025-01-25","name":"Qwen VL Max 2025-01-25","context":128000,"output":8192,"vision":true,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"upstream-0;etd-past=2026-07-08;in:audio"},
  {"id":"qwen2.5-vl-72b-instruct","name":"Qwen 2.5 VL 72B Instruct","context":128000,"output":8192,"vision":true,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-06-02;in:audio"},
  {"id":"qwen3-235b-a22b","name":"Qwen 3 235B A22B","context":128000,"output":32000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-04"},
  {"id":"qwen3-30b-a3b","name":"Qwen3 30B A3B","context":40000,"output":8192,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"upstream-0;etd-past=2026-07-07"},
  {"id":"qwen3-235b-a22b-instruct-2507","name":"Qwen3 235B A22B Instruct 2507","context":262144,"output":64000,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-04"},
  {"id":"qwen3-235b-a22b-thinking-2507","name":"Qwen3 235B A22B Thinking 2507","context":262144,"output":4096,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-04"},
  {"id":"deepseek-v3","name":"DeepSeek V3","context":128000,"output":16000,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"status=unavailable;etd-past=2026-10-09"},
  {"id":"qwen3-coder-480b-a35b-instruct","name":"Qwen3 Coder 480B A35B Instruct","context":262000,"output":4096,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"doubao-seed-1.6","name":"Doubao Seed 1.6","context":256000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-14"},
  {"id":"doubao-seed-1.6-flash","name":"Doubao Seed 1.6 Flash","context":256000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-03-31"},
  {"id":"doubao-seed-1.6-thinking","name":"Doubao Seed 1.6 Thinking","context":256000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-03-31"},
  {"id":"deepseek-v3.1","name":"DeepSeek V3.1","context":128000,"output":32000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"status=unavailable;etd-past=2026-08-04"},
  {"id":"qwen3-next-80b-a3b-thinking","name":"Qwen3 Next 80B A3B Thinking","context":131072,"output":32768,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-09"},
  {"id":"qwen3-next-80b-a3b-instruct","name":"Qwen3 Next 80B A3B Instruct","context":131072,"output":32768,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"deepseek/deepseek-v3.2-exp-thinking","name":"DeepSeek V3.2 Exp Thinking","context":128000,"output":32000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"status=unavailable;etd-past=2026-07-16"},
  {"id":"z-ai/glm-4.6","name":"GLM 4.6","context":200000,"output":200000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-06-30"},
  {"id":"moonshotai/kimi-k2-thinking","name":"Kimi K2 Thinking","context":256000,"output":100000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-01"},
  {"id":"deepseek/deepseek-v3.2-251201","name":"DeepSeek V3.2 251201","context":128000,"output":32000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"status=unavailable;etd-past=2026-09-29"},
  {"id":"z-ai/glm-4.7","name":"GLM 4.7","context":200000,"output":200000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-06-30"},
  {"id":"qwen3-30b-a3b-thinking-2507","name":"Qwen3 30B A3B Thinking 2507","context":126000,"output":32000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"z-ai/glm-4.5-air-free","name":"GLM 4.5 Air Free","context":131072,"output":8192,"vision":false,"reasoning":true,"free":true,"rate":0,"toolCall":true,"note":"upstream-0;ctx-0;etd-past=2026-06-25"},
  {"id":"tencent/hy3-preview","name":"Hy3 Preview","context":262144,"output":262144,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-31"},
  {"id":"qwen/qwen3.6-27b","name":"Qwen3.6 27B","context":262100,"output":262100,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-14"},
  {"id":"deepseek/deepseek-v4-flash-202605","name":"DeepSeek V4 Flash 202605","context":1000000,"output":384000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-18"},
  {"id":"nvidia/nemotron-3-ultra-550b-a55b0-free","name":"Nemotron 3 Ultra 550B A55B Free","context":1000000,"output":128000,"vision":false,"reasoning":true,"free":true,"rate":0,"toolCall":true,"note":""},
  {"id":"moonshotai/kimi-k3-free","name":"Kimi K3 Free","context":1048576,"output":1048576,"vision":true,"reasoning":true,"free":true,"rate":0,"toolCall":true,"note":"etd-past=2026-10-27"},
  {"id":"z-ai/glm-5.1","name":"GLM 5.1","context":200000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"moonshotai/kimi-k2.6","name":"Kimi K2.6","context":262000,"output":262000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"deepseek/deepseek-v4-flash","name":"DeepSeek V4 Flash","context":1000000,"output":384000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-25"},
  {"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro","context":1000000,"output":384000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-25;name-vision-fp"},
  {"id":"qwen/qwen3.7-max","name":"Qwen3.7 Max","context":1000000,"output":64000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"minimax/minimax-m3","name":"MiniMax M3","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"deepseek/deepseek-v4-pro-202606","name":"DeepSeek V4 Pro 202606","context":1000000,"output":384000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-18;name-vision-fp"},
  {"id":"moonshotai/kimi-k2.7-code","name":"Kimi K2.7 Code","context":262144,"output":262144,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"z-ai/glm-5.2","name":"GLM 5.2","context":1000000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qwen/qwen3.7-plus","name":"Qwen3.7 Plus","context":1000000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:audio"},
  {"id":"bytedance/doubao-seed-2-1-pro","name":"Doubao Seed 2.1 Pro","context":256000,"output":256000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"bytedance/doubao-seed-2-1-turbo","name":"Doubao Seed 2.1 Turbo","context":256000,"output":256000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"stepfun/step-3.7-flash","name":"Step 3.7 Flash","context":256000,"output":256000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-23"},
  {"id":"moonshotai/kimi-k3","name":"Kimi K3","context":1048576,"output":1048576,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"deepseek/deepseek-v4-flash-20260731","name":"DeepSeek V4 Flash 2026-07-31","context":1000000,"output":8192,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"upstream-0"},
  {"id":"qwen/qwen3.8-max","name":"Qwen3.8 Max","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"deepseek/deepseek-v4-pro-0813","name":"DeepSeek V4 Pro 0813","context":1000000,"output":384000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"name-vision-fp"},
  {"id":"z-ai/glm-5.3","name":"GLM 5.3","context":1000000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"deepseek/deepseek-v4-flash-vision-exp","name":"DeepSeek V4 Flash Vision Exp","context":1000000,"output":384000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-25"},
  {"id":"qwen/qwen3.8-flash-next","name":"Qwen3.8 Flash","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"z-ai/glm-5.3-flash","name":"GLM 5.3 Flash","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:file"},
  {"id":"tencent/hy4-preview","name":"Hy4 Preview","context":1000000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"retiring=2026-12-07"},
  {"id":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","context":1000000,"output":384000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qwen/qwen3.7-flash","name":"Qwen3.7 Flash","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"xiaomi/mimo-v2.6-pro","name":"MiMo V2.6 Pro","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:audio"},
  {"id":"xiaomi/mimo-v2.6-flash","name":"MiMo V2.6 Flash","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:audio"},
  {"id":"bytedance/doubao-seed-2-1-lite","name":"Doubao Seed 2.1 Lite","context":1024000,"output":256000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:audio"},
  {"id":"qwen/qwen3.8-omni-flash","name":"Qwen3.8 Omni Flash","context":1000000,"output":131072,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"in:audio"},
  {"id":"deepseek/deepseek-v4.1-flash-1017","name":"DeepSeek V4.1 Flash 1017","context":1000000,"output":384000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"minimax/minimax-m3.1-flash","name":"MiniMax M3.1 Flash","context":1000000,"output":512000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qiniu/conatus-free","name":"Conatus Free","context":1000000,"output":128000,"vision":true,"reasoning":true,"free":true,"rate":0,"toolCall":true,"note":""},
  {"id":"moonshotai/kimi-k3.1-pro","name":"Kimi K3.1 Pro","context":1048576,"output":1048576,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"moonshotai/kimi-k3.1-pro-highspeed","name":"Kimi K3.1 Pro HighSpeed","context":1048576,"output":1048576,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"tencent/hy4","name":"Hy4","context":1000000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"sensenova/sensenova-6.8-flash","name":"SenseNova 6.8 Flash","context":1048576,"output":131072,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"sensenova/sensenova-6.8-flash-lite","name":"SenseNova 6.8 Flash Lite","context":262144,"output":65536,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qwen/qwen4-max","name":"Qwen4 Max","context":1000000,"output":393000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"tencent/hy4-flash","name":"Hy4 Flash","context":1000000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"z-ai/glm-5","name":"GLM 5","context":200000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"minimax/minimax-m2.5","name":"MiniMax M2.5","context":204800,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"minimax/minimax-m2.5-highspeed","name":"MiniMax M2.5 HighSpeed","context":204800,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-23"},
  {"id":"doubao-seed-2.0-code","name":"Doubao Seed 2.0 Code","context":256000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-11-24"},
  {"id":"doubao-seed-2.0-pro","name":"Doubao Seed 2.0 Pro","context":256000,"output":128000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-11-24"},
  {"id":"doubao-seed-2.0-mini","name":"Doubao Seed 2.0 Mini","context":256000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"doubao-seed-2.0-lite","name":"Doubao Seed 2.0 Lite","context":256000,"output":32000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qwen3.5-397b-a17b","name":"Qwen3.5 397B A17B","context":256000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"minimax/minimax-m2.7","name":"MiniMax M2.7","context":204800,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"MiniMax-M1","name":"MiniMax M1","context":1000000,"output":80000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-10-23"},
  {"id":"qwen-max-2025-01-25","name":"Qwen2.5 Max 2025-01-25","context":128000,"output":4096,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-05-30"},
  {"id":"qwen3-32b","name":"Qwen3 32B","context":40000,"output":8192,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"upstream-0;etd-past=2026-07-07"},
  {"id":"qwen3-max-preview","name":"Qwen3 Max Preview","context":256000,"output":64000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"qwen3-max","name":"Qwen3 Max","context":262144,"output":65536,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"minimax/minimax-m2","name":"MiniMax M2","context":200000,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-01"},
  {"id":"minimax/minimax-m2.1","name":"MiniMax M2.1","context":204800,"output":128000,"vision":false,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-01"},
  {"id":"moonshotai/kimi-k2.5","name":"Kimi K2.5","context":256000,"output":256000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-08-31"},
  {"id":"qwen3-30b-a3b-instruct-2507","name":"Qwen3 30B A3B Instruct 2507","context":128000,"output":32000,"vision":false,"reasoning":false,"free":false,"rate":1,"toolCall":true,"note":"etd-past=2026-07-07"},
  {"id":"qwen/qwen3.5-plus","name":"Qwen3.5 Plus","context":1000000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
  {"id":"qwen/qwen3.6-plus","name":"Qwen3.6 Plus","context":1000000,"output":64000,"vision":true,"reasoning":true,"free":false,"rate":1,"toolCall":true,"note":""},
];

/** 免费条目：id 含 free ∪ 文档 hot_tags 含「免费/限时免费」∪ 全部单价=0。rate 一律给 0，free 是关键位
 *  （主控把 rate=0 当「未给折扣」，所以判免费只能看这里）。 */
export const FREE_IDS = new Set([
  "meituan/longcat-flash-lite","z-ai/glm-4.5-air-free","nvidia/nemotron-3-ultra-550b-a55b0-free","moonshotai/kimi-k3-free",
  "qiniu/conatus-free"
]);

/** 推理/思考位：文档 reasoning.supported=true ∪ features 含「深度思考」。 */
export const REASONING_IDS = new Set([
  "meituan/longcat-flash-lite","qwen3-vl-30b-a3b-thinking","glm-4.5","qwen-turbo",
  "qwen3-235b-a22b","qwen3-30b-a3b","qwen3-235b-a22b-thinking-2507","doubao-seed-1.6",
  "doubao-seed-1.6-flash","doubao-seed-1.6-thinking","deepseek-v3.1","qwen3-next-80b-a3b-thinking",
  "deepseek/deepseek-v3.2-exp-thinking","z-ai/glm-4.6","moonshotai/kimi-k2-thinking","deepseek/deepseek-v3.2-251201",
  "z-ai/glm-4.7","qwen3-30b-a3b-thinking-2507","z-ai/glm-4.5-air-free","tencent/hy3-preview",
  "qwen/qwen3.6-27b","deepseek/deepseek-v4-flash-202605","nvidia/nemotron-3-ultra-550b-a55b0-free","moonshotai/kimi-k3-free",
  "z-ai/glm-5.1","moonshotai/kimi-k2.6","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro",
  "qwen/qwen3.7-max","minimax/minimax-m3","deepseek/deepseek-v4-pro-202606","moonshotai/kimi-k2.7-code",
  "z-ai/glm-5.2","qwen/qwen3.7-plus","bytedance/doubao-seed-2-1-pro","bytedance/doubao-seed-2-1-turbo",
  "stepfun/step-3.7-flash","moonshotai/kimi-k3","deepseek/deepseek-v4-flash-20260731","qwen/qwen3.8-max",
  "deepseek/deepseek-v4-pro-0813","z-ai/glm-5.3","deepseek/deepseek-v4-flash-vision-exp","qwen/qwen3.8-flash-next",
  "z-ai/glm-5.3-flash","tencent/hy4-preview","deepseek/deepseek-v4.1-flash","qwen/qwen3.7-flash",
  "xiaomi/mimo-v2.6-pro","xiaomi/mimo-v2.6-flash","bytedance/doubao-seed-2-1-lite","qwen/qwen3.8-omni-flash",
  "deepseek/deepseek-v4.1-flash-1017","minimax/minimax-m3.1-flash","qiniu/conatus-free","moonshotai/kimi-k3.1-pro",
  "moonshotai/kimi-k3.1-pro-highspeed","tencent/hy4","sensenova/sensenova-6.8-flash","sensenova/sensenova-6.8-flash-lite",
  "qwen/qwen4-max","tencent/hy4-flash","z-ai/glm-5","minimax/minimax-m2.5",
  "minimax/minimax-m2.5-highspeed","doubao-seed-2.0-code","doubao-seed-2.0-pro","doubao-seed-2.0-mini",
  "doubao-seed-2.0-lite","qwen3.5-397b-a17b","minimax/minimax-m2.7","MiniMax-M1",
  "qwen-max-2025-01-25","qwen3-32b","qwen3-max-preview","qwen3-max",
  "minimax/minimax-m2","minimax/minimax-m2.1","moonshotai/kimi-k2.5","qwen/qwen3.5-plus",
  "qwen/qwen3.6-plus"
]);

/** 视觉位：文档 input_modalities 含 image|video ∪ features 含 图像理解/视频理解/全模态理解。 */
export const VISION_IDS = new Set([
  "qwen3-vl-30b-a3b-thinking","doubao-1.5-vision-pro","qwen-vl-max-2025-01-25","qwen2.5-vl-72b-instruct",
  "doubao-seed-1.6","doubao-seed-1.6-flash","doubao-seed-1.6-thinking","qwen/qwen3.6-27b",
  "moonshotai/kimi-k3-free","moonshotai/kimi-k2.6","minimax/minimax-m3","moonshotai/kimi-k2.7-code",
  "qwen/qwen3.7-plus","bytedance/doubao-seed-2-1-pro","bytedance/doubao-seed-2-1-turbo","stepfun/step-3.7-flash",
  "moonshotai/kimi-k3","qwen/qwen3.8-max","deepseek/deepseek-v4-flash-vision-exp","qwen/qwen3.8-flash-next",
  "z-ai/glm-5.3-flash","deepseek/deepseek-v4.1-flash","qwen/qwen3.7-flash","xiaomi/mimo-v2.6-pro",
  "xiaomi/mimo-v2.6-flash","bytedance/doubao-seed-2-1-lite","qwen/qwen3.8-omni-flash","deepseek/deepseek-v4.1-flash-1017",
  "minimax/minimax-m3.1-flash","qiniu/conatus-free","moonshotai/kimi-k3.1-pro","moonshotai/kimi-k3.1-pro-highspeed",
  "tencent/hy4","sensenova/sensenova-6.8-flash","sensenova/sensenova-6.8-flash-lite","qwen/qwen4-max",
  "tencent/hy4-flash","doubao-seed-2.0-code","doubao-seed-2.0-pro","doubao-seed-2.0-mini",
  "doubao-seed-2.0-lite","qwen3.5-397b-a17b","moonshotai/kimi-k2.5","qwen/qwen3.5-plus",
  "qwen/qwen3.6-plus"
]);

/** 上游 service_status≠available 的 4 条（实测唯一非 available 取值就是 "unavailable"），一律隐藏。 */
export const HIDDEN_IDS = new Set([
  "deepseek-v3","deepseek-v3.1","deepseek/deepseek-v3.2-exp-thinking","deepseek/deepseek-v3.2-251201"
]);

/** 文档明确不支持工具调用的条目（toolCall=false 的全集），models.mjs 不要给它们挂 tool_call。 */
export const NO_TOOL_IDS = new Set([
  "doubao-1.5-vision-pro"
]);

/** 文档 model_alias → 上游 id。给 models.mjs 的 ALIASES 当原料；本模块的 catalogEntry 只做精确查表。 */
export const DOC_ALIASES = {
 "moonshotai/kimi-k2": "kimi-k2",
 "aliyun/qwen-turbo": "qwen-turbo",
 "deepseek/deepseek-v3.2": "deepseek/deepseek-v3.2-exp-thinking",
 "deepseek-v3.2-251201": "deepseek/deepseek-v3.2-251201",
 "deepseek-v4-flash-202605": "deepseek/deepseek-v4-flash-202605",
 "glm-5.1": "z-ai/glm-5.1",
 "kimi-k2.6": "moonshotai/kimi-k2.6",
 "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
 "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
 "deepseek-v4-pro-202606": "deepseek/deepseek-v4-pro-202606",
 "kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
 "glm-5.2": "z-ai/glm-5.2",
 "doubao-seed-2-1-pro": "bytedance/doubao-seed-2-1-pro",
 "doubao-seed-2.1-pro": "bytedance/doubao-seed-2-1-pro",
 "doubao-seed-2-1-turbo": "bytedance/doubao-seed-2-1-turbo",
 "doubao-seed-2.1-turbo": "bytedance/doubao-seed-2-1-turbo",
 "step-3.7-flash": "stepfun/step-3.7-flash",
 "kimi-k3": "moonshotai/kimi-k3",
 "deepseek-v4-flash-20260731": "deepseek/deepseek-v4-flash-20260731",
 "deepseek-v4-flash-0731": "deepseek/deepseek-v4-flash-20260731",
 "deepseek-v4-pro-0813": "deepseek/deepseek-v4-pro-0813",
 "deepseek-v4-pro-20260813": "deepseek/deepseek-v4-pro-0813",
 "deepseek/deepseek-v4-pro-20260813": "deepseek/deepseek-v4-pro-0813",
 "glm-5.3": "z-ai/glm-5.3",
 "GLM-5.3": "z-ai/glm-5.3",
 "qwen3.8-flash-next": "qwen/qwen3.8-flash-next",
 "qwen3.8-flash": "qwen/qwen3.8-flash-next",
 "qwen/qwen3.8-flash": "qwen/qwen3.8-flash-next",
 "glm-5.3-flash": "z-ai/glm-5.3-flash",
 "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
 "qwen3.7-flash": "qwen/qwen3.7-flash",
 "doubao-seed-2-1-lite": "bytedance/doubao-seed-2-1-lite",
 "doubao-seed-2.1-lite": "bytedance/doubao-seed-2-1-lite",
 "qwen3.8-omni-flash": "qwen/qwen3.8-omni-flash",
 "deepseek-flash": "deepseek/deepseek-v4.1-flash-1017",
 "deepseek-v4.1-flash-1017": "deepseek/deepseek-v4.1-flash-1017",
 "minimax-m3.1-flash": "minimax/minimax-m3.1-flash",
 "kimi-k3.1-pro": "moonshotai/kimi-k3.1-pro",
 "kimi-k3.1-pro-highspeed": "moonshotai/kimi-k3.1-pro-highspeed",
 "glm-5": "z-ai/glm-5",
 "minimax/minimax-m1": "MiniMax-M1",
 "aliyun/qwen3-32b": "qwen3-32b",
 "aliyun/qwen3-max": "qwen3-max",
 "minimax-m2.1": "minimax/minimax-m2.1",
 "kimi-k2.5": "moonshotai/kimi-k2.5"
};

/** 精确查表（原样 id，不做 slug 化）。查不到返回 undefined。 */
export function catalogEntry(id) {
  if (typeof id !== "string" || id === "") return undefined;
  const key = id.trim();
  for (let i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === key) return CATALOG[i];
  return undefined;
}
