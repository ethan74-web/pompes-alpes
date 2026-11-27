// Rejeu d'un vol en 3D : relief à l'échelle (teinté selon l'altitude), trace colorée par la Vz,
// ombre au sol, planeur orienté (cap, inclinaison), pompes prévues à l'heure du rejeu (disques tous les 250 m du départ
// au plafond, décalés par la dérive du vent, couleur = Vz prévue, opacité = fiabilité). La caméra suit le planeur ; on tourne et zoome autour.
import { SCALES } from "./scales.js";
import { three } from "./pump3d.js";

const fr = (x, n = 1) => x.toFixed(n).replace(".", ",").replace(/^-0,0$/, "0,0");
const km = x => String(Math.round(x / 50) * 50).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const D = 111320, D2R = Math.PI / 180;
// teintes du relief selon l'altitude : plaine, forêt, alpages, rocher, neige
const HYPSO = (() => {
  const st = [[200, [108, 136, 84]], [900, [92, 122, 72]], [1500, [104, 112, 76]], [2000, [148, 140, 112]], [2600, [160, 156, 150]], [3100, [214, 218, 224]], [4000, [246, 247, 250]]];
  return z => {
    let k = 1;
    while (k < st.length - 1 && z > st[k][0]) k++;
    const [z0, a] = st[k - 1], [z1, b] = st[k], t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
    return [0, 1, 2].map(c => (a[c] + (b[c] - a[c]) * t) / 255);
  };
})();

