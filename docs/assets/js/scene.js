/* WebGL stage: instanced price columns on a reflective grid, with camera
   presets, hover picking, replay dimming, and a theme-aware bloom pass. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { laneLabel, laneOf, pointKey } from "./data.js?v=20261029-2";

const STAGE_WIDTH = 30;
const MAX_HEIGHT = 13;
const LANE_GAP = 3.4;
const REVEAL_MS = 620;
const STAGGER_MS = 260;
const MAX_RENDER_BARS = 12000;

const THEMES = {
  dark: {
    background: 0x05080f,
    floor: 0x070c16,
    gridA: 0x2b4d70,
    gridB: 0x142235,
    fog: 0x05080f,
    fogDensity: 0.016,
    hemiSky: 0x8fd8ff,
    hemiGround: 0x05070c,
    hemiIntensity: 0.55,
    key: 0xffffff,
    keyIntensity: 1.15,
    pointA: 0x4cd7ff,
    pointB: 0xffb24d,
    pointIntensity: 42,
    particle: 0x9be6ff,
    particleOpacity: 0.5,
    bloom: 0.52,
    exposure: 1.06,
    glow: 0x4cd7ff,
    glowOpacity: 0.32,
  },
  light: {
    background: 0xe9eef6,
    floor: 0xccd8e8,
    gridA: 0x54749c,
    gridB: 0x9db1c8,
    fog: 0xe9eef6,
    fogDensity: 0.011,
    hemiSky: 0xffffff,
    hemiGround: 0xa8b7cb,
    hemiIntensity: 0.8,
    key: 0xffffff,
    keyIntensity: 1.2,
    pointA: 0x3a8fc4,
    pointB: 0xcf8f3f,
    pointIntensity: 20,
    particle: 0x6f9cc9,
    particleOpacity: 0.22,
    bloom: 0.14,
    exposure: 0.98,
    glow: 0x3a8fc4,
    glowOpacity: 0.14,
  },
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function clockLabel(ms, spanMs) {
  const date = new Date(ms);
  if (spanMs > 36 * 3600 * 1000) {
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  }
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

function makeGlowTexture() {  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.28)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class PriceScene {
  constructor(container, { onHover, onSelect, onCamera } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});

    this.theme = "dark";
    this.bars = [];
    this.byKey = new Map();
    this.model = null;
    this.playhead = null;
    this.hoverKey = null;
    this.selectedKey = null;
    this.animating = false;
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.tween = null;
    this.pointerDown = null;
    this.idleTimer = 0;
    this.clock = new THREE.Clock();
    this.disposed = false;
    this.hasBloom = true;

    this.initRenderer();
    this.initScene();
    this.initLights();
    this.initFloor();
    this.initParticles();
    this.initOutline();
    this.initInteraction();
    this.resize();
    this.setTheme("dark");
    this.animate();
  }

  /* ---------------- setup ---------------- */

  initRenderer() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
    this.camera.position.set(0, 16, 34);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 170;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.target.set(0, 3.4, 0);
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 0.32;
    this.controls.enablePan = true;
    this.controls.panSpeed = 0.6;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 0.72);
    this.composer.addPass(this.bloomPass);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  initScene() {
    this.scene.background = new THREE.Color(THEMES.dark.background);
    this.scene.fog = new THREE.FogExp2(THEMES.dark.fog, THEMES.dark.fogDensity);
    this.barGroup = new THREE.Group();
    this.scene.add(this.barGroup);

    this.labels = [];
    this.timeLabels = [];
  }
  initLights() {
    this.hemi = new THREE.HemisphereLight(0x8fd8ff, 0x05070c, 0.48);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 0.95);
    this.key.position.set(12, 24, 14);
    this.scene.add(this.key);

    this.fill = new THREE.DirectionalLight(0xbfe9ff, 0.35);
    this.fill.position.set(0, 8, 28);
    this.scene.add(this.fill);

    this.pointA = new THREE.PointLight(0x4cd7ff, 55, 70, 2);
    this.pointA.position.set(-16, 9, 12);
    this.scene.add(this.pointA);

    this.pointB = new THREE.PointLight(0xffb24d, 32, 70, 2);
    this.pointB.position.set(17, 7, -10);
    this.scene.add(this.pointB);
  }

  initFloor() {
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 140),
      new THREE.MeshStandardMaterial({ color: 0x070c16, metalness: 0.62, roughness: 0.44 })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.03;
    this.scene.add(this.floor);

    this.grid = new THREE.GridHelper(96, 48, 0x5088b8, 0x233a55);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.8;
    this.grid.position.y = 0.004;
    this.scene.add(this.grid);

    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(86, 86),
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        color: 0x4cd7ff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.0015;
    this.scene.add(this.glow);

    this.nowRing = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.78, 56),
      new THREE.MeshBasicMaterial({
        color: 0x4cd7ff,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.nowRing.rotation.x = -Math.PI / 2;
    this.nowRing.position.y = 0.012;
    this.nowRing.visible = false;
    this.scene.add(this.nowRing);
  }

  initParticles() {
    const count = window.innerWidth < 720 ? 240 : 520;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 30 + 1;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 70;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.particles = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x9be6ff,
        size: 0.1,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
    );
    this.scene.add(this.particles);
  }

  initOutline() {
    const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.outline = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false })
    );
    this.outline.visible = false;
    this.outline.renderOrder = 5;
    this.scene.add(this.outline);
  }

  initInteraction() {
    const dom = this.renderer.domElement;
    this.onPointerMove = (event) => this.handlePointerMove(event);
    this.onPointerDown = (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
      this.cancelTween();
      this.controls.autoRotate = false;
    };
    this.onPointerUp = (event) => this.handlePointerUp(event);
    this.onPointerLeave = () => {
      this.hoverKey = null;
      this.updateOutline();
      this.onHover(null);
    };
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("pointerleave", this.onPointerLeave);

    this.controls.addEventListener("start", () => {
      this.cancelTween();
      this.controls.autoRotate = false;
      clearTimeout(this.idleTimer);
    });
    this.controls.addEventListener("end", () => {
      clearTimeout(this.idleTimer);
      const hint = document.getElementById("scene-hint");
      if (hint) hint.classList.add("is-hidden");
    });
  }

  /* ---------------- theme ---------------- */

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    const palette = THEMES[this.theme];
    this.palette = palette;
    this.scene.background.setHex(palette.background);
    this.scene.fog.color.setHex(palette.fog);
    this.scene.fog.density = palette.fogDensity;
    this.floor.material.color.setHex(palette.floor);
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.grid = new THREE.GridHelper(96, 48, palette.gridA, palette.gridB);
    this.grid.material.transparent = true;
    this.grid.material.opacity = this.theme === "light" ? 0.55 : 0.8;
    this.grid.position.y = 0.004;
    this.scene.add(this.grid);
    this.glow.material.color.setHex(palette.glow);
    this.glow.material.opacity = palette.glowOpacity * 0.55;
    this.particles.material.color.setHex(palette.particle);
    this.particles.material.opacity = palette.particleOpacity;
    this.hemi.color.setHex(palette.hemiSky);
    this.hemi.groundColor.setHex(palette.hemiGround);
    this.hemi.intensity = palette.hemiIntensity;
    this.key.intensity = palette.keyIntensity;
    this.pointA.color.setHex(palette.pointA);
    this.pointA.intensity = palette.pointIntensity;
    this.pointB.color.setHex(palette.pointB);
    this.pointB.intensity = palette.pointIntensity * 0.62;
    this.renderer.toneMappingExposure = palette.exposure;
    this.nowRing.material.color.setHex(palette.pointA);

    const bloomScale = this.hasBloom ? 1 : 0;
    this.bloomPass.strength = palette.bloom * bloomScale;
    this.bloomPass.enabled = this.hasBloom;

    if (this.model) this.rebuildBars(false);
  }

  /* ---------------- model ---------------- */

  setModel(model, { animate = true } = {}) {
    this.model = model;
    this.playhead = model.playhead ?? null;
    this.selectedKey = model.selected || null;
    this.rebuildBars(animate);
  }

  rebuildBars(animate = true) {
    const model = this.model;
    if (!model) return;

    this.disposeBars();
    const sourcePoints = model.points || [];
    if (!sourcePoints.length) {
      this.layoutState = null;
      this.laneSpan = 0;
      for (const label of this.labels) label.element.remove();
      this.labels = [];
      for (const label of this.timeLabels) label.element.remove();
      this.timeLabels = [];
      this.nowRing.visible = false;
      this.updateOutline();
      return;
    }
    // Drawing one column per reading stops being meaningful long before the
    // 80k-row contract cap. Sample per lane for the 3D stage only; KPIs,
    // charts, and the focus panel still use every row.
    const points = this.sampleForRender(sourcePoints);

    const lanes = model.lanes?.length
      ? model.lanes
      : [...new Set(points.map((point) => point.l || laneOf(point)))];
    const laneIndex = new Map(lanes.map((lane, index) => [lane, index]));
    this.laneGap = lanes.length <= 2 ? LANE_GAP : Math.max(0.62, Math.min(LANE_GAP, 34 / (lanes.length - 1)));
    const layout = this.layout(points, lanes);
    this.layoutState = layout;
    const laneSpan = layout.laneSpan;
    this.laneSpan = laneSpan;
    this.syncLaneLabels(lanes, model.colors || {});
    this.syncTimeLabels(layout, lanes);

    const frameZ = laneSpan / 2 + 1.5;
    const framePoints = [
      new THREE.Vector3(-STAGE_WIDTH / 2 - 1.1, 0.02, -frameZ),
      new THREE.Vector3(STAGE_WIDTH / 2 + 1.1, 0.02, -frameZ),
      new THREE.Vector3(STAGE_WIDTH / 2 + 1.1, 0.02, frameZ),
      new THREE.Vector3(-STAGE_WIDTH / 2 - 1.1, 0.02, frameZ),
      new THREE.Vector3(-STAGE_WIDTH / 2 - 1.1, 0.02, -frameZ),
    ];
    const frame = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(framePoints),
      new THREE.LineBasicMaterial({
        color: this.theme === "light" ? 0x0a84b8 : 0x4cd7ff,
        transparent: true,
        opacity: 0.28,
      })
    );
    this.barGroup.add(frame);

    // Thin lane rails keep the two feeds legible even when history is sparse.
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const rail = new THREE.Mesh(
        new THREE.PlaneGeometry(STAGE_WIDTH + 1.4, 0.045),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(model.colors?.[lanes[lane]] || "#9fb2cc"),
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      rail.rotation.x = -Math.PI / 2;
      rail.position.set(0, 0.009, layout.z(lane));
      this.barGroup.add(rail);
    }

    const count = points.length;
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.05,
      envMapIntensity: 0.4,
    });
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;

    const capMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const capMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), capMaterial, count);
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    capMesh.frustumCulled = false;

    const white = new THREE.Color(0xffffff);
    const lanePalette = new Map();
    for (const lane of lanes) lanePalette.set(lane, new THREE.Color(model.colors?.[lane] || "#9fb2cc"));
    const scratchColor = new THREE.Color();
    const scratchCap = new THREE.Color();
    const scratchMatrix = new THREE.Matrix4();
    const scratchPosition = new THREE.Vector3();
    const scratchScale = new THREE.Vector3();
    const scratchQuaternion = new THREE.Quaternion();
    const now = performance.now();
    const bars = [];

    for (let index = 0; index < count; index += 1) {
      const point = points[index];
      const lane = laneIndex.get(point.l || laneOf(point)) ?? 0;
      const value = point.v ?? point.p;
      const x = layout.x(point.t);
      const z = layout.z(lane);
      const ratio = layout.timeRatio(point.t);
      const barWidth = layout.barWidth(lane);

      let height;
      let direction = 1;
      if (value >= layout.base) {
        height = ((value - layout.base) / layout.range) * MAX_HEIGHT;
      } else {
        height = ((layout.base - value) / layout.range) * MAX_HEIGHT;
        direction = -1;
      }
      height = Math.max(0.05, Math.min(height, MAX_HEIGHT * 1.04));

      const baseColor = lanePalette.get(point.l || laneOf(point)) || lanePalette.get(lanes[lane]);
      const norm = Math.max(0, Math.min(1, (value - layout.domainMin) / Math.max(1e-9, layout.domainMax - layout.domainMin)));
      const lift = this.theme === "light" ? 0.02 + norm * 0.2 : 0.06 + norm * 0.34;
      const color = scratchColor.copy(baseColor).lerp(white, lift);
      const active = this.playhead == null || point.t <= this.playhead;
      const shownColor = active ? color : scratchCap.copy(color).multiplyScalar(0.2);

      const key = pointKey(point);
      const bar = {
        key,
        index,
        point,
        lane,
        x,
        z,
        width: barWidth,
        depth: Math.min(Math.max(barWidth * 1.9, 0.34), 2.1),
        height,
        direction,
        ratio,
        color: color.clone(),
        active,
        reveal: 0,
        vis: active ? 1 : 0.08,
        delay: ratio * STAGGER_MS,
      };
      bars.push(bar);
      this.byKey.set(key, bar);

      mesh.setColorAt(index, shownColor);
      const capColor = scratchCap.copy(color).lerp(white, 0.5);
      capMesh.setColorAt(index, active ? capColor : capColor.multiplyScalar(0.2));

      const sx = bar.width;
      const sy = Math.max(0.001, bar.height * bar.vis * (animate ? 0.001 : 1));
      const sz = bar.depth;
      scratchMatrix.compose(
        scratchPosition.set(bar.x, (bar.height * bar.vis * (animate ? 0.001 : 1) * bar.direction) / 2, bar.z),
        scratchQuaternion,
        scratchScale.set(sx, sy, sz)
      );
      mesh.setMatrixAt(index, scratchMatrix);
      capMesh.setMatrixAt(index, scratchMatrix);
    }

    mesh.instanceColor.needsUpdate = true;
    capMesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    capMesh.instanceMatrix.needsUpdate = true;

    this.barMesh = mesh;
    this.capMesh = capMesh;
    this.bars = bars;
    this.barGroup.add(mesh);
    this.barGroup.add(capMesh);

    this.reveal = {
      start: now,
      active: animate && !reducedMotion,
      duration: REVEAL_MS,
    };
    if (!this.reveal.active) {
      for (const bar of bars) bar.reveal = 1;
      this.applyBarMatrices();
    }

    // Newest reading marker on the floor.
    const latest = sourcePoints.reduce((acc, point) => (point.t > acc.t ? point : acc), sourcePoints[0]);
    this.nowRing.visible = true;
    this.nowRing.position.x = layout.x(latest.t);
    this.nowRing.position.z = laneSpan / 2 + 1.5;
    this.nowRing.userData.baseScale = 1;

    this.animating = true;
    this.updateOutline();
    if (!this.userHasOrbited && !this.cameraFramed) {
      this.updateCameraForAspect();
      this.cameraFramed = true;
    }
  }

  /** Even per-lane decimation for the instanced mesh, capped at MAX_RENDER_BARS. */
  sampleForRender(points) {
    if (points.length <= MAX_RENDER_BARS) return points;
    const counts = new Map();
    for (const point of points) {
      const lane = point.l || laneOf(point);
      counts.set(lane, (counts.get(lane) || 0) + 1);
    }
    const lanes = Math.max(1, counts.size);
    const perLane = Math.max(2, Math.floor(MAX_RENDER_BARS / lanes));
    const strides = new Map();
    for (const [lane, count] of counts) strides.set(lane, Math.max(1, Math.ceil(count / perLane)));
    const seen = new Map();
    const sampled = [];
    for (const point of points) {
      const lane = point.l || laneOf(point);
      const index = seen.get(lane) || 0;
      seen.set(lane, index + 1);
      if (index % strides.get(lane) === 0) sampled.push(point);
    }
    return sampled;
  }

  layout(points, lanes) {
    let tMin = Infinity;
    let tMax = -Infinity;
    let domainMin = Infinity;
    let domainMax = -Infinity;
    const laneCounts = new Map();

    for (const point of points) {
      if (point.t < tMin) tMin = point.t;
      if (point.t > tMax) tMax = point.t;
      const value = point.v ?? point.p;
      if (value < domainMin) domainMin = value;
      if (value > domainMax) domainMax = value;
      const lane = point.l || laneOf(point);
      laneCounts.set(lane, (laneCounts.get(lane) || 0) + 1);
    }

    if (this.model?.domain) {
      domainMin = Math.min(domainMin, this.model.domain.min);
      domainMax = Math.max(domainMax, this.model.domain.max);
    }
    if (domainMin === domainMax) {
      domainMin -= 1;
      domainMax += 1;
    }
    const base = this.model?.baseline === "zero" ? 0 : domainMin;
    const span = Math.max(1e-9, (this.model?.baseline === "zero" ? domainMax : domainMax - domainMin));
    const timeSpan = Math.max(1, tMax - tMin);
    const gap = this.laneGap || LANE_GAP;
    const laneSpan = (lanes.length - 1) * gap;

    return {
      tMin,
      tMax,
      timeSpan,
      laneSpan,
      domainMin,
      domainMax,
      base,
      range: span,
      x: (t) => -STAGE_WIDTH / 2 + ((t - tMin) / timeSpan) * STAGE_WIDTH,
      z: (lane) => -laneSpan / 2 + lane * gap,
      timeRatio: (t) => (t - tMin) / timeSpan,
      barWidth: (lane) => {
        const count = laneCounts.get(lanes[lane]) || 1;
        return Math.min(Math.max(STAGE_WIDTH / (count * 1.65), 0.11), 1.45);
      },
    };
  }

  applyBarMatrices() {
    if (!this.barMesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();

    for (const bar of this.bars) {
      const factor = bar.height * bar.vis * bar.reveal;
      position.set(bar.x, (factor * bar.direction) / 2, bar.z);
      scale.set(bar.width, Math.max(0.001, factor), bar.depth);
      matrix.compose(position, quaternion, scale);
      this.barMesh.setMatrixAt(bar.index, matrix);

      const capY = factor * bar.direction;
      position.set(bar.x, capY, bar.z);
      scale.set(bar.width * 1.015, 0.055, bar.depth * 1.015);
      matrix.compose(position, quaternion, scale);
      this.capMesh.setMatrixAt(bar.index, matrix);
    }

    this.barMesh.instanceMatrix.needsUpdate = true;
    this.capMesh.instanceMatrix.needsUpdate = true;
  }

  setPlayhead(ms) {
    this.playhead = ms;
    if (!this.bars.length) return;
    const white = this.capWhite || (this.capWhite = new THREE.Color(0xffffff));
    const scratch = this.capScratch || (this.capScratch = new THREE.Color());
    let changed = false;
    for (const bar of this.bars) {
      const active = ms == null || bar.point.t <= ms;
      const target = active ? 1 : 0.06;
      if (bar.active !== active) {
        bar.active = active;
        if (this.barMesh) {
          this.barMesh.setColorAt(bar.index, active ? bar.color : scratch.copy(bar.color).multiplyScalar(0.2));
          if (this.capMesh) {
            const cap = scratch.copy(bar.color).lerp(white, 0.5);
            this.capMesh.setColorAt(bar.index, active ? cap : cap.multiplyScalar(0.2));
          }
        }
        changed = true;
      }
      bar.targetVis = target;
    }
    if (changed) {
      if (this.barMesh?.instanceColor) this.barMesh.instanceColor.needsUpdate = true;
      if (this.capMesh?.instanceColor) this.capMesh.instanceColor.needsUpdate = true;
    }
    this.animating = true;
  }

  setSelected(key) {
    this.selectedKey = key || null;
    this.updateOutline();
  }

  setHover(key) {
    this.hoverKey = key || null;
    this.updateOutline();
  }

  updateOutline() {
    const key = this.selectedKey || this.hoverKey;
    const bar = key ? this.byKey.get(key) : null;
    if (!bar) {
      this.outline.visible = false;
      return;
    }
    this.outline.visible = true;
    this.outline.scale.set(bar.width * 1.03, Math.max(0.02, bar.height * bar.vis * bar.reveal) * 1.03, bar.depth * 1.03);
    this.outline.position.set(bar.x, (bar.height * bar.vis * bar.reveal * bar.direction) / 2, bar.z);
    this.outline.material.color.set(this.selectedKey === bar.key ? 0xffffff : 0x9be6ff);
    this.outline.material.opacity = this.selectedKey === bar.key ? 1 : 0.7;
  }

  /* ---------------- interaction ---------------- */

  pickAt(clientX, clientY) {
    if (!this.barMesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.barMesh, false);
    if (!hits.length) return null;
    const bar3d = hits[0];
    const bar = this.bars[bar3d.instanceId] || null;
    if (!bar) return null;
    // Skip occluded picks by confirming the point is in front of the bar center.
    const distance = this.camera.position.distanceTo(bar3d.point);
    const centerDistance = this.camera.position.distanceTo(new THREE.Vector3(bar.x, bar.height / 2, bar.z));
    if (distance > centerDistance + 4) return null;
    return bar;
  }

  handlePointerMove(event) {
    if (!this.barMesh) return;
    const now = performance.now();
    if (now - (this.lastPick || 0) < 26) return;
    this.lastPick = now;
    const bar = this.pickAt(event.clientX, event.clientY);
    if (bar) {
      this.hoverKey = bar.key;
      this.updateOutline();
      this.onHover(bar, event.clientX, event.clientY);
      this.renderer.domElement.style.cursor = "pointer";
    } else {
      if (this.hoverKey) {
        this.hoverKey = null;
        this.updateOutline();
      }
      this.onHover(null);
      this.renderer.domElement.style.cursor = "";
    }
  }

  handlePointerUp(event) {
    if (!this.pointerDown) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    this.pointerDown = null;
    if (moved > 6) return;
    // Re-pick on release so taps and clicks without a prior move still select a bar.
    const bar = this.pickAt(event.clientX, event.clientY);
    this.hoverKey = bar ? bar.key : this.hoverKey;
    this.updateOutline();
    this.onSelect(bar || null);
  }

  /* ---------------- camera ---------------- */

  frameDistance() {
    const aspect = this.camera.aspect || 1;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // Portrait viewports need a looser width fit, otherwise the columns shrink
    // into a thin band. Cropping the outermost bar edge is the better trade.
    const portrait = aspect < 0.85;
    const widthFactor = portrait ? 0.58 : 0.62;
    const widthDistance = (STAGE_WIDTH * widthFactor) / Math.tan(hFov / 2);
    const heightDistance = (MAX_HEIGHT * 0.85) / Math.tan(vFov / 2);
    const laneSpan = this.laneSpan || LANE_GAP;
    const depthDistance = ((laneSpan / 2 + 3) / Math.tan(vFov / 2)) * 1.35;
    const maxDistance = portrait ? 130 : 150;
    return Math.min(maxDistance, Math.max(22, Math.max(widthDistance, heightDistance, depthDistance)));
  }

  setCamera(name, animate = true) {
    const distance = this.frameDistance();
    this.userHasOrbited = true;
    this.cameraFramed = true;
    const portrait = (this.camera.aspect || 1) < 0.85;
    const presets = {
      overview: {
        position: new THREE.Vector3(0, distance * (portrait ? 0.34 : 0.6), distance * (portrait ? 0.98 : 0.84)),
        target: new THREE.Vector3(0, portrait ? 3.4 : 2.8, 0),
      },
      profile: {
        position: new THREE.Vector3(0, distance * 0.22, distance * 1.06),
        target: new THREE.Vector3(0, 5.2, 0),
      },
      top: {
        position: new THREE.Vector3(0, distance * 1.24, 0.01),
        target: new THREE.Vector3(0, 0, 0),
      },
    };
    const preset = presets[name] || presets.overview;
    this.flyTo(preset.position, preset.target, animate);
    this.onCamera(name);
  }

  flyTo(position, target, animate = true) {
    clearTimeout(this.idleTimer);
    this.tween = {
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      start: performance.now(),
      duration: animate && !reducedMotion ? 760 : 1,
    };
    if (!animate || reducedMotion) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.tween = null;
    }
  }

  focusBar(bar, animate = true) {
    if (!bar) return;
    const target = new THREE.Vector3(bar.x, bar.height / 2, bar.z);
    const distance = Math.max(10, this.frameDistance() * 0.52);
    const position = new THREE.Vector3(bar.x, bar.height / 2 + distance * 0.38, bar.z + distance);
    this.flyTo(position, target, animate);
  }

  cancelTween() {
    this.tween = null;
  }

  updateCameraForAspect() {
    if (this.tween) return;
    if (!this.userHasOrbited && this.model) {
      const distance = this.frameDistance();
      const portrait = (this.camera.aspect || 1) < 0.85;
      this.controls.target.set(0, portrait ? 3.4 : 2.8, 0);
      this.camera.position.set(0, distance * (portrait ? 0.34 : 0.6), distance * (portrait ? 0.98 : 0.84));
    }
  }

  /* ---------------- loop ---------------- */

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.composer.setSize(width, height);
    this.updateCameraForAspect();
  }

  animate = () => {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const delta = Math.min(this.clock.getDelta(), 0.1);

    if (this.tween) {
      const progress = Math.min(1, (now - this.tween.start) / this.tween.duration);
      const eased = easeInOutCubic(progress);
      this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, eased);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, eased);
      this.userHasOrbited = true;
      if (progress >= 1) this.tween = null;
    }

    let needsMatrices = false;
    if (this.reveal?.active) {
      const elapsed = now - this.reveal.start;
      for (const bar of this.bars) {
        const local = elapsed - bar.delay;
        const k = local <= 0 ? 0 : Math.min(1, local / this.reveal.duration);
        bar.reveal = easeOutCubic(k);
      }
      if (elapsed > this.reveal.duration + STAGGER_MS) this.reveal.active = false;
      needsMatrices = true;
    }

    for (const bar of this.bars) {
      if (bar.targetVis == null) bar.targetVis = bar.active ? 1 : 0.06;
      const diff = bar.targetVis - bar.vis;
      if (Math.abs(diff) > 0.0015) {
        bar.vis += diff * Math.min(1, delta * 9);
        needsMatrices = true;
      } else if (bar.vis !== bar.targetVis) {
        bar.vis = bar.targetVis;
        needsMatrices = true;
      }
    }

    if (needsMatrices) {
      this.applyBarMatrices();
      this.updateOutline();
    }

    if (this.nowRing.visible) {
      const pulse = 1 + Math.sin(now * 0.0024) * 0.12;
      this.nowRing.scale.setScalar(pulse);
      this.nowRing.material.opacity = 0.35 + (pulse - 1) * 1.6;
    }

    if (this.particles) this.particles.rotation.y += delta * 0.008;
    if (this.glow) this.glow.rotation.z += delta * 0.004;

    this.controls.update();
    this.updateLabels();
    if (this.hasBloom) this.composer.render(delta);
    else this.renderer.render(this.scene, this.camera);
  };

  updateLabels() {
    if (!this.labels.length && !this.timeLabels.length) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const vector = new THREE.Vector3();
    const placed = [];
    for (const label of this.labels) {
      vector.set(-STAGE_WIDTH / 2 - 2.6, 0.95, label.z);
      vector.project(this.camera);
      const onScreen = vector.z < 1 && vector.z > -1;
      const x = Math.min(Math.max((vector.x * 0.5 + 0.5) * width, 54), Math.max(54, width - 54));
      const y = (-vector.y * 0.5 + 0.5) * height;
      label.element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      placed.push({ label, y, onScreen });
    }
    placed.sort((a, b) => a.y - b.y);
    let lastY = -Infinity;
    let count = 0;
    for (const item of placed) {
      const clear = item.onScreen && item.y - lastY >= 14 && count < 28;
      item.label.element.classList.toggle("is-visible", clear);
      if (clear) {
        lastY = item.y;
        count += 1;
      }
    }
    for (const label of this.timeLabels) {
      vector.set(label.x, 0.06, label.z);
      vector.project(this.camera);
      const visible = vector.z < 1 && vector.z > -1;
      const x = Math.min(Math.max((vector.x * 0.5 + 0.5) * width, 18), Math.max(18, width - 18));
      const y = (-vector.y * 0.5 + 0.5) * height;
      const shift = label.align === "start" ? "0%" : label.align === "end" ? "-100%" : "-50%";
      label.element.style.transform = `translate(${x}px, ${y}px) translate(${shift}, -50%)`;
      label.element.classList.toggle("is-visible", visible);
    }
  }

  syncLaneLabels(lanes, colors) {
    for (const label of this.labels) label.element.remove();
    this.labels = [];
    if (!this.layoutState) return;
    const gap = this.laneGap || LANE_GAP;
    lanes.forEach((lane, index) => {
      const element = document.createElement("div");
      element.className = "lane-label";
      element.style.setProperty("--dot", colors[lane] || "#9fb2cc");
      const dot = document.createElement("i");
      const text = document.createElement("span");
      text.textContent = laneLabel(lane);
      element.append(dot, text);
      this.container.appendChild(element);
      const laneSpan = (lanes.length - 1) * gap;
      this.labels.push({ element, z: -laneSpan / 2 + index * gap });
    });
  }

  syncTimeLabels(layout, lanes) {
    for (const label of this.timeLabels) label.element.remove();
    this.timeLabels = [];
    const span = layout.tMax - layout.tMin;
    if (span < 60000) return;
    const laneSpan = layout.laneSpan ?? (lanes.length - 1) * (this.laneGap || LANE_GAP);
    const z = laneSpan / 2 + 2.2;
    const ticks = 5;
    for (let i = 0; i < ticks; i += 1) {
      const t = layout.tMin + (span * i) / (ticks - 1);
      const element = document.createElement("div");
      element.className = "time-label";
      element.textContent = clockLabel(t, span);
      this.container.appendChild(element);
      this.timeLabels.push({
        element,
        x: layout.x(t),
        z,
        align: i === 0 ? "start" : i === ticks - 1 ? "end" : "center",
      });
    }
  }

  disposeBars() {
    for (const child of [...this.barGroup.children]) {
      this.barGroup.remove(child);
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material?.dispose();
    }
    this.bars = [];
    this.byKey.clear();
    this.outline.visible = false;
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.disposeBars();
    this.controls?.dispose();
    this.renderer?.dispose();
    this.composer?.dispose?.();
    this.container.innerHTML = "";
  }
}
