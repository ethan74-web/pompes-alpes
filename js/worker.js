// Calcul en arrière-plan : la page reste fluide pendant que les heures de la journée se calculent.
import { computeHour, loadTerrain, pointSounding, windAt } from "./model.js";
import { SCALES } from "./scales.js";
import { fetchRange, hourIndex } from "./weather.js";

const H0 = 7, H1 = 21;
let T = null;
const cur = { token: 0, date: null, W: null, hours: new Map(), full: new Map(), pending: [] };
const yieldNow = () => new Promise(ok => setTimeout(ok, 0));
const post = (m, tr) => self.postMessage(m, tr || []);

self.onmessage = e => handle(e.data).catch(err => post({ type: "error", token: e.data.token, message: String(err && err.message || err) }));

async function handle(m) {
  if (m.type === "init") {
    T = await loadTerrain(new URL("../data/", import.meta.url).href);
    post({ type: "ready", meta: T.meta });
  } else if (m.type === "day") await day(m);
  else if (m.type === "render") render(m);
  else if (m.type === "point") await point(m);
  else if (m.type === "overview") await overview(m);
}

// ---------------------------------------------------------------- journée
async function day(m) {
  cur.token = m.token; cur.pending = [];
  const W = await fetchRange(T.meta, m.start, m.end);
  if (m.token !== cur.token) return;
  if (hourIndex(W, m.date, 12) < 0) throw new Error("pas de données pour cette date");
  cur.date = m.date; cur.W = W; cur.hours = new Map(); cur.full = new Map();
  post({ type: "dayInfo", token: m.token, date: m.date, source: W.source });
  const order = [m.hour];
  for (let h = H0; h <= H1; h++) if (h !== m.hour) order.push(h);
  for (const h of order) {
    await yieldNow();
    if (m.token !== cur.token) return;
    const idx = hourIndex(W, m.date, h);
    if (idx < 0) continue;
    const F = computeHour(T, W, idx);
    store(h, F);
    post({ type: "hour", token: m.token, date: m.date, h, stats: F.stats, spots: F.spots });
    flushPending();
  }
  post({ type: "dayDone", token: m.token, date: m.date });
}

function store(h, F) {
  const { n, meta } = T;
  const climb = new Uint8Array(n), H = new Uint8Array(n), conv = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    climb[p] = Math.min(255, Math.round(F.climb[p] * 25));
    H[p] = Math.min(255, Math.round(F.H[p] / 2));
    conv[p] = Math.min(255, Math.round(F.conv[p] * 100));
  }
  // flèches de vent tous les ~3,3 km
  const arrows = [], st = 22;
  for (let j = st >> 1; j < meta.ny; j += st) for (let i = st >> 1; i < meta.nx; i += st) {
    const p = j * meta.nx + i;
    if (!T.cover[p]) continue;
    const [u, v] = windAt(T, F.S, p);
    arrows.push(i, j, u, v);
  }
  cur.hours.set(h, { climb, ceil: F.ceil, H, conv, arrows });
  // champs complets gardés pour les deux dernières heures (diagnostic au clic)
  cur.full.set(h, F);
  while (cur.full.size > 2) cur.full.delete(cur.full.keys().next().value);
}

// ---------------------------------------------------------------- image d'un calque
function render(m) {
  if (m.token !== cur.token || !cur.hours.has(m.h)) { cur.pending = cur.pending.filter(x => x.kind !== "render"); cur.pending.push({ kind: "render", m }); return; }
  const D = cur.hours.get(m.h), n = T.n, sc = SCALES[m.layer];
  const img = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    let v, a;
    if (m.layer === "climb") { v = D.climb[p] / 25; a = Math.min(1, Math.max(0, (v - 0.1) / 0.5)); }
    else if (m.layer === "ceil") { v = D.ceil[p]; a = D.climb[p] > 5 ? 1 : 0; }
    else if (m.layer === "heat") { v = D.H[p] * 2; a = Math.min(1, Math.max(0, (v - 25) / 60)); }
    else { v = D.conv[p] / 100; a = Math.min(1, Math.max(0, (v - 0.12) / 0.25)) * (D.H[p] > 15 ? 1 : 0); }
    if (a <= 0) continue;
    const c = sc.col(v);
    img[p * 4] = c[0]; img[p * 4 + 1] = c[1]; img[p * 4 + 2] = c[2]; img[p * 4 + 3] = 255 * a;
  }
  post({ type: "image", token: m.token, h: m.h, layer: m.layer, img: img.buffer, arrows: D.arrows }, [img.buffer]);
}

function flushPending() {
  const todo = cur.pending; cur.pending = [];
  for (const x of todo) if (x.kind === "render") render(x.m); else point(x.m);
}

// ---------------------------------------------------------------- diagnostic au clic
async function point(m) {
  if (m.token !== cur.token) return;
  let F = cur.full.get(m.h);
  if (!F) {
    if (!cur.hours.has(m.h)) { cur.pending.push({ kind: "point", m }); return; }
    const idx = hourIndex(cur.W, cur.date, m.h);
    F = computeHour(T, cur.W, idx);
    cur.full.set(m.h, F);
    while (cur.full.size > 2) cur.full.delete(cur.full.keys().next().value);
  }
  const D = pointSounding(T, F, m.i, m.j);
  post({ type: "point", token: m.token, h: m.h, i: m.i, j: m.j, D });
}

// ---------------------------------------------------------------- aperçu des autres jours
async function overview(m) {
  const W = await fetchRange(T.meta, m.start, m.end);
  for (const d of m.dates) {
    let best = 0, any = false;
    for (const h of [12, 14, 16]) {
      await yieldNow();
      if (m.token !== cur.token) return;
      const idx = hourIndex(W, d, h);
      if (idx < 0) continue;
      any = true;
      best = Math.max(best, computeHour(T, W, idx).stats.spotClimb);
    }
    if (any) post({ type: "dayScore", token: m.token, date: d, best });
  }
}
