// Calcul en arrière-plan : la page reste fluide pendant que les heures de la journée se calculent.
import { computeHour, feedAnalysis, loadTerrain, pointSounding, polarOf, pumpStructure, setPolar, windAt } from "./model.js";
import { SCALES } from "./scales.js";
import { fetchRange, hourIndex, MODELS } from "./weather.js";

const H0 = 7, H1 = 21;
const DATA = new URL("../data/", import.meta.url).href;
let T = null;
const cur = { token: 0, date: null, model: null, W: null, hours: new Map(), full: new Map(), pending: [] };
const yieldNow = () => new Promise(ok => setTimeout(ok, 0));
const post = (m, tr) => self.postMessage(m, tr || []);
let cmpToken = 0;

self.onmessage = e => handle(e.data).catch(err => post({ type: e.data.type === "compare" ? "cmpError" : "error", token: e.data.token, message: String(err && err.message || err) }));

// ---------------------------------------------------------------- calcul parallèle des heures
// Fils annexes (helper.js) : chacun charge le relief et calcule des heures entières ; sans eux, calcul ici même.
const pool = { helpers: [], W: null, queue: [], next: 0, jobs: new Map() };
async function initPool() {
  const hw = self.navigator.hardwareConcurrency || 2, mem = self.navigator.deviceMemory || 8;
  const n = Math.max(0, Math.min(mem <= 4 ? 1 : 3, hw - 1));
  const ready = [];
  for (let k = 0; k < n; k++) {
    try {
      const h = new Worker(new URL("./helper.js", import.meta.url), { type: "module" });
      h.busy = false;
      ready.push(new Promise(ok => {
        h.onmessage = e => {
          const r = e.data;
          if (r.type === "ready") { pool.helpers.push(h); ok(); dispatch(); return; }
          const job = pool.jobs.get(r.job); pool.jobs.delete(r.job); h.busy = false;
          if (job) { if (r.type === "hour") job.ok(r.F); else job.ko(new Error(r.message)); }
          dispatch();
        };
        h.onerror = () => ok();
      }));
      h.postMessage({ type: "init", base: DATA });
    } catch (e) { /* fils imbriqués non pris en charge : calcul sur place */ }
  }
  await Promise.race([Promise.all(ready), new Promise(ok => setTimeout(ok, 20000))]);
}
function dispatch() {
  for (const h of pool.helpers) {
    if (h.busy || !pool.queue.length) continue;
    const job = pool.queue.shift();
    if (h.W !== job.W) { h.postMessage({ type: "weather", W: job.W }); h.W = job.W; }
    h.busy = true; pool.jobs.set(job.id, job);
    h.postMessage({ type: "hour", job: job.id, idx: job.idx });
  }
}
/** Calcule l'heure idx de W, sur un fil annexe libre si possible. */
function computeAsync(W, idx, front = false) {
  if (!pool.helpers.length) return yieldNow().then(() => computeHour(T, W, idx));
  return new Promise((ok, ko) => {
    const job = { id: ++pool.next, W, idx, ok, ko };
    if (front) pool.queue.unshift(job); else pool.queue.push(job);
    dispatch();
  });
}
function cancelQueued() { for (const j of pool.queue) j.ko(new Error("annulé")); pool.queue = []; }

async function handle(m) {
  if (m.type === "init") {
    T = await loadTerrain(DATA);
    await initPool();
    post({ type: "ready", meta: T.meta, threads: pool.helpers.length });
  } else if (m.type === "day") await day(m);
  else if (m.type === "render") render(m);
  else if (m.type === "point") await point(m);
  else if (m.type === "overview") await overview(m).catch(() => {});     // l'aperçu des autres jours est facultatif
  else if (m.type === "compare") await compare(m);
}

// ---------------------------------------------------------------- journée
let gliderKey = "std/0";
function useGlider(g) {
  const key = g ? `${g.id}/${g.ballast}` : "std/0";
  if (key === gliderKey) return;
  gliderKey = key;
  const P = polarOf(g ? g.id : "std", g ? g.ballast : 0);
  setPolar(P.a, P.b, P.vm);
  for (const h of pool.helpers) h.postMessage({ type: "polar", a: P.a, b: P.b, vm: P.vm });
}

async function day(m) {
  cur.token = m.token; cur.pending = [];
  cancelQueued();
  useGlider(m.glider);
  const W = await fetchRange(T.meta, m.start, m.end, m.model, DATA, s => post({ type: "wait", token: m.token, seconds: s }));
  if (m.token !== cur.token) return;
  if (hourIndex(W, m.date, 12) < 0) throw new Error("pas de données pour cette date");
  cur.date = m.date; cur.model = m.model; cur.W = W; cur.hours = new Map(); cur.full = new Map();
  post({ type: "dayInfo", token: m.token, date: m.date, source: W.source });
  const order = [m.hour];
  for (let d = 1; d <= H1 - H0; d++) for (const h of [m.hour + d, m.hour - d]) if (h >= H0 && h <= H1) order.push(h);
  const t0 = Date.now();
  await Promise.all(order.map(h => {
    const idx = hourIndex(W, m.date, h);
    if (idx < 0) return null;
    return computeAsync(W, idx).then(F => {
      if (m.token !== cur.token) return;
      store(h, F);
      post({ type: "hour", token: m.token, date: m.date, h, stats: F.stats, spots: F.spots });
      flushPending();
    }, () => {});
  }));
  if (m.token !== cur.token) return;
  post({ type: "dayDone", token: m.token, date: m.date, seconds: (Date.now() - t0) / 1000 });
}