let R = null;
function setup(THREE, el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(50, 1, 20, 600000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 150; controls.maxDistance = 150000;
  R = { THREE, renderer, camera, controls, el, scene: null, labels: [], on: false, follow: true };
  window.__replay3d = R;                    // débogage dans la console
  new ResizeObserver(resize).observe(el);
  const loop = () => {
    requestAnimationFrame(loop);
    if (!R.on || !R.scene) return;
    if (R.follow && R.glider) {
      const d = R.glider.position.clone().sub(controls.target);
      camera.position.add(d); controls.target.add(d);
    }
    controls.update();
    renderer.render(R.scene, camera);
    placeLabels();
  };
  loop();
}
function resize() {
  if (!R) return;
  const w = R.el.clientWidth, h = R.el.clientHeight;
  if (!w || !h) return;
  R.renderer.setSize(w, h);
  R.camera.aspect = w / h; R.camera.updateProjectionMatrix();
}
function placeLabels() {
  const w = R.el.clientWidth, h = R.el.clientHeight, v = new R.THREE.Vector3();
  for (const L of R.labels) {
    v.copy(L.pos).project(R.camera);
    const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
    L.el.style.display = vis ? "" : "none";
    if (vis) { L.el.style.left = ((v.x + 1) / 2 * w) + "px"; L.el.style.top = ((1 - v.y) / 2 * h) + "px"; }
  }
}
function clearLabels(kind) {
  R.labels = R.labels.filter(L => { if (L.kind !== kind) return true; L.el.remove(); return false; });
}
function label(text, pos, kind, cls = "") {
  const d = document.createElement("div");
  d.className = "lbl " + cls; d.innerHTML = text; R.el.appendChild(d);
  R.labels.push({ el: d, pos, kind });
}

export function pauseReplay3D() { if (R) R.on = false; }
export function setFollow(on) { if (R) R.follow = on; }

/**
 * Construit la scène pour le vol C.F (fixes avec lat, lon, alt, t) ; C.meta et C.elev : grille du relief ;
 * C.vz : Vz lissée de chaque point.
 */
export async function openReplay3D(el, C) {
  const THREE = await three();
  if (!R) setup(THREE, el);
  R.on = true;
  if (R.F === C.F && R.scene) { resize(); return; }
  for (const L of R.labels) L.el.remove();
  R.labels = [];
  R.F = C.F;
  const { meta, elev } = C, P = C.F.fixes, n = P.length;
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const f of P) { la0 = Math.min(la0, f.lat); la1 = Math.max(la1, f.lat); lo0 = Math.min(lo0, f.lon); lo1 = Math.max(lo1, f.lon); }
  const lat0 = (la0 + la1) / 2, lon0 = (lo0 + lo1) / 2, cl = Math.cos(lat0 * D2R);
  const X = lon => (lon - lon0) * D * cl, Z = lat => -(lat - lat0) * D;
  R.X = X; R.Z = Z; R.lat0 = lat0; R.lon0 = lon0; R.cl = cl;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb7cc);
  scene.fog = new THREE.Fog(0x9fb7cc, 60000, 220000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50483a, 0.55));
  const sun = new THREE.DirectionalLight(0xfff6e8, 0.75); sun.position.set(0.3, 1, 0.6); scene.add(sun);

  // relief : la trace plus 6 km, au plus ~220 000 sommets
  const mx = 6000;
  const ci = lon => (lon - meta.west) / (meta.east - meta.west) * meta.nx, cj = lat => (meta.north - lat) / (meta.north - meta.south) * meta.ny;
  const i0 = Math.max(0, Math.floor(ci(lo0 - mx / (D * cl)))), i1 = Math.min(meta.nx - 1, Math.ceil(ci(lo1 + mx / (D * cl))));
  const j0 = Math.max(0, Math.floor(cj(la1 + mx / D))), j1 = Math.min(meta.ny - 1, Math.ceil(cj(la0 - mx / D)));
  const step = Math.max(1, Math.ceil(Math.sqrt((i1 - i0 + 1) * (j1 - j0 + 1) / 220000)));
  const w = Math.floor((i1 - i0) / step) + 1, h = Math.floor((j1 - j0) / step) + 1;
  const pos = new Float32Array(w * h * 3), col = new Float32Array(w * h * 3);
  for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) {
    const i = i0 + a * step, j = j0 + b * step, q = b * w + a;
    const lat = meta.north - (j + 0.5) / meta.ny * (meta.north - meta.south), lon = meta.west + (i + 0.5) / meta.nx * (meta.east - meta.west);
    pos[q * 3] = X(lon); pos[q * 3 + 1] = elev[j * meta.nx + i]; pos[q * 3 + 2] = Z(lat);
    col.set(HYPSO(elev[j * meta.nx + i]), q * 3);
  }
  const idx = new Uint32Array((w - 1) * (h - 1) * 6);
  for (let b = 0, o = 0; b < h - 1; b++) for (let a = 0; a < w - 1; a++) {
    const p = b * w + a; idx.set([p, p + w, p + 1, p + 1, p + w, p + w + 1], o); o += 6;
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  tg.setAttribute("color", new THREE.BufferAttribute(col, 3));
  tg.setIndex(new THREE.BufferAttribute(idx, 1)); tg.computeVertexNormals();
  scene.add(new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true })));
  R.box = { x0: X(lo0) - mx, x1: X(lo1) + mx, z0: Z(la1) - mx, z1: Z(la0) + mx };
  const ground = (lat, lon) => {
    const i = Math.min(meta.nx - 1, Math.max(0, Math.floor(ci(lon)))), j = Math.min(meta.ny - 1, Math.max(0, Math.floor(cj(lat))));
    return elev[j * meta.nx + i];
  };
  R.ground = ground;

  // trace : ruban (horizontal + vertical, 30 m) coloré par la Vz pour la partie volée, trait gris pour la suite
  const vcol = v => v >= 0.2 ? SCALES.climb.col(Math.min(6, v)).map(c => c / 255) : v > -1 ? [0.85, 0.88, 0.9] : [0.45, 0.62, 0.95];
  const rp = new Float32Array(n * 4 * 3), rc = new Float32Array(n * 4 * 3), lp = new Float32Array(n * 3), sp = new Float32Array(n * 3);
  const HW = 15;
  for (let k = 0; k < n; k++) {
    const f = P[k], g = P[Math.min(n - 1, k + 1)], e = P[Math.max(0, k - 1)];
    const x = X(f.lon), z = Z(f.lat), y = f.alt;
    let dx = X(g.lon) - X(e.lon), dz = Z(g.lat) - Z(e.lat);
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const c = vcol(C.vz[k]), o = k * 12;
    rp.set([x - dz * HW, y, z + dx * HW, x + dz * HW, y, z - dx * HW, x, y + HW, z, x, y - HW, z], o);
    for (let q = 0; q < 4; q++) rc.set(c, o + q * 3);
    lp.set([x, y, z], k * 3);
    sp.set([x, ground(f.lat, f.lon) + 8, z], k * 3);
  }
  const ri = new Uint32Array((n - 1) * 12);
  for (let k = 0; k < n - 1; k++) {
    const a = k * 4, b = a + 4;
    ri.set([a, b, a + 1, a + 1, b, b + 1, a + 2, b + 2, a + 3, a + 3, b + 2, b + 3], k * 12);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute("position", new THREE.BufferAttribute(rp, 3));
  rg.setAttribute("color", new THREE.BufferAttribute(rc, 3));
  rg.setIndex(new THREE.BufferAttribute(ri, 1));
  const ribbon = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  scene.add(ribbon);
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(lp, 3));
  const lc = new THREE.BufferGeometry(); lc.setAttribute("position", new THREE.BufferAttribute(lp, 3)); lc.setAttribute("color", new THREE.BufferAttribute(rc.filter((_, q) => q % 12 < 3), 3));
  const future = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  const past = new THREE.Line(lc, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(future, past);
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  const shadow = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.55 }));
  scene.add(shadow);
  R.track = { ribbon, past, shadow, future };

  // planeur (agrandi ×10 pour rester visible : 150 m d'envergure à l'écran)
  const gl = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color: 0xf97316, emissive: 0x401a00 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 8), mat); body.position.z = 0.5;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(15, 0.25, 1.1), mat); wing.position.z = -0.6;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.7), mat); tail.position.z = 4.2;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, 0.9), mat); fin.position.set(0, 0.9, 4.2);
  gl.add(body, wing, tail, fin); gl.scale.setScalar(10); gl.rotation.order = "YXZ";
  const stick = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]);
  R.stick = new THREE.Line(stick, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
  scene.add(gl, R.stick);
  R.glider = gl;

  R.spots = new THREE.Group(); scene.add(R.spots);
  R.unit = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  R.spotKey = null;
  R.scene = scene;
  const f = P[0];
  gl.position.set(X(f.lon), f.alt, Z(f.lat));
  R.camera.position.set(gl.position.x - 2500, gl.position.y + 1400, gl.position.z + 2500);
  R.controls.target.copy(gl.position); R.controls.update();
  resize();
}

