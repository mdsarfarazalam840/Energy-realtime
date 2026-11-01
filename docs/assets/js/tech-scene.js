/* WebGL stage for the Tech Pulse dashboard: a futuristic, hacker-style 3D
   "hologram" of the latest Hacker News headlines.

   Stories float as glowing data cards on a ring around a central beacon. A
   matrix-style rain of glyphs falls behind them, a grid floor anchors the
   scene, and each card reacts to hover and selection. Camera presets swing the
   view for a cinematic, cinematic "hacker screen" effect. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatCount, storyTone } from "./tech-data.js?v=20261104-1";

const MAX_STORIES = 60;
const RING_RADIUS = 15;
const CARD_WIDTH = 4.2;
const CARD_HEIGHT = 2.6;

const CONTENT = {
  dark: {
    bg: 0x03050a,
    fog: 0x03050a,
    grid: 0x0a1a2e,
    gridStrong: 0x29ffb0,
    dim: 0x39ffd0,
    accent: 0x29ffb0,
    panel: "rgba(5, 12, 20, 0.82)",
    text: "#c8ffe8",
    textDim: "#5aa88a",
  },
  light: {
    bg: 0xeaf2ed,
    fog: 0xeaf2ed,
    grid: 0xcfe2d8,
    gridStrong: 0x0a7a5e,
    dim: 0x12806a,
    accent: 0x0a7a5e,
    panel: "rgba(255, 255, 255, 0.88)",
    text: "#0b3a2e",
    textDim: "#4d7a6c",
  },
};

const TONE_COLORS = {
  hot: 0x29ffb0,
  warm: 0x5be8ff,
  cool: 0x7e8bff,
};

function randomMatrixGlyph() {
  const glyphs = "01アイウエオカキクケコサシスセソタチツテトナニヌネノア<>[]{}*$#&@%";
  let out = "";
  const count = 3 + Math.floor(Math.random() * 8);
  for (let i = 0; i < count; i += 1) out += glyphs[Math.floor(Math.random() * glyphs.length)];
  return out;
}

function makeCardTexture(story, theme) {
  const width = 512;
  const height = 320;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const tone = storyTone(story);
  const toneColor = TONE_COLORS[tone] || TONE_COLORS.cool;
  const toneHex = `#${toneColor.toString(16).padStart(6, "0")}`;

  ctx.clearRect(0, 0, width, height);

  // Glowing bezel.
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(41,255,176,0.16)");
  gradient.addColorStop(0.5, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(41,255,176,0.10)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = toneHex;
  ctx.lineWidth = 3;
  ctx.shadowColor = toneHex;
  ctx.shadowBlur = 18;
  ctx.strokeRect(4, 4, width - 8, height - 8);

  // Corner brackets (hacker HUD feel).
  ctx.shadowBlur = 0;
  ctx.lineWidth = 5;
  const bracket = 26;
  ctx.beginPath();
  ctx.moveTo(4, bracket); ctx.lineTo(4, 4); ctx.lineTo(bracket, 4);
  ctx.moveTo(width - bracket, 4); ctx.lineTo(width - 4, 4); ctx.lineTo(width - 4, bracket);
  ctx.moveTo(width - 4, height - bracket); ctx.lineTo(width - 4, height - 4); ctx.lineTo(width - bracket, height - 4);
  ctx.moveTo(bracket, height - 4); ctx.lineTo(4, height - 4); ctx.lineTo(4, height - bracket);
  ctx.strokeStyle = toneHex;
  ctx.stroke();

  // Score badge.
  const badge = formatCount(story.score);
  ctx.font = "600 34px 'Courier New', monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillStyle = toneHex;
  ctx.shadowColor = toneHex;
  ctx.shadowBlur = 14;
  ctx.fillText(`▲ ${badge}`, width - 28, 64);

  // Domain line.
  ctx.font = "600 26px 'Courier New', monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = theme.textDim;
  ctx.shadowBlur = 8;
  ctx.fillText(story.domain ? `◈ ${story.domain}` : "◈ news.ycombinator.com", 28, 64);

  // Title (wrapped).
  ctx.font = "700 38px 'Courier New', monospace";
  ctx.fillStyle = theme.text;
  const lines = wrapText(ctx, story.title, width - 56, 92);
  let y = 118;
  for (const line of lines.slice(0, 4)) {
    ctx.fillText(line, 28, y);
    y += 52;
  }

  // Author footer.
  ctx.font = "500 24px 'Courier New', monospace";
  ctx.fillStyle = theme.textDim;
  ctx.textAlign = "left";
  ctx.fillText(`by ${story.by}`, 28, height - 34);
  ctx.textAlign = "right";
  ctx.fillText(`${formatCount(story.comments)} comments`, width - 28, height - 34);

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

export class TechScene {
  constructor(container, { onHover, onSelect, onCamera } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});

    this.theme = "dark";
    this.stories = [];
    this.cards = [];
    this.selectedId = null;
    this.hoveredId = null;
    this.cardGroup = new THREE.Group();

    this.clock = new THREE.Clock();
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.initRenderer();
    this.initScene();
    this.initLights();
    this.initFloor();
    this.initRain();
    this.initRing();
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
    this.camera.position.set(0, 7, 30);
    this.camera.lookAt(0, 1, 0);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 60;
    this.controls.target.set(0, 1, 0);
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
    this.scene.fog = new THREE.Fog(CONTENT.dark.bg, 38, 95);
  }

  initLights() {
    this.ambient = new THREE.AmbientLight(0x29ffb0, 0.35);
    this.scene.add(this.ambient);

    const key = new THREE.DirectionalLight(0x9dffdb, 1.1);
    key.position.set(8, 14, 8);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x5be8ff, 0.5);
    rim.position.set(-10, 4, -10);
    this.scene.add(rim);

    const beacon = new THREE.PointLight(0x29ffb0, 1.6, 40, 2);
    beacon.position.set(0, 1.2, 0);
    this.scene.add(beacon);
    this.beacon = beacon;
  }

  initFloor() {
    const grid = new THREE.GridHelper(50, 34, CONTENT.dark.gridStrong, CONTENT.dark.grid);
    grid.position.y = -0.6;
    this.scene.add(grid);
    this.grid = grid;

    // Central beacon ring.
    const ringGeo = new THREE.RingGeometry(2.5, 3.0, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: CONTENT.dark.accent, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.55;
    this.scene.add(ring);
    this.beaconRing = ring;

    // A floating core.
    const coreGeo = new THREE.SphereGeometry(0.65, 32, 32);
    const coreMat = new THREE.MeshStandardMaterial({ color: CONTENT.dark.accent, emissive: CONTENT.dark.accent, emissiveIntensity: 0.9 });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 1.2;
    this.scene.add(core);
    this.core = core;
  }

  initRain() {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    const palette = [0x29ffb0, 0x5be8ff, 0x7e8bff, 0x55ff9c];
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const theta = Math.random() * Math.PI * 2;
      const radius = 18 + Math.random() * 40;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = -2 + Math.random() * 46;
      positions[i * 3 + 2] = Math.sin(theta) * radius;
      speeds[i] = 4 + Math.random() * 12;
      sizes[i] = 0.5 + Math.random() * 2.2;
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
      size: 1.6,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.rain = { points, speeds, count };
  }

  initRing() {
    this.scene.add(this.cardGroup);
  }

  initInteraction() {
    this.controls.addEventListener("change", () => this.onCamera?.());
    this.cardGroup.traverse((obj) => {
      if (obj.isMesh) obj.userData.storyNeedsIndex = true;
    });
  }

  setStories(stories) {
    this.stories = stories || [];
    this.rebuildCards();
  }

  rebuildCards() {
    this.clearCards();
    const stories = this.stories.slice(0, MAX_STORIES);
    const theme = CONTENT[this.theme];
    const count = stories.length;
    const angleStep = count > 1 ? (Math.PI * 2) / count : 0;

    stories.forEach((story, index) => {
      const texture = makeCardTexture(story, theme);
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        opacity: 1,
        emissive: TONE_COLORS[storyTone(story)] || TONE_COLORS.cool,
        emissiveIntensity: 0.12,
        side: THREE.DoubleSide,
      });
      const card = new THREE.Mesh(new THREE.PlaneGeometry(CARD_WIDTH, CARD_HEIGHT), material);
      card.userData.storyId = story.id;

      const angle = index * angleStep;
      const radius = RING_RADIUS + (index % 3) * 1.6;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const band = index % 5;
      const y = 0.4 + band * 1.5 + (story.score % 3) * 0.4;

      card.position.set(x, y, z);
      card.lookAt(this.core?.position || new THREE.Vector3(0, 1.2, 0));

      this.cardGroup.add(card);
      this.cards.push(card);
    });

    this.applySelection();
  }

  clearCards() {
    for (const card of this.cards) {
      this.cardGroup.remove(card);
      card.material.map?.dispose();
      card.material.dispose();
      card.geometry.dispose();
    }
    this.cards = [];
  }

  setSelected(id) {
    this.selectedId = id || null;
    this.applySelection();
  }

  applySelection() {
    for (const card of this.cards) {
      const active = card.userData.storyId === this.selectedId;
      const material = card.material;
      material.emissiveIntensity = active ? 0.45 : (card.userData.storyId === this.hoveredId ? 0.28 : 0.12);
    }
  }

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    const content = CONTENT[this.theme];
    this.renderer.setClearColor(content.bg, 1);
    this.scene.fog.color.setHex(content.bg);
    // GridHelper uses vertexColors (no material.color2), so re-theme by rebuilding the grid.
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    const grid = new THREE.GridHelper(50, 34, content.gridStrong, content.grid);
    grid.position.y = -0.6;
    this.scene.add(grid);
    this.grid = grid;
    this.beaconRing.material.color.setHex(content.accent);
    this.core.material.color.setHex(content.accent);
    this.core.material.emissive.setHex(content.accent);
    this.beacon.color.setHex(content.accent);
    this.ambient.color.setHex(content.accent);
    this.rebuildCards();
  }

  onClick(event) {
    const hits = this.pick(event);
    const hit = hits[0];
    const id = hit?.object?.userData?.storyId || null;
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
    const id = hits[0]?.object?.userData?.storyId || null;
    if (id === this.hoveredId) {
      if (id) this.onHover(hits[0].object.userData.storyId, event);
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
    return this.raycaster.intersectObjects(this.cards, false);
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

    // Gentle spacecraft drift around the beacon.
    if (!this.reducedMotion) {
      this.cardGroup.rotation.y += delta * 0.05;
      this.core.position.y = 1.2 + Math.sin(t * 1.4) * 0.18;
      this.core.scale.setScalar(1 + Math.sin(t * 2) * 0.06);
      this.beaconRing.scale.setScalar(1 + Math.sin(t * 1.2) * 0.05);
      this.beacon.intensity = 1.4 + Math.sin(t * 2.2) * 0.5;
    }

    // Matrix rain falling glyphs.
    if (this.rain) {
      const positions = this.rain.points.geometry.attributes.position.array;
      const speeds = this.rain.speeds;
      for (let i = 0; i < this.rain.count; i += 1) {
        positions[i * 3 + 1] -= speeds[i] * delta;
        if (positions[i * 3 + 1] < -2) {
          positions[i * 3 + 1] = 44 + Math.random() * 4;
        }
      }
      this.rain.points.geometry.attributes.position.needsUpdate = true;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.clearCards();
    this.controls.dispose();
    this.rain?.points.geometry.dispose();
    this.rain?.points.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
