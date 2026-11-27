// Fenêtre « la pompe en 3D » : relief autour du départ, colonne du thermique (cœur, bord, descendance), spirale
// conseillée, air qui la nourrit ; profils de vitesse selon l'altitude et Vz selon l'inclinaison.
// three.js n'est chargé qu'à la première ouverture.
import { SCALES, css } from "./scales.js";

const fr = (x, n = 1) => x.toFixed(n).replace(".", ",").replace(/^-0,0$/, "0,0");
const km = x => String(Math.round(x / 50) * 50).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const cardinal = d => ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"][Math.round(((d % 360) + 360) % 360 / 45) % 8];
const vers = d => { const c = cardinal(d); return c === "est" || c === "ouest" ? "vers l'" + c : "vers le " + c; };

let threeP = null;
function loadScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = src; s.crossOrigin = "anonymous";
    s.onload = ok; s.onerror = () => ko(new Error("chargement impossible de " + src));
    document.head.appendChild(s);
  });
}
export function three() {
  if (!threeP) threeP = (async () => {
    await loadScript("https://unpkg.com/three@0.128.0/build/three.min.js");
    await loadScript("https://unpkg.com/three@0.128.0/examples/js/controls/OrbitControls.js");
    return window.THREE;
  })();
  return threeP;
}

