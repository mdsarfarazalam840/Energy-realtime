/* WebGL stage for the AI & Tech Trends dashboard: a "neural constellation"
   of trending Hugging Face models. Each model is a 3D cube floating at its
   own depth in space, coloured by pipeline tag, with its name and trending
   score on the front face. Cubes are linked by pulsing neural-web lines, and
   a rotating polyhedron core sits at the centre. Camera presets swing the
   view for a cinematic "AI observatory" effect — visually distinct from the
   flat holographic card ring on the Tech page. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatCount, trendingTone } from "./ai-data.js?v=20261104-1";

const MAX_MODELS = 100;
const CUBE_SIZE = 1.1;
const BASE_RADIUS = 16;

const PIPELINE_COLORS = {
  "text-generation": 0x8b5cf6,
  "image-to-3d": 0x22d3ee,
  "image-text-to-text": 0xa855f7,
  "text-to-image": 0xf472b6,
  "automatic-speech-recognition": 0x34d399,
  "feature-extraction": 0xfbbf24,
  "text-classification": 0xef4444,
  "zero-shot-classification": 0x10b981,
  "—": 0x64748b,
};

const CONTENT = {
  dark: {
    bg: 0x0b0812,
    fog: 0x0b0812,
    grid: 0x1a1233,
    gridStrong: 0x8b5cf6,
    dim: 0xa78bfa,
    accent: 0x8b5cf6,
    panel: "rgba(12, 8, 20, 0.82)",
    text: "#e9d5ff",
    textDim: "#9a87c4",
  },
  light: {
    bg: 0xf5f3ff,
    fog: 0xf5f3ff,
    grid: 0xd8d0ec,
    gridStrong: 0x6b21a8,
    dim: 0x6b21a8,
    accent: 0x6b21a8,
    panel: "rgba(255, 255, 255, 0.88)",
    text: "#312e81",
    textDim: "#5b21b6",
  },
};

function makeFaceTexture(model, theme) {
  const width = 256;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const toneColor = PIPELINE_COLORS[model.pipeline_tag] || PIPELINE_COLORS["—"];
  const toneHex = `#${toneColor.toString(16).padStart(6, "0")}`;

  ctx.clearRect(0, 0, width, height);

  // Bezel glow.
  const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
  gradient.addColorStop(0, "rgba(139,92,246,0.25)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Border.
  ctx.strokeStyle = toneHex;
  ctx.lineWidth = 6;
  ctx.shadowColor = toneHex;
  ctx.shadowBlur = 20;
  ctx.strokeRect(8, 8, width - 16, height - 16);

  // Corner brackets.
  ctx.shadowBlur = 0;
  ctx.lineWidth = 5;
  const bracket = 24;
  ctx.beginPath();
  ctx.moveTo(8, bracket); ctx.lineTo(8, 8); ctx.lineTo(bracket, 8);
  ctx.moveTo(width - bracket, 8); ctx.lineTo(width - 8, 8); ctx.lineTo(width - 8, bracket);
  ctx.moveTo(width - 8, height - bracket); ctx.lineTo(width - 8, height - 8); ctx.lineTo(width - bracket, height - 8);
  ctx.moveTo(bracket, height - 8); ctx.lineTo(8, height - 8); ctx.lineTo(8, height - bracket);
  ctx.strokeStyle = toneHex;
  ctx.stroke();

  // Trending score badge.
  ctx.font = "700 30px 'Courier New', monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = toneHex;
  ctx.shadowColor = toneHex;
  ctx.shadowBlur = 12;
  ctx.fillText(`▲ ${formatCount(model.trendingScore)}`, width - 24, 44);

  // Pipeline tag.
  ctx.font = "600 20px 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = theme.textDim;
  ctx.shadowBlur = 6;
  ctx.fillText(model.pipeline_tag || "—", 24, 44);

  // Model title (wrapped, 2 lines max).
  ctx.font = "700 28px 'Courier New', monospace";
  ctx.fillStyle = theme.text;
  const lines = wrapText(ctx, model.title, width - 48, 2);
  let y = 112;
  for (const line of lines) {
    ctx.fillText(line, 24, y);
    y += 40;
  }

  // Author footer.
  ctx.font = "500 20px 'Courier New', monospace";
  ctx.fillStyle = theme.textDim;
  ctx.textAlign = "left";
  ctx.fillText(`by ${model.author}`, 24, height - 34);
  ctx.textAlign = "right";
  ctx.fillText(`${formatCount(model.downloads)} dl`, width - 24, height - 34);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

// Fibonacci sphere: distribute points evenly on a sphere surface.
function fibonacciSphere(count, radius) {
  const points = [];
  const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle in radians
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2; // y from 1 to -1
    const radiusAtY = Math.sqrt(1 - y * y);
    const theta = phi * i;
    const x = Math.cos(theta) * radiusAtY;
    const z = Math.sin(theta) * radiusAtY;
    // Add radial jitter so cubes sit at different depths.
    const depthJitter = 0.6 + Math.random() * 1.4;
    points.push(new THREE.Vector3(x * radius * depthJitter, y * radius * depthJitter, z * radius * depthJitter));
  }
  return points;
}

export class AIScene {
  constructor(container, { onHover, onSelect, onCamera } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});

    this.theme = "dark";
    this.models = [];
    this.cubes = [];
    this.lines = [];
    this.selectedId = null;
    this.hoveredId = null;
    this.nodeGroup = new THREE.Group();
    this.lineGroup = new THREE.Group();
    this.linksSet = new Set();

    this.clock = new THREE.Clock();
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.initRenderer();
    this.initScene();
    this.initLights();
    this.initCore();
    this.initFloor();
    this.initParticles();
    this.initInteraction();
    this.setTheme(this.theme);
  }

  initRenderer() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1);
    renderer.setClearColor(CONTENT.dark.bg, 1);
    renderer.shadowMap.enabled = false;
    renderer.domElement.classList.add("scene-canvas");
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(48, (this.container.clientWidth || 1) / (this.container.clientHeight || 1), 0.1, 300);
    this.camera.position.set(0, 2, 42);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 90;
    this.controls.target.set(0, 0, 0);
    this.controls.enablePan = false;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.renderer.domElement.addEventListener("click", this.onClick.bind(this));
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove.bind(this));
    this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave.bind(this));

    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(CONTENT.dark.bg, 40, 110);
  }

  initLights() {
    this.ambient = new THREE.AmbientLight(0x8b5cf6, 0.3);
    this.scene.add(this.ambient);

    const key = new THREE.DirectionalLight(0xa78bfa, 1.0);
    key.position.set(10, 16, 10);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x22d3ee, 0.5);
    rim.position.set(-12, -4, -12);
    this.scene.add(rim);

    const coreLight = new THREE.PointLight(0x8b5cf6, 2.0, 60, 2);
    coreLight.position.set(0, 0, 0);
    this.scene.add(coreLight);
    this.coreLight = coreLight;
  }

  initCore() {
    // Rotating polyhedron core instead of a flat ring.
    const coreGeo = new THREE.IcosahedronGeometry(1.4, 1);
    const coreMat = new THREE.MeshStandardMaterial({
      color: CONTENT.dark.accent,
      emissive: CONTENT.dark.accent,
      emissiveIntensity: 1.2,
      flatShading: true,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    this.scene.add(core);
    this.core = core;

    // Orbit ring around the core.
    const ringGeo = new THREE.RingGeometry(2.2, 2.6, 96);
    const ringMat = new THREE.MeshBasicMaterial({ color: CONTENT.dark.accent, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.coreRing = ring;
  }

  initFloor() {
    const grid = new THREE.GridHelper(90, 46, CONTENT.dark.gridStrong, CONTENT.dark.grid);
    grid.position.y = -14;
    this.scene.add(grid);
    this.grid = grid;
  }

  initParticles() {
    const count = 2200;
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    const palette = [0x8b5cf6, 0x22d3ee, 0xa855f7, 0xf472b6, 0x34d399];
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const theta = Math.random() * Math.PI * 2;
      const radius = 24 + Math.random() * 70;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = -12 + Math.random() * 64;
      positions[i * 3 + 2] = Math.sin(theta) * radius;
      speeds[i] = 2 + Math.random() * 10;
      sizes[i] = 0.3 + Math.random() * 1.6;
      const color = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
      size: 1.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.particles = { points, speeds, count };
  }

  initInteraction() {
    this.controls.addEventListener("change", () => this.onCamera?.());
  }

  setModels(models) {
    this.models = models || [];
    this.rebuildConstellation();
  }

  rebuildConstellation() {
    // Clear old nodes and lines.
    this.nodeGroup.clear();
    this.lineGroup.clear();
    this.cubes = [];
    this.lines = [];
    this.scene.remove(this.nodeGroup);
    this.scene.remove(this.lineGroup);

    const models = this.models.slice(0, MAX_MODELS);
    const count = models.length;
    const theme = CONTENT[this.theme];
    const positions = fibonacciSphere(count, BASE_RADIUS);

    // Build cubes.
    models.forEach((model, index) => {
      const texture = makeFaceTexture(model, theme);
      const color = PIPELINE_COLORS[model.pipeline_tag] || PIPELINE_COLORS["—"];
      const faceMat = new THREE.MeshStandardMaterial({ map: texture, transparent: true, opacity: 1, side: THREE.DoubleSide });
      const sideMat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
      const materials = [faceMat, faceMat, faceMat, faceMat, faceMat, faceMat];
      const cube = new THREE.Mesh(new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), materials);
      cube.userData.modelId = model.id;
      cube.userData.index = index;

      const pos = positions[index];
      cube.position.copy(pos);
      cube.userData.basePosition = pos.clone();
      cube.userData.driftOffset = Math.random() * Math.PI * 2;

      this.nodeGroup.add(cube);
      this.cubes.push(cube);
    });

    // Build neural-web connections: nearest neighbors + same-pipeline links.
    this.buildConnections(models, positions);

    this.nodeGroup.name = "nodeGroup";
    this.lineGroup.name = "lineGroup";
    this.scene.add(this.lineGroup);
    this.scene.add(this.nodeGroup);

    this.applySelection();
  }

  buildConnections(models, positions) {
    const maxLinksPerNode = 3;
    const linkDistance = BASE_RADIUS * 1.6;

    // Nearest-neighbor links.
    for (let i = 0; i < models.length; i += 1) {
      const links = [];
      for (let j = 0; j < models.length; j += 1) {
        if (i === j) continue;
        const d = positions[i].distanceTo(positions[j]);
        if (d < linkDistance) links.push({ index: j, distance: d });
      }
      links.sort((a, b) => a.distance - b.distance);
      for (let k = 0; k < Math.min(maxLinksPerNode, links.length); k += 1) {
        const j = links[k].index;
        this.addLine(i, j, models[i].pipeline_tag === models[j].pipeline_tag);
      }
    }

    // Same-pipeline long-range links (sparser).
    const byPipeline = new Map();
    models.forEach((m, i) => {
      const key = m.pipeline_tag || "—";
      if (!byPipeline.has(key)) byPipeline.set(key, []);
      byPipeline.get(key).push(i);
    });
    for (const [, indices] of byPipeline) {
      if (indices.length < 2) continue;
      for (let a = 0; a < indices.length; a += 1) {
        for (let b = a + 1; b < indices.length; b += 1) {
          if (Math.random() < 0.25) this.addLine(indices[a], indices[b], true);
        }
      }
    }
  }

  addLine(i, j, strong) {
    // Avoid duplicates.
    const key = [i, j].sort().join(",");
    if (this.linksSet.has(key)) return;
    this.linksSet.add(key);

    const material = new THREE.LineBasicMaterial({
      color: strong ? 0x8b5cf6 : 0x4c3d7a,
      transparent: true,
      opacity: strong ? 0.35 : 0.15,
    });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), material);
    line.userData = { i, j, strong, baseOpacity: material.opacity };
    this.lineGroup.add(line);
    this.lines.push(line);
  }

  clearCards() {
    // Kept for API compatibility with the controller's dispose path if needed.
  }

  setSelected(id) {
    this.selectedId = id || null;
    this.applySelection();
  }

  applySelection() {
    for (const cube of this.cubes) {
      const active = cube.userData.modelId === this.selectedId;
      const hovered = cube.userData.modelId === this.hoveredId;
      cube.scale.setScalar(active ? 1.5 : hovered ? 1.2 : 1);
    }
    for (const line of this.lines) {
      const i = line.userData.i;
      const j = line.userData.j;
      const active = this.cubes[i]?.userData.modelId === this.selectedId || this.cubes[j]?.userData.modelId === this.selectedId;
      line.material.opacity = active ? (line.userData.strong ? 0.7 : 0.45) : line.userData.baseOpacity;
    }
  }

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    const content = CONTENT[this.theme];
    this.renderer.setClearColor(content.bg, 1);
    this.scene.fog.color.setHex(content.bg);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const grid = new THREE.GridHelper(90, 46, content.gridStrong, content.grid);
    grid.position.y = -14;
    this.scene.add(grid);
    this.grid = grid;
    this.core.material.color.setHex(content.accent);
    this.core.material.emissive.setHex(content.accent);
    this.coreLight.color.setHex(content.accent);
    this.ambient.color.setHex(content.accent);
    this.coreRing.material.color.setHex(content.accent);
    this.rebuildConstellation();
  }

  onClick(event) {
    const hits = this.pick(event);
    const hit = hits[0];
    const id = hit?.object?.userData?.modelId || null;
    if (id) {
      this.setSelected(id);
      this.onSelect(id);
    } else {
      this.setSelected(null);
      this.onSelect(null);
    }
  }

  onPointerMove(event) {
    const hits = this.pick(event);
    const id = hits[0]?.object?.userData?.modelId || null;
    if (id === this.hoveredId) {
      if (id) this.onHover(hits[0].object.userData.modelId, event);
      return;
    }
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    this.applySelection();
    this.onHover(id, event);
  }

  onPointerLeave() {
    this.hoveredId = null;
    this.renderer.domElement.style.cursor = "grab";
    this.applySelection();
    this.onHover(null, null);
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.cubes, false);
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  loop() {
    if (this.disposed) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    if (!this.reducedMotion) {
      // Core rotates and pulses.
      this.core.rotation.x += delta * 0.35;
      this.core.rotation.y += delta * 0.25;
      this.core.rotation.z += delta * 0.15;
      this.core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.08);
      this.coreRing.rotation.z += delta * 0.2;
      this.coreRing.scale.setScalar(1 + Math.sin(t * 1.4) * 0.06);
      this.coreLight.intensity = 1.6 + Math.sin(t * 2.4) * 0.6;

      // Constellation drifts slowly.
      for (const cube of this.cubes) {
        const base = cube.userData.basePosition;
        const offset = cube.userData.driftOffset;
        cube.position.x = base.x + Math.sin(t * 0.5 + offset) * 0.9;
        cube.position.y = base.y + Math.cos(t * 0.4 + offset) * 0.7;
        cube.position.z = base.z + Math.sin(t * 0.6 + offset) * 0.9;
        cube.rotation.y += delta * 0.15;
        cube.rotation.x += delta * 0.1;
      }

      // Pulse line opacities.
      for (const line of this.lines) {
        const base = line.userData.baseOpacity;
        const p = Math.sin(t * 2 + line.userData.i * 0.7 + line.userData.j * 0.3);
        line.material.opacity = base + (line.userData.strong ? 0.15 : 0.08) * Math.max(0, p);
      }
    }

    if (this.particles) {
      const positions = this.particles.points.geometry.attributes.position.array;
      const speeds = this.particles.speeds;
      for (let i = 0; i < this.particles.count; i += 1) {
        positions[i * 3 + 1] -= speeds[i] * delta;
        if (positions[i * 3 + 1] < -12) {
          positions[i * 3 + 1] = 52 + Math.random() * 8;
        }
      }
      this.particles.points.geometry.attributes.position.needsUpdate = true;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.particles?.points.geometry.dispose();
    this.particles?.points.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}


