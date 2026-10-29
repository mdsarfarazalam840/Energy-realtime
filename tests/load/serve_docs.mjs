/* Static origin mirror for load tests.
 *
 * Serves docs/ from memory with production-like headers, gzip, and ETags.
 * This is a stand-in for the GitHub Pages / Fastly edge, so a load test never
 * touches the real host. Do not point a load test at the public site.
 *
 *   node tests/load/serve_docs.mjs --root docs --port 8000 --workers 4
 */

import cluster from "node:cluster";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ROOT = path.resolve(here, "..", "..", arg("root", "docs"));
const PORT = Number(arg("port", "8000"));
const WORKERS = Math.max(1, Number(arg("workers", String(Math.min(4, os.cpus().length)))));
const LATENCY_MS = Number(arg("latency", "0"));
const CACHE_CONTROL = arg("cache-control", "public, max-age=600");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pem": "application/x-pem-file",
};

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function buildCache() {
  const cache = new Map();
  for (const file of walk(ROOT)) {
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || "application/octet-stream";
    const compressible = /^(text\/|application\/json|image\/svg)/.test(type) && body.length > 1024;
    cache.set(`/${path.relative(ROOT, file).split(path.sep).join("/")}`, {
      body,
      gzip: compressible ? zlib.gzipSync(body, { level: 6 }) : null,
      type,
      etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"`,
      immutable: /\/(assets\/js|assets\/css)\//.test(file) && /[?&]v=/.test(file) === false,
    });
  }
  // Directory indexes, matching Pages behaviour for `/` and `/diagrams/`.
  for (const [key, value] of [...cache]) {
    if (key.endsWith("/index.html")) {
      cache.set(key.slice(0, -"index.html".length), value);
    }
  }
  return cache;
}

function startWorker() {
  const cache = buildCache();
  const server = http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    const entry = cache.get(pathname) || cache.get(`${pathname}/`);

    const finish = (status, headers, body) => {
      const send = () => {
        res.writeHead(status, headers);
        res.end(body);
      };
      if (LATENCY_MS > 0) setTimeout(send, LATENCY_MS);
      else send();
    };

    if (!entry) {
      finish(404, { "content-type": "text/plain" }, "Not found");
      return;
    }

    const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && entry.gzip;
    const body = gzip ? entry.gzip : entry.body;
    const headers = {
      "content-type": entry.type,
      "content-length": String(body.length),
      "cache-control": pathname.startsWith("/data/") ? CACHE_CONTROL : entry.immutable ? "public, max-age=31536000, immutable" : CACHE_CONTROL,
      etag: entry.etag,
      vary: "Accept-Encoding",
      "x-origin-time-ms": String(Number(process.hrtime.bigint() - started) / 1e6),
    };
    if (gzip) headers["content-encoding"] = "gzip";

    if (req.headers["if-none-match"] === entry.etag) {
      delete headers["content-length"];
      res.writeHead(304, headers);
      res.end();
      return;
    }
    finish(200, headers, body);
  });

  server.keepAliveTimeout = 65000;
  server.listen(PORT, () => {
    if (cluster.isPrimary) console.log(`[origin] ${ROOT} on http://127.0.0.1:${PORT} (${cache.size} files)`);
  });
}

if (WORKERS > 1 && cluster.isPrimary) {
  console.log(`[origin] starting ${WORKERS} workers on port ${PORT}`);
  for (let i = 0; i < WORKERS; i += 1) cluster.fork();
} else {
  startWorker();
}