let R = null;
function setup(THREE, el) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  el.appendChild(renderer.domElement);
  const camera = new THREE.PerspectiveCamera(42, 1, 20, 80000);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  R = { THREE, renderer, camera, controls, scene: null, el, labels: [], on: false };
  new ResizeObserver(resize).observe(el);
  const loop = () => {
    requestAnimationFrame(loop);
    if (!R.on || !R.scene) return;
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
export function pause3D() { if (R) R.on = false; }

/** Construit la scène pour la pompe P (worker : pumpStructure) ; feed : trajets d'alimentation éventuels. */
export async function showPump3D(el, P, feed) {
  const THREE = await three();
  if (!R) setup(THREE, el);
  R.on = true;
  for (const L of R.labels) L.el.remove();
  R.labels = [];
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0e);
  scene.add(new THREE.HemisphereLight(0xe8eef8, 0x3a352b, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(-0.5, 1, 0.8); scene.add(sun);
  let base = 1e9;
  for (const e of P.elev) base = Math.min(base, e);
  const X = ii => (ii + P.i0 - P.i) * P.dx, Z = jj => (jj + P.j0 - P.j) * P.dx, Y = z => z - base;
  // relief coloré par la chaleur rendue à l'air
  const n = P.w * P.h, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), heat = SCALES.heat.col;
  for (let jj = 0; jj < P.h; jj++) for (let ii = 0; ii < P.w; ii++) {
    const q = jj * P.w + ii, c = heat(P.heat[q] * 2), g = 0.55;
    pos.set([X(ii), Y(P.elev[q]), Z(jj)], q * 3);
    col.set([(c[0] * g + 90 * (1 - g)) / 255, (c[1] * g + 88 * (1 - g)) / 255, (c[2] * g + 80 * (1 - g)) / 255], q * 3);
  }
  const idx = [];
  for (let jj = 0; jj < P.h - 1; jj++) for (let ii = 0; ii < P.w - 1; ii++) {
    const a = jj * P.w + ii, b = a + 1, c = a + P.w, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  tg.setAttribute("color", new THREE.BufferAttribute(col, 3));
  tg.setIndex(idx); tg.computeVertexNormals();
  scene.add(new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  const ground = (x, z) => {
    const ii = Math.round(x / P.dx + P.i - P.i0), jj = Math.round(z / P.dx + P.j - P.j0);
    if (ii < 0 || jj < 0 || ii >= P.w || jj >= P.h) return null;
    return Y(P.elev[jj * P.w + ii]);
  };
  // colonne : tube du cœur (rayon où l'air monte à la moitié de la vitesse au centre), enveloppe (bord), anneaux de descendance
  const L = P.levels, NS = 28;
  const tube = (rOf, colOf, opacity, depthWrite) => {
    const p = new Float32Array(L.length * NS * 3), c = new Float32Array(L.length * NS * 3), ix = [];
    L.forEach((lv, k) => {
      const r = Math.max(4, rOf(lv)), cc = colOf(lv);
      for (let s = 0; s < NS; s++) {
        const t = s / NS * 2 * Math.PI, o = (k * NS + s) * 3;
        p[o] = lv.x + r * Math.cos(t); p[o + 1] = Y(lv.z); p[o + 2] = -lv.y + r * Math.sin(t);
        c[o] = cc[0] / 255; c[o + 1] = cc[1] / 255; c[o + 2] = cc[2] / 255;
      }
      if (k < L.length - 1) for (let s = 0; s < NS; s++) {
        const a = k * NS + s, b = k * NS + (s + 1) % NS, d = a + NS, e = b + NS;
        ix.push(a, d, b, b, d, e);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.setIndex(ix); g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite }));
  };
  scene.add(tube(lv => lv.rHalf, lv => SCALES.climb.col(Math.max(0.3, lv.core)), 0.9, true));
  scene.add(tube(lv => lv.rEdge, () => [235, 240, 245], 0.13, false));
  L.forEach((lv, k) => {
    if (k % 3 !== 1 || lv.wMin > -0.15) return;
    const tor = new THREE.Mesh(new THREE.TorusGeometry(lv.rSink, Math.max(3, 0.06 * lv.rSink), 6, 48),
      new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: Math.min(0.9, 0.25 + 0.5 * -lv.wMin) }));
    tor.rotation.x = Math.PI / 2; tor.position.set(lv.x, Y(lv.z), -lv.y); scene.add(tor);
  });
  // spirale conseillée, à mi-hauteur de la bande où l'on spirale
  const mid = L[Math.round(L.length / 2)], bb = P.bestBank;
  const gl = new THREE.Mesh(new THREE.TorusGeometry(bb.R, 3.5, 6, 64), new THREE.MeshBasicMaterial({ color: 0xf97316 }));
  gl.rotation.x = Math.PI / 2; gl.position.set(mid.x, Y(mid.z), -mid.y); scene.add(gl);
  // points de convergence d'où l'air chaud part vraiment, et trajets de l'air près du sol
  const smax = P.sources.length ? P.sources[0][2] : 1;
  for (const [ii, jj, wt] of P.sources) {
    const x = (ii - P.i) * P.dx, z = (jj - P.j) * P.dx, y = ground(x, z);
    if (y == null) continue;
    const s = new THREE.Mesh(new THREE.SphereGeometry(10 + 40 * Math.sqrt(wt / smax), 12, 8), new THREE.MeshBasicMaterial({ color: 0xa5f3fc, transparent: true, opacity: 0.85 }));
    s.position.set(x, y + 10, z); scene.add(s);
  }
  if (feed) for (const path of feed.paths) {
    const pts = [];
    for (let k = 0; k < path.length; k += 2) {
      const x = (path[k] - P.i) * P.dx, z = (path[k + 1] - P.j) * P.dx, y = ground(x, z);
      if (y != null) pts.push(new THREE.Vector3(x, y + 25, z));
    }
    if (pts.length > 1) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xa5f3fc })));
  }
  // repères
  const label = (text, x, y, z, cls = "") => {
    const d = document.createElement("div");
    d.className = "lbl " + cls; d.textContent = text; R.el.appendChild(d);
    R.labels.push({ el: d, pos: new THREE.Vector3(x, y, z) });
  };
  const top = L[L.length - 1];
  label(`plafond ${km(P.ceil)} m`, top.x, Y(top.z) + 120, -top.y);
  label(`départ ${km(P.z0)} m`, 0, Y(P.z0) - 90, 0);
  label(`${bb.deg}° · ${Math.round(bb.V * 3.6)} km/h`, mid.x + bb.R + 160, Y(mid.z), -mid.y);
  if (P.lid) {
    const lid = new THREE.Mesh(new THREE.PlaneGeometry(P.w * P.dx, P.h * P.dx), new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    lid.rotation.x = -Math.PI / 2; lid.position.set(X((P.w - 1) / 2), Y(P.lid), Z((P.h - 1) / 2)); scene.add(lid);
    label(`couvercle de l'air de vallée ~${km(P.lid)} m`, X(0) + 500, Y(P.lid) + 60, Z(0) + 300);
  }
  const span = Math.max(P.w, P.h) * P.dx;
  label("N", 0, Y(P.z0) + 40, Z(0) + 200, "north");
  // règle des altitudes au coin nord-est (au fond, vu depuis le sud-ouest)
  const cx = X(P.w - 1), cz = Z(0);
  const z1 = Math.ceil(base / 500) * 500, z2 = Math.max(P.ceil, P.top) + 300;
  const rp = [];
  for (let z = z1; z <= z2; z += 500) { rp.push(new THREE.Vector3(cx, Y(z), cz), new THREE.Vector3(cx + 120, Y(z), cz)); label(`${km(z)} m`, cx - 260, Y(z), cz); }
  rp.push(new THREE.Vector3(cx, Y(z1), cz), new THREE.Vector3(cx, Y(z2 - 300), cz));
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rp), new THREE.LineBasicMaterial({ color: 0x8b8f93 })));
  R.scene = scene;
  // caméra : depuis le sud-ouest, un peu au-dessus, assez loin pour voir le relief et toute la colonne (dérive comprise)
  const H = Math.max(P.ceil, P.top) - base, dr = Math.hypot(top.x, top.y);
  const target = new THREE.Vector3(top.x * 0.4, (Y(P.z0) + Y(P.ceil)) / 2, -top.y * 0.4);
  const d = 1.15 * Math.max(span, H * 1.5, dr + span * 0.6);
  R.camera.position.set(target.x - d * 0.55, target.y + d * 0.42, target.z + d * 0.72);
  R.controls.target.copy(target); R.controls.autoRotate = true; R.controls.update();
  resize();
}

