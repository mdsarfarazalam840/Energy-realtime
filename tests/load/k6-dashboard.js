/* k6 load test for the VoltScope dashboard.
 *
 *   k6 run -e USERS=1000 -e BASE=http://127.0.0.1:8000 tests/load/k6-dashboard.js
 *
 * Start tests/load/serve_docs.mjs first. Do not run this against the public
 * GitHub Pages site; GitHub's Acceptable Use policy forbids unsolicited load.
 *
 * The journey mirrors a real browser: load the shell and every module once,
 * then poll the snapshot with an ETag. Thresholds match load_test.mjs.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.BASE || "http://127.0.0.1:8000";
const USERS = Number(__ENV.USERS || 1000);
const SCENARIO = __ENV.SCENARIO || "revalidate";

export const options = {
  scenarios: {
    dashboard: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "20s", target: USERS },
        { duration: "60s", target: USERS },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500", "p(99)<1500"],
    checks: ["rate>0.99"],
  },
};

const ASSETS = [
  "/",
  "/assets/css/dashboard.css?v=20261028-5",
  "/assets/js/main.js?v=20261028-5",
  "/assets/js/data.js?v=20261028-5",
  "/assets/js/demo.js?v=20261028-5",
  "/assets/js/charts.js?v=20261028-5",
  "/assets/js/scene.js?v=20261028-5",
  "/assets/vendor/three/three.module.js",
  "/assets/vendor/three/addons/controls/OrbitControls.js",
  "/assets/vendor/three/addons/postprocessing/EffectComposer.js",
  "/assets/vendor/three/addons/postprocessing/RenderPass.js",
  "/assets/vendor/three/addons/postprocessing/UnrealBloomPass.js",
  "/assets/vendor/three/addons/postprocessing/ShaderPass.js",
  "/assets/vendor/three/addons/postprocessing/MaskPass.js",
  "/assets/vendor/three/addons/postprocessing/Pass.js",
  "/assets/vendor/three/addons/shaders/CopyShader.js",
  "/assets/vendor/three/addons/shaders/LuminosityHighPassShader.js",
];

const snapshotDuration = new Trend("manifest_duration", true);
const snapshotValid = new Rate("manifest_valid");
const DAYS_TO_LOAD = Number(__ENV.DAYS || 7);

export default function () {
  const params = { tags: { kind: "page" } };
  for (const asset of ASSETS) {
    const response = http.get(BASE + asset, params);
    check(response, { [`asset ${asset}`]: (r) => r.status === 200 });
  }

  const manifestResponse = http.get(`${BASE}/data/index.json`, params);
  let dayFiles = [];
  if (manifestResponse.status === 200) {
    const manifest = manifestResponse.json();
    dayFiles = (manifest && Array.isArray(manifest.days) ? manifest.days : []).map((day) => day.file).filter(Boolean);
    check(manifestResponse, { "manifest lists days": () => dayFiles.length > 0 });
    for (const file of dayFiles.slice(-DAYS_TO_LOAD)) {
      const response = http.get(`${BASE}/data/${file}`, params);
      check(response, { [`day ${file}`]: (r) => r.status === 200 });
    }
  }

  let etag = null;
  // 60 polls = one hour of an open dashboard. Only the manifest is revalidated;
  // day shards stay in the browser cache.
  for (let index = 0; index < 60; index += 1) {
    const url =
      SCENARIO === "bypass"
        ? `${BASE}/data/index.json?v=${__VU}-${__ITER}-${index}-${Date.now()}`
        : `${BASE}/data/index.json`;
    const response = http.get(url, {
      headers: etag ? { "If-None-Match": etag } : {},
      tags: { kind: "snapshot" },
    });
    if (response.headers.Etag) etag = response.headers.Etag;
    snapshotDuration.add(response.timings.duration);
    if (response.status === 200) {
      const body = response.json();
      snapshotValid.add(Boolean(body && Array.isArray(body.days)));
    }
    check(response, { "manifest 200 or 304": (r) => r.status === 200 || r.status === 304 });
    sleep(1);
  }
}
