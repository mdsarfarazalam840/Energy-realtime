/* Realtime presence and live Databricks feed for VoltScope.
 *
 * Two transports, one contract:
 *
 *   relay   WebSocket presence + `/api/live` from `workers/live`.
 *   static  `data/live.json`, refreshed by the `Live Databricks Feed` GitHub
 *           Action every five minutes. Works with no extra infrastructure.
 *
 * Both are optional. If neither is configured the dashboard keeps its existing
 * 60-second snapshot behaviour and this module stays quiet.
 */

const CONFIG_URL = "data/live-config.json";
const DEFAULT_POLL_MS = 12000;
const MIN_POLL_MS = 5000;
const MAX_POLL_MS = 120000;
const PRESENCE_POLL_MS = 20000;
const HEARTBEAT_MS = 25000;

function trimSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function clampPoll(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(ms)));
}

export function visitorId() {
  const key = "voltscope.visitor";
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const id =
      (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).slice(
        0,
        64
      );
    localStorage.setItem(key, id);
    return id;
  } catch {
    return "anonymous";
  }
}

export async function loadLiveConfig(url = CONFIG_URL) {
  let raw = null;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.ok) raw = await response.json();
  } catch {
    /* The live layer is optional; a missing config is not an error. */
  }
  return normaliseConfig(raw);
}

export function normaliseConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const relay = trimSlash(source.relay_url);
  const liveUrl = trimSlash(source.live_url) || (relay ? `${relay}/api/live` : "");
  const presenceUrl = trimSlash(source.presence_url) || relay;
  const enabled = source.enabled !== false && Boolean(liveUrl || presenceUrl || source.static !== false);
  return {
    enabled,
    relay,
    liveUrl,
    presenceUrl,
    pollMs: clampPoll(source.poll_ms),
    staticFallback: source.static !== false,
  };
}

/* ------------------------------------------------------------------ */
/* Presence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Count people on the page right now.
 *
 * With a relay, the Durable Object owns the count and pushes it over a
 * WebSocket. Without one, the count is this tab only (`mode: "local"`) and the
 * UI says so instead of inventing a number.
 */
export function createPresence(config, { onUpdate } = {}) {
  const local = { online: 1, peak: 1, ts: Date.now(), mode: "local" };
  let stopped = false;
  let socket = null;
  let heartbeat = null;
  let httpTimer = null;
  let retry = 0;
  let reconnectTimer = null;
  let current = local;

  function emit(next) {
    current = { ...current, ...next };
    onUpdate?.(current);
  }

  function sendPing() {
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* the close handler will reconnect */
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || !config.presenceUrl) return;
    retry = Math.min(retry + 1, 5);
    const wait = Math.min(30000, 1500 * 2 ** retry);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, wait);
  }

  function connect() {
    if (stopped || !config.presenceUrl) return;
    const base = config.presenceUrl.replace(/^http/i, "ws");
    const url = `${base}/ws?v=${encodeURIComponent(visitorId())}`;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      retry = 0;
      clearInterval(heartbeat);
      heartbeat = setInterval(sendPing, HEARTBEAT_MS);
      sendPing();
      emit({ mode: "relay", connected: true });
    };

    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload?.type !== "presence") return;
      const online = Number(payload.online);
      const peak = Number(payload.peak);
      emit({
        mode: "relay",
        online: Number.isFinite(online) ? online : current.online,
        peak: Number.isFinite(peak) ? peak : current.peak,
        ts: Number(payload.ts) || Date.now(),
      });
    };

    socket.onclose = () => {
      clearInterval(heartbeat);
      socket = null;
      if (stopped) return;
      emit({ mode: "reconnecting", online: 0 });
      scheduleReconnect();
    };

    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
    };
  }

  async function pollHttp() {
    if (stopped || !config.presenceUrl || socket?.readyState === WebSocket.OPEN) return;
    try {
      const response = await fetch(`${config.presenceUrl}/api/presence`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;
      const payload = await response.json();
      const online = Number(payload.online);
      const peak = Number(payload.peak);
      if (!Number.isFinite(online)) return;
      emit({
        mode: "relay",
        online,
        peak: Number.isFinite(peak) ? peak : current.peak,
        ts: Number(payload.ts) || Date.now(),
      });
    } catch {
      /* the WebSocket reconnect path will keep trying */
    }
  }

  if (!config.enabled) {
    onUpdate?.({ online: 0, peak: 0, ts: Date.now(), mode: "off" });
  } else if (!config.presenceUrl) {
    onUpdate?.(local);
  } else {
    connect();
    httpTimer = setInterval(pollHttp, PRESENCE_POLL_MS);
    pollHttp();
  }

  return {
    get state() {
      return current;
    },
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(httpTimer);
      clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Live readings                                                       */
/* ------------------------------------------------------------------ */

/**
 * Poll the newest Databricks readings.
 *
 * `onPoints` receives the raw `{t,z,p,s}` array. `onStatus` receives transport,
 * freshness, and error information for the UI.
 */
export function createLiveFeed(config, { onPoints, onStatus } = {}) {
  let stopped = false;
  let timer = null;
  let controller = null;
  let failures = 0;
  const transport = config.relay ? "relay" : "static";

  function status(patch) {
    onStatus?.({ transport, ...patch });
  }

  async function poll() {
    if (stopped) return;
    if (!config.enabled) {
      status({ state: "off" });
      return;
    }

    const base = config.liveUrl || "data/live.json";
    // A cache bucket keeps GitHub Pages from serving a 10-minute-old file while
    // still letting the CDN absorb bursts inside one poll window.
    const bucket = transport === "static" ? Math.floor(Date.now() / config.pollMs) : null;
    const url = bucket == null ? base : `${base}${base.includes("?") ? "&" : "?"}v=${bucket}`;

    controller?.abort();
    controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 404) {
        failures = 0;
        status({ state: "waiting", reason: "no live file yet" });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = await response.json();
      const points = Array.isArray(document?.points) ? document.points : [];
      const generated = document?.generated_at ? Date.parse(document.generated_at) : Date.now();
      failures = 0;
      onPoints?.(points, document);
      status({
        state: "live",
        rows: points.length,
        generated: Number.isFinite(generated) ? generated : Date.now(),
        synced: Date.now(),
        meta: document?.meta || {},
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      failures += 1;
      status({ state: failures > 1 ? "error" : "retrying", reason: String(error?.message || error) });
    } finally {
      clearTimeout(abortTimer);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(async () => {
      await poll();
      schedule();
    }, config.pollMs);
  }

  if (config.enabled) {
    poll();
    schedule();
  } else {
    status({ state: "off" });
  }

  return {
    poll,
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
