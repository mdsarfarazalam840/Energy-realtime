/* Flights globe scene: a wireframe Earth, a seeded starfield, one dot per
 * aircraft position, and a hand-rolled orbit camera (drag to rotate, wheel to
 * zoom — no addon dependency, no CDN).
 *
 * Data arrives as plain objects {icao24, lon, lat, ...}; the scene keeps only
 * what it needs to draw and to pick: a unit-sphere Vector3 + an index.
 * Selection and hover are colour-only, so a click never rebuilds the buffer.
 *
 * The camera starts calm: auto-orbit is on unless the OS asks for reduced
 * motion, and the render loop idles while the document is hidden. */

import * as THREE from "three";

const DEG = Math.PI / 180;
const AUTO_ORBIT_SPEED = 0.13; // radians / second
const MIN_DISTANCE = 2.4;
const MAX_DISTANCE = 9.5;
const DEFAULT_DISTANCE = 4.6;
const PITCH_LIMIT = 1.5; // ~86 degrees, just shy of the poles
const DRAG_SPEED = 0.0075; // radians / pixel
const WHEEL_SPEED = 0.0012;
const CLICK_SLOP_PX = 6;
const PICK_RADIUS_PX = 24;
const STAR_COUNT = 360;
const STAR_MIN = 2.7;
const STAR_SPAN = 0.5;
const STAR_SIZE = 0.018;
const PLANE_SIZE = 0.01;
const PLANE_RADIUS = 1.01;
const PIXEL_BUDGET = 4500000;
const MAX_DEVICE_RATIO = 2;

const PALETTES = {
  dark: {
    grid: 0x33557d,
    equator: 0x4f8fbf,
    stars: [0xffffff, 0xdbe9ff, 0xc6d8ff, 0x9fd8f5],
    planes: 0x8fe6ff,
    selected: 0xffd479,
    hover: 0xffffff,
  },
  light: {
    grid: 0x93a9c6,
    equator: 0x6b8fb8,
    stars: [0x5b6478, 0x7d8798, 0x98a2b3, 0xb7bfcc],
    planes: 0x0b7ea8,
    selected: 0xa86900,
    hover: 0x16202c,
  },
};

function hexToRgb01(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
}

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Positions in {x, y, z}; every writer keeps the index math explicit so the
// buffer layout stays obvious: three floats per point, colours as 0..1 triples.
function buildLines() {
  const grid = [];
  const equator = [];
  const push = (target, lat, lon) => {
    const latRad = lat * DEG;
    const lonRad = lon * DEG;
    target.push(
      Math.cos(latRad) * Math.cos(lonRad),
      Math.sin(latRad),
      Math.cos(latRad) * Math.sin(lonRad),
    );
  };
  for (const lat of [-60, -45, -30, -15, 15, 30, 45, 60]) {
    for (let step = 0; step < 72; step++) {
      const lon = (step / 72) * 360;
      push(grid, lat, lon);
      if (step > 0) push(grid, lat, lon - (360 / 72));
    }
  }
  for (let index = 0; index < 12; index++) {
    const lon = index * 30;
    for (let step = 0; step < 120; step++) {
      const lat = (step / 120) * 180 - 90;
      push(grid, lat, lon);
      if (step > 0) push(grid, lat, lon);
    }
  }
  for (let step = 0; step < 72; step++) {
    const lon = (step / 72) * 360;
    push(equator, 0, lon);
    if (step > 0) push(equator, 0, lon - (360 / 72));
  }
  const make = (values) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(values), 3));
    return geometry;
  };
  return { grid: make(grid), equator: make(equator) };
}

