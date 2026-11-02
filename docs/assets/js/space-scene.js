/* WebGL observatory for the Space dashboard.
 *
 * A full-screen deep-space stage: a star field, soft nebulae, a ringed planet,
 * a hero frame that holds NASA's Astronomy Picture of the Day, and a curved
 * orbit rail of the other days in the window. Everything visible is drawn with
 * Three.js; the HTML panel is the accessible mirror of the selected picture.
 *
 * Photos are loaded as CORS textures. NASA serves
 * `Access-Control-Allow-Origin: *` on its image hosts. If a texture cannot be
 * loaded (offline, blocked, or an old host without CORS), the frame keeps a
 * procedurally drawn card with the title and date instead of a broken plane.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatShortDate, formatDate, mediaLabel } from "./space-data.js?v=20261106-1";

const PLATE_WIDTH = 1.62;
const PLATE_HEIGHT = 1.01;
const MAX_PLATES = 10;
const HERO_LIMITS = {
  wide: { width: 9.2, height: 5.2 },
  medium: { width: 7.4, height: 4.6 },
  narrow: { width: 8.6, height: 5.4 },
};
const CAMERAS = {
  hero: {
    wide: { pos: [0, 2.6, 16.5], target: [0.2, 0.7, 0] },
    medium: { pos: [0, 2.8, 17], target: [0.2, 0.7, 0] },
    narrow: { pos: [0, 3.6, 19], target: [0, 0.1, 0] },
  },
  wide: {
    wide: { pos: [0, 9.5, 27], target: [0.2, 0.2, 0] },
    medium: { pos: [0, 9.5, 27], target: [0.2, 0.2, 0] },
    narrow: { pos: [0, 8.5, 24], target: [0, 2.2, 0] },
  },
  close: {
    wide: { pos: [0, 1.4, 10], target: [0.2, 0.8, 0] },
    medium: { pos: [0, 1.4, 10], target: [0.2, 0.8, 0] },
    narrow: { pos: [0, 4.8, 12], target: [0, 4.4, 0] },
  },
};

const CONTENT = {
  dark: {
    bg: 0x04060f,
    accent: 0x9d8cff,
    accent2: 0x5be8ff,
    gold: 0xffd479,
    starOpacity: 0.95,
    nebulaOpacity: 0.24,
    ringOpacity: 0.42,
    planet: 0x1b2350,
    panel: "rgba(10, 13, 28, 0.92)",
    text: "#eceaff",
    muted: "#9a94c4",
    faint: "#6b6590",
    starColors: [0xffffff, 0xd8e6ff, 0xc0b4ff, 0x9df0ff],
    plateTop: "#1a1f46",
    plateBottom: "#070a18",
  },
  light: {
    bg: 0xe9ecf8,
    accent: 0x5b46c8,
    accent2: 0x147fa8,
    gold: 0xa86900,
    starOpacity: 0.5,
    nebulaOpacity: 0.18,
    ringOpacity: 0.32,
    planet: 0xaeb8dd,
    panel: "rgba(255, 255, 255, 0.94)",
    text: "#171436",
    muted: "#575180",
    faint: "#7d78a0",
    starColors: [0x3b3470, 0x5b4ba8, 0x147fa8, 0x8a80c0],
    plateTop: "#d8dcf2",
    plateBottom: "#f4f5fc",
  },
};

function hexOf(number) {
  return `#${number.toString(16).padStart(6, "0")}`;
}

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeGlowTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.35, "rgba(255, 255, 255, 0.55)");
  gradient.addColorStop(0.7, "rgba(255, 255, 255, 0.12)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) return lines;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function drawStarField(ctx, width, height, theme, rand, count) {
  for (let i = 0; i < count; i += 1) {
    const x = rand() * width;
    const y = rand() * height;
    const radius = rand() * 1.5 + 0.3;
    const alpha = 0.2 + rand() * 0.6;
    ctx.fillStyle = theme === "dark" ? `rgba(226, 232, 255, ${alpha})` : `rgba(60, 52, 120, ${alpha * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function makeHeroCard(entry, themeName) {
  const theme = CONTENT[themeName];
  const width = 1200;
  const height = 676;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const rand = seededRandom(hashText(entry.date + entry.title));

  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, themeName === "dark" ? "#0b1030" : "#e5e8fa");
  base.addColorStop(0.55, themeName === "dark" ? "#050714" : "#f4f5fd");
  base.addColorStop(1, themeName === "dark" ? "#120a2a" : "#dfe3f5");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  drawStarField(ctx, width, height, themeName, rand, 220);

  // Nebula wash.
  const nebula = ctx.createRadialGradient(width * 0.68, height * 0.32, 0, width * 0.68, height * 0.32, width * 0.46);
  nebula.addColorStop(0, themeName === "dark" ? "rgba(120, 96, 255, 0.34)" : "rgba(91, 70, 200, 0.16)");
  nebula.addColorStop(0.55, themeName === "dark" ? "rgba(64, 170, 255, 0.12)" : "rgba(20, 127, 168, 0.08)");
  nebula.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = nebula;
  ctx.fillRect(0, 0, width, height);

  // Planet limb.
  ctx.save();
  ctx.beginPath();
  ctx.arc(width * 0.82, height * 1.18, width * 0.34, 0, Math.PI * 2);
  const planet = ctx.createLinearGradient(0, height * 0.7, 0, height);
  planet.addColorStop(0, themeName === "dark" ? "#2b2f6b" : "#b9c1e6");
  planet.addColorStop(1, themeName === "dark" ? "#0a0d22" : "#8f97c9");
  ctx.fillStyle = planet;
  ctx.fill();
  ctx.restore();

  // Frame rules.
  ctx.strokeStyle = themeName === "dark" ? "rgba(157, 140, 255, 0.55)" : "rgba(91, 70, 200, 0.45)";
  ctx.lineWidth = 3;
  ctx.strokeRect(34, 34, width - 68, height - 68);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "700 24px 'Courier New', monospace";
  ctx.fillStyle = hexOf(theme.accent);
  ctx.fillText("NASA · ASTRONOMY PICTURE OF THE DAY", 72, 104);

  ctx.font = "500 22px 'Courier New', monospace";
  ctx.fillStyle = theme.muted;
  ctx.fillText(formatDate(entry.date), 72, 148);

  ctx.font = "700 62px 'Segoe UI', system-ui, -apple-system, sans-serif";
  ctx.fillStyle = theme.text;
  const lines = wrapText(ctx, entry.title, width - 160, 3);
  let y = height - 150 - (lines.length - 1) * 68;
  for (const line of lines) {
    ctx.fillText(line, 72, y);
    y += 70;
  }

  ctx.font = "600 22px 'Courier New', monospace";
  ctx.fillStyle = hexOf(theme.gold);
  const kind = mediaLabel(entry).toUpperCase();
  ctx.fillText(entry.mediaType === "video" ? `► ${kind} · OPEN ON NASA` : `${kind} · PREVIEW`, 72, height - 56);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function makePlateCard(entry, themeName) {
  const theme = CONTENT[themeName];
  const width = 512;
  const height = 320;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const rand = seededRandom(hashText(entry.date + entry.title));
  const hue = (hashText(entry.title) % 360) / 360;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, themeName === "dark" ? `hsl(${Math.round(hue * 360)}, 46%, 22%)` : theme.plateTop);
  gradient.addColorStop(1, theme.plateBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  drawStarField(ctx, width, height, themeName, rand, 70);

  const glow = ctx.createRadialGradient(width * 0.7, height * 0.3, 0, width * 0.7, height * 0.3, width * 0.5);
  glow.addColorStop(0, themeName === "dark" ? "rgba(157, 140, 255, 0.36)" : "rgba(91, 70, 200, 0.18)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = themeName === "dark" ? "rgba(255, 255, 255, 0.16)" : "rgba(60, 52, 120, 0.22)";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, width - 20, height - 20);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = "600 20px 'Courier New', monospace";
  ctx.fillStyle = entry.mediaType === "video" ? hexOf(theme.gold) : hexOf(theme.accent);
  ctx.fillText(entry.mediaType === "video" ? "► VIDEO" : "APOD", 26, 46);

  ctx.textAlign = "right";
  ctx.fillStyle = theme.muted;
  ctx.fillText(formatShortDate(entry.date), width - 26, 46);

  ctx.textAlign = "left";
  ctx.font = "700 29px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = theme.text;
  const lines = wrapText(ctx, entry.title, width - 52, 3);
  let y = 108;
  for (const line of lines) {
    ctx.fillText(line, 26, y);
    y += 34;
  }

  ctx.font = "500 18px 'Courier New', monospace";
  ctx.fillStyle = theme.faint;
  ctx.fillText(entry.mediaType === "video" ? "video · click to focus" : "image · click to focus", 26, height - 28);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function makePlanetTexture() {
  const width = 512;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const base = ctx.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, "#2a3270");
  base.addColorStop(0.45, "#1b2350");
  base.addColorStop(1, "#0a0e25");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  const rand = seededRandom(7);
  for (let i = 0; i < 26; i += 1) {
    const y = rand() * height;
    const bandHeight = 3 + rand() * 12;
    ctx.fillStyle = `rgba(${120 + Math.round(rand() * 60)}, ${130 + Math.round(rand() * 50)}, 230, ${0.05 + rand() * 0.1})`;
    ctx.fillRect(0, y, width, bandHeight);
  }
  ctx.fillStyle = "rgba(255, 212, 121, 0.08)";
  ctx.fillRect(0, height * 0.52, width, height * 0.1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function cropTexture(source, aspect) {
  const texture = source.clone();
  texture.needsUpdate = true;
  const image = texture.image;
  const imageAspect = image && image.width && image.height ? image.width / image.height : aspect;
  if (imageAspect > aspect) {
    const repeat = aspect / imageAspect;
    texture.repeat.set(repeat, 1);
    texture.offset.set((1 - repeat) / 2, 0);
  } else {
    const repeat = imageAspect / aspect;
    texture.repeat.set(1, repeat);
    texture.offset.set(0, (1 - repeat) / 2);
  }
  return texture;
}

export class SpaceScene {
  constructor(container, { onHover, onSelect, onOpen } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onOpen = onOpen || (() => {});

    this.theme = "dark";
    this.mode = "wide";
    this.entries = [];
    this.plates = [];
    this.selectedDate = null;
    this.currentEntry = null;
    this.heroToken = 0;
    this.plateToken = 0;
    this.textures = new Map();
    this.pending = new Map();
    this.fallbackCards = new Map();
    this.plateCards = new Map();

    this.clock = new THREE.Clock();
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.glowTexture = makeGlowTexture();

    this.initRenderer();
    this.initScene();
    this.initStars();
    this.initNebulae();
    this.initPlanet();
    this.initHero();
    this.initRail();
    this.initInteraction();
    this.updateMode();
    this.setTheme(this.theme);
  }

  /* ---------- Setup ---------- */

  initRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1);
    renderer.setClearColor(CONTENT.dark.bg, 1);
    renderer.domElement.classList.add("scene-canvas");
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(48, (this.container.clientWidth || 1) / (this.container.clientHeight || 1), 0.1, 400);
    this.camera.position.set(0, 2.6, 16.5);
    this.camera.lookAt(0.2, 0.7, 0);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 46;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = Math.PI - 0.35;
    this.controls.target.set(0.2, 0.7, 0);
    this.controls.autoRotateSpeed = 0.42;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    renderer.domElement.addEventListener("click", this.onClick.bind(this));
    renderer.domElement.addEventListener("pointermove", this.onPointerMove.bind(this));
    renderer.domElement.addEventListener("pointerleave", this.onPointerLeave.bind(this));

    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  initScene() {
    this.scene = new THREE.Scene();
  }

  initStars() {
    const count = 2600;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const paletteIndex = new Uint8Array(count);
    const rand = seededRandom(1337);
    for (let i = 0; i < count; i += 1) {
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const radius = 45 + rand() * 95;
      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
      positions[i * 3 + 1] = Math.cos(phi) * radius * 0.72;
      positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;
      paletteIndex[i] = Math.floor(rand() * CONTENT.dark.starColors.length);
    }
    this.starPalette = paletteIndex;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 1.5,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geometry, material);
    this.scene.add(this.stars);
    this.paintStars();
  }

  paintStars() {
    const theme = CONTENT[this.theme];
    const colors = this.stars.geometry.attributes.color.array;
    for (let i = 0; i < this.starPalette.length; i += 1) {
      const color = new THREE.Color(theme.starColors[this.starPalette[i] % theme.starColors.length]);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    this.stars.geometry.attributes.color.needsUpdate = true;
    this.stars.material.opacity = theme.starOpacity;
  }

  initNebulae() {
    const colors = [0x9d8cff, 0x3ea8ff, 0xffd479];
    const spots = [
      [-34, 12, -62, 78],
      [36, -10, -74, 96],
      [4, 26, -84, 70],
    ];
    this.nebulae = [];
    spots.forEach(([x, y, z, scale], index) => {
      const material = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: colors[index],
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(scale);
      this.scene.add(sprite);
      this.nebulae.push(sprite);
    });
  }

  initPlanet() {
    const geometry = new THREE.SphereGeometry(14, 56, 56);
    const material = new THREE.MeshBasicMaterial({ map: makePlanetTexture(), color: 0xffffff });
    this.planet = new THREE.Mesh(geometry, material);
    this.planet.position.set(32, -17, -46);
    this.scene.add(this.planet);

    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0x6f7dff,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    halo.position.copy(this.planet.position);
    halo.scale.setScalar(52);
    this.scene.add(halo);
    this.planetHalo = halo;

    const ringGeometry = new THREE.RingGeometry(18, 24, 96);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd479,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.planetRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.planetRing.position.copy(this.planet.position);
    this.planetRing.rotation.set(-1.15, 0.4, 0.2);
    this.scene.add(this.planetRing);
  }

  initHero() {
    this.heroGroup = new THREE.Group();
    this.heroGroup.position.set(1.3, 1.15, 0);
    this.heroBaseY = 1.15;
    this.scene.add(this.heroGroup);

    this.heroGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.glowTexture,
        color: CONTENT.dark.accent,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.heroGlow.position.z = -0.3;
    this.heroGroup.add(this.heroGlow);

    this.heroImage = new THREE.Mesh(
      new THREE.PlaneGeometry(9.2, 5.175),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    );
    this.heroGroup.add(this.heroImage);

    const rect = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -0.5, 0),
      new THREE.Vector3(0.5, -0.5, 0),
      new THREE.Vector3(0.5, 0.5, 0),
      new THREE.Vector3(-0.5, 0.5, 0),
    ]);
    this.heroFrame = new THREE.LineLoop(
      rect,
      new THREE.LineBasicMaterial({ color: CONTENT.dark.accent, transparent: true, opacity: 0.8 })
    );
    this.heroFrame.position.z = 0.02;
    this.heroGroup.add(this.heroFrame);

    this.heroFrameOuter = new THREE.LineLoop(
      rect.clone(),
      new THREE.LineBasicMaterial({ color: CONTENT.dark.gold, transparent: true, opacity: 0.25 })
    );
    this.heroFrameOuter.position.z = 0.01;
    this.heroGroup.add(this.heroFrameOuter);

    this.scanLine = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: CONTENT.dark.accent2,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.scanLine.position.z = 0.03;
    this.heroGroup.add(this.scanLine);

    this.heroSize = { width: 9.2, height: 5.175 };
  }

  initRail() {
    this.railGroup = new THREE.Group();
    this.scene.add(this.railGroup);
  }

  initInteraction() {
    this.controls.addEventListener("start", () => {
      this.renderer.domElement.style.cursor = "grabbing";
    });
    this.controls.addEventListener("end", () => {
      this.renderer.domElement.style.cursor = "grab";
    });
  }

  /* ---------- Viewport ---------- */

  updateMode() {
    const width = this.container.clientWidth || window.innerWidth;
    const next = width <= 760 ? "narrow" : width <= 1180 ? "medium" : "wide";
    if (next === this.mode && this.initialized) return;
    this.initialized = true;
    this.mode = next;
    this.applyLayout();
  }

  applyLayout() {
    const limits = HERO_LIMITS[this.mode];
    this.heroGroup.position.x = this.mode === "wide" ? 1.3 : this.mode === "medium" ? 3 : 0;
    this.heroBaseY = this.mode === "narrow" ? 4.4 : 1.15;
    this.heroGroup.position.y = this.heroBaseY;
    this.heroMax = limits;
    // The fanned rail needs the free column beside the panel; below that the
    // accessible orbit index is the selector and the hero carries the 3D.
    this.railGroup.visible = this.mode === "wide";
    this.railGroup.position.x = this.mode === "wide" ? 2.4 : this.mode === "medium" ? 1.4 : 0;
    this.layoutPlates();
    this.focusCamera("hero");
    if (this.currentTexture) this.applyHeroSize(this.currentTexture);
  }

  /* ---------- Public API ---------- */

  setEntries(entries, selectedDate) {
    this.entries = entries || [];
    this.selectedDate = selectedDate || this.entries[this.entries.length - 1]?.date || null;
    this.rebuildPlates();
    this.selectEntry(this.selectedDate);
    this.prefetchPlates();
  }

  setSelected(date) {
    if (!date || date === this.selectedDate) return;
    this.selectEntry(date);
    this.prefetchPlates();
  }

  setTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    this.theme = next;
    const content = CONTENT[next];
    this.renderer.setClearColor(content.bg, 1);
    this.scene.background = new THREE.Color(content.bg);
    this.heroGlow.material.color.setHex(content.accent);
    this.heroFrame.material.color.setHex(content.accent);
    this.heroFrameOuter.material.color.setHex(content.gold);
    this.scanLine.material.color.setHex(content.accent2);
    this.heroImage.material.color.setHex(0xffffff);
    this.paintStars();
    for (const sprite of this.nebulae) sprite.material.opacity = content.nebulaOpacity;
    this.planet.material.color.setHex(next === "light" ? 0xd8ddf0 : 0xffffff);
    this.planetHalo.material.color.setHex(next === "light" ? 0x9d8cff : 0x6f7dff);
    this.planetHalo.material.opacity = next === "light" ? 0.18 : 0.34;
    this.planetRing.material.color.setHex(content.gold);
    this.planetRing.material.opacity = next === "light" ? 0.1 : 0.16;
    for (const texture of this.fallbackCards.values()) texture.dispose();
    for (const texture of this.plateCards.values()) texture.dispose();
    this.fallbackCards.clear();
    this.plateCards.clear();
    this.rebuildPlates();
    if (this.currentEntry) {
      const loaded = this.currentEntry.imageUrl ? this.textures.get(this.currentEntry.imageUrl) : null;
      const texture = loaded && loaded.isTexture ? loaded : this.cardFor(this.currentEntry);
      this.heroImage.material.map = texture;
      this.heroImage.material.needsUpdate = true;
      this.applyHeroSize(texture);
    }
    this.prefetchPlates();
  }

  setOrbit(enabled) {
    this.controls.autoRotate = Boolean(enabled) && !this.reducedMotion;
  }

  focusCamera(preset = "hero") {
    const presets = CAMERAS[preset] || CAMERAS.hero;
    const shot = presets[this.mode] || presets.wide;
    this.camera.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
    this.controls.target.set(shot.target[0], shot.target[1], shot.target[2]);
    this.controls.update();
  }

  /* ---------- Hero ---------- */

  selectEntry(date) {
    const entry = this.entries.find((item) => item.date === date) || null;
    if (!entry) return;
    this.selectedDate = entry.date;
    this.currentEntry = entry;

    const cached = this.textures.get(entry.imageUrl);
    if (cached) {
      this.currentTexture = cached;
      this.heroImage.material.map = cached;
      this.heroImage.material.needsUpdate = true;
      this.applyHeroSize(cached);
    } else {
      const card = this.cardFor(entry);
      this.currentTexture = null;
      this.heroImage.material.map = card;
      this.heroImage.material.needsUpdate = true;
      this.applyHeroSize(card);
      if (entry.imageUrl) this.loadHero(entry);
    }

    this.applyPlateSelection();
  }

  loadHero(entry) {
    const token = ++this.heroToken;
    this.loadTexture(entry.imageUrl).then((texture) => {
      if (this.disposed || token !== this.heroToken || !texture) return;
      if (this.currentEntry?.date !== entry.date) return;
      this.currentTexture = texture;
      this.heroImage.material.map = texture;
      this.heroImage.material.needsUpdate = true;
      this.applyHeroSize(texture);
    });
  }

  cardFor(entry) {
    const key = `${this.theme}:${entry.date}`;
    if (!this.fallbackCards.has(key)) this.fallbackCards.set(key, makeHeroCard(entry, this.theme));
    return this.fallbackCards.get(key);
  }

  applyHeroSize(texture) {
    const limits = this.heroMax || HERO_LIMITS[this.mode];
    const image = texture?.image;
    const aspect = image && image.width && image.height ? image.width / image.height : 16 / 9;
    let width = limits.width;
    let height = width / aspect;
    if (height > limits.height) {
      height = limits.height;
      width = height * aspect;
    }
    this.heroSize = { width, height };
    this.heroImage.geometry.dispose();
    this.heroImage.geometry = new THREE.PlaneGeometry(width, height);
    this.heroGlow.scale.set(width * 1.5, height * 1.7, 1);
    this.heroFrame.scale.set(width + 0.16, height + 0.16, 1);
    this.heroFrameOuter.scale.set(width + 0.42, height + 0.42, 1);
    this.scanLine.scale.set(width, 0.055, 1);
  }

  /* ---------- Rails ---------- */

  rebuildPlates() {
    this.clearPlates();
    this.entries.slice(-MAX_PLATES).forEach((entry) => {
      const material = new THREE.MeshBasicMaterial({ map: this.plateCardFor(entry), toneMapped: false });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_WIDTH, PLATE_HEIGHT), material);
      plate.userData.date = entry.date;
      plate.userData.entry = entry;
      this.railGroup.add(plate);
      this.plates.push(plate);
    });
    this.layoutPlates();
    this.applyPlateSelection();
  }

  plateCardFor(entry) {
    const key = `${this.theme}:${entry.date}`;
    if (!this.plateCards.has(key)) this.plateCards.set(key, makePlateCard(entry, this.theme));
    return this.plateCards.get(key);
  }

  layoutPlates() {
    const count = this.plates.length;
    if (!count) return;
    const span = this.mode === "medium" ? 1.35 : 1.55;
    const radius = this.mode === "medium" ? 6.8 : 7.6;
    this.plates.forEach((plate, index) => {
      const t = count === 1 ? 0.5 : index / (count - 1);
      const angle = -span / 2 + span * t;
      const x = Math.sin(angle) * radius;
      const z = 2.7 + Math.cos(angle) * radius * 0.34;
      const y = -2.45 + Math.cos(angle) * 0.42;
      plate.userData.baseY = y;
      plate.userData.index = index;
      plate.position.set(x, y, z);
      plate.rotation.y = -angle * 0.55;
      plate.rotation.x = this.mode === "medium" ? 0.04 : 0.02;
    });
  }

  applyPlateSelection() {
    for (const plate of this.plates) {
      const active = plate.userData.date === this.selectedDate;
      const scale = active ? 1.16 : 1;
      plate.scale.setScalar(scale);
      plate.userData.active = active;
    }
  }

  clearPlates() {
    for (const plate of this.plates) {
      this.railGroup.remove(plate);
      plate.userData.croppedMap?.dispose();
      plate.geometry.dispose();
      plate.material.dispose();
    }
    this.plates = [];
  }

  prefetchPlates() {
    const token = ++this.plateToken;
    const pending = this.plates
      .map((plate) => plate.userData.entry)
      .filter((entry) => entry && entry.imageUrl && !this.textures.has(entry.imageUrl));
    const run = async () => {
      for (const entry of pending) {
        if (this.disposed || token !== this.plateToken) return;
        const texture = await this.loadTexture(entry.imageUrl);
        if (!texture || this.disposed || token !== this.plateToken) continue;
        const plate = this.plates.find((item) => item.userData.date === entry.date);
        if (!plate) continue;
        const cropped = cropTexture(texture, PLATE_WIDTH / PLATE_HEIGHT);
        plate.userData.croppedMap = cropped;
        plate.material.map = cropped;
        plate.material.needsUpdate = true;
      }
    };
    run();
  }

  /* ---------- Textures ---------- */

  loadTexture(url) {
    if (!url) return Promise.resolve(null);
    if (this.textures.has(url)) return Promise.resolve(this.textures.get(url));
    if (this.pending.has(url)) return this.pending.get(url);
    const promise = new Promise((resolve) => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      loader.load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
          resolve(texture);
        },
        undefined,
        () => resolve(null)
      );
    }).then((texture) => {
      this.textures.set(url, texture);
      this.pending.delete(url);
      return texture;
    });
    this.pending.set(url, promise);
    return promise;
  }

  /* ---------- Interaction ---------- */

  onClick(event) {
    const hits = this.pick(event);
    const first = hits[0]?.object;
    if (first?.userData?.date) {
      this.setSelected(first.userData.date);
      this.onSelect(first.userData.date);
      return;
    }
    if (first === this.heroImage && this.currentEntry) {
      this.onOpen(this.currentEntry);
    }
  }

  onPointerMove(event) {
    const hits = this.pick(event);
    const first = hits[0]?.object;
    const date = first?.userData?.date || null;
    const entry = date ? this.entries.find((item) => item.date === date) : first === this.heroImage ? this.currentEntry : null;
    this.renderer.domElement.style.cursor = entry ? "pointer" : "grab";
    this.onHover(entry, event);
  }

  onPointerLeave() {
    this.renderer.domElement.style.cursor = "grab";
    this.onHover(null, null);
  }

  pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = this.railGroup.visible ? [...this.plates, this.heroImage] : [this.heroImage];
    return this.raycaster.intersectObjects(targets, false);
  }

  /* ---------- Loop ---------- */

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.updateMode();
  }

  loop() {
    if (this.disposed) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    if (!this.reducedMotion) {
      this.stars.rotation.y += delta * 0.008;
      this.planet.rotation.y += delta * 0.012;
      this.planetRing.rotation.z += delta * 0.004;
      this.heroGroup.position.y = this.heroBaseY + Math.sin(t * 0.62) * 0.055;
      this.heroGlow.material.opacity = 0.36 + Math.sin(t * 1.15) * 0.06;
      const span = this.heroSize.height;
      this.scanLine.position.y = ((t * 0.22) % 1 - 0.5) * span;
      for (const plate of this.plates) {
        const wobble = Math.sin(t * 0.9 + (plate.userData.index || 0) * 0.55) * 0.05;
        plate.position.y = (plate.userData.baseY || -2.45) + wobble;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  dispose() {
    this.disposed = true;
    this.plateToken += 1;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.clearPlates();
    for (const texture of this.fallbackCards.values()) texture.dispose();
    for (const texture of this.plateCards.values()) texture.dispose();
    for (const texture of this.textures.values()) {
      if (texture && texture.isTexture) texture.dispose();
    }
    this.textures.clear();
    this.controls.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.heroImage.geometry.dispose();
    this.heroImage.material.dispose();
    this.heroGlow.material.dispose();
    this.scanLine.geometry.dispose();
    this.scanLine.material.dispose();
    this.heroFrame.geometry.dispose();
    this.heroFrame.material.dispose();
    this.heroFrameOuter.geometry.dispose();
    this.heroFrameOuter.material.dispose();
    this.planet.geometry.dispose();
    this.planet.material.dispose();
    this.planetRing.geometry.dispose();
    this.planetRing.material.dispose();
    this.planetHalo.material.dispose();
    for (const sprite of this.nebulae) sprite.material.dispose();
    this.glowTexture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