// ---------------------------------------------------------------- texte et graphiques
export function pumpText(P) {
  const bb = P.bestBank, b35 = P.banks.find(b => b.deg === 35), b55 = P.banks.find(b => b.deg === 55);
  const band = P.levels.filter(l => l.z > P.z0 + 0.3 * (P.ceil - P.z0) && l.z < P.z0 + 0.7 * (P.ceil - P.z0));
  const midL = band[Math.floor(band.length / 2)] || P.levels[12];
  const coreMax = P.levels.filter(l => l.z > P.z0 + 0.25 * (P.ceil - P.z0)).reduce((a, l) => (l.core > a.core ? l : a), { core: 0, z: P.z0 });
  const wMin = Math.min(...band.map(l => l.wMin));
  const style = bb.deg >= 50 ? "pompe <b>étroite</b> : serrer franchement, quitte à voler plus lentement"
    : bb.deg <= 35 ? "pompe <b>large</b> : inutile de serrer, une spirale ample monte autant" : "spirale classique";
  const turb = Math.max(bb.wing, 0.7 * P.edge);
  const tCat = turb < 0.4 ? "faible" : turb < 0.9 ? "modérée" : "forte";
  const last = P.levels[P.levels.length - 1], drift = Math.hypot(last.x, last.y);
  const out = [];
  out.push(`Vz au vario <b>+${fr(Math.max(0, bb.vz))} m/s</b> en spirale conseillée · plafond <b>${km(P.ceil)} m</b>.`);
  out.push(`<b>Inclinaison conseillée : ${bb.deg}°</b> à ${Math.round(bb.V * 3.6)} km/h (rayon ${Math.round(bb.R)} m) ; à 35° : ${fr(b35.vz)} m/s, à 55° : ${fr(b55.vz)} m/s. ${style[0].toUpperCase() + style.slice(1)}.`);
  out.push(`Largeur : l'air monte à plus de la moitié de la vitesse du cœur sur <b>${Math.round(2 * midL.rHalf)} m</b> de diamètre à mi-hauteur, et ne monte plus au-delà de ${Math.round(2 * midL.rEdge)} m. Cœur le plus fort : ${fr(coreMax.core)} m/s vers ${km(coreMax.z)} m.`);
  out.push(`<b>Turbulence ${tCat}</b> : ${fr(bb.wing)} m/s d'écart entre les bouts d'aile en spirale conseillée, jusqu'à ${fr(P.edge)} m/s en entrant dans la pompe` + (wMin < -0.2 ? ` ; descendance autour jusqu'à ${fr(wMin)} m/s, à ${Math.round(midL.rSink)} m du centre.` : ".")
    + (P.shear * 3.6 > 15 ? ` Le vent change de ${Math.round(P.shear * 3.6)} km/h entre le bas et le haut : pompe penchée, souvent hachée.` : ""));
  const src = P.sources.length;
  if (src) {
    const [si, sj] = P.sources[0], d = Math.hypot(si - P.i, sj - P.j) * P.dx;
    out.push(`Départ : l'air chaud s'élève surtout ${d < 120 ? "au point de départ même" : `à ${Math.round(d / 10) * 10} m du point de départ`} (point bleu clair le plus gros)${src > 1 ? `, aidé par ${src - 1} autre${src > 2 ? "s" : ""} point${src > 2 ? "s" : ""} de convergence dans un rayon de ${km(2 * P.Rc)} m` : ""}.`
      + (drift > 300 ? ` La colonne dérive de ${km(drift)} m ${vers(Math.atan2(last.x, last.y) * 180 / Math.PI)} jusqu'au plafond.` : ""));
  }
  if (P.shared > 0.05) out.push(`Air partagé : ${Math.round(P.shared * 100)} % de la chaleur de son bassin est aussi captée par une pompe voisine ; chacune n'en reçoit que sa part.`);
  if (P.lid) out.push(`Couvercle de l'air de vallée vers ${km(P.lid)} m : les thermiques partis du bas de la vallée s'y arrêtent souvent ; au-dessus, il faut rejoindre les pentes plus hautes.`);
  return out.join("<br>");
}

