/* dsh-workbuddy-usage · host half
 *
 * 宿主进程内：
 *   1. 用 Bearer API Key 拉取 workbuddy2api 面板 /panel/api/usage（跨域且面板禁止浏览器直连，
 *      所以必须由宿主拉取）；
 *   2. 在 DSH 自己的 webServer 上注册同源前缀路由 /dsh-workbuddy-usage，
 *      客户端（浏览器，127.0.0.1:43120）只需 fetch 同源路径即可拿到规范化后的 JSON。
 *
 * 配置解析顺序：环境变量 < 插件目录 config.json < 内置默认值。
 */
import { readFileSync } from "node:fs";

const CONFIG_URL = new URL("./config.json", import.meta.url);

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:7863",
  apiKey: "",
  routePrefix: "/dsh-workbuddy-usage",
  cacheTtlMs: 25000,
  accountTtlMs: 60000,
  timeoutMs: 20000,
};

const SCOPES = ["today", "7d", "30d", "all"];

function loadConfig() {
  let disk = {};
  try {
    disk = JSON.parse(readFileSync(CONFIG_URL, "utf8")) ?? {};
  } catch {
    disk = {};
  }
  const cfg = { ...DEFAULTS, ...disk };
  if (process.env.WORKBUDDY_USAGE_BASE) cfg.baseUrl = process.env.WORKBUDDY_USAGE_BASE;
  if (process.env.WORKBUDDY_USAGE_KEY) cfg.apiKey = process.env.WORKBUDDY_USAGE_KEY;
  cfg.baseUrl = String(cfg.baseUrl || "").replace(/\/+$/, "");
  cfg.routePrefix = String(cfg.routePrefix || DEFAULTS.routePrefix).replace(/\/+$/, "");
  return cfg;
}

