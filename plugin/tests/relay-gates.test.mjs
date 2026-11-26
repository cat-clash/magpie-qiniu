import test from "node:test";
import assert from "node:assert/strict";
import { forwardChat } from "../src/relay.mjs";
import { createPacing } from "../src/pacing.mjs";
import { createBreaker } from "../src/breaker.mjs";

const SECRET = "sk-" + "GateTest0123456";
const URL = "https://api.qnaigc.com/v1/chat/completions";

function makeBreaker(threshold = 2) {
  let t = 1_000_000;
  const breaker = createBreaker({ threshold, cooldownMs: 60_000, now: () => t, random: () => 0.5 });
  return { breaker, advance: (ms) => (t += ms) };
}

function makePacing() {
  const slept = [];
  const pacing = createPacing({ minMs: 100, jitterMs: 0, now: () => 1_000_000, sleep: async (ms) => slept.push(ms) });
  return { pacing, slept };
}

const okResponse = () => new Response("data: {}\n\n", { status: 200 });

test("熔断打开时直接本地拒绝，一个字节都不打上游", async () => {
  const { breaker } = makeBreaker(1);
  breaker.record("acc-1", false);
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      return okResponse();
    },
    options: { breaker, accountKey: "acc-1" },
  });
  assert.equal(calls, 0, "熔断期间不该再发请求");
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal((await res.json()).error.code, "breaker_open");
});

test("熔断按账号分桶：A 号熔断时 B 号照常出网", async () => {
  const { breaker } = makeBreaker(1);
  breaker.record("acc-a", false);
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      return okResponse();
    },
    options: { breaker, accountKey: "acc-b" },
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
});

test("出网前会过节奏闸，且用的是同一个账号桶", async () => {
  const { pacing, slept } = makePacing();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse();
  };
  for (let i = 0; i < 3; i += 1) {
    await forwardChat({ url: URL, headers: new Headers(), apiKey: SECRET, timeoutMs: 5000, fetchImpl, options: { pacing, accountKey: "acc-1" } });
  }
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 200], "同一账号后两次要被间隔闸拦住");
});

test("传输层错误重试一次，成功即返回 200", async () => {
  const { breaker } = makeBreaker(5);
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return okResponse();
    },
    options: { breaker, accountKey: "acc-1" },
  });
  assert.equal(calls, 2, "网络错误应重发一次");
  assert.equal(res.status, 200);
});

test("连续两次传输层错误：502，且记为一次账号失败", async () => {
  const { breaker } = makeBreaker(2);
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
    options: { breaker, accountKey: "acc-1" },
  });
  assert.equal(calls, 2);
  assert.equal(res.status, 502);
  assert.equal(breaker.state("acc-1").failures, 1);
});

test("retryOnNetworkError=false 时不重试", async () => {
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
    options: { retryOnNetworkError: false },
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 502);
});

test("取消（AbortError）不重试，直接回 499", async () => {
  let calls = 0;
  const res = await forwardChat({
    url: URL,
    headers: new Headers(),
    apiKey: SECRET,
    timeoutMs: 5000,
    fetchImpl: async () => {
      calls += 1;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
    options: { retryOnNetworkError: true },
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 499);
});

test("上游 429 记为账号失败，够阈值就熔断", async () => {
  const { breaker } = makeBreaker(2);
  const fetchImpl = async () => new Response("UID rate limit reached for TPM for UID", { status: 429 });
  for (let i = 0; i < 2; i += 1) {
    await forwardChat({ url: URL, headers: new Headers(), apiKey: SECRET, timeoutMs: 5000, fetchImpl, options: { breaker, accountKey: "acc-1" } });
  }
  assert.ok(breaker.blockedFor("acc-1") > 0, "两次 429 后该账号应处于熔断");
});

test("模型级 404（未标价）不算账号失败，反而把账号记成健康", async () => {
  const { breaker } = makeBreaker(2);
  breaker.record("acc-1", false); // 先挂一笔失败
  const fetchImpl = async () => new Response("the price of the model is not set", { status: 503 });
  const res = await forwardChat({ url: URL, headers: new Headers(), apiKey: SECRET, timeoutMs: 5000, fetchImpl, options: { breaker, accountKey: "acc-1" } });
  assert.equal(res.status, 404);
  assert.equal(breaker.state("acc-1").failures, 0, "模型问题应清零账号失败计数");
  assert.equal(breaker.blockedFor("acc-1"), 0);
});

test("401 记为账号失败并保留 expired 标记", async () => {
  const { breaker } = makeBreaker(1);
  const fetchImpl = async () => new Response("Invalid API key", { status: 401 });
  const res = await forwardChat({ url: URL, headers: new Headers(), apiKey: SECRET, timeoutMs: 5000, fetchImpl, options: { breaker, accountKey: "acc-1" } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("x-magpie-sign-in"), "expired");
  assert.ok(breaker.blockedFor("acc-1") > 0);
});