function store(h, F) {
  const { n, meta } = T;
  const climb = new Uint8Array(n), H = new Uint8Array(n), conv = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    climb[p] = Math.min(255, Math.round(F.climb[p] * 25));
    H[p] = Math.min(255, Math.round(F.H[p] / 2));
    conv[p] = Math.min(255, Math.round(F.conv[p] * 100));
  }
  // flèches : vent dans la couche convective tous les ~3,3 km ; flux près du relief (brises + vent) tous les 900 m
  const arrows = [], st = 22;
  for (let j = st >> 1; j < meta.ny; j += st) for (let i = st >> 1; i < meta.nx; i += st) {
    const p = j * meta.nx + i;
    if (!T.cover[p]) continue;
    const [u, v] = windAt(T, F.S, p);
    arrows.push(i, j, u, v);
  }
  const surf = [], s2 = 6;
  for (let j = s2 >> 1; j < meta.ny; j += s2) for (let i = s2 >> 1; i < meta.nx; i += s2) {
    const p = j * meta.nx + i;
    if (!T.cover[p]) continue;
    surf.push(i, j, F.flow.fu[p], F.flow.fv[p]);
  }
  cur.hours.set(h, { climb, ceil: F.ceil, H, conv, arrows, surf: new Float32Array(surf), wave: F.wave });
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
    else if (m.layer === "wave") { v = D.wave ? D.wave[p] / 255 : 0; a = Math.min(1, v * 2.5); }
    else { v = D.conv[p] / 100; a = Math.min(1, Math.max(0, (v - 0.15) / 0.25)) * (D.H[p] > 15 ? 1 : 0); }
    if (a <= 0) continue;
    const c = sc.col(v);
    img[p * 4] = c[0]; img[p * 4 + 1] = c[1]; img[p * 4 + 2] = c[2]; img[p * 4 + 3] = 255 * a;
  }
  const surf = D.surf.slice();
  post({ type: "image", token: m.token, h: m.h, layer: m.layer, img: img.buffer, arrows: D.arrows, surf }, [img.buffer, surf.buffer]);
}

function flushPending() {
  const todo = cur.pending; cur.pending = [];
  for (const x of todo) if (x.kind === "render") render(x.m); else point(x.m);
}

// ---------------------------------------------------------------- diagnostic au clic
async function fullHour(h) {
  let F = cur.full.get(h);
  if (!F) {
    const idx = hourIndex(cur.W, cur.date, h);
    F = await computeAsync(cur.W, idx, true);
    cur.full.set(h, F);
    while (cur.full.size > 2) cur.full.delete(cur.full.keys().next().value);
  }
  return F;
}

async function point(m) {
  if (m.token !== cur.token) return;
  if (!cur.hours.has(m.h)) { cur.pending.push({ kind: "point", m }); return; }
  const F = await fullHour(m.h);
  const D = pointSounding(T, F, m.i, m.j);
  if (m.pump) D.pump = pumpStructure(T, F, m.i, m.j);
  if (m.feed) D.feed = feedAnalysis(T, F, m.i, m.j);
  const tr = [];
  if (D.feed) tr.push(D.feed.raster.buffer);
  if (D.pump) tr.push(D.pump.elev.buffer, D.pump.heat.buffer);
  post({ type: "point", token: m.token, h: m.h, i: m.i, j: m.j, D }, tr);
}

// ---------------------------------------------------------------- aperçu des autres jours
async function overview(m) {
  const W = await fetchRange(T.meta, m.start, m.end, m.model, DATA);
  await Promise.all(m.dates.map(async d => {
    const idxs = [12, 14, 16].map(h => hourIndex(W, d, h)).filter(i => i >= 0);
    if (!idxs.length || m.token !== cur.token) return;
    const Fs = await Promise.all(idxs.map(i => computeAsync(W, i).catch(() => null)));
    if (m.token !== cur.token) return;
    const best = Math.max(0, ...Fs.filter(Boolean).map(F => F.stats.spotClimb));
    post({ type: "dayScore", token: m.token, date: d, best });
  }));
}

// ---------------------------------------------------------------- comparaison des modèles
async function compare(m) {
  const my = ++cmpToken;
  const hours = [9, 11, 13, 15, 17];
  for (const mod of MODELS) {
    let W;
    try { W = await fetchRange(T.meta, m.date, m.date, mod.id, DATA, s => post({ type: "cmp", token: m.token, model: mod.id, wait: s })); }
    catch (e) { post({ type: "cmp", token: m.token, model: mod.id, error: String(e.message || e) }); continue; }
    if (my !== cmpToken) return;
    await Promise.all(hours.map(async h => {
      const idx = hourIndex(W, m.date, h);
      if (idx < 0) return;
      const F = await computeAsync(W, idx).catch(() => null);
      if (!F || my !== cmpToken) return;
      const s = F.stats;
      const out = { type: "cmp", token: m.token, model: mod.id, h, vz: s.spotClimb, ceil: s.ceilMed, ceilLo: s.ceilLo, ceilHi: s.ceilHi,
        wind: s.wind25, cloud: s.cloud, rain: s.rain, n: s.nSpots };
      if (m.i != null) { const D = pointSounding(T, F, m.i, m.j); out.sounding = D.rows.map(r => [r.z, r.T, r.Td]); out.z0 = D.z0; out.top = D.top; }
      post(out);
    }));
  }
  post({ type: "cmpDone", token: m.token });
}