function axes(g, W, H, L0, R0, T0, B0) { return { X0: L0, X1: W - R0, Y0: T0, Y1: H - B0 }; }

export function drawProfile(c, P) {
  const g = c.getContext("2d"), W = c.width, H = c.height, cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  g.clearRect(0, 0, W, H);
  const L = P.levels.filter(l => l.z >= P.z0 + 0.06 * (P.ceil - P.z0));
  const zmin = P.z0, zmax = Math.max(P.ceil, P.top) + 150;
  const vmax = Math.min(12, Math.ceil(Math.max(...L.map(l => l.core)) + 0.5)), vmin = Math.min(-2, Math.floor(Math.min(...L.map(l => Math.min(l.wMin, l.best.vz)))));
  const A = axes(g, W, H, 64, 16, 44, 46);
  const x = v => A.X0 + (v - vmin) / (vmax - vmin) * (A.X1 - A.X0), y = z => A.Y1 - (z - zmin) / (zmax - zmin) * (A.Y1 - A.Y0);
  g.font = "15px system-ui, sans-serif"; g.lineWidth = 1; g.strokeStyle = col("--line"); g.fillStyle = col("--muted");
  g.textAlign = "right";
  const zs = Math.max(250, Math.round((zmax - zmin) / 6 / 250) * 250);
  for (let z = Math.ceil(zmin / zs) * zs; z <= zmax; z += zs) { g.beginPath(); g.moveTo(A.X0, y(z)); g.lineTo(A.X1, y(z)); g.stroke(); g.fillText(km(z) + " m", A.X0 - 6, y(z) + 5); }
  g.textAlign = "center";
  for (let v = vmin; v <= vmax; v += vmax - vmin > 8 ? 2 : 1) { g.beginPath(); g.moveTo(x(v), A.Y0); g.lineTo(x(v), A.Y1); g.stroke(); g.fillText(String(v), x(v), A.Y1 + 20); }
  g.fillText("vitesse verticale (m/s)", (A.X0 + A.X1) / 2, H - 6);
  g.strokeStyle = col("--muted"); g.lineWidth = 1.5; g.beginPath(); g.moveTo(x(0), A.Y0); g.lineTo(x(0), A.Y1); g.stroke();
  g.setLineDash([4, 4]); g.strokeStyle = col("--fg"); g.beginPath(); g.moveTo(A.X0, y(P.ceil)); g.lineTo(A.X1, y(P.ceil)); g.stroke(); g.setLineDash([]);
  g.fillStyle = col("--fg"); g.textAlign = "left"; g.fillText("plafond " + km(P.ceil) + " m", A.X0 + 6, y(P.ceil) - 6);
  if (P.lid && P.lid > zmin && P.lid < zmax) { g.fillStyle = "rgba(251,191,36,.18)"; g.fillRect(A.X0, y(P.lid + 300), A.X1 - A.X0, y(P.lid) - y(P.lid + 300)); }
  const line = (get, color, w, dash = []) => { g.strokeStyle = color; g.lineWidth = w; g.setLineDash(dash); g.beginPath(); L.forEach((l, k) => { const px = x(get(l)), py = y(l.z); k ? g.lineTo(px, py) : g.moveTo(px, py); }); g.stroke(); g.setLineDash([]); };
  line(l => l.wMin, "#3b82f6", 2.5);
  line(l => l.core, "#ef4444", 3.5);
  line(l => l.best.vz, col("--fg"), 3);
  // inclinaison conseillée le long de la montée
  g.font = "600 13px system-ui, sans-serif"; g.fillStyle = col("--fg"); g.textAlign = "left";
  let lastDeg = null;
  L.forEach((l, k) => { if (k % 4 === 0 && l.best.deg !== lastDeg) { g.fillText(l.best.deg + "°", x(l.best.vz) + 8, y(l.z) + 4); lastDeg = l.best.deg; } });
  // légende
  g.font = "14px system-ui, sans-serif";
  const leg = [["#ef4444", "cœur"], [col("--fg"), "au vario, inclinaison conseillée"], ["#3b82f6", "descendance autour"]];
  let lx = A.X0;
  for (const [cc, t] of leg) { g.fillStyle = cc; g.fillRect(lx, 14, 16, 4); g.fillStyle = col("--ink2"); g.fillText(t, lx + 22, 20); lx += 32 + g.measureText(t).width; }
}