function buildStars(random, palette) {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let index = 0; index < STAR_COUNT; index++) {
    // Uniform-ish shell distribution.
    const phi = random() * Math.PI * 2;
    const cosTheta = random() * 2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const radius = STAR_MIN + random() * STAR_SPAN;
    positions[index * 3] = radius * sinTheta * Math.cos(phi);
    positions[index * 3 + 1] = radius * cosTheta;
    positions[index * 3 + 2] = radius * sinTheta * Math.sin(phi);
    const tint = hexToRgb01(palette.stars[Math.floor(random() * palette.stars.length)]);
    colors[index * 3] = tint[0];
    colors[index * 3 + 1] = tint[1];
    colors[index * 3 + 2] = tint[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return { geometry, colors };
}

function clone01(rgb) {
  return [rgb[0], rgb[1], rgb[2]];
}

function createScene(root, options = {}) {
  const onSelect = typeof options.onSelect === "function" ? options.onSelect : () => {};
  const onHover = typeof options.onHover === "function" ? options.onHover : () => {};
  const onUnavailable = typeof options.onUnavailable === "function" ? options.onUnavailable : null;
  const onContextLost = typeof options.onContextLost === "function" ? options.onContextLost : null;
  const tooltip = options.tooltip || null;

  const canvas = root.querySelector("canvas") || document.createElement("canvas");
  canvas.className = canvas.className || "flight-canvas";
  canvas.setAttribute("aria-hidden", "true");
  if (!canvas.isConnected) root.appendChild(canvas);

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    renderer = null;
  }
  if (!renderer) {
    if (onUnavailable) onUnavailable("WebGL is unavailable in this browser.");
    return null;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  let theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  let cssWidth = 800;
  let cssHeight = 600;
  let deviceRatio = 1;
  let contextLost = false;
  let yaw = 0.6;
  let pitch = 0.35;
  let distance = DEFAULT_DISTANCE;
  let autoOrbit = !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let dragging = false;
  let activePointerId = null;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let movedPx = 0;
  let hoveredIcao = null;
  let highlight = null; // { icao, role }
  let planes = []; // { icao, v: Vector3, base: [r, g, b] }
  let scratch = new THREE.Vector3();

  let palette = PALETTES[theme];
  let starField = buildStars(seededRandom(20261110), palette);
  const lines = buildLines();

  const globe = new THREE.Group();
  const gridMaterial = new THREE.LineBasicMaterial({ color: palette.grid });
  const equatorMaterial = new THREE.LineBasicMaterial({ color: palette.equator });
  globe.add(new THREE.LineSegments(lines.grid, gridMaterial), new THREE.LineSegments(lines.equator, equatorMaterial));
  scene.add(globe);

  const starMaterial = new THREE.PointsMaterial({
    size: STAR_SIZE,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  scene.add(new THREE.Points(starField.geometry, starMaterial));

  const pointsMaterial = new THREE.PointsMaterial({
    size: PLANE_SIZE,
    sizeAttenuation: true,
    vertexColors: true,
  });
  const planePoints = new THREE.Points();
  scene.add(planePoints);

  function applyPalette() {
    palette = PALETTES[theme];
    gridMaterial.color.setHex(palette.grid);
    equatorMaterial.color.setHex(palette.equator);
    const tints = palette.stars.map(hexToRgb01);
    for (let index = 0; index < starField.colors.length; index += 3) {
      const tint = tints[index % tints.length];
      starField.colors[index] = tint[0];
      starField.colors[index + 1] = tint[1];
      starField.colors[index + 2] = tint[2];
    }

    const base = hexToRgb01(palette.planes);
    for (const plane of planes) plane.base = clone01(base);
    writePointColors();
  }

  function writePointColors() {
    const attribute = planePoints.geometry && planePoints.geometry.getAttribute("color");
    if (!attribute) return;
    const colors = attribute.array;
    for (let index = 0; index < planes.length; index++) {
      const plane = planes[index];
      let rgb = plane.base;
      if (hoveredIcao !== null && plane.icao === hoveredIcao) rgb = hexToRgb01(palette.hover);
      else if (highlight !== null && highlight.icao === plane.icao && highlight.role === "select") rgb = hexToRgb01(palette.selected);
      colors[index * 3] = rgb[0];
      colors[index * 3 + 1] = rgb[1];
      colors[index * 3 + 2] = rgb[2];
    }
    attribute.needsUpdate = true;
  }

  function setPlanes(list) {
    planes = [];
    const wanted = Array.isArray(list) ? list : [];
    for (const plane of wanted) {
      if (!plane) continue;
      if (!Number.isFinite(plane.lon) || !Number.isFinite(plane.lat)) continue;
      const latRad = plane.lat * DEG;
      const lonRad = plane.lon * DEG;
      planes.push({
        icao: String(plane.icao24 || "").trim().toLowerCase(),
        v: new THREE.Vector3(
          Math.cos(latRad) * Math.cos(lonRad) * PLANE_RADIUS,
          Math.sin(latRad) * PLANE_RADIUS,
          Math.cos(latRad) * Math.sin(lonRad) * PLANE_RADIUS,
        ),
        base: clone01(hexToRgb01(palette.planes)),
      });
    }
    const positions = new Float32Array(planes.length * 3);
    const colors = new Float32Array(planes.length * 3);
    for (let index = 0; index < planes.length; index++) {
      positions[index * 3] = planes[index].v.x;
      positions[index * 3 + 1] = planes[index].v.y;
      positions[index * 3 + 2] = planes[index].v.z;
      colors[index * 3] = 1;
      colors[index * 3 + 1] = 1;
      colors[index * 3 + 2] = 1;
    }
    if (!planePoints.geometry || !planePoints.geometry.getAttribute("position")) {
      planePoints.setGeometry(new THREE.BufferGeometry());
    }
    const geometry = planePoints.geometry;
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setDrawRange(0, planes.length);
    applyPalette();
    if (hoveredIcao !== null && !planes.some((plane) => plane.icao === hoveredIcao)) {
      hoveredIcao = null;
      hideTooltip();
      onHover(null);
    }
  }

  function setHighlight(icao, role) {
    highlight = icao ? { icao: String(icao).trim().toLowerCase(), role: role === "hover" ? "hover" : "select" } : null;
    writePointColors();
  }

  function setTheme(next) {
    theme = next === "light" ? "light" : "dark";
    applyPalette();
  }

  function setOrbit(enabled) {
    autoOrbit = Boolean(enabled);
  }

  function hideTooltip() {
    if (!tooltip) return;
    tooltip.hidden = true;
    tooltip.textContent = "";
  }

  function ageLabel(lastUpdateMs) {
    const minutes = (Date.now() - lastUpdateMs) / 60000;
    if (!Number.isFinite(minutes) || minutes < 1) return "under a minute ago";
    if (minutes < 60) return `${Math.round(minutes)} min ago`;
    return `${Math.floor(minutes / 60)} h ago`;
  }

  function showTooltip(plane, screenX, screenY) {
    if (!tooltip || !plane) return;
    const label = plane.callsign || plane.icao || "aircraft";
    tooltip.textContent = "";
    const line1 = document.createElement("strong");
    line1.textContent = label;
    const line2 = document.createElement("span");
    line2.textContent = `${plane.country} · ${plane.lat.toFixed(2)}, ${plane.lon.toFixed(2)}`;
    const line3 = document.createElement("span");
    line3.textContent = plane.lastUpdateMs
      ? `updated ${new Date(plane.lastUpdateMs).toISOString().slice(11, 19)}Z · ${ageLabel(plane.lastUpdateMs)}`
      : "update time unknown";
    tooltip.append(line1, line2, line3);
    tooltip.hidden = false;
    const width = tooltip.offsetWidth || 0;
    const rootWidth = cssWidth;
    tooltip.style.left = `${Math.max(width / 2 + 4, Math.min(screenX, rootWidth - width / 2 - 4))}px`;
    tooltip.style.top = `${Math.max(34, screenY)}px`;
  }

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    if (screenX < 0 || screenY < 0 || screenX > rect.width || screenY > rect.height) {
      return { plane: null, screenX, screenY };
    }
    camera.updateMatrixWorld();
    let best = null;
    let bestDistance = PICK_RADIUS_PX;
    for (const plane of planes) {
      scratch.set(plane.v.x, plane.v.y, plane.v.z).project(camera);
      if (scratch.z > 1) continue;
      const x = (scratch.x + 1) * 0.5 * rect.width;
      const y = (1 - (scratch.y + 1) * 0.5) * rect.height;
      const deltaX = x - screenX;
      const deltaY = y - screenY;
      const distancePx = Math.hypot(deltaX, deltaY);
      if (distancePx <= bestDistance) {
        bestDistance = distancePx;
        best = plane;
      }
    }
    return { plane: best, screenX, screenY };
  }

  function onPointerDown(event) {
    if (contextLost) return;
    if (dragging) return; // ignore extra touches while dragging
    dragging = true;
    activePointerId = event.pointerId;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    movedPx = 0;
    root.classList.add("is-dragging");
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety, not a requirement */
    }
  }

  function onPointerMove(event) {
    if (contextLost) return;
    if (dragging && event.pointerId === activePointerId) {
      const deltaX = event.clientX - lastPointerX;
      const deltaY = event.clientY - lastPointerY;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      movedPx += Math.hypot(deltaX, deltaY);
      yaw -= deltaX * DRAG_SPEED;
      pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch + deltaY * DRAG_SPEED));
      if (hoveredIcao !== null) {
        hoveredIcao = null;
        hideTooltip();
        onHover(null);
      }
      return;
    }
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const hit = pickAt(event.clientX, event.clientY);
    const icao = hit.plane ? hit.plane.icao : null;
    if (icao !== hoveredIcao) {
      hoveredIcao = icao;
      setHighlight(hoveredIcao, "hover");
      if (icao) showTooltip(hit.plane, hit.screenX, hit.screenY);
      else hideTooltip();
      onHover(icao);
    } else if (icao) {
      showTooltip(hit.plane, hit.screenX, hit.screenY);
    }
  }

  function endDrag(event) {
    if (!dragging || (event && event.pointerId !== activePointerId)) return;
    dragging = false;
    activePointerId = null;
    root.classList.remove("is-dragging");
    if (event && movedPx < CLICK_SLOP_PX && event.type === "pointerup") {
      const hit = pickAt(event.clientX, event.clientY);
      if (hit.plane) {
        setHighlight(hit.plane.icao, "select");
        onSelect(hit.plane.icao);
      } else if (highlight !== null && highlight.role === "select") {
        setHighlight(null);
        onSelect(null);
      }
    }
  }

  function resize() {
    const rect = root.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || window.innerHeight));
    deviceRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_RATIO);
    if (width * height * deviceRatio * deviceRatio > PIXEL_BUDGET) {
      deviceRatio = Math.max(1, Math.sqrt(PIXEL_BUDGET / (width * height)));
    }
    cssWidth = width;
    cssHeight = height;
    renderer.setPixelRatio(deviceRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function updateCamera() {
    const cosPitch = Math.cos(pitch);
    camera.position.set(cosPitch * Math.sin(yaw) * distance, Math.sin(pitch) * distance, cosPitch * Math.cos(yaw) * distance);
    camera.lookAt(0, 0, 0);
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, distance * Math.exp(event.deltaY * WHEEL_SPEED)));
  }, { passive: false });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    if (onContextLost) onContextLost();
  });
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(root);

  resize();
  updateCamera();
  setPlanes([]);

  const start = performance.now();
  function frame(now) {
    const delta = Math.min(0.1, (now - start) / 1000);
    start = now;
    if (autoOrbit && !dragging && !contextLost) yaw += AUTO_ORBIT_SPEED * delta;
    if (!contextLost) {
      updateCamera();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    canvas,
    setPlanes,
    setHighlight,
    setTheme,
    setOrbit,
    stats: () => ({ plotted: planes.length }),
  };
}

export { PALETTES, PICK_RADIUS_PX, DEFAULT_DISTANCE };
