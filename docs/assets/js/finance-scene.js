/* WebGL stage for the finance dashboard: one animated column per company,
   coloured by sector, with camera presets, hover picking, a selection ring,
   and a theme-aware rim. Mirrors the crypto 3D market scene. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatMoney, formatPercent, sectorColor } from "./finance-data.js?v=20261101-3";

const MAX_COMPANIES = 60;
const MAX_HEIGHT = 11.5;
const SPACING = 3.6;

const THEMES = {
  dark: {
    floor: 0x0c0a06,
    gridA: 0x4a3a20,
    gridB: 0x241d12,
    ring: 0xffc45c,
    hemiSky: 0xfff0d6,
    hemiGround: 0x120d07,
    hemiIntensity: 0.6,
    keyIntensity: 1.15,
    pointA: 0xffc45c,
    pointB: 0x8a7bff,
    labelBg: "rgba(18,13,7,0.85)",
    labelText: "#ffe9c8",
  },
  light: {
    floor: 0xe9e2d6,
    gridA: 0xb08a4a,
    gridB: 0xd8c9ae,
    ring: 0xc88b2b,
    hemiSky: 0xffeac8,
    hemiGround: 0xf1eadc,
    hemiIntensity: 0.7,
    keyIntensity: 1.0,
    pointA: 0xd99a3d,
    pointB: 0x6a5df0,
    labelBg: "rgba(255,250,240,0.92)",
    labelText: "#3a2c16",
  },
};

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function metricValue(company, metric) {
  const latest = company.latest || {};
  const ratios = company.ratios || {};
  switch (metric) {
    case "revenue":
      return Number(latest.revenue) || 0;
    case "net_income":
      return Number(latest.net_income) || 0;
    case "net_margin":
      return Math.abs(Number(ratios.net_margin)) || 0;
    case "return_on_equity":
      return Math.abs(Number(ratios.return_on_equity)) || 0;
    case "revenue_growth":
      return Math.abs(Number(ratios.revenue_growth)) || 0;
    default:
      return 0;
  }
}

function intensityOf(company) {
  const margin = Number((company.ratios || {}).net_margin) || 0;
  return 0.15 + Math.min(0.32, Math.abs(margin) * 4);
}

function metricDisplay(company, metric) {
  const latest = company.latest || {};
  const ratios = company.ratios || {};
  switch (metric) {
    case "revenue":
      return formatMoney(latest.revenue);
    case "net_income":
      return formatMoney(latest.net_income);
    case "net_margin":
      return `${formatPercent(ratios.net_margin)} margin`;
    case "return_on_equity":
      return `${formatPercent(ratios.return_on_equity)} ROE`;
    case "revenue_growth":
      return `${formatPercent(ratios.revenue_growth)} growth`;
    default:
      return "";
  }
}

function metricHeight(company, metric, maxMetric) {
  const value = Math.max(0, metricValue(company, metric));
  let scaled = Math.sqrt(value);
  const max = Math.sqrt(maxMetric);
  if (!Number.isFinite(scaled) || scaled <= 0) scaled = 0;
  const norm = max > 0 ? Math.min(1, scaled / max) : 0;
  return 0.5 + MAX_HEIGHT * norm ** 0.82;
}

export class FinanceScene {
  constructor(container, { onHover, onSelect, onCamera } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});

    this.theme = "dark";
    this.companies = [];
    this.bars = [];
    this.byId = new Map();
    this.metric = "revenue";
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
    this.renderer.domElement.className = "finance-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Interactive 3D financial scene");
    this.renderer.domElement.setAttribute("role", "img");
    this.container.appendChild(this.renderer.domElement);
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 260);
    this.camera.position.set(0, 20, 34);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 4.6, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 78;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotate = !this.reducedMotion;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.update();
  }

  initLights() {
    this.hemi = new THREE.HemisphereLight(0xfff0d6, 0x120d07, 0.6);
    this.scene.add(this.hemi);

    this.key = new THREE.DirectionalLight(0xffffff, 1.15);
    this.key.position.set(14, 26, 14);
    this.scene.add(this.key);

    this.fillA = new THREE.PointLight(0xffc45c, 40, 50, 2);
    this.fillA.position.set(-14, 10, -8);
    this.scene.add(this.fillA);

    this.fillB = new THREE.PointLight(0x8a7bff, 32, 50, 2);
    this.fillB.position.set(16, 8, 12);
    this.scene.add(this.fillB);
  }

  initFloor() {
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(34, 64),
      new THREE.MeshStandardMaterial({ color: 0x0c0a06, roughness: 0.85, metalness: 0.3 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.06;
    this.scene.add(this.floor);

    this.grid = new THREE.GridHelper(68, 68, 0x4a3a20, 0x241d12);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

    this.halo = new THREE.Mesh(
      new THREE.RingGeometry(20.5, 22.5, 80),
      new THREE.MeshBasicMaterial({ color: 0xffc45c, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = -0.04;
    this.scene.add(this.halo);
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
      if (hit) this.onSelect(hit.item.id);
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
    const hits = this.raycaster.intersectObjects(this.bars.map((bar) => bar.mesh), false);
    return hits.length ? hits[0].object.userData.bar : null;
  }

  handlePointerMove(event) {
    const hit = this.pick(event);
    const id = hit ? hit.item.id : null;
    if (id === this.hoveredId) {
      if (hit) this.onHover(hit.item, event);
      return;
    }
    this.hoveredId = id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "grab";
    this.onHover(hit ? hit.item : null, event);
  }

  clearHover() {
    this.hoveredId = null;
    this.renderer.domElement.style.cursor = "grab";
    this.onHover(null, null);
  }

  columnColor(company) {
    return new THREE.Color(sectorColor(company.sector));
  }

  makeLabel(company) {
    const canvas = document.createElement("canvas");
    canvas.width = 340;
    canvas.height = 92;
    const context = canvas.getContext("2d");
    const theme = THEMES[this.theme];
    context.fillStyle = theme.labelBg;
    context.beginPath();
    if (typeof context.roundRect === "function") {
      context.roundRect(4, 4, 332, 84, 16);
    } else {
      context.rect(4, 4, 332, 84);
    }
    context.fill();
    context.strokeStyle = "rgba(255,196,92,0.55)";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = theme.labelText;
    context.font = "700 34px 'Segoe UI', system-ui, sans-serif";
    context.fillText(company.ticker.slice(0, 6), 22, 42);
    context.fillStyle = sectorColor(company.sector);
    context.font = "600 22px 'Segoe UI', system-ui, sans-serif";
    context.fillText(company.sector.slice(0, 16), 22, 70);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.96 }),
    );
    sprite.scale.set(3.3, 0.9, 1);
    sprite.userData.texture = texture;
    return sprite;
  }

  clearColumns() {
    for (const bar of this.bars) {
      this.columnGroup.remove(bar.mesh, bar.ring, bar.label);
      bar.mesh.geometry.dispose();
      bar.mesh.material.dispose();
      bar.ring.geometry.dispose();
      bar.ring.material.dispose();
      bar.label.material.map?.dispose();
      bar.label.material.dispose();
    }
    this.bars = [];
    this.byId.clear();
  }

  setData(companies, { metric = this.metric, selectedId = this.selectedId } = {}) {
    this.metric = metric;
    this.selectedId = selectedId;
    this.companies = companies.slice(0, MAX_COMPANIES).map((company) => ({ ...company, id: company.ticker }));

    if (!this.columnGroup) {
      this.columnGroup = new THREE.Group();
      this.scene.add(this.columnGroup);
    }
    this.clearColumns();

    const maxMetric = Math.max(1, ...this.companies.map((company) => metricValue(company, this.metric)));
    const count = this.companies.length;
    const cols = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(count))));
    const rows = Math.ceil(count / cols);

    this.companies.forEach((company, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = (col - (cols - 1) / 2) * SPACING;
      const z = (row - (rows - 1) / 2) * SPACING;
      const targetHeight = metricHeight(company, this.metric, maxMetric);
      const height = this.heightById.has(company.id) ? this.heightById.get(company.id) : 0.05;

      const geometry = new THREE.BoxGeometry(1.9, 1, 1.9);
      const color = this.columnColor(company);
      const material = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.45,
        roughness: 0.32,
        emissive: color,
        emissiveIntensity: intensityOf(company),
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, height / 2 + 0.05, z);
      mesh.scale.y = Math.max(0.05, height);
      mesh.userData.company = company;

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.05, 1.38, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.035, z);

      const label = this.makeLabel(company);
      label.position.set(x, height + 1.05, z);

      const bar = { item: company, mesh, ring, label, targetHeight, height, index, x, z };
      mesh.userData.bar = bar;
      this.bars.push(bar);
      this.byId.set(company.id, bar);
      this.columnGroup.add(mesh, ring, label);
    });

    this.applySelection();
    this.applyHover();
  }

  setMetric(metric) {
    this.setData(this.companies, { metric });
  }

  setSelected(id) {
    this.selectedId = id;
    this.applySelection();
  }

  applySelection() {
    for (const bar of this.bars) {
      const selected = bar.item.id === this.selectedId;
      bar.ring.material.opacity = selected ? 0.95 : 0.4;
      bar.ring.scale.setScalar(selected ? 1.35 : 1);
      bar.mesh.material.emissiveIntensity = selected ? 0.72 : intensityOf(bar.item);
    }
  }

  applyHover() {
    for (const bar of this.bars) {
      const hovered = bar.item.id === this.hoveredId;
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
    const position = target.clone().add(direction.multiplyScalar(14)).add(new THREE.Vector3(0, 7, 0));
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

  cameraPreset(name) {
    if (name === "top") {
      this.flyTo(new THREE.Vector3(0, 50, 0.1), new THREE.Vector3(0, 0, 0));
    } else if (name === "close") {
      this.flyTo(new THREE.Vector3(14, 11, 22), new THREE.Vector3(0, 5.4, 0));
    } else {
      this.flyTo(new THREE.Vector3(0, 20, 34), new THREE.Vector3(0, 4.6, 0));
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
    this.halo.material.opacity = this.theme === "light" ? 0.16 : 0.28;
    this.renderer.toneMappingExposure = this.theme === "light" ? 0.96 : 1.05;
    if (this.bars.length) {
      const companies = this.companies.slice();
      this.setData(companies, { metric: this.metric, selectedId: this.selectedId });
    }
  }

  resize() {
    const width = this.container.clientWidth || 640;
    const height = this.container.clientHeight || 460;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
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

    const speed = this.reducedMotion ? 1 : Math.min(1, delta * 6);
    for (const bar of this.bars) {
      bar.height += (bar.targetHeight - bar.height) * speed;
      bar.mesh.position.y = bar.height / 2 + 0.05;
      bar.mesh.scale.y = Math.max(0.05, bar.height);
      bar.label.position.y = bar.height + 1.05;
      bar.label.material.opacity = bar.item.id === this.hoveredId ? 1 : 0.92;
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
