/* VoltScope live relay.
 *
 * One Cloudflare Worker provides three things the static GitHub Pages site
 * cannot do on its own:
 *
 *   1. `/ws` + `/api/presence`  realtime "people here now" presence, backed by
 *      one hibernating Durable Object that deduplicates tabs per visitor.
 *   2. `/api/live`              a read-only proxy for the newest Databricks
 *      rows. The Databricks token stays in a Worker secret, never in the
 *      browser. Results are cached in KV for a few seconds.
 *   3. `scheduled`              a cron that can dispatch the GitHub Actions
 *      live workflow, so the ingest keeps moving even when GitHub's own
 *      scheduler drifts.
 *
 * The site works without this Worker. Without a relay URL the dashboard falls
 * back to the 60-second snapshot plus the `data/live.json` fast lane.
 */

const JSON_TYPE = "application/json; charset=utf-8";
const PRESENCE_ALARM_MS = 30000;
const DISPATCH_MIN_GAP_MS = 4 * 60 * 1000;

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function json(data, env, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": JSON_TYPE,
      "cache-control": "no-store",
      ...corsHeaders(env),
      ...extra,
    },
  });
}

function text(body, env, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders(env) },
  });
}

/* ------------------------------------------------------------------ */
/* Presence Durable Object                                             */
/* ------------------------------------------------------------------ */

export class PresenceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.peak = 0;
    this.state.blockConcurrencyWhile(async () => {
      this.peak = Number((await this.state.storage.get("peak")) || 0);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/snapshot")) {
      const online = this.online();
      return json({ online, peak: Math.max(this.peak, online), ts: Date.now() }, this.env);
    }

    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return text("Expected a WebSocket upgrade", this.env, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const visitor =
      (url.searchParams.get("v") || "").trim().slice(0, 64) || crypto.randomUUID();

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ visitor, joined: Date.now() });

    await this.trackPeak(this.online());
    await this.ensureAlarm();
    this.broadcast();

    return new Response(null, { status: 101, webSocket: client });
  }

  online() {
    const visitors = new Set();
    for (const socket of this.state.getWebSockets()) {
      // `getWebSockets()` can briefly include a socket that is closing, so
      // trust the socket state instead of the list membership. A socket is not
      // OPEN yet while its own join is broadcast, so only closing states count
      // as gone.
      if (typeof socket.readyState === "number" && socket.readyState >= 2) continue;
      const attachment = socket.deserializeAttachment?.() || {};
      visitors.add(attachment.visitor || "anonymous");
    }
    return visitors.size;
  }

  async trackPeak(online) {
    if (online <= this.peak) return;
    this.peak = online;
    await this.state.storage.put("peak", online);
  }

  async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    if (current === null) await this.state.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
  }

  broadcast() {
    const online = this.online();
    const payload = JSON.stringify({
      type: "presence",
      online,
      peak: Math.max(this.peak, online),
      ts: Date.now(),
    });
    for (const socket of this.state.getWebSockets()) {
      if (typeof socket.readyState === "number" && socket.readyState >= 2) continue;
      try {
        socket.send(payload);
      } catch {
        /* closed between the list and the send */
      }
    }
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > 512) return;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    if (payload?.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    }
  }

  async webSocketClose(socket, code, reason, wasClean) {
    this.broadcast();
  }

  async webSocketError(socket) {
    try {
      socket.close(1011, "error");
    } catch {
      /* already closed */
    }
    this.broadcast();
  }

  async alarm() {
    this.broadcast();
    if (this.state.getWebSockets().length) {
      await this.state.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Databricks read path                                                */
/* ------------------------------------------------------------------ */

let memoryCache = null;

function tableSql(env) {
  const raw = (env.ENERGY_TABLE || "workspace.default.energy_prices_realtime").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) {
    throw new Error("Unsafe ENERGY_TABLE value");
  }
  return raw
    .split(".")
    .map((part) => `\`${part}\``)
    .join(".");
}

function liveQuery(env) {
  const hours = Math.max(1, Math.min(72, Number(env.LIVE_WINDOW_HOURS || 6)));
  const limit = Math.max(1, Math.min(20000, Number(env.LIVE_LIMIT || 2000)));
  return `
SELECT unix_millis(CAST(timestamp AS TIMESTAMP)) AS t_ms,
       zone,
       price,
       source
FROM ${tableSql(env)}
WHERE CAST(timestamp AS TIMESTAMP) >= current_timestamp() - INTERVAL ${hours} HOURS
ORDER BY t_ms ASC
LIMIT ${limit}
`.trim();
}

function compactRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const t = Number(row.t_ms);
    const p = Number(row.price);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    const zone = String(row.zone || "unknown").trim() || "unknown";
    const source = String(row.source || "unknown").trim() || "unknown";
    seen.set(`${source}|${zone}|${t}`, { t, z: zone, p: Math.round(p * 10000) / 10000, s: source });
  }
  return [...seen.values()].sort((a, b) => a.t - b.t);
}