/** Place le planeur au point k + frac (interpolé) ; cap (rad, depuis le nord, sens horaire) et inclinaison (rad). */
export function updateReplay3D(k, frac, hd, bank) {
  if (!R || !R.scene || !R.F) return;
  const P = R.F.fixes, a = P[k], b = P[Math.min(P.length - 1, k + 1)];
  const lat = a.lat + (b.lat - a.lat) * frac, lon = a.lon + (b.lon - a.lon) * frac, alt = a.alt + (b.alt - a.alt) * frac;
  const x = R.X(lon), z = R.Z(lat);
  R.glider.position.set(x, alt, z);
  R.glider.rotation.set(0, -hd, -bank);
  const g = R.ground(lat, lon);
  R.stick.position.set(x, alt, z); R.stick.scale.set(1, Math.max(1, alt - g), 1);
  R.track.ribbon.geometry.setDrawRange(0, 12 * k);
  R.track.past.geometry.setDrawRange(0, k + 1);
  R.track.shadow.geometry.setDrawRange(0, k + 1);
  R.track.future.geometry.setDrawRange(k, P.length - k);
  R.pos = { lat, lon, alt };
}

/** Pompes de l'heure (spots avec lat, lon) au-dessus de la fiabilité minimale ; étiquettes des plus proches du planeur. */
export function setReplaySpots(spots, minP, key) {
  if (!R || !R.scene) return;
  const THREE = R.THREE;
  if (key !== R.spotKey) {
    R.spotKey = key;
    for (const c of R.spots.children) { c.material.dispose(); if (c.isLineSegments) c.geometry.dispose(); }
    R.spots.clear();
    R.shown = [];
    // un disque horizontal tous les 250 m, du départ au plafond, décalé par la dérive : là où l'on doit spiraler à cette
    // altitude. Cinq groupes d'opacité (fiabilité), couleur = Vz prévue.
    const groups = [[], [], [], [], []], axis = [], acol = [];
    if (spots) for (const s of spots) {
      if (s.prob < minP || s.vz < 0.3 || s.ceil - s.elev < 200) continue;
      const x0 = R.X(s.lon), z0 = R.Z(s.lat);
      if (x0 < R.box.x0 || x0 > R.box.x1 || z0 < R.box.z0 || z0 > R.box.z1) continue;
      const r = s.bank >= 55 ? 160 : s.bank >= 45 ? 210 : 280, H = s.ceil - s.elev;   // rayon doublé pour rester lisible de loin
      const c = SCALES.climb.col(Math.min(6, Math.max(0.3, s.vz))), g = groups[Math.min(4, Math.floor(s.prob * 5))];
      for (let z = s.elev + 150; z <= s.ceil + 1; z += 250) {
        const f = (z - s.elev) / H;
        g.push([x0 + s.tx * f, z, z0 - s.ty * f, r, c]);
      }
      R.shown.push({ s, top: new THREE.Vector3(x0 + s.tx, s.ceil, z0 - s.ty) });
      axis.push(x0, s.elev, z0, x0 + s.tx, s.ceil, z0 - s.ty);
      for (let q = 0; q < 2; q++) acol.push(c[0] / 255, c[1] / 255, c[2] / 255);
    }
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    groups.forEach((L, q) => {
      if (!L.length) return;
      const mesh = new THREE.InstancedMesh(R.unit, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2 + 0.1 * q, side: THREE.DoubleSide, depthWrite: false }), L.length);
      L.forEach(([x, y, z, r, c], k) => {
        m4.makeScale(r, 1, r).setPosition(x, y, z);
        mesh.setMatrixAt(k, m4);
        mesh.setColorAt(k, col.setRGB(c[0] / 255, c[1] / 255, c[2] / 255));
      });
      mesh.frustumCulled = false;                 // la sphère englobante serait celle d'un seul disque
      R.spots.add(mesh);
    });
    // axe de chaque pompe (trait fin, toujours visible même vu de profil)
    if (axis.length) {
      const ag = new THREE.BufferGeometry();
      ag.setAttribute("position", new THREE.Float32BufferAttribute(axis, 3));
      ag.setAttribute("color", new THREE.Float32BufferAttribute(acol, 3));
      R.spots.add(new THREE.LineSegments(ag, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 })));
    }
    R.labelAt = null;
  }
  // étiquettes : les 6 pompes les plus proches du planeur (moins de 12 km), recalculées tous les 1,5 km parcourus
  if (!R.pos || !R.shown) return;
  const p = R.pos, here = new THREE.Vector3(R.X(p.lon), p.alt, R.Z(p.lat));
  if (R.labelAt && R.labelAt.distanceTo(here) < 1500 && R.labelKey === key) return;
  R.labelAt = here; R.labelKey = key;
  clearLabels("spot");
  const near = R.shown.map(o => ({ ...o, d: Math.hypot(o.top.x - here.x, o.top.z - here.z) })).filter(o => o.d < 12000).sort((u, v) => u.d - v.d).slice(0, 6);
  for (const o of near) label(`+${fr(Math.max(0, o.s.vz))} · ${km(o.s.ceil)} m`, o.top.clone().add(new THREE.Vector3(0, 90, 0)), "spot", "spot3d");
}
