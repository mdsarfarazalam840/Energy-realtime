const BASE = "https://voltscope-live.md-sarfarazalam840.workers.dev";

const snap = async (room) =>
  (await fetch(`${BASE}/api/presence?room=${room}`, { cache: "no-store" })).json();

const ws = new WebSocket(`${BASE}/ws?room=tech&visitor=probe-${Date.now()}`);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
  setTimeout(() => rej(new Error("ws timeout")), 10000);
});
await new Promise((r) => setTimeout(r, 1500));

const tech = await snap("tech");
const crypto = await snap("crypto");
const global = await snap("global");
console.log(JSON.stringify({ tech, crypto, global }));
ws.close();
await new Promise((r) => setTimeout(r, 1000));
console.log(JSON.stringify({ afterClose: await snap("tech") }));
process.exit(0);