export function drawBank(c, P) {
  const g = c.getContext("2d"), W = c.width, H = c.height, cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  g.clearRect(0, 0, W, H);
  const B = P.banks, A = axes(g, W, H, 56, 56, 40, 58);
  const vmin = Math.floor(Math.min(0, ...B.map(b => b.vz))), vmax = Math.ceil(Math.max(1, ...B.map(b => b.vz)) + 0.3);
  const tmax = Math.max(1.5, Math.ceil(Math.max(...B.map(b => b.wing)) * 2) / 2);
  const x = d => A.X0 + (d - 25) / 35 * (A.X1 - A.X0), y = v => A.Y1 - (v - vmin) / (vmax - vmin) * (A.Y1 - A.Y0), yt = t => A.Y1 - t / tmax * (A.Y1 - A.Y0);
  g.font = "14px system-ui, sans-serif"; g.strokeStyle = col("--line"); g.fillStyle = col("--muted"); g.lineWidth = 1;
  g.textAlign = "right";
  for (let v = vmin; v <= vmax; v++) { g.beginPath(); g.moveTo(A.X0, y(v)); g.lineTo(A.X1, y(v)); g.stroke(); g.fillText(String(v), A.X0 - 6, y(v) + 5); }
  g.textAlign = "left"; g.fillStyle = "#60a5fa";
  for (let t = 0; t <= tmax; t += 0.5) g.fillText(fr(t), A.X1 + 6, yt(t) + 5);
  g.textAlign = "center"; g.fillStyle = col("--muted");
  for (const b of B) if (b.deg % 5 === 0) g.fillText(b.deg + "°", x(b.deg), A.Y1 + 18);
  g.font = "13px system-ui, sans-serif";
  for (const b of B) if (b.deg === 30 || b.deg === 45 || b.deg === 60) g.fillText(`${Math.round(b.V * 3.6)} km/h · ${Math.round(b.R)} m`, x(b.deg), A.Y1 + 36);
  g.font = "14px system-ui, sans-serif";
  g.fillText("inclinaison (vitesse et rayon de la spirale)", (A.X0 + A.X1) / 2, H - 4);
  g.setLineDash([6, 5]); g.strokeStyle = "#60a5fa"; g.lineWidth = 2; g.beginPath(); B.forEach((b, k) => k ? g.lineTo(x(b.deg), yt(b.wing)) : g.moveTo(x(b.deg), yt(b.wing))); g.stroke(); g.setLineDash([]);
  g.strokeStyle = col("--fg"); g.lineWidth = 3; g.beginPath(); B.forEach((b, k) => k ? g.lineTo(x(b.deg), y(b.vz)) : g.moveTo(x(b.deg), y(b.vz))); g.stroke();
  const bb = P.bestBank;
  g.fillStyle = "#f97316"; g.beginPath(); g.arc(x(bb.deg), y(bb.vz), 7, 0, 2 * Math.PI); g.fill();
  g.font = "600 14px system-ui, sans-serif"; g.textAlign = x(bb.deg) > W - 200 ? "right" : "left"; g.fillStyle = col("--fg");
  g.fillText(`${bb.deg}° : +${fr(Math.max(0, bb.vz))} m/s`, x(bb.deg) + (g.textAlign === "left" ? 12 : -12), y(bb.vz) - 10);
  g.font = "14px system-ui, sans-serif"; g.textAlign = "left";
  g.fillStyle = col("--fg"); g.fillRect(A.X0, 14, 16, 4); g.fillStyle = col("--ink2"); g.fillText("Vz au vario (m/s)", A.X0 + 22, 20);
  g.fillStyle = "#60a5fa"; g.fillRect(A.X0 + 170, 14, 16, 4); g.fillStyle = col("--ink2"); g.fillText("écart entre bouts d'aile (m/s, à droite)", A.X0 + 192, 20);
}