async function databricksFetch(env, path, init = {}) {
  const host = String(env.DATABRICKS_HOST || "")
    .trim()
    .replace(/\/+$/, "");
  if (!host) throw new Error("DATABRICKS_HOST is not configured");
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
  const response = await fetch(base + path, {
    ...init,
    headers: {
      authorization: `Bearer ${env.DATABRICKS_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "voltscope-live-relay/1.0",
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.message || body?.error_code || `HTTP ${response.status}`;
    throw new Error(`Databricks ${path} failed: ${detail}`);
  }
  return body;
}

async function queryLive(env) {
  const started = Date.now();
  let body = await databricksFetch(env, "/api/2.0/sql/statements", {
    method: "POST",
    body: JSON.stringify({
      statement: liveQuery(env),
      warehouse_id: env.DATABRICKS_WAREHOUSE_ID,
      wait_timeout: "20s",
      on_wait_timeout: "CONTINUE",
      format: "JSON_ARRAY",
      disposition: "INLINE",
    }),
  });

  let state = body?.status?.state || "";
  const statementId = body?.statement_id;
  for (let attempt = 0; attempt < 4 && (state === "PENDING" || state === "RUNNING"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    body = await databricksFetch(
      env,
      `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`
    );
    state = body?.status?.state || "";
  }

  if (state && state !== "SUCCEEDED") {
    const detail = body?.status?.error?.message || `state=${state}`;
    throw new Error(`Databricks live query failed: ${detail}`);
  }

  const columns = (body?.manifest?.schema?.columns || []).map((column) => column.name);
  const rows = (body?.result?.data_array || []).map((row) =>
    Object.fromEntries(columns.map((name, index) => [name, row[index]]))
  );
  const points = compactRows(rows);
  const latest = points.length ? points[points.length - 1].t : 0;

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: "live",
    transport: "relay",
    points,
    meta: {
      source: "databricks",
      table: env.ENERGY_TABLE || "workspace.default.energy_prices_realtime",
      row_count: points.length,
      latest_timestamp_ms: latest,
      query_ms: Date.now() - started,
      cached: false,
    },
  };
}

async function livePayload(env, force = false) {
  const ttl = Math.max(5, Number(env.LIVE_TTL_SECONDS || 20)) * 1000;
  if (!force) {
    if (env.LIVE_CACHE) {
      const cached = await env.LIVE_CACHE.get("live:payload", { type: "json" });
      if (cached?.ts && Date.now() - cached.ts < ttl && cached.data) {
        return { ...cached.data, meta: { ...cached.data.meta, cached: true } };
      }
    } else if (memoryCache && Date.now() - memoryCache.ts < ttl) {
      return { ...memoryCache.data, meta: { ...memoryCache.data.meta, cached: true } };
    }
  }

  try {
    const payload = await queryLive(env);
    if (env.LIVE_CACHE) {
      await env.LIVE_CACHE.put("live:payload", JSON.stringify({ ts: Date.now(), data: payload }), {
        expirationTtl: 300,
      });
    } else {
      memoryCache = { ts: Date.now(), data: payload };
    }
    return payload;
  } catch (error) {
    const stale = env.LIVE_CACHE
      ? await env.LIVE_CACHE.get("live:payload", { type: "json" })
      : memoryCache;
    if (stale?.data) {
      return {
        ...stale.data,
        meta: { ...stale.data.meta, cached: true, stale: true, error: String(error.message || error) },
      };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* GitHub Actions dispatch                                             */
/* ------------------------------------------------------------------ */

async function dispatchWorkflow(env) {
  if (env.DISPATCH_ENABLED !== "1") return { dispatched: false, reason: "disabled" };
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPO || !env.GITHUB_WORKFLOW) {
    return { dispatched: false, reason: "missing configuration" };
  }
  if (env.LIVE_CACHE) {
    const last = Number(await env.LIVE_CACHE.get("dispatch:last"));
    if (last && Date.now() - last < DISPATCH_MIN_GAP_MS) {
      return { dispatched: false, reason: "recent dispatch" };
    }
  }

  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${encodeURIComponent(
      env.GITHUB_WORKFLOW
    )}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "voltscope-live-relay/1.0",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    return { dispatched: false, reason: `GitHub ${response.status}: ${detail.slice(0, 200)}` };
  }
  if (env.LIVE_CACHE) {
    await env.LIVE_CACHE.put("dispatch:last", String(Date.now()), { expirationTtl: 3600 });
  }
  return { dispatched: true };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, env, 405);
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json(
          {
            service: "voltscope-live",
            ok: true,
            presence: "/ws",
            live: "/api/live",
            ts: Date.now(),
          },
          env
        );
      }

      if (url.pathname === "/ws" || url.pathname === "/api/presence") {
        const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
        const target = new URL(request.url);
        if (url.pathname === "/api/presence") target.pathname = "/snapshot";
        return stub.fetch(new Request(target, request));
      }

      if (url.pathname === "/api/live") {
        const payload = await livePayload(env, url.searchParams.get("force") === "1");
        return json(payload, env, 200, { "cache-control": "no-store" });
      }

      return json({ error: "not found" }, env, 404);
    } catch (error) {
      return json({ error: String(error?.message || error) }, env, 502);
    }
  },

  async scheduled(event, env, ctx) {
    const work = (async () => {
      try {
        await livePayload(env, true);
      } catch (error) {
        console.warn("live refresh failed", error);
      }
      try {
        await dispatchWorkflow(env);
      } catch (error) {
        console.warn("workflow dispatch failed", error);
      }
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
  },
};
