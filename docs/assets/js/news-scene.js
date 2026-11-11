/* News & Culture 3D scene: five switchable themes.
   Mode 1 globe · 2 vortex · 3 city · 4 polyhedron · 5 web. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { formatCount, categoryColor } from "./news-data.js?v=20261111-1";

const MODES = ["globe", "vortex", "city", "polyhedron", "web"];
const MAX_ITEMS = 50;

let _delta = 0;
let _t = 0;

const THEME_BG = { dark: 0x060b14, light: 0xe8f2fa };

function colorFor(category) {
  return new THREE.Color(categoryColor(category));
}

export class NewsScene {
  constructor(container, { onHover, onSelect, onCamera, mode = "globe" } = {}) {
    this.container = container;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onCamera = onCamera || (() => {});
    this.theme = "dark";
    this.mode = MODES.includes(mode) ? mode : "globe";
    this.items = [];
    this.meshes = [];
    this.selectedId = null;
    this.hoveredId = null;
    this.clock = new THREE.Clock();
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.initRenderer();
    this.initScene();
    this.initLights();
    this.initControls();
    this.rebuild();
    this.setTheme(this.theme);
  }

  initRenderer() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1);
    renderer.setClearColor(THEME_BG.dark, 1);
    renderer.domElement.classList.add("scene-canvas");
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.camera = new THREE.PerspectiveCamera(45, (this.container.clientWidth || 1) / (this.container.clientHeight || 1), 0.1, 400);
    this.camera.position.set(0, 6, 26);
    this.camera.lookAt(0, 0.5, 0);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 120;
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
    this.scene.fog = new THREE.Fog(THEME_BG.dark, 26, 120);

    /* Static starfield: depth without extra draw calls per rebuild. */
    const starCount = 700;
    const positions = new Float32Array(starCount * 3);
    let seed = 20261111;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < starCount; i += 1) {
      const radius = 45 + rand() * 70;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x22d3ee,
      size: 0.5,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.scene.add(this.stars);
  }

  initLights() {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.8);
    key.position.set(10, 20, 10);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x22d3ee, 0.4);
    fill.position.set(-10, -5, -10);
    this.scene.add(fill);
  }

  initControls() {
    this.controls.addEventListener("change", () => this.onCamera?.());
  }

  setItems(items) {
    this.items = items || [];
    this.rebuild();
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = mode;
    this.rebuild();
  }

  rebuild() {
    this.clear();
    const items = this.items.slice(0, MAX_ITEMS);
    switch (this.mode) {
      case "globe": this.buildGlobe(items); break;
      case "vortex": this.buildVortex(items); break;
      case "city": this.buildCity(items); break;
      case "polyhedron": this.buildPolyhedron(items); break;
      case "web": this.buildWeb(items); break;
    }
    this.applySelection();
  }

  clear() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) {
        if (Array.isArray(m.material)) m.material.forEach(mat => mat.dispose());
        else m.material.dispose();
      }
    }
    this.meshes = [];
  }

  setTheme(theme) {
    this.theme = theme === "light" ? "light" : "dark";
    const bg = THEME_BG[this.theme];
    this.renderer.setClearColor(bg, 1);
    this.scene.fog.color.setHex(bg);
    if (this.stars) {
      this.stars.material.color.setHex(this.theme === "light" ? 0x0e7490 : 0x22d3ee);
      this.stars.material.opacity = this.theme === "light" ? 0.22 : 0.55;
    }
    this.rebuild();
  }

  setSelected(id) {
    this.selectedId = id || null;
    this.applySelection();
  }

  applySelection() {
    this.scene.traverse((obj) => {
      if (!obj.isMesh || !obj.userData.articleId) return;
      const active = obj.userData.articleId === this.selectedId;
      const hovered = obj.userData.articleId === this.hoveredId;
      const base = obj.userData.baseScale || 1;
      obj.scale.setScalar(base * (active ? 1.7 : hovered ? 1.35 : 1));
    });
  }

  makeLabel(text, colorHex) {
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = `#${colorHex.toString(16).padStart(6, "0")}`;
    ctx.font = "bold 44px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText(text, 256, 78);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  addMesh(mesh, articleId, pickable = true) {
    mesh.userData.articleId = articleId;
    mesh.userData.pickable = pickable;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  onClick(event) {
    const hits = this.pick(event);
    const hit = hits[0];
    const id = hit?.object?.userData?.articleId || null;
    if (id) { this.setSelected(id); this.onSelect(id); }
    else { this.setSelected(null); this.onSelect(null); }
  }

  onPointerMove(event) {
    const hit = this.pick(event);
    const id = hit?.object?.userData?.articleId || null;
    if (id === this.hoveredId) { if (id) this.onHover(id, event); return; }
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
    // Collect every mesh that carries an articleId (recursively, inside groups).
    const targets = [];
    this.scene.traverse((obj) => {
      if (obj.isMesh && obj.userData.articleId) targets.push(obj);
    });
    return this.raycaster.intersectObjects(targets, false);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  loop() {
    if (this.disposed) return;
    _delta = Math.min(this.clock.getDelta(), 0.05);
    _t = this.clock.elapsedTime;
    if (!this.reducedMotion) this.animate();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop.bind(this));
  }

  animate() {
    for (const mesh of this.meshes) {
      if (mesh.userData.animate) mesh.userData.animate(_delta, _t);
    }
    if (this.globeEarth) {
      this.globeEarth.rotation.y += _delta * 0.12;
      if (this.globeWire) {
        this.globeWire.rotation.y = this.globeEarth.rotation.y;
        this.globeWire.rotation.x = this.globeEarth.rotation.x;
      }
      if (this.globePins) this.globePins.rotation.y = this.globeEarth.rotation.y;
      this.globeEarth.rotation.x += _delta * 0.05;
    }
    if (this.stars) this.stars.rotation.y += _delta * 0.01;
    if (this.cityGroup) this.cityGroup.rotation.y += _delta * 0.06;
    if (this.polyCluster) {
      this.polyCluster.rotation.y += _delta * 0.12;
    }
  }

  /* ---------- Theme 1: Globe with News Pins ---------- */

  buildGlobe(items) {
    const light = this.theme === "light";
    const maxViews = Math.max(...items.map((item) => item.views), 1);

    const geo = new THREE.SphereGeometry(10, 64, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: light ? 0xbdd6ea : 0x08131f,
      emissive: light ? 0xffffff : 0x0d2436,
      emissiveIntensity: light ? 0.32 : 0.45,
      roughness: 0.85,
      metalness: 0.15,
    });
    const earth = new THREE.Mesh(geo, mat);
    this.scene.add(earth);
    this.meshes.push(earth);
    this.globeEarth = earth;

    const wire = new THREE.Mesh(
      new THREE.SphereGeometry(10.02, 24, 16),
      new THREE.MeshBasicMaterial({
        color: light ? 0x0e7490 : 0x22d3ee,
        wireframe: true,
        transparent: true,
        opacity: light ? 0.18 : 0.10,
      })
    );
    this.scene.add(wire);
    this.meshes.push(wire);
    this.globeWire = wire;

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(10.7, 48, 32),
      new THREE.MeshBasicMaterial({
        color: light ? 0x38bdf8 : 0x22d3ee,
        transparent: true,
        opacity: light ? 0.10 : 0.07,
        side: THREE.BackSide,
      })
    );
    this.scene.add(atmosphere);
    this.meshes.push(atmosphere);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(10.9, 11.6, 96),
      new THREE.MeshBasicMaterial({
        color: light ? 0x0e7490 : 0x22d3ee,
        transparent: true,
        opacity: light ? 0.28 : 0.16,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.meshes.push(ring);

    const pins = new THREE.Group();
    items.forEach((item, i) => {
      const phi = Math.acos(-1 + (2 * i) / items.length);
      const theta = Math.sqrt(items.length * Math.PI) * phi;
      const r = 10.5;
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);
      const c = colorFor(item.category);
      const scale = 0.6 + (item.views / maxViews) * 1.1;
      const pinColor = light ? c.clone().multiplyScalar(0.66) : c;
      const glowBase = light ? 0.35 : 1.1;

      const pin = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.4, 0),
        new THREE.MeshStandardMaterial({
          color: pinColor,
          emissive: light ? pinColor : c,
          emissiveIntensity: glowBase,
          roughness: 0.35,
          metalness: 0.2,
        })
      );
      pin.position.set(x, y, z);
      pin.scale.setScalar(scale);
      pin.userData.baseScale = scale;
      pin.userData.articleId = item.id;
      pin.userData.animate = (d, t) => {
        pin.rotation.y += d * 0.6;
        pin.material.emissiveIntensity = glowBase + Math.sin(t * 1.6 + i) * (light ? 0.15 : 0.5);
      };
      pins.add(pin);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, y, z), new THREE.Vector3(0, 0, 0)]),
        new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: light ? 0.16 : 0.09 })
      );
      pins.add(line);
    });
    this.scene.add(pins);
    this.meshes.push(pins);
    this.globePins = pins;

    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(10.4, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.05, side: THREE.BackSide })
    );
    pulse.userData.animate = (d, t) => {
      pulse.scale.setScalar(1 + Math.sin(t * 1.6) * 0.2);
      pulse.material.opacity = 0.05 + Math.sin(t * 1.6) * 0.03;
    };
    this.scene.add(pulse);
    this.meshes.push(pulse);
  }

  /* ---------- Theme 2: News Vortex Tunnel ---------- */

  buildVortex(items) {
    const tunnel = new THREE.Group();
    items.forEach((item, i) => {
      const angle = (i / items.length) * Math.PI * 2 * 3;
      const radius = 6 + (i / items.length) * 10;
      const height = (i / items.length - 0.5) * 24;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const c = colorFor(item.category);
      const cardGeo = new THREE.BoxGeometry(1.6, 0.9, 0.12);
      const cardMat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6 });
      const card = new THREE.Mesh(cardGeo, cardMat);
      card.position.set(x, height, z);
      card.lookAt(0, height, 0);
      card.rotateY(Math.PI / 2);
      card.userData.baseAngle = angle;
      card.userData.baseRadius = radius;
      card.userData.baseHeight = height;
      card.userData.articleId = item.id;
      card.userData.animate = (d, t) => {
        const a = card.userData.baseAngle + t * 0.4 + i * 0.2;
        card.position.x = Math.cos(a) * card.userData.baseRadius;
        card.position.z = Math.sin(a) * card.userData.baseRadius;
        card.rotation.y = a + Math.PI / 2;
        card.position.y = card.userData.baseHeight + Math.sin(t + i) * 0.6;
      };
      tunnel.add(card);
    });
    this.scene.add(tunnel);
    this.meshes.push(tunnel);
    this.vortexTunnel = tunnel;

    const coreGeo = new THREE.TorusKnotGeometry(1.2, 0.4, 64, 16);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1, wireframe: true });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.userData.animate = (d) => {
      core.rotation.x += d * 0.5;
      core.rotation.y += d * 0.3;
    };
    this.scene.add(core);
    this.meshes.push(core);
  }

  /* ---------- Theme 3: 3D Bar-City Skyline ---------- */

  buildCity(items) {
    const city = new THREE.Group();
    const maxViews = Math.max(...items.map(i => i.views), 1);
    items.forEach((item, i) => {
      const col = (i % 7) - 3;
      const row = Math.floor(i / 7) - 3;
      const x = col * 3.2;
      const z = row * 3.2;
      const height = (item.views / maxViews) * 14 + 1;
      const c = colorFor(item.category);
      const bGeo = new THREE.BoxGeometry(2.4, height, 2.4);
      const bMat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.4 });
      const building = new THREE.Mesh(bGeo, bMat);
      building.position.set(x, height / 2, z);
      building.userData.baseHeight = height;
      building.userData.articleId = item.id;
      building.userData.animate = (d, t) => {
        building.scale.y = 1 + Math.sin(t * 2 + i) * 0.08;
        building.position.y = building.userData.baseHeight / 2 * building.scale.y;
      };
      city.add(building);

      const labelGeo = new THREE.PlaneGeometry(2.2, 0.9);
      const labelMat = new THREE.MeshBasicMaterial({ map: this.makeLabel(item.title, c.getHex()), transparent: true });
      const label = new THREE.Mesh(labelGeo, labelMat);
      label.position.set(x, height + 0.7, z + 1.3);
      label.rotation.x = -Math.PI / 6;
      city.add(label);
    });
    this.scene.add(city);
    this.meshes.push(city);
    this.cityGroup = city;

    const floorGeo = new THREE.PlaneGeometry(60, 60);
    const floorMat = new THREE.MeshBasicMaterial({ color: 0x03060b, transparent: true, opacity: 0.4 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.1;
    this.scene.add(floor);
    this.meshes.push(floor);
  }

  /* ---------- Theme 4: Rotating Polyhedron Face Tiles ---------- */

  buildPolyhedron(items) {
    const cluster = new THREE.Group();
    const perSolid = Math.ceil(items.length / 3);
    const solids = [
      new THREE.IcosahedronGeometry(4, 1),
      new THREE.DodecahedronGeometry(4, 1),
      new THREE.OctahedronGeometry(4, 1),
    ];
    const solidsMesh = [];
    solids.forEach((geo, s) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0x111a26, roughness: 0.6, metalness: 0.3 });
      const solid = new THREE.Mesh(geo, mat);
      solid.position.set((s - 1) * 11, 0, 0);
      solid.userData.animate = (d) => {
        solid.rotation.x += d * 0.2 + s * 0.1;
        solid.rotation.y += d * 0.15 + s * 0.08;
      };
      cluster.add(solid);
      solidsMesh.push(solid);
    });
    this.scene.add(cluster);
    this.meshes.push(cluster);
    this.polyCluster = cluster;

    items.forEach((item, i) => {
      const s = Math.floor(i / perSolid);
      const local = i % perSolid;
      const solid = solidsMesh[s] || solidsMesh[0];
      const c = colorFor(item.category);
      const faceGeo = new THREE.BoxGeometry(1.5, 1.5, 0.2);
      const faceMat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.8 });
      const tile = new THREE.Mesh(faceGeo, faceMat);
      const v = new THREE.Vector3();
      const positions = solid.geometry.attributes.position;
      const idx = (local * 3) % positions.count;
      v.fromBufferAttribute(positions, idx);
      v.multiplyScalar(1.15);
      tile.position.copy(v);
      tile.lookAt((s - 1) * 11, 0, 0);
      tile.userData.articleId = item.id;
      tile.userData.animate = (d, t) => {
        tile.material.emissiveIntensity = 0.8 + Math.sin(t * 2 + i) * 0.4;
      };
      cluster.add(tile);
    });
  }

  /* ---------- Theme 5: Floating Article Constellation (Web) ---------- */

  buildWeb(items) {
    const web = new THREE.Group();
    const positions = [];
    items.forEach((item, i) => {
      const phi = Math.acos(-1 + (2 * i) / items.length);
      const theta = Math.sqrt(items.length * Math.PI) * phi;
      const r = 14 + Math.random() * 6;
      const x = Math.sin(phi) * Math.cos(theta) * r;
      const y = Math.sin(phi) * Math.sin(theta) * r;
      const z = Math.cos(phi) * r;
      positions.push({ x, y, z });
      const c = colorFor(item.category);
      const maxViews = Math.max(...items.map(it => it.views), 1);
      const orbGeo = new THREE.SphereGeometry(0.35 + (item.views / maxViews) * 0.8, 16, 16);
      const orbMat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 1 });
      const orb = new THREE.Mesh(orbGeo, orbMat);
      orb.position.set(x, y, z);
      orb.userData.basePos = new THREE.Vector3(x, y, z);
      orb.userData.drift = Math.random() * Math.PI * 2;
      orb.userData.articleId = item.id;
      orb.userData.animate = (d, t) => {
        const base = orb.userData.basePos;
        const drift = orb.userData.drift;
        orb.position.x = base.x + Math.sin(t * 0.7 + drift) * 1.2;
        orb.position.y = base.y + Math.cos(t * 0.5 + drift) * 1.2;
        orb.position.z = base.z + Math.sin(t * 0.9 + drift) * 1.2;
        orb.rotation.y += d * 0.4;
      };
      web.add(orb);
    });

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (Math.random() > 0.55) continue;
        const p1 = positions[i], p2 = positions[j];
        const dist = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2 + (p1.z - p2.z) ** 2);
        if (dist > 22) continue;
        const lineGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p1.x, p1.y, p1.z), new THREE.Vector3(p2.x, p2.y, p2.z)
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.12 });
        const line = new THREE.Line(lineGeo, lineMat);
        line.userData.animate = (d, t) => {
          line.material.opacity = 0.12 + Math.sin(t * 2 + i + j) * 0.08;
        };
        web.add(line);
      }
    }
    this.scene.add(web);
    this.meshes.push(web);
    this.webGroup = web;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