const num = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 本地时区当天 0 点，offsetDays 为负表示往前推。 */
function startOfLocalDay(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function windowFor(scope) {
  const now = Date.now();
  if (scope === "all") {
    return { query: "hours=0", fromISO: null, toISO: new Date(now).toISOString() };
  }
  const days = scope === "7d" ? 6 : scope === "30d" ? 29 : 0;
  const from = startOfLocalDay(-days);
  const q = `from=${Math.floor(from.getTime() / 1000)}&to=${Math.floor(now / 1000)}`;
  return { query: q, fromISO: from.toISOString(), toISO: new Date(now).toISOString() };
}

function statOf(row) {
  return {
    requests: num(row?.requests),
    errors: num(row?.errors),
    promptTokens: num(row?.prompt_tokens),
    completionTokens: num(row?.completion_tokens),
    totalTokens: num(row?.total_tokens),
    credits: Math.round(num(row?.credits) * 100) / 100,
    creditTokens: num(row?.credit_tokens),
    creditsPer1M: Math.round(num(row?.credits_per_1m_tokens) * 1000) / 1000,
    cacheHitTokens: num(row?.cache_hit_tokens),
    cacheMissTokens: num(row?.cache_miss_tokens),
    cacheHitRate: Math.round(num(row?.cache_hit_rate) * 100) / 100,
    avgLatencyMs: Math.round(num(row?.avg_latency_ms)),
    tokensPerSecond: Math.round(num(row?.avg_tokens_per_second) * 10) / 10,
  };
}

function normalize(raw, scope, win) {
  const totals = statOf(raw?.totals);
  const models = (Array.isArray(raw?.by_model) ? raw.by_model : [])
    .map((m) => ({ key: String(m?.key ?? m?.model ?? "unknown"), ...statOf(m) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m) => ({ ...m, share: totals.totalTokens > 0 ? m.totalTokens / totals.totalTokens : 0 }));
  const accounts = (Array.isArray(raw?.by_account) ? raw.by_account : [])
    .map((a) => ({
      key: String(a?.extra ?? a?.key ?? "unknown"),
      realm: a?.realm ?? null,
      ...statOf(a),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const series = (Array.isArray(raw?.series) ? raw.series : []).map((p) => ({
    t: p?.t ?? null,
    requests: num(p?.requests),
    totalTokens: num(p?.total_tokens),
    credits: Math.round(num(p?.credits) * 100) / 100,
  }));
  return {
    ok: true,
    scope,
    from: win.fromISO,
    to: win.toISO,
    fetchedAt: Date.now(),
    totals,
    models,
    accounts,
    series,
    upstream: { since: raw?.since ?? null, generated: raw?.generated ?? null },
  };
}

async function fetchUsage(scope, cfg) {
  const win = windowFor(scope);
  const url = `${cfg.baseUrl}/panel/api/usage?${win.query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`上游 ${res.status}: ${text.slice(0, 200) || "(empty)"}`);
    }
    return normalize(JSON.parse(text), scope, win);
  } finally {
    clearTimeout(timer);
  }
}

function accountOf(a) {
  const tu = a?.token_usage ?? {};
  return {
    uid: String(a?.uid ?? ""),
    nickname: String(a?.nickname ?? "未命名"),
    realm: a?.realm ?? null,
    credits: Math.round(num(a?.credits) * 100) / 100,
    creditsTotal: Math.round(num(a?.credits_total) * 100) / 100,
    cooling: Boolean(a?.cooling),
    disabled: Boolean(a?.disabled),
    until: a?.until ?? null,
    reason: a?.reason ?? null,
    checkinDone: Boolean(a?.checkin_done),
    successCount: num(a?.success_count),
    lastSuccess: a?.last_success ?? null,
    lastModel: tu?.last_model ?? null,
    requests: num(tu?.request_count),
    totalTokens: num(tu?.total_tokens),
    earliestExpiry: a?.credits_earliest_expiry ?? null,
    earliestRemaining: Math.round(num(a?.credits_earliest_remaining) * 100) / 100,
  };
}

/** /panel/api/overview → 账号池剩余额度与状态。 */
function normalizeAccount(raw) {
  const rows = (Array.isArray(raw?.accounts) ? raw.accounts : []).map(accountOf);
  const credits = rows.reduce((sum, a) => sum + (a.disabled ? 0 : a.credits), 0);
  const creditsTotal = rows.reduce((sum, a) => sum + (a.disabled ? 0 : a.creditsTotal), 0);
  return {
    ok: true,
    fetchedAt: Date.now(),
    totals: {
      accounts: rows.length,
      healthy: num(raw?.healthy),
      cooling: num(raw?.cooling),
      paused: num(raw?.paused),
      disabled: num(raw?.disabled),
      credits: Math.round(credits * 100) / 100,
      creditsTotal: Math.round(creditsTotal * 100) / 100,
    },
    version: raw?.version ?? null,
    uptimeSec: num(raw?.uptime_sec),
    accounts: rows.sort((a, b) => b.credits - a.credits),
  };
}

async function fetchAccount(cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/panel/api/overview`, {
      headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`上游 ${res.status}: ${text.slice(0, 200) || "(empty)"}`);
    }
    return normalizeAccount(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

export const name = "dsh-workbuddy-usage";
export const inject = ["webServer"];

export function apply(ctx) {
  const cfg = loadConfig();
  const cache = new Map();

  async function getUsage(scope, refresh) {
    const now = Date.now();
    const hit = cache.get(scope);
    if (!refresh && hit && now - hit.at < cfg.cacheTtlMs) {
      return { ...hit.data, cacheAgeMs: now - hit.at, cached: true };
    }
    if (!cfg.apiKey) {
      return { ok: false, scope, fetchedAt: now, error: "缺少 API Key：请在插件目录 config.json 里填写 apiKey" };
    }
    try {
      const data = await fetchUsage(scope, cfg);
      cache.set(scope, { at: Date.now(), data });
      return { ...data, cacheAgeMs: 0, cached: false };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (hit) {
        return { ...hit.data, stale: true, cacheAgeMs: now - hit.at, error: message };
      }
      return { ok: false, scope, fetchedAt: now, error: message };
    }
  }

  async function getAccount(refresh) {
    const now = Date.now();
    const hit = cache.get("@account");
    if (!refresh && hit && now - hit.at < cfg.accountTtlMs) {
      return { ...hit.data, cacheAgeMs: now - hit.at, cached: true };
    }
    if (!cfg.apiKey) {
      return { ok: false, fetchedAt: now, error: "缺少 API Key：请在插件目录 config.json 里填写 apiKey" };
    }
    try {
      const data = await fetchAccount(cfg);
      cache.set("@account", { at: Date.now(), data });
      return { ...data, cacheAgeMs: 0, cached: false };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (hit) {
        return { ...hit.data, stale: true, cacheAgeMs: now - hit.at, error: message };
      }
      return { ok: false, fetchedAt: now, error: message };
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: cfg.routePrefix,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            const sub = url.pathname.slice(cfg.routePrefix.length).replace(/\/+$/, "");
            if (req.method !== "GET" && req.method !== "HEAD") {
              sendJson(res, 405, { ok: false, error: "method_not_allowed" });
              return;
            }
            if (sub === "/api/usage" || sub === "/usage") {
              const rawScope = url.searchParams.get("scope") ?? "today";
              const scope = SCOPES.includes(rawScope) ? rawScope : "today";
              const refresh = url.searchParams.get("refresh") === "1";
              const [usage, account] = await Promise.all([getUsage(scope, refresh), getAccount(refresh)]);
              sendJson(res, 200, { ...usage, account });
              return;
            }
            if (sub === "/api/account" || sub === "/account") {
              const refresh = url.searchParams.get("refresh") === "1";
              sendJson(res, 200, await getAccount(refresh));
              return;
            }
            if (sub === "/api/ping") {
              sendJson(res, 200, { ok: true, baseUrl: cfg.baseUrl, scopes: SCOPES, routes: ["/api/usage", "/api/account", "/api/ping"] });
              return;
            }
            sendJson(res, 404, { ok: false, error: "not_found" });
          } catch (error) {
            try {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
            } catch {
              /* 响应已发出 */
            }
          }
        },
      }),
    "dsh-workbuddy-usage: usage route",
  );
}
