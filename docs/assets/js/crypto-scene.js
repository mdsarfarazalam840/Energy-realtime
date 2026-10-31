/* WebGL stage for the crypto dashboard: one animated column per coin. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { changeColor, formatPercent, metricValue } from "./crypto-data.js?v=20261031-1";

const MAX_COINS = 48;
const MAX_HEIGHT = 11.5;
const SPACING = 3.5;

const THEMES = {
  dark: {
    floor: 0x07101d,
    gridA: 0x1f4b6e,
    gridB: 0x101d2e,
    ring: 0x4cd7ff,
    hemiSky: 0x9bdcff,
    hemiGround: 0x05070c,
    hemiIntensity: 0.62,
    key: 0xffffff,
    keyIntensity: 1.1,
    pointA: 0x4cd7ff,
    pointB: 0xffb24d,
    particles: 0x8fe3ff,
    particleOpacity: 0.4,
    labelBg: "rgba(5,10,20,0.82)",
    labelText: "#eaf6ff",
  },
  light: {
    floor: 0xdbe6f4,
    gridA: 0x6386ab,
    gridB: 0xa8bcd3,
    ring: 0x2b7fa8,
    hemiSky: 0xffffff,
    hemiGround: 0xb6c6d8,
    hemiIntensity: 0.85,
    key: 0xffffff,
    keyIntensity: 1.05,
    pointA: 0x2f8fbd,
    pointB: 0xcf8f3f,
    particles: 0x5c86ad,
    particleOpacity: 0.2,
    labelBg: "rgba(247,251,255,0.88)",
    labelText: "#102033",
  },
};

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function metricHeight(coin, metric, maxMetric) {
  const value = Math.max(0, metricValue(coin, metric));
  let scaled = metric === "price" ? Math.log10(value + 1) : Math.sqrt(value);
  const max = metric === "price" ? Math.log10(maxMetric + 1) : Math.sqrt(maxMetric);
  if (!Number.isFinite(scaled) || scaled <= 0) scaled = 0;
  const norm = max > 0 ? Math.min(1, scaled / max) : 0;
  return 0.5 + MAX_HEIGHT * norm ** 0.82;
}

export class CryptoScene {
  constructor(container, { onHover, onSelect, onCamera } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});

    this.theme = "dark";
    this.coins = [];
    this.bars = [];
    this.byId = new Map();
    this.metric = "market_cap";
    this.colorMode = "change";
    this.selectedId = null;
    this.hoveredId = null;
    this.heightById = new Map();
    this.clock = new THREE.Clock();
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.tween = null;
    this.pointerDown = null;
    this.frame = 0;
    this.disposed = false;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.initRenderer();
    this.initScene();
    this.initLights();
    this.initFloor();
    this.initParticles();
    this.initInteraction();
    this.applyTheme();
    this.resize();
    this.animate();
  }

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.className = "crypto-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D cryptocurrency market scene");
    this.renderer.domElement.setAttribute("role", "img");
    this.container.appendChild(this.renderer.domElement);
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 240);
    this.camera.position.set(0, 19, 31);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 4.4, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.update();
  }

  initLights() {
    this.hemi = new THREE.HemisphereLight(0x9bdcff, 0x05070c, 0.62);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 1.1);
    this.key.position.set(14, 24, 12);
    this.scene.add(this.key);

    this.fillA = new THREE.PointLight(0x4cd7ff, 38, 46, 2);
    this.fillA.position.set(-14, 10, -8);
    this.scene.add(this.fillA);

    this.fillB = new THREE.PointLight(0xffb24d, 30, 46, 2);
    this.fillB.position.set(16, 7, 10);
    this.scene.add(this.fillB);
  }

  initFloor() {
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(31, 64),
      new THREE.MeshStandardMaterial({ color: 0x07101d, roughness: 0.82, metalness: 0.35 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.06;
    this.scene.add(this.floor);

    this.grid = new THREE.GridHelper(62, 62, 0x1f4b6e, 0x101d2e);
    this.grid.position.y = 0;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(20.5, 20.9, 96),
      new THREE.MeshBasicMaterial({ color: 0x4cd7ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.02;
    this.scene.add(this.halo);
  }

  initParticles() {
    const count = this.reducedMotion ? 120 : 340;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 6 + Math.random() * 24;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = 0.5 + Math.random() * 17;
      positions[index * 3 + 2] = Math.sin(angle) * radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.particles = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x8fe3ff,
        size: 0.09,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(this.particles);
  }

  initInteraction() {
    const element = this.renderer.domElement;
    element.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    element.addEventListener("pointerleave", () => this.clearHover());
    element.addEventListener("pointerdown", (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
    });
    element.addEventListener("pointerup", (event) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved > 6) return;
      const hit = this.pick(event);
      if (hit) this.onSelect(hit.coin.id);
      else this.onSelect(null);
    });
    element.addEventListener("dblclick", () => this.cameraPreset("overview"));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.controls.addEventListener("start", () => {
      this.controls.autoRotate = false;
      this.onCamera({ autoRotate: false });
    });
    this.onCamera({ autoRotate: this.controls.autoRotate });
  }

  pick(event) {
    if (!this.bars.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.bars.map((bar) => bar.mesh),
      false,
    );
    return hits.length ? hits[0].object.userData.bar : null;
  }

  handlePointerMove(event) {
    const hit = this.pick(event);
    const id = hit ? hit.coin.id : null;
    if (id === this.hoveredId) {
      if (hit) this.onHover(hit.coin, event);
      return;
    }
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    this.onHover(hit ? hit.coin : null, event);
  }

  clearHover() {
    this.hoveredId = null;
    this.renderer.domElement.style.cursor = "grab";
    this.onHover(null, null);
  }

  columnColor(coin, index) {
    if (this.colorMode === "rank") {
      const n = Math.max(1, this.coins.length - 1);
      const hue = 192 + (index / n) * 78;
      return new THREE.Color(`hsl(${hue}, 78%, 58%)`);
    }
    if (this.colorMode === "trending") {
      return new THREE.Color(coin.trending ? "#ffc45c" : "#4cd7ff");
    }
    return new THREE.Color(changeColor(coin.change_24h));
  }

  makeLabel(coin) {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 96;
    const context = canvas.getContext("2d");
    const theme = THEMES[this.theme];
    context.fillStyle = theme.labelBg;
    context.beginPath();
    if (typeof context.roundRect === "function") {
      context.roundRect(4, 4, 312, 88, 18);
    } else {
      context.rect(4, 4, 312, 88);
    }
    context.fill();
    context.strokeStyle = coin.trending ? "rgba(255,196,92,0.9)" : "rgba(126,178,220,0.5)";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = theme.labelText;
    context.font = "700 34px 'Segoe UI', system-ui, sans-serif";
    context.fillText(coin.symbol.slice(0, 6), 22, 43);
    context.fillStyle = changeColor(coin.change_24h);
    context.font = "600 24px 'Segoe UI', system-ui, sans-serif";
    context.fillText(formatPercent(coin.change_24h), 22, 76);
    if (coin.trending) {
      context.fillStyle = "#ffc45c";
      context.font = "700 24px 'Segoe UI', system-ui, sans-serif";
      context.fillText("HOT", 248, 43);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.96 }),
    );
    sprite.scale.set(3.1, 0.93, 1);
    sprite.userData.texture = texture;
    return sprite;
  }

  clearColumns() {
    for (const bar of this.bars) {
      this.columnGroup.remove(bar.mesh);
      this.columnGroup.remove(bar.ring);
      this.columnGroup.remove(bar.label);
      bar.mesh.geometry.dispose();
      bar.mesh.material.dispose();
      bar.ring.geometry.dispose();
      bar.ring.material.dispose();
      bar.label.material.dispose();
      bar.label.userData.texture?.dispose();
      this.heightById.set(bar.coin.id, bar.height);
    }
    this.bars = [];
    this.byId.clear();
  }

  setData(coins, { metric = this.metric, colorMode = this.colorMode, selectedId = this.selectedId } = {}) {
    this.metric = metric;
    this.colorMode = colorMode;
    this.selectedId = selectedId;
    this.coins = coins.slice(0, MAX_COINS);

    if (!this.columnGroup) {
      this.columnGroup = new THREE.Group();
      this.scene.add(this.columnGroup);
    }
    this.clearColumns();

    const maxMetric = Math.max(1, ...this.coins.map((coin) => metricValue(coin, this.metric)));
    const count = this.coins.length;
    const cols = Math.min(7, Math.max(4, Math.ceil(Math.sqrt(count))));
    const rows = Math.ceil(count / cols);

    this.coins.forEach((coin, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = (col - (cols - 1) / 2) * SPACING;
      const z = (row - (rows - 1) / 2) * SPACING;
      const targetHeight = metricHeight(coin, this.metric, maxMetric);
      const height = this.heightById.has(coin.id) ? this.heightById.get(coin.id) : 0.05;

      const geometry = new THREE.BoxGeometry(1.85, 1, 1.85);
      const color = this.columnColor(coin, index);
      const material = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.5,
        roughness: 0.3,
        emissive: color,
        emissiveIntensity: 0.16 + Math.min(0.34, Math.abs(coin.change_24h) / 22),
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, height / 2 + 0.05, z);
      mesh.scale.y = Math.max(0.05, height);
      mesh.userData.coin = coin;

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.02, 1.34, 40),
        new THREE.MeshBasicMaterial({
          color: changeColor(coin.change_24h),
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.035, z);

      const label = this.makeLabel(coin);
      label.position.set(x, height + 1.05, z);

      const bar = { coin, mesh, ring, label, targetHeight, height, index, x, z };
      mesh.userData.bar = bar;
      this.bars.push(bar);
      this.byId.set(coin.id, bar);
      this.columnGroup.add(mesh, ring, label);
    });

    this.applySelection();
    this.applyHover();
  }

  setMetric(metric) {
    this.setData(this.coins, { metric });
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this.setData(this.coins, {});
  }

  setSelected(id) {
    this.selectedId = id;
    this.applySelection();
  }

  applySelection() {
    for (const bar of this.bars) {
      const selected = bar.coin.id === this.selectedId;
      bar.ring.material.opacity = selected ? 0.95 : 0.4;
      bar.ring.scale.setScalar(selected ? 1.35 : 1);
      bar.mesh.material.emissiveIntensity = selected
        ? 0.72
        : 0.16 + Math.min(0.34, Math.abs(bar.coin.change_24h) / 22);
    }
  }

  applyHover() {
    for (const bar of this.bars) {
      const hovered = bar.coin.id === this.hoveredId;
      bar.mesh.scale.x = hovered ? 1.14 : 1;
      bar.mesh.scale.z = hovered ? 1.14 : 1;
      bar.label.material.opacity = hovered ? 1 : 0.92;
    }
  }

  focusOn(id) {
    const bar = this.byId.get(id);
    if (!bar) return;
    const target = new THREE.Vector3(bar.x, Math.max(2.2, bar.height * 0.55), bar.z);
    const direction = new THREE.Vector3(bar.x, 0, bar.z);
    if (direction.lengthSq() < 0.01) direction.set(0, 0, 1);
    direction.normalize();
    const position = target.clone().add(direction.multiplyScalar(13)).add(new THREE.Vector3(0, 6.5, 0));
    this.flyTo(position, target);
  }

  cameraPreset(name) {
    if (name === "top") {
      this.flyTo(new THREE.Vector3(0, 47, 0.1), new THREE.Vector3(0, 0, 0));
    } else if (name === "close") {
      this.flyTo(new THREE.Vector3(13, 11, 20), new THREE.Vector3(0, 5.2, 0));
    } else {
      this.flyTo(new THREE.Vector3(0, 19, 31), new THREE.Vector3(0, 4.4, 0));
    }
    this.onCamera({ preset: name });
  }

  flyTo(position, target) {
    if (this.reducedMotion) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.tween = {
      t: 0,
      fromPosition: this.camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
    };
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = Boolean(enabled);
    this.onCamera({ autoRotate: this.controls.autoRotate });
  }

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    this.applyTheme();
    if (this.coins.length) {
      const selected = this.selectedId;
      this.selectedId = selected;
    }
  }

  applyTheme() {
    const theme = THEMES[this.theme];
    this.floor.material.color.setHex(theme.floor);
    this.grid.material.color.setHex(theme.gridA);
    this.hemi.color.setHex(theme.hemiSky);
    this.hemi.groundColor.setHex(theme.hemiGround);
    this.hemi.intensity = theme.hemiIntensity;
    this.key.intensity = theme.keyIntensity;
    this.fillA.color.setHex(theme.pointA);
    this.fillB.color.setHex(theme.pointB);
    this.halo.material.color.setHex(theme.ring);
    this.halo.material.opacity = this.theme === "light" ? 0.18 : 0.28;
    this.particles.material.color.setHex(theme.particles);
    this.particles.material.opacity = theme.particleOpacity;
    this.renderer.toneMappingExposure = this.theme === "light" ? 0.96 : 1.05;
    if (this.bars.length) {
      // Rebuild label sprites so their background follows the theme.
      const coins = this.coins.slice();
      const metric = this.metric;
      const mode = this.colorMode;
      const selected = this.selectedId;
      this.setData(coins, { metric, colorMode: mode, selectedId: selected });
    }
  }

  resize() {
    const width = this.container.clientWidth || 640;
    const height = this.container.clientHeight || 420;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.05);

    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + delta / 1.05);
      const k = easeInOut(this.tween.t);
      this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, k);
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, k);
      if (this.tween.t >= 1) this.tween = null;
    }

    if (this.particles) this.particles.rotation.y += delta * 0.012;

    const speed = this.reducedMotion ? 1 : Math.min(1, delta * 6);
    for (const bar of this.bars) {
      bar.height += (bar.targetHeight - bar.height) * speed;
      bar.mesh.scale.y = Math.max(0.05, bar.height);
      bar.mesh.position.y = bar.height / 2 + 0.05;
      bar.label.position.y = bar.height + 1.02;
      bar.label.material.opacity = bar.coin.id === this.hoveredId ? 1 : 0.92;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.clearColumns();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
