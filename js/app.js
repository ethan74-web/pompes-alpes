// Interface : carte Leaflet, calques calculés en arrière-plan (worker.js), curseur horaire, diagnostic au clic,
// alimentation des pompes, choix et comparaison des modèles météo.
import { SCALES, css } from "./scales.js";
import { addDays, isoDate, MODELS, DEFAULT_MODEL, fetchEnsemble } from "./weather.js";
import { drawBank, drawProfile, pause3D, pumpText, showPump3D } from "./pump3d.js";
import { GLIDERS } from "./model.js";
import { compareFlight, findThermals, flightStats, localHour, parseIGC } from "./igc.js";

const $ = id => document.getElementById(id);
const H0 = 7, H1 = 21;
const fr = (x, n = 1) => x.toFixed(n).replace(".", ",").replace(/^-0,0$/, "0,0");
const km = x => String(Math.round(x / 50) * 50).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pct = x => Math.round(x * 100) + " %";
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MCOL = ["#f97316", "#60a5fa", "#2dd4a7", "#fbbf24", "#c084fc", "#f87171"];

const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } } };
const st = { meta: null, date: null, hour: 14, layer: "climb", hours: new Map(), dayScores: new Map(), token: 0, point: null, playing: null,
  week: null, wanted: null, deferred: false, done: false, source: "", model: DEFAULT_MODEL, cmp: null, cmpToken: 0, feed: null };
if (MODELS.some(m => m.id === store.get("model"))) st.model = store.get("model");
let map, bounds, fieldLayer, windLayer, spotsLayer, namesLayer, feedLayer, baseLayers, canvas, ctx, wcanvas, wctx, worker, spotRenderer, flightLayer, liveLayer;
window.__pompes = st;                       // accès pour le débogage dans la console
window.__feed = (i, j) => askPoint(L.latLng(...cellCenter(i, j)), false, true);

// calque Leaflet qui affiche directement un <canvas> (pas de réencodage d'image à chaque heure)
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const c = this._image = this._url;
    L.DomUtil.addClass(c, "leaflet-image-layer");
    if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
    c.onselectstart = L.Util.falseFn; c.onmousemove = L.Util.falseFn;
    if (this.options.zIndex != null) this._updateZIndex();
  },
});

// ---------------------------------------------------------------- initialisation
async function init() {
  setStatus("Chargement du relief…");
  $("date").addEventListener("change", e => {
    if (!e.target.value) return;
    if (st.week) selectDate(e.target.value, true); else { st.wanted = e.target.value; st.deferred = true; }
  });
  const sel = $("model");
  for (const m of MODELS) { const o = document.createElement("option"); o.value = m.id; o.textContent = m.name; sel.appendChild(o); }
  sel.value = st.model;
  const gs = $("glider");
  for (const g of GLIDERS) { const o = document.createElement("option"); o.value = g.id; o.textContent = g.name; gs.appendChild(o); }
  if (GLIDERS.some(g => g.id === store.get("glider"))) gs.value = store.get("glider");
  if (["0", "0.1", "0.2", "0.3"].includes(store.get("ballast"))) $("ballast").value = store.get("ballast");
  const regl = () => {
    store.set("glider", gs.value); store.set("ballast", $("ballast").value);
    st.dayScores = new Map(); paintDays();
    if (st.date || st.wanted) { const d = st.date || st.wanted; selectDate(d, !(st.week && st.week.includes(d))); }
  };
  gs.addEventListener("change", regl); $("ballast").addEventListener("change", regl);
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = e => onWorker(e.data);
  worker.onerror = e => setStatus("Erreur du calcul : " + (e.message || "navigateur trop ancien ?"), true);
  worker.postMessage({ type: "init" });
}

function onReady(meta) {
  st.meta = meta;
  bounds = [[meta.south, meta.west], [meta.north, meta.east]];
  map = L.map("map", { zoomSnap: 0.25, minZoom: 8, maxZoom: 14, maxBounds: L.latLngBounds(bounds).pad(0.3) });
  map.fitBounds(bounds);
  window.__map = map;
  baseLayers = {
    relief: L.imageOverlay("data/relief.jpg", bounds, { attribution: "Relief SRTM (NASA)" }),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 15, attribution: "© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)" }),
    osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }),
  };
  baseLayers.relief.addTo(map);
  canvas = document.createElement("canvas"); canvas.width = meta.nx; canvas.height = meta.ny; ctx = canvas.getContext("2d");
  wcanvas = document.createElement("canvas"); wcanvas.width = meta.nx * 2; wcanvas.height = meta.ny * 2; wctx = wcanvas.getContext("2d");
  fieldLayer = new CanvasOverlay(canvas, bounds, { opacity: 0.72, className: "field", interactive: false }).addTo(map);
  windLayer = new CanvasOverlay(wcanvas, bounds, { opacity: 0.9, interactive: false }).addTo(map);
  feedLayer = L.layerGroup().addTo(map);
  spotRenderer = L.canvas({ padding: 0.3, tolerance: 4 });       // jusqu'à ~1 200 pompes : canvas plutôt que SVG
  spotsLayer = L.layerGroup().addTo(map);
  namesLayer = L.layerGroup(meta.places.map(p => L.marker([p.lat, p.lon], { interactive: false,
    icon: L.divIcon({ className: "", html: `<div class="place ${p.kind}">${p.name}</div>` }) }))).addTo(map);
  map.on("click", e => askPoint(e.latlng));
  map.on("zoomend", () => { zoomClass(); drawSpots(); });
  map.on("zoomend moveend", () => updateWind());
  zoomClass();
  for (const ev of ["mousedown", "wheel", "touchstart"]) $("map").addEventListener(ev, () => { st.touched = true; }, { passive: true });
  new ResizeObserver(() => { map.invalidateSize(); if (!st.touched) map.fitBounds(bounds); }).observe($("map"));

  $("hour").addEventListener("input", e => { st.hour = +e.target.value; stopPlay(); render(); });
  $("play").addEventListener("click", togglePlay);
  $("layers").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    st.layer = b.dataset.layer;
    for (const x of $("layers").children) x.classList.toggle("on", x === b);
    render();
  });
  for (const id of ["showSpots", "showWind", "showNames"]) $(id).addEventListener("change", render);
  const saved = +store.get("minProb");
  if (saved >= 0 && saved <= 95 && store.get("minProb") != null) $("minProb").value = saved;
  $("minProbLabel").textContent = $("minProb").value + " %";
  $("minProb").addEventListener("input", e => { $("minProbLabel").textContent = e.target.value + " %"; store.set("minProb", e.target.value); drawSpots(); });
  const fsel = $("field"), fields = meta.places.filter(p => p.kind === "field");
  for (const f of fields) { const o = document.createElement("option"); o.value = f.name; o.textContent = f.name; fsel.appendChild(o); }
  fsel.value = fields.some(f => f.name === store.get("field")) ? store.get("field") : (fields.find(f => /Challes/.test(f.name)) || fields[0] || {}).name;
  fsel.addEventListener("change", () => { store.set("field", fsel.value); drawField(); });
  $("fieldChart").addEventListener("click", e => {
    const r = e.target.getBoundingClientRect();
    st.hour = Math.min(H1, Math.max(H0, Math.floor(H0 + (e.clientX - r.left) / r.width * (H1 - H0 + 1))));
    $("hour").value = st.hour; stopPlay(); render();
  });
  $("open3d").addEventListener("click", open3D);
  $("ensBtn").addEventListener("click", runEnsemble);
  $("exportCup").addEventListener("click", exportCup);
  flightLayer = L.layerGroup().addTo(map);
  liveLayer = L.layerGroup().addTo(map);
  if (store.get("live") === "1") $("showLive").checked = true;
  $("showLive").addEventListener("change", e => { store.set("live", e.target.checked ? "1" : "0"); refreshLive(); });
  setInterval(() => { if ($("showLive").checked && document.visibilityState === "visible") refreshLive(); }, 300e3);
  refreshLive();
  $("igc").addEventListener("change", e => loadFlights(e.target.files));
  $("flightClear").addEventListener("click", () => { st.flights = []; st.flight = null; flightLayer.clearLayers(); drawFlightList(); $("flightText").textContent = ""; $("flightTable").innerHTML = ""; });
  for (const ev of ["dragover", "drop"]) $("map").addEventListener(ev, e => {
    if (!e.dataTransfer || ![...e.dataTransfer.items || []].some(i => i.kind === "file")) return;
    e.preventDefault();
    if (ev === "drop") loadFlights(e.dataTransfer.files);
  });
  $("pumpClose").addEventListener("click", close3D);
  $("pumpWin").addEventListener("click", e => { if (e.target === $("pumpWin")) close3D(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("pumpWin").hidden) close3D(); });
  $("opacity").addEventListener("input", e => fieldLayer.setOpacity(e.target.value / 100));
  $("base").addEventListener("change", e => {
    for (const k in baseLayers) map.removeLayer(baseLayers[k]);
    baseLayers[e.target.value].addTo(map);
    baseLayers[e.target.value].bringToBack();
  });
  $("model").addEventListener("change", e => {
    st.model = e.target.value; store.set("model", st.model);
    st.dayScores = new Map(); paintDays();
    const d = st.date || st.wanted || isoDate(new Date());
    selectDate(d, !(st.week && st.week.includes(d)));
  });
  $("compare").addEventListener("click", startCompare);
  $("cmpClose").addEventListener("click", () => { $("cmpBox").hidden = true; st.cmp = null; st.cmpToken++; });
  $("pointClose").addEventListener("click", () => { st.point = null; st.pumpData = null; $("pointBox").hidden = true; clearFeed(); });
  $("daychart").addEventListener("click", e => {
    const r = e.target.getBoundingClientRect();
    st.hour = Math.min(H1, Math.max(H0, Math.floor(H0 + (e.clientX - r.left) / r.width * (H1 - H0 + 1))));
    $("hour").value = st.hour; stopPlay(); render();
  });

  const today = isoDate(new Date());
  $("date").max = addDays(today, 14);
  // lien direct vers un jour : ?date=2026-07-08
  const asked = new URLSearchParams(location.search).get("date");
  if (asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= addDays(today, 14)) { st.wanted = asked; st.deferred = true; }
  loadWeek(today);
  setInterval(() => { if (document.visibilityState === "visible" && st.week && st.week.includes(st.date)) loadWeek(isoDate(new Date()), true); }, 3600e3);
}

function zoomClass() { $("map").classList.toggle("far", map.getZoom() < 10.25); }
function setStatus(t, err = false) { $("status").textContent = t; $("status").classList.toggle("err", err); }
const modelName = id => (MODELS.find(m => m.id === id) || {}).short || id;

// ---------------------------------------------------------------- dialogue avec le calcul
function onWorker(m) {
  if (m.type === "ready") return onReady(m.meta);
  if (m.type === "cmp" || m.type === "cmpDone" || m.type === "cmpError") return onCompare(m);
  if (m.type === "error") {
    if (m.token != null && m.token !== st.token) return;
    setStatus("Impossible d'afficher le " + (st.wanted || "jour demandé") + " : " + m.message, true);
    if (st.deferred) { st.deferred = false; selectDate(st.wanted, true); }
    return;
  }
  if (m.token !== st.token) return;
  if (m.type === "wait") { setStatus(`Limite par minute du service météo : nouvel essai dans ${m.seconds} s…`); return; }
  if (m.type === "dayInfo") {
    st.date = m.date; st.source = m.source; st.hours = new Map(); st.done = false;
    $("date").value = m.date;
    for (const b of $("days").children) b.classList.toggle("on", b.dataset.date === m.date);
  } else if (m.type === "hour") {
    st.hours.set(m.h, { stats: m.stats, spots: m.spots });
    if (m.h === st.hour) render();
    drawDayChart(); drawField();
    setStatus(`Calcul ${st.hours.size}/${H1 - H0 + 1}…`);
  } else if (m.type === "dayDone") {
    st.done = true;
    setStatus(`${st.source} · ${modelName(st.model)} · ${labelDate(st.date)}`);
    let best = 0;
    for (const x of st.hours.values()) best = Math.max(best, x.stats.spotClimb);
    st.dayScores.set(st.date, best);
    paintDays();
    if (st.flight && st.flight.F.date === st.date) showFlight();
    if (st.week && st.weekRange && st.week.includes(st.date)) {        // pas d'aperçu de la semaine pour un jour ancien
      const dates = st.week.filter(d => !st.dayScores.has(d));
      if (dates.length) worker.postMessage({ type: "overview", token: st.token, dates, start: st.weekRange[0], end: st.weekRange[1], model: st.model });
    }
  } else if (m.type === "dayScore") {
    st.dayScores.set(m.date, m.best); paintDays();
  } else if (m.type === "image") {
    if (m.h !== st.hour || m.layer !== st.layer) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(m.img), st.meta.nx, st.meta.ny), 0, 0);
    st.surf = m.surf;
    drawArrows(m.arrows);
    if (st.live) drawLive();
  } else if (m.type === "point") {
    if (m.h === st.hour) showPoint(m.D);
  }
}

// ---------------------------------------------------------------- jours
function loadWeek(today, silent = false) {
  const start = addDays(today, -1), end = addDays(today, 5);
  st.week = [];
  for (let d = start; d <= end; d = addDays(d, 1)) st.week.push(d);
  st.weekRange = [start, end];
  st.dayScores = new Map();
  buildDays(today);
  const want = st.wanted || today;
  if (st.deferred) { st.deferred = false; selectDate(want, !st.week.includes(want)); }
  else if (!silent || st.week.includes(st.date)) selectDate(st.week.includes(want) ? want : today, false);
}

function buildDays(today) {
  const box = $("days"); box.innerHTML = "";
  for (const d of st.week) {
    const dt = new Date(d + "T12:00:00");
    const b = document.createElement("button");
    b.type = "button"; b.dataset.date = d;
    b.innerHTML = `<small>${d === today ? "auj." : JOURS[dt.getDay()]}</small><b>${dt.getDate()}</b><i></i>`;
    b.addEventListener("click", () => selectDate(d, false));
    box.appendChild(b);
  }
}

function paintDays() {
  for (const b of $("days").children) {
    const v = st.dayScores.get(b.dataset.date);
    b.querySelector("i").style.background = v == null || v < 0.3 ? "var(--line)" : css(SCALES.climb.col(v));
    b.title = v == null ? "" : v < 0.3 ? "pas de convection exploitable" : `jusqu'à ${fr(v)} m/s au vario`;
  }
}

function selectDate(date, custom) {
  stopPlay();
  st.wanted = date;
  const my = ++st.token;
  const inWeek = st.week && st.week.includes(date) && !custom;
  setStatus("Récupération des données du " + labelDate(date) + "…");
  clearFeed();
  worker.postMessage({ type: "day", token: my, date, hour: st.hour, model: st.model, glider: { id: $("glider").value, ballast: +$("ballast").value }, start: inWeek ? st.weekRange[0] : date, end: inWeek ? st.weekRange[1] : date });
}

function labelDate(d) {
  return new Date(d + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

// ---------------------------------------------------------------- rendu
function render() {
  $("hourLabel").textContent = st.hour + " h";
  drawDayChart();
  const X = st.hours.get(st.hour);
  if (!X) return;
  worker.postMessage({ type: "render", token: st.token, h: st.hour, layer: st.layer });
  drawSpots();
  if ($("showNames").checked) namesLayer.addTo(map); else map.removeLayer(namesLayer);
  drawLegend(); writeSummary(X.stats); drawField();
  if (st.point) askPoint(st.point, true, st.feed, st.pump);
}

function drawArrows(a) { st.arrows = a; updateWind(); }

// Vent : vue d'ensemble = vent dans la couche convective, dessiné sur le calque image ; au zoom = flux près du relief
// (brises de pente + vent ajusté au relief), en marqueurs de taille fixe (sinon les flèches grossiraient avec la carte).
let windMarkers = null;
function updateWind() {
  const a = st.arrows;
  wctx.clearRect(0, 0, wcanvas.width, wcanvas.height);
  if (!windMarkers) windMarkers = L.layerGroup().addTo(map);
  windMarkers.clearLayers();
  if (!a || !$("showWind").checked) return;
  if (map.getZoom() <= 10.75) {
    for (let k = 0; k < a.length; k += 4) {
      const u = a[k + 2], v = a[k + 3], s = Math.hypot(u, v);
      if (s < 0.5) continue;
      arrow(wctx, a[k] * 2, a[k + 1] * 2, u / s, -v / s, Math.min(26, 6 + s * 2.4));
    }
    return;
  }
  const b = st.surf || [], view = map.getBounds().pad(0.1), every = map.getZoom() >= 12 ? 1 : 2;
  let n = 0;
  for (let k = 0; k < b.length; k += 4) {
    const i = b[k], j = b[k + 1];
    if (every > 1 && (((i - 3) / 6) % 2 || ((j - 3) / 6) % 2)) continue;
    const u = b[k + 2], v = b[k + 3], s = Math.hypot(u, v);
    const ll = cellCenter(i, j);
    if (s < 0.4 || !view.contains(ll)) continue;
    if (++n > 1500) break;
    const len = Math.min(26, 9 + s * 3), ang = Math.atan2(u, v) * 180 / Math.PI;
    const svg = `<svg width="${len + 8}" height="${len + 8}" viewBox="${-(len + 8) / 2} ${-(len + 8) / 2} ${len + 8} ${len + 8}" style="transform:rotate(${ang}deg)">`
      + `<path d="M0 ${len / 2} V${-len / 2} M-4 ${-len / 2 + 6} L0 ${-len / 2} L4 ${-len / 2 + 6}" stroke="rgba(0,0,0,.7)" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="M0 ${len / 2} V${-len / 2} M-4 ${-len / 2 + 6} L0 ${-len / 2} L4 ${-len / 2 + 6}" stroke="#d9f99d" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    windMarkers.addLayer(L.marker(ll, { interactive: false, keyboard: false,
      icon: L.divIcon({ className: "wind", html: svg, iconSize: [len + 8, len + 8], iconAnchor: [(len + 8) / 2, (len + 8) / 2] }) }));
  }
}

function arrow(c, x, y, ux, uy, len) {
  const x1 = x + ux * len / 2, y1 = y + uy * len / 2, x0 = x - ux * len / 2, y0 = y - uy * len / 2, h = 6;
  for (const [col, lw] of [["rgba(0,0,0,.7)", 4.5], ["#ffffff", 2]]) {
    c.strokeStyle = col; c.lineWidth = lw; c.lineCap = "round"; c.lineJoin = "round";
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
    c.moveTo(x1 - ux * h - uy * h * 0.6, y1 - uy * h + ux * h * 0.6); c.lineTo(x1, y1); c.lineTo(x1 - ux * h + uy * h * 0.6, y1 - uy * h - ux * h * 0.6);
    c.stroke();
  }
}

function cardinal(d) { return ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"][Math.round(d / 45) % 8]; }
const du = d => { const c = cardinal(d); return c === "est" || c === "ouest" ? "de l'" + c : "du " + c; };
const vers = d => { const c = cardinal(d); return c === "est" || c === "ouest" ? "vers l'" + c : "vers le " + c; };
function offset(lat, lon, east, north) { return [lat + north / 111320, lon + east / (111320 * Math.cos(lat * Math.PI / 180))]; }
function cellCenter(i, j) { const m = st.meta; return [m.north - (j + 0.5) / m.ny * (m.north - m.south), m.west + (i + 0.5) / m.nx * (m.east - m.west)]; }
const windFrom = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;

function ellipse(lat, lon, a, b, ang) {
  const pts = [];
  for (let k = 0; k < 40; k++) {
    const t = k / 40 * 2 * Math.PI, x = a * Math.cos(t), y = b * Math.sin(t);
    pts.push(offset(lat, lon, x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)));
  }
  return pts;
}

function drawSpots() {
  if (!spotsLayer) return;
  spotsLayer.clearLayers();
  const X = st.hours.get(st.hour);
  if (!X || !$("showSpots").checked) return;
  const minP = +$("minProb").value / 100;
  const rf = Math.min(1.2, Math.max(0.5, Math.pow(2, map.getZoom() - 10.5)));
  const r = { renderer: spotRenderer };
  // vue d'ensemble : pompes principales seulement (les plus sûres et fortes, une tous les ~5 km), sans zone
  const overview = map.getZoom() < 10.75;
  let list = X.spots.filter(s => s.prob >= minP);
  if (overview) {
    const keep = [], R = 7000 / 150;
    for (const s of list.slice().sort((a, b) => b.prob * Math.max(0.3, b.vz) - a.prob * Math.max(0.3, a.vz))) {
      if (keep.some(k => Math.hypot(k.i - s.i, k.j - s.j) < R)) continue;
      keep.push(s);
    }
    list = keep;
  }
  let shown = 0;
  // les plus sûres dessinées en dernier (au-dessus)
  for (const s of list.sort((a, b) => a.prob - b.prob)) {
    shown++;
    const [lat, lon] = cellCenter(s.i, s.j);
    const col = css(SCALES.climb.col(s.vz));
    const [clat, clon] = offset(lat, lon, s.ex, s.ey);
    const zone = overview ? null : L.polygon(ellipse(clat, clon, s.ea, s.eb, s.eang), { ...r, color: col, weight: 1.6, opacity: 0.95, fillColor: col,
      fillOpacity: 0.10 + 0.30 * s.prob, dashArray: s.prob < 0.5 ? "4 4" : null });
    const [tlat, tlon] = offset(lat, lon, s.tx, s.ty);
    if (Math.hypot(s.tx, s.ty) > 300) spotsLayer.addLayer(L.polyline([[lat, lon], [tlat, tlon]], { ...r, color: "#0b0d0e", weight: 3.5, opacity: 0.7, interactive: false }));
    if (Math.hypot(s.tx, s.ty) > 300) spotsLayer.addLayer(L.polyline([[lat, lon], [tlat, tlon]], { ...r, color: col, weight: 1.6, interactive: false }));
    const dot = L.circleMarker([lat, lon], { ...r, radius: rf * (3 + 1.2 * Math.min(5, Math.max(0, s.vz))), color: "#0b0d0e", weight: 1.3, fillColor: col, fillOpacity: 1 });
    const w = Math.hypot(s.wu, s.wv);
    const tip = `<b>Pompe : Vz +${fr(Math.max(0, s.vz))} m/s</b> <span class="muted">(95 % : ${fr(Math.max(0, s.vzLo))} à ${fr(s.vzHi)})</span>`
      + `<br>fiabilité : <b>${pct(s.prob)}</b> <span class="muted">(${s.nSector > 3 ? `${s.rank >= 0.9 ? "parmi les 10 % les plus sûres" : s.rank >= 0.7 ? "parmi les 30 % les plus sûres" : s.rank >= 0.4 ? "dans la moyenne" : "parmi les moins sûres"} des ${s.nSector} pompes du secteur` : "secteur presque vide"})</span>`
      + `<br>plafond ${km(s.ceil)} m <span class="muted">(${km(s.ceilLo)} à ${km(s.ceilHi)})</span> · ${s.cu ? "cumulus" : "thermique bleu"}`
      + `<br>spirale vers ${s.bank}°${s.bank >= 55 ? " : pompe étroite, serrer" : s.bank <= 35 ? " : pompe large" : ""}`
      + `<br>départ vers ${km(s.elev)} m · vent ${Math.round(w * 3.6)} km/h ${du(windFrom(s.wu, s.wv))}`
      + `<br>zone à 95 % : ${fr(2 * s.ea / 1000)} × ${fr(2 * s.eb / 1000)} km`
      + (s.shared > 0.1 ? `<br>air partagé avec une voisine : ${Math.round(s.shared * 100)} % de son bassin` : "")
      + (s.lid > 0.5 ? `<br><span class="muted">sous le couvercle de l'air de vallée</span>` : "")
      + `<br><span class="muted">cliquer : vue en 3D${s.vz >= 3 ? ", d'où vient son air, effet du vent" : ""}</span>`;
    for (const l of zone ? [zone, dot] : [dot]) {
      l.bindTooltip(tip, { className: "spot", direction: "top", sticky: l === zone });
      l.on("click", e => { L.DomEvent.stopPropagation(e); askPoint(L.latLng(lat, lon), false, s.vz >= 3, true); });
      spotsLayer.addLayer(l);
    }
  }
  $("spotCount").textContent = overview ? `(${shown} principales, ${X.spots.filter(s => s.prob >= minP).length} en zoomant)` : `(${shown} sur ${X.spots.length})`;
}

// ---------------------------------------------------------------- ensemble ECMWF au terrain : dispersion des prévisions
const ISA = { 925: 762, 850: 1457, 700: 3012, 600: 4206, 500: 5574 };
const pIsa = z => 1013.25 * Math.pow(1 - 2.25577e-5 * z, 5.25588);
/** Sommet d'une particule partie du sol (+1,5 K), par la courbe adiabatique sèche, dans le profil d'un membre. */
function ensTop(M, k, z0) {
  const th = (T, p) => (T + 273.15) * Math.pow(1000 / p, 0.2857);
  const thP = th(M.t2[k] + 1.5, pIsa(z0));
  let zPrev = z0, dPrev = thP - th(M.t2[k], pIsa(z0));
  for (const p of [925, 850, 700, 600, 500]) {
    const z = ISA[p], T = M.t[p][k];
    if (z <= z0 + 50 || T == null) continue;
    const d = thP - th(T, p);
    if (d < 0) return zPrev + (z - zPrev) * dPrev / Math.max(1e-6, dPrev - d);
    zPrev = z; dPrev = d;
  }
  return 6000;
}
async function runEnsemble() {
  const f = st.meta.places.find(p => p.name === $("field").value), date = st.date;
  if (!f || !date) return;
  $("ensText").textContent = "Requête à l'ensemble ECMWF…"; $("ensChart").hidden = true;
  let E;
  try { E = await fetchEnsemble(f.lat, f.lon, date); }
  catch (e) { $("ensText").textContent = "Ensemble indisponible pour cette date (il ne couvre que les jours récents et à venir) : " + e.message; return; }
  const q = (a, x) => { const b = a.filter(v => v === v).sort((u, v) => u - v); return b.length ? b[Math.min(b.length - 1, Math.floor(x * b.length))] : NaN; };
  const hours = [], z0 = E.elev;
  E.time.forEach((t, k) => {
    const h = +t.slice(11, 13);
    if (h < 8 || h > 20) return;
    const tops = [], bases = [], capes = [], clouds = [], winds = [];
    for (const M of E.members) {
      if (M.t2[k] == null) continue;
      const sunny = (M.sw[k] || 0) > 60, top = sunny ? ensTop(M, k, z0) : z0, base = z0 + 125 * (M.t2[k] - M.td2[k]);
      tops.push(top); if (base < top) bases.push(base);
      capes.push(M.cape[k] || 0); clouds.push(M.cloud[k] || 0); if (M.w700[k] != null) winds.push(M.w700[k]);
    }
    hours.push({ h, n: tops.length, lo: q(tops, 0.1), med: q(tops, 0.5), hi: q(tops, 0.9), cu: bases.length, base: q(bases, 0.5),
      pc: capes.filter(c => c > 500).length / Math.max(1, capes.length), cloud: q(clouds, 0.5), wLo: q(winds, 0.1), wHi: q(winds, 0.9) });
  });
  const H = hours.find(x => x.h === Math.min(20, Math.max(8, st.hour))) || hours[0];
  if (!H) { $("ensText").textContent = "Pas de données d'ensemble pour cette journée."; return; }
  const spread = H.hi - H.lo, agree = spread < 600 ? "bon" : spread < 1200 ? "moyen" : "faible";
  $("ensText").innerHTML = `<b>Ensemble ECMWF, ${f.name.replace(/ \(.*\)/, "")} à ${H.h} h</b> (${H.n} prévisions, maille de 25 km : un ordre de grandeur de l'incertitude, pas le plafond local) : `
    + `sommet des thermiques ${km(H.med)} m (10–90 % : ${km(H.lo)} à ${km(H.hi)} m), accord <b>${agree}</b> ; `
    + `cumulus pour ${H.cu} prévisions sur ${H.n}${H.cu ? `, base médiane ${km(H.base)} m` : ""} ; vent vers 3 000 m ${Math.round(H.wLo)} à ${Math.round(H.wHi)} km/h`
    + (H.pc > 0.2 ? ` ; <span style="color:#fbbf24">${Math.round(H.pc * 100)} % des prévisions donnent de l'instabilité (CAPE > 500 J/kg)</span>` : "") + ".";
  const c = $("ensChart"), g = c.getContext("2d"), W = c.width, Hc = c.height, cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  c.hidden = false; g.clearRect(0, 0, W, Hc);
  const L0 = 58, R0 = 12, T0 = 28, B0 = 44, zmin = Math.floor(z0 / 500) * 500, zmax = Math.max(zmin + 1500, Math.ceil((Math.max(...hours.map(x => x.hi)) + 300) / 500) * 500);
  const X = h => L0 + (h - 8) / 12 * (W - L0 - R0), Y = z => Hc - B0 - (z - zmin) / (zmax - zmin) * (Hc - T0 - B0);
  g.font = "14px system-ui, sans-serif"; g.strokeStyle = col("--line"); g.fillStyle = col("--muted"); g.lineWidth = 1; g.textAlign = "right";
  for (let z = zmin; z <= zmax; z += 500) { g.beginPath(); g.moveTo(L0, Y(z)); g.lineTo(W - R0, Y(z)); g.stroke(); g.fillText(km(z), L0 - 6, Y(z) + 5); }
  g.textAlign = "center"; for (let h = 8; h <= 20; h += 2) g.fillText(h + " h", X(h), Hc - B0 + 18);
  g.fillStyle = "rgba(249,115,22,.28)"; g.beginPath();
  hours.forEach((x, k) => (k ? g.lineTo(X(x.h), Y(x.hi)) : g.moveTo(X(x.h), Y(x.hi))));
  hours.slice().reverse().forEach(x => g.lineTo(X(x.h), Y(x.lo))); g.closePath(); g.fill();
  g.strokeStyle = "#f97316"; g.lineWidth = 3; g.beginPath(); hours.forEach((x, k) => (k ? g.lineTo(X(x.h), Y(x.med)) : g.moveTo(X(x.h), Y(x.med)))); g.stroke();
  g.strokeStyle = "#60a5fa"; g.lineWidth = 2; g.setLineDash([6, 5]); g.beginPath();
  let started = false; for (const x of hours) { if (x.cu < x.n / 3) { started = false; continue; } started ? g.lineTo(X(x.h), Y(x.base)) : g.moveTo(X(x.h), Y(x.base)); started = true; }
  g.stroke(); g.setLineDash([]);
  for (const x of hours) {
    g.fillStyle = "rgba(200,200,200,.5)"; g.fillRect(X(x.h) - 6, Hc - B0 + 24, 12, -0.1 * x.cloud);
    if (x.pc > 0.2) { g.fillStyle = "#ef4444"; g.globalAlpha = Math.min(1, x.pc + 0.3); g.beginPath(); g.moveTo(X(x.h) - 6, T0 - 4); g.lineTo(X(x.h) + 6, T0 - 4); g.lineTo(X(x.h), T0 + 6); g.fill(); g.globalAlpha = 1; }
  }
  g.textAlign = "left"; g.fillStyle = col("--ink2"); g.font = "13px system-ui, sans-serif";
  g.fillText("sommet des thermiques : médiane et 10–90 % · tirets : base des cumulus · gris : nébulosité · ▼ instabilité", 6, 16);
}

// ---------------------------------------------------------------- balises de vent en temps réel (OpenWindMap / Pioupiou)
async function refreshLive() {
  if (!liveLayer) return;
  if (!$("showLive").checked) { liveLayer.clearLayers(); st.live = null; return; }
  try {
    const r = await fetch("https://api.pioupiou.fr/v1/live-with-meta/all");
    const j = await r.json(), m = st.meta;
    st.live = (j.data || []).filter(s => s.location && s.measurements && s.measurements.wind_speed_avg != null
      && s.location.latitude > m.south && s.location.latitude < m.north && s.location.longitude > m.west && s.location.longitude < m.east
      && Date.now() - Date.parse(s.measurements.date) < 3 * 3600e3)
      .map(s => ({ name: s.meta.name, lat: s.location.latitude, lon: s.location.longitude, from: s.measurements.wind_heading,
        avg: s.measurements.wind_speed_avg, min: s.measurements.wind_speed_min, max: s.measurements.wind_speed_max, age: (Date.now() - Date.parse(s.measurements.date)) / 60e3 }));
    drawLive();
  } catch (e) { setStatus("Balises en direct indisponibles : " + e.message, true); }
}
/** Vent prévu près du relief (brises + vent) au point le plus proche, à l'heure affichée : [u, v] m/s, ou null. */
function surfAt(lat, lon) {
  const b = st.surf, m = st.meta;
  if (!b) return null;
  const i = (lon - m.west) / (m.east - m.west) * m.nx, j = (m.north - lat) / (m.north - m.south) * m.ny;
  let best = null, bd = 1e9;
  for (let k = 0; k < b.length; k += 4) { const d = (b[k] - i) ** 2 + (b[k + 1] - j) ** 2; if (d < bd) { bd = d; best = k; } }
  return best == null || bd > 64 ? null : [b[best + 2], b[best + 3]];
}
function drawLive() {
  liveLayer.clearLayers();
  if (!st.live || !$("showLive").checked) return;
  const today = st.date === isoDate(new Date());
  for (const s of st.live) {
    const col = s.avg < 10 ? "#a7f3d0" : s.avg < 20 ? "#fde047" : s.avg < 30 ? "#fb923c" : "#ef4444", len = 22;
    const svg = `<svg width="${len + 10}" height="${len + 10}" viewBox="${-(len + 10) / 2} ${-(len + 10) / 2} ${len + 10} ${len + 10}" style="transform:rotate(${s.from + 180}deg)">`
      + `<circle r="4" fill="${col}" stroke="#0b0d0e" stroke-width="1.5"/>`
      + `<path d="M0 0 V${-len / 2} M-4 ${-len / 2 + 6} L0 ${-len / 2} L4 ${-len / 2 + 6}" stroke="#0b0d0e" stroke-width="4" fill="none" stroke-linecap="round"/>`
      + `<path d="M0 0 V${-len / 2} M-4 ${-len / 2 + 6} L0 ${-len / 2} L4 ${-len / 2 + 6}" stroke="${col}" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
    const f = today ? surfAt(s.lat, s.lon) : null;
    const pred = f ? `<br>prévu près du relief à ${st.hour} h : ${Math.round(Math.hypot(...f) * 3.6)} km/h ${Math.hypot(...f) > 0.5 ? du(windFrom(...f)) : ""}` : "";
    liveLayer.addLayer(L.marker([s.lat, s.lon], { keyboard: false, icon: L.divIcon({ className: "wind", html: svg, iconSize: [len + 10, len + 10], iconAnchor: [(len + 10) / 2, (len + 10) / 2] }) })
      .bindTooltip(`<b>${s.name}</b> · il y a ${Math.round(s.age)} min<br>vent ${Math.round(s.avg)} km/h ${du(s.from)} (${Math.round(s.min)} à ${Math.round(s.max)})${pred}<br><span class="muted">© OpenWindMap</span>`, { className: "spot", direction: "top" }));
  }
}
/** Balises à moins de 12 km d'un point : texte court pour l'alimentation d'une pompe. */
function liveNear(lat, lon) {
  if (!st.live) return "";
  const near = st.live.map(s => ({ s, d: Math.hypot((s.lat - lat) * 111.3, (s.lon - lon) * 111.3 * Math.cos(lat * Math.PI / 180)) })).filter(x => x.d < 12).sort((a, b) => a.d - b.d).slice(0, 3);
  return near.length ? `<br>Balises proches maintenant : ` + near.map(({ s, d }) => `${s.name} (${fr(d, 0)} km) ${Math.round(s.avg)} km/h ${du(s.from)}`).join(" · ") + "." : "";
}

// ---------------------------------------------------------------- mes vols : traces IGC comparées à la prévision
async function loadFlights(files) {
  st.flights = st.flights || [];
  for (const f of files) {
    try {
      const F = parseIGC(await f.text()), th = findThermals(F);
      st.flights.push({ name: f.name.replace(/\.igc$/i, ""), F, th });
    } catch (e) { setStatus(`${f.name} : ${e.message}`, true); }
  }
  drawFlightList();
  if (st.flights.length) selectFlight(st.flights[st.flights.length - 1]);
}
function drawFlightList() {
  const box = $("flightList"); box.innerHTML = "";
  $("flightClear").hidden = !(st.flights && st.flights.length);
  for (const fl of st.flights || []) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = `${fl.F.date.split("-").reverse().join("/")} · ${fl.th.length} spirales`;
    b.title = fl.name; b.classList.toggle("on", fl === st.flight);
    b.addEventListener("click", () => selectFlight(fl));
    box.appendChild(b);
  }
}
function selectFlight(fl) {
  st.flight = fl; drawFlightList();
  flightLayer.clearLayers();
  const pts = fl.F.fixes.filter((_, k) => k % 3 === 0).map(f => [f.lat, f.lon]);
  flightLayer.addLayer(L.polyline(pts, { color: "#0b0d0e", weight: 4, opacity: 0.6, interactive: false }));
  flightLayer.addLayer(L.polyline(pts, { color: "#ffffff", weight: 1.8, opacity: 0.9, interactive: false }));
  map.fitBounds(L.latLngBounds(pts).pad(0.1));
  const first = fl.th.find(T => T.gain >= 200) || fl.th[0];
  if (first) { st.hour = Math.min(H1, Math.max(H0, Math.round(first.h))); $("hour").value = st.hour; }
  if (st.date === fl.F.date && st.done) showFlight();
  else { $("flightText").textContent = `Calcul de la prévision du ${labelDate(fl.F.date)}…`; selectDate(fl.F.date, !(st.week && st.week.includes(fl.F.date))); }
}
function spotsAt(h) {
  const X = st.hours.get(h);
  if (!X) return null;
  return X.ll || (X.ll = X.spots.map(s => { const [lat, lon] = cellCenter(s.i, s.j); return { ...s, lat, lon }; }));
}
const hm = h => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
function showFlight() {
  const fl = st.flight;
  const cmp = compareFlight(fl.F, fl.th, spotsAt), S = flightStats(cmp);
  fl.cmp = cmp; fl.stats = S;
  // spirales et pompes survolées sur la carte
  for (const l of flightLayer.getLayers().slice(2)) flightLayer.removeLayer(l);
  for (const r of cmp.rows) {
    const T = r.T, col = T.gain < 100 ? "#94a3b8" : css(SCALES.climb.col(Math.max(0.2, T.climb)));
    const pred = r.s ? `<br>prévu (${Math.round(r.d)} m, ${r.inside ? "dans" : "hors de"} la zone) : +${fr(Math.max(0, r.s.vz))} m/s, plafond ${km(r.s.ceil)} m, fiabilité ${pct(r.s.prob)}, ${r.s.bank}°` : "<br>pas de prévision à cette heure";
    flightLayer.addLayer(L.circleMarker([T.lat, T.lon], { radius: 4 + 2 * Math.min(4, Math.max(0, T.climb)), color: "#0b0d0e", weight: 1.5, fillColor: col, fillOpacity: 1 })
      .bindTooltip(`<b>${hm(T.h)} · ${T.gain < 100 ? "spirale sans gain" : `+${fr(T.climb)} m/s`}</b> (meilleures 30 s : +${fr(Math.max(0, T.best))})<br>${km(T.base)} → ${km(T.top)} m · ${Math.round(T.circles)} tours · ${Math.round(T.bank)}°, rayon ${Math.round(T.radius)} m${pred}`, { className: "spot", direction: "top" }));
  }
  for (const p of cmp.passed) if (!p.used) {
    flightLayer.addLayer(L.circleMarker([p.s.lat, p.s.lon], { radius: 5, color: "#fbbf24", weight: 2, fill: false })
      .bindTooltip(`<span class="pass"><b>Passée sans spiraler</b></span> à ${hm(localHour(fl.F.date, p.t))}, à ${km(p.alt)} m<br>prévu : +${fr(Math.max(0, p.s.vz))} m/s, plafond ${km(p.s.ceil)} m, fiabilité ${pct(p.s.prob)}<br><span class="muted">à confirmer : manquée, cherchée ailleurs, ou inutile ?</span>`, { className: "spot", direction: "top" }));
  }
  // bilan
  const out = [`<b>${labelDate(fl.F.date)}</b> : ${fl.th.length} spirales, dont ${fl.th.filter(T => T.gain >= 200).length} avec plus de 200 m de gain.`];
  if (S.n) {
    out.push(`Vz prévue − Vz moyenne relevée : <b>${S.bias >= 0 ? "+" : "−"}${fr(Math.abs(S.bias))} m/s</b>, erreur type ${fr(S.rms)} m/s (une valeur constante ferait ${fr(S.rmsConst)}), corrélation ${fr(S.corr, 2)}.`);
    out.push(`Plafond prévu − sommet atteint : ${S.ceilBias >= 0 ? "+" : "−"}${km(Math.abs(S.ceilBias))} m. Pompe prévue à moins de 1 km : ${pct(S.within1)} des spirales ; dans la zone à 95 % : ${pct(S.inside)}.`);
  }
  const bl = S.bins.filter(b => b.n);
  if (bl.length) out.push(`Pompes prévues survolées sous leur plafond, et prises : ` + bl.map(b => `fiabilité ${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))} % : ${b.used}/${b.n}`).join(" · ") + ".");
  const all = (st.flights || []).filter(f => f.stats && f.stats.n);
  if (all.length > 1) {
    const n = all.reduce((s, f) => s + f.stats.n, 0), w = k => all.reduce((s, f) => s + f.stats[k] * f.stats.n, 0) / n;
    out.push(`<b>Bilan de ${all.length} vols</b> (${n} spirales) : biais ${fr(w("bias"))} m/s, erreur type ${fr(Math.sqrt(all.reduce((s, f) => s + f.stats.rms ** 2 * f.stats.n, 0) / n))} m/s.`);
  }
  $("flightText").innerHTML = out.join("<br>");
  const rows = cmp.rows.filter(r => r.T.gain >= 100);
  $("flightTable").innerHTML = rows.length ? `<table><thead><tr><th>Heure</th><th>Vz relevée</th><th>Vz prévue</th><th>Sommet</th><th>Plafond prévu</th><th>Incl.</th><th>Écart</th></tr></thead><tbody>`
    + rows.map((r, k) => `<tr data-k="${k}"><td>${hm(r.T.h)}</td><td>+${fr(r.T.climb)}</td><td>${r.s ? "+" + fr(Math.max(0, r.s.vz)) : "–"}</td><td>${km(r.T.top)}</td><td>${r.s ? km(r.s.ceil) : "–"}</td><td>${Math.round(r.T.bank)}° / ${r.s ? r.s.bank + "°" : "–"}</td><td>${r.s ? fr(r.d / 1000) + " km" : "–"}</td></tr>`).join("") + "</tbody></table>" : "";
  for (const tr of $("flightTable").querySelectorAll("tr[data-k]")) tr.addEventListener("click", () => {
    const T = rows[+tr.dataset.k].T;
    st.hour = Math.min(H1, Math.max(H0, Math.round(T.h))); $("hour").value = st.hour; stopPlay(); render();
    map.setView([T.lat, T.lon], Math.max(map.getZoom(), 12));
  });
}

// ---------------------------------------------------------------- export des pompes du jour (.cup : SeeYou, XCSoar)
function exportCup() {
  if (!st.date || !st.hours.size) return;
  const minP = +$("minProb").value / 100, R = 800 / 150, C = [];
  for (let h = 10; h <= 18; h++) {
    const X = st.hours.get(h); if (!X) continue;
    for (const s of X.spots) {
      if (s.prob < minP || s.vz < 0.8) continue;
      let c = C.find(c => Math.hypot(c.i - s.i, c.j - s.j) <= R);
      if (!c) { c = { i: s.i, j: s.j, elev: s.elev, hours: [], vz: 0, ceil: 0, p: 0, bank: s.bank, score: 0 }; C.push(c); }
      if (c.hours.includes(h)) continue;
      c.hours.push(h); c.p += s.prob; c.score += s.prob * s.vz;
      if (s.vz > c.vz) { c.vz = s.vz; c.bank = s.bank; }
      c.ceil = Math.max(c.ceil, s.ceil);
    }
  }
  const keep = C.filter(c => c.hours.length >= 2).sort((a, b) => b.score - a.score).slice(0, 400);
  const dm = (x, w) => { const a = Math.abs(x), d = Math.floor(a), m = (a - d) * 60; return String(d).padStart(w, "0") + m.toFixed(3).padStart(6, "0"); };
  const lines = ["name,code,country,lat,lon,elev,style,rwdir,rwlen,freq,desc"];
  keep.forEach((c, k) => {
    const [lat, lon] = cellCenter(c.i, c.j), h0 = Math.min(...c.hours), h1 = Math.max(...c.hours) + 1;
    const name = `P${fr(c.vz).replace(",", ".")} ${h0}-${h1}h`;
    const desc = `Vz ${fr(c.vz)} m/s, plafond ${km(c.ceil)} m, fiabilite ${Math.round(100 * c.p / c.hours.length)} %, ${h0}-${h1} h, spirale ${c.bank} deg (prevision du ${st.date})`;
    lines.push(`"${name}","P${String(k + 1).padStart(3, "0")}",FR,${dm(lat, 2)}${lat >= 0 ? "N" : "S"},${dm(lon, 3)}${lon >= 0 ? "E" : "W"},${Math.round(c.elev)}m,1,,,,"${desc}"`);
  });
  const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/plain" }), a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `pompes-${st.date}.cup`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus(`${keep.length} pompes exportées (fiabilité ≥ ${$("minProb").value} %, présentes au moins 2 h entre 10 h et 19 h).`);
}

// ---------------------------------------------------------------- terrain choisi : pompes proches heure par heure
const dirFrom = (u, v) => (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
function drawField() {
  const name = $("field").value;
  const get = h => { const X = st.hours.get(h); return X && X.stats.fields ? X.stats.fields.find(f => f.name === name) : null; };
  const F = get(st.hour), short = name.replace(/ \(.*\)/, "");
  const side = d => { const c = cardinal((d + 360) % 360); return c === "est" || c === "ouest" ? "à l'" + c : "au " + c; };
  const where = (x, what) => `${what} à ${fr(x.d / 1000)} km${x.d < 400 ? "" : " " + side(x.az)}`;
  if (!F) { $("fieldText").textContent = st.hours.size ? "" : "Calcul en cours…"; }
  else {
    const w10 = Math.hypot(...F.w10), w15 = Math.hypot(...F.w15), out = [];
    out.push(`<b>${short} à ${st.hour} h</b>`);
    if (F.best) out.push(`${where(F.best, "Meilleure pompe")} : <b>+${fr(Math.max(0, F.best.vz))} m/s</b>, plafond ${km(F.best.ceil)} m, fiabilité ${pct(F.best.prob)}.`);
    else out.push("Pas de pompe sûre à moins de 10 km.");
    if (F.low) out.push(`${where(F.low, "Première pompe basse")} : +${fr(Math.max(0, F.low.vz))} m/s, départ vers ${km(F.low.elev)} m, ${F.low.bank}°.`);
    out.push(`Vent au sol ${Math.round(w10 * 3.6)} km/h ${w10 > 0.5 ? du(dirFrom(...F.w10)) : ""} ; vers 1 500 m ${Math.round(w15 * 3.6)} km/h ${w15 > 0.5 ? du(dirFrom(...F.w15)) : ""}.`);
    const ok = [];
    for (let h = H0; h <= H1; h++) { const G = get(h); if (G && G.best && G.best.vz >= 1.5) ok.push(h); }
    if (ok.length) out.push(`Thermiques exploitables près du terrain de <b>${ok[0]} h à ${ok[ok.length - 1] + 1} h</b> (pompe ≥ 1,5 m/s, fiabilité ≥ 40 %, à moins de 10 km).`);
    $("fieldText").innerHTML = out.join(" ");
  }
  const c = $("fieldChart"), g = c.getContext("2d"), Wc = c.width, Hc = c.height, cs = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, Wc, Hc);
  const n = H1 - H0 + 1, bw = Wc / n, base = Hc - 26, vmax = 5;
  g.font = "600 15px system-ui, sans-serif"; g.textAlign = "center";
  for (let h = H0; h <= H1; h++) {
    const x = (h - H0) * bw, G = get(h);
    if (h === st.hour) { g.fillStyle = "rgba(249,115,22,.16)"; g.fillRect(x, 0, bw, Hc); }
    if (G && G.best) {
      const v = Math.max(0, G.best.vz), hh = Math.min(1, v / vmax) * (base - 30);
      g.fillStyle = css(SCALES.climb.col(v)); g.globalAlpha = 0.35 + 0.65 * G.best.prob;
      g.beginPath(); g.roundRect(x + 6, base - Math.max(2, hh), bw - 12, Math.max(2, hh), [4, 4, 0, 0]); g.fill(); g.globalAlpha = 1;
    }
    if (G && G.low) {
      const v = Math.max(0, G.low.vz), y = base - Math.min(1, v / vmax) * (base - 30);
      g.fillStyle = "#fff"; g.strokeStyle = "#0b0d0e"; g.lineWidth = 2; g.beginPath(); g.arc(x + bw / 2, y, 5, 0, 2 * Math.PI); g.fill(); g.stroke();
    }
    g.fillStyle = h === st.hour ? cs.getPropertyValue("--fg") : cs.getPropertyValue("--muted");
    g.fillText(h % 2 ? String(h) : "", x + bw / 2, Hc - 6);
  }
  g.fillStyle = cs.getPropertyValue("--muted"); g.textAlign = "left"; g.font = "14px system-ui, sans-serif";
  g.fillText("barres : meilleure pompe à moins de 10 km (Vz, pâle si peu sûre) · points : première pompe basse", 8, 16);
}

function drawLegend() {
  const sc = SCALES[st.layer], t = sc.ticks;
  const stops = [];
  for (let k = 0; k <= 20; k++) { const v = t[0] + (t[t.length - 1] - t[0]) * k / 20; stops.push(`${css(sc.col(v))} ${k * 5}%`); }
  const fmt = v => st.layer === "climb" || st.layer === "conv" || st.layer === "wave" ?fr(v, v % 1 ? (v * 4 % 1 ? 2 : 1) : 0) : String(v);
  $("legend").innerHTML = `<div class="cap">${sc.cap}</div><div class="bar" style="background:linear-gradient(90deg,${stops.join(",")})"></div>
    <div class="ticks">${t.map(v => `<span>${fmt(v)}</span>`).join("")}</div>
    <div class="spots"><span class="ell"></span> pompe : zone où la trouver à 95 % (pleine si fiabilité ≥ 50 %, tiretée sinon ; affichée au zoom)
    · point : départ au sol · trait : dérive jusqu'au plafond · flèches blanches : vent dans la couche convective ; au zoom, flèches vertes : air près du relief (brises + vent)</div>`;
}

function drawDayChart() {
  const c = $("daychart"), g = c.getContext("2d"), Wc = c.width, Hc = c.height;
  const cs = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, Wc, Hc);
  const n = H1 - H0 + 1, bw = Wc / n, base = Hc - 26, vmax = 5;
  g.font = "600 17px system-ui, sans-serif"; g.textAlign = "center";
  for (let h = H0; h <= H1; h++) {
    const x = (h - H0) * bw, X = st.hours.get(h);
    if (h === st.hour) { g.fillStyle = "rgba(249,115,22,.16)"; g.fillRect(x, 0, bw, Hc); }
    if (X) {
      const v = X.stats.spotClimb, hh = Math.min(1, Math.max(0, v) / vmax) * (base - 30);
      g.fillStyle = v < 0.3 ? cs.getPropertyValue("--line") : css(SCALES.climb.col(v));
      g.beginPath(); g.roundRect(x + 5, base - Math.max(2, hh), bw - 10, Math.max(2, hh), [4, 4, 0, 0]); g.fill();
      if (v >= 0.3) { g.fillStyle = cs.getPropertyValue("--fg"); g.fillText(fr(v), x + bw / 2, base - hh - 7); }
      // repères : surdéveloppement (triangle orange/rouge en haut), onde (trait bleu en bas)
      const o = X.stats.over, w = X.stats.wave;
      if (o && o.level) { g.fillStyle = o.level === 2 ? "#ef4444" : "#fbbf24"; g.beginPath(); g.moveTo(x + bw / 2 - 7, 30); g.lineTo(x + bw / 2 + 7, 30); g.lineTo(x + bw / 2, 22); g.fill(); }
      if (w && w.idx > 0.25) { g.fillStyle = "#60a5fa"; g.globalAlpha = Math.min(1, 0.4 + w.idx); g.fillRect(x + 4, base + 2, bw - 8, 4); g.globalAlpha = 1; }
    }
    g.fillStyle = h === st.hour ? cs.getPropertyValue("--fg") : cs.getPropertyValue("--muted");
    g.fillText(h % 2 ? String(h) : "", x + bw / 2, Hc - 6);
  }
  g.fillStyle = cs.getPropertyValue("--muted"); g.textAlign = "left"; g.font = "14px system-ui, sans-serif";
  g.fillText("Vz moyenne des 12 meilleures pompes (m/s), heure locale · ▲ surdéveloppement · ▬ onde", 8, 16);
}

function writeSummary(s) {
  if (s.sunEl <= 1) { $("summary").innerHTML = "Soleil couché : pas de convection."; $("flags").textContent = ""; return; }
  if (s.nAll === 0 || s.spotClimb < 0.3) {
    $("summary").innerHTML = "<b>Pas d'ascendance thermique exploitable</b> à cette heure" + (s.cloud > 70 ? " (ciel couvert)." : s.hMean < 40 ? " (le sol chauffe trop peu)." : " (air stable).");
  } else {
    const rng = s.ceilHi - s.ceilLo >= 200 ? `<b>${km(s.ceilLo)} m</b> sur les premiers reliefs à <b>${km(s.ceilHi)} m</b> sur les plus hauts` : `vers <b>${km(s.ceilHi)} m</b>`;
    const sky = s.cuFrac > 0.6 ? `cumulus, base de ${rng}` : s.cuFrac > 0.2 ? `quelques cumulus, plafond de ${rng}` : `thermiques bleus, plafond de ${rng}`;
    $("summary").innerHTML = `<b>${s.nSpots} pompes</b> fiables à plus de 50 % · Vz typique <b>+${fr(s.spotClimb)} m/s</b> au vario dans les meilleures · ${sky}`;
  }
  const fl = [];
  if (s.rain > 0.3) fl.push("averses prévues");
  if (s.cape > 800) fl.push(`risque de surdéveloppement ou d'orage (CAPE ${Math.round(s.cape)} J/kg)`);
  if (s.wind10 > 7) fl.push(`vent soutenu au sol (${Math.round(s.wind10 * 3.6)} km/h)`);
  if (s.cloud > 75 && s.spotClimb >= 0.3) fl.push("ciel très nuageux : pompes irrégulières");
  if (s.snowLine < 2600) fl.push(`neige au-dessus de ${km(s.snowLine)} m environ`);
  if (s.over && s.over.level === 2) fl.push(`cumulus très épais (${km(s.over.depth)} m) : congestus, averses ou orages probables`);
  else if (s.over && s.over.level === 1) fl.push(`cumulus épais (${km(s.over.depth)} m) : étalements ou surdéveloppements possibles`);
  if (s.wave && s.wave.idx > 0.25) fl.push(`onde ${s.wave.idx > 0.6 ? "probable" : "possible"} : vent ${Math.round(s.wave.u * 3.6)} km/h ${du(s.wave.dir)} vers 3 000 m, air stable, longueur d'onde ~${fr(s.wave.lambda / 1000)} km${s.wave.trapped ? ", ondes en série" : ""} (calque Onde)`);
  if (s.wave && s.wave.foehn) fl.push("foehn du sud probable : rafales et rotors dans les vallées");
  if (s.challes) {
    const [u, v] = s.challes, sp = Math.hypot(u, v), d = windFrom(u, v);
    if (sp >= 3 && d >= 135 && d <= 225 && st.hour <= 16)
      fl.push(`sud annoncé vers 1 500 m (${Math.round(sp * 3.6)} km/h) : souvent de l'est sur la piste de Challes, premières pompes au treuil déstructurées`);
  }
  $("flags").textContent = fl.length ? "⚠ " + fl.join(" · ") : "";
}

// ---------------------------------------------------------------- diagnostic en un point
function askPoint(latlng, keep = false, feed = false, pump = false) {
  const m = st.meta;
  const i = Math.floor((latlng.lng - m.west) / (m.east - m.west) * m.nx), j = Math.floor((m.north - latlng.lat) / (m.north - m.south) * m.ny);
  if (i < 0 || j < 0 || i >= m.nx || j >= m.ny || !st.hours.has(st.hour)) return;
  st.point = latlng; st.keep = keep; st.feed = feed; st.pump = pump;
  if (!feed) clearFeed();
  if (!pump) { st.pumpData = null; $("open3d").hidden = true; }
  $("pointBox").hidden = false;
  if (!keep) $("pointText").textContent = feed ? "Calcul de l'alimentation de la pompe…" : "Calcul…";
  worker.postMessage({ type: "point", token: st.token, h: st.hour, i, j, feed, pump });
}

function showPoint(D) {
  const w = Math.hypot(D.wu, D.wv), u = D.u, s = Math.hypot(D.su, D.sv);
  $("pointTitle").textContent = D.pump ? `Pompe à ${km(D.z0)} m` : `Point à ${km(D.z0)} m`;
  if (D.pump) {
    st.pumpData = { P: D.pump, feed: D.feed || null, hour: st.hour };
    $("open3d").hidden = false;
    if (!$("pumpWin").hidden) open3D();
  }
  $("pointText").innerHTML = u && D.climb > 0.1
    ? `Vz au vario <b>+${fr(Math.max(0, u.vz))} m/s</b> (95 % : ${fr(Math.max(0, u.vzLo))} à ${fr(u.vzHi)}) · au cœur ${fr(u.core)} m/s<br>`
      + `${D.cu ? "base des cumulus" : "thermique bleu, plafond utilisable"} <b>${km(u.ceil)} m</b> (${km(u.ceilLo)} à ${km(u.ceilHi)}) · sommet des thermiques ${km(D.top)} m<br>`
      + `chances d'un thermique exploitable ici : ${pct(u.pdev)} · sol ${Math.round(D.H)} W/m² · alimentation ${fr(D.conv, 2)}`
      + ` · air près du sol ${Math.round(s * 3.6)} km/h ${vers((Math.atan2(D.su, D.sv) * 180 / Math.PI + 360) % 360)} · vent en altitude ${Math.round(w * 3.6)} km/h ${du(windFrom(D.wu, D.wv))}`
    : `Pas d'ascendance exploitable ici à ${st.hour} h (sol : ${Math.round(D.H)} W/m²).`;
  if (D.feed) drawFeed(D.feed); else $("feedBox").hidden = true;
  drawEmagram(D);
  if (!st.keep) $("pointBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------------------------------------------------------- pompe en 3D
function open3D() {
  const X = st.pumpData;
  if (!X) return;
  const P = X.P;
  $("pumpWin").hidden = false;
  $("pumpTitle").textContent = `Pompe à ${km(P.z0)} m · ${labelDate(st.date)} · ${X.hour} h`;
  $("pumpText").innerHTML = pumpText(P);
  drawProfile($("pumpProfile"), P);
  drawBank($("pumpBank"), P);
  showPump3D($("pump3d"), P, X.feed).catch(e => { $("pump3d").innerHTML = `<p class="hint" style="padding:12px">Vue 3D indisponible : ${e.message}</p>`; });
}
function close3D() { $("pumpWin").hidden = true; pause3D(); }

// ---------------------------------------------------------------- alimentation d'une pompe
function clearFeed() { if (feedLayer) feedLayer.clearLayers(); $("feedBox").hidden = true; }

function drawFeed(f) {
  feedLayer.clearLayers();
  const m = st.meta;
  const c = document.createElement("canvas"); c.width = f.w; c.height = f.h;
  const g = c.getContext("2d"), img = g.createImageData(f.w, f.h);
  for (let q = 0; q < f.w * f.h; q++) {
    const v = f.raster[q]; if (!v) continue;
    img.data[q * 4] = 120 + v / 2; img.data[q * 4 + 1] = 230; img.data[q * 4 + 2] = 255; img.data[q * 4 + 3] = 40 + v * 0.75;
  }
  g.putImageData(img, 0, 0);
  const north = m.north - f.j0 / m.ny * (m.north - m.south), south = m.north - (f.j0 + f.h) / m.ny * (m.north - m.south);
  const west = m.west + f.i0 / m.nx * (m.east - m.west), east = m.west + (f.i0 + f.w) / m.nx * (m.east - m.west);
  feedLayer.addLayer(new CanvasOverlay(c, [[south, west], [north, east]], { opacity: 0.85, className: "feedimg", interactive: false }));
  for (const p of f.paths) {
    const pts = [];
    for (let k = 0; k < p.length; k += 2) pts.push(cellCenter(p[k], p[k + 1]));
    if (pts.length < 2) continue;
    feedLayer.addLayer(L.polyline(pts, { color: "#0b0d0e", weight: 4, opacity: 0.6, interactive: false }));
    feedLayer.addLayer(L.polyline(pts, { color: "#a5f3fc", weight: 2, opacity: 0.95, interactive: false }));
    feedLayer.addLayer(L.circleMarker(pts[0], { radius: 3, color: "#0b0d0e", weight: 1, fillColor: "#a5f3fc", fillOpacity: 1, interactive: false }));
  }
  // lecture de la rose : où la pompe tient, où elle disparaît
  const speeds = f.speeds, ok = [], weak = [];
  const dirs = [...Array(f.dirs).keys()].map(d => d * 360 / f.dirs);
  const i20 = speeds.indexOf(20);
  f.rose.forEach((row, d) => { if (row[i20] >= Math.max(1.5, 0.7 * f.rose[d][0])) ok.push(dirs[d]); else if (row[i20] < 1) weak.push(dirs[d]); });
  const names = list => { const seen = new Set(); return list.filter(d => { const c = cardinal(d); if (seen.has(c)) return false; seen.add(c); return true; }).map(du).join(", "); };
  const amb = Math.hypot(...f.ambient), ad = windFrom(...f.ambient);
  const nw = new Set(weak.map(cardinal)).size;
  $("feedText").innerHTML = `Chaleur collectée : environ ${fr(f.total / 1e9, 1)} GW, apportée par ${f.paths.length} trajets principaux.`
    + ` Vent prévu près du relief : <b>${Math.round(amb * 3.6)} km/h ${du(ad)}</b> → Vz +${fr(Math.max(0, f.vzNow))} m/s.`
    + (ok.length ? `<br>Par 20 km/h, la pompe tient avec un vent <b>${names(ok)}</b>.` : "")
    + (nw >= 6 && !ok.length ? `<br>Par 20 km/h, elle faiblit beaucoup quelle que soit la direction : pompe fragile, à prendre par vent faible.`
      : weak.length ? `<br>Elle faiblit beaucoup ou se déplace par vent <b>${names(weak)}</b> (20 km/h).` : "")
    + (st.point && st.date === isoDate(new Date()) ? liveNear(st.point.lat, st.point.lng) : "");
  $("feedBox").hidden = false;
  drawRose(f);
}

function drawRose(f) {
  const c = $("rose"), g = c.getContext("2d"), W = c.width, cx = W / 2, cy = W / 2, R = W / 2 - 46;
  const cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  g.clearRect(0, 0, W, W);
  const ns = f.speeds.length, rad = k => R * (k + 0.5) / (ns - 0.5) * (k === 0 ? 0.6 : 1);
  const step = 2 * Math.PI / f.dirs;
  for (let d = 0; d < f.dirs; d++) {
    const a0 = -Math.PI / 2 + d * step - step / 2, a1 = a0 + step;
    for (let k = ns - 1; k >= 0; k--) {
      const r1 = k === ns - 1 ? R : (rad(k) + rad(k + 1)) / 2, r0 = k === 0 ? 0 : (rad(k - 1) + rad(k)) / 2;
      const v = f.rose[d][k];
      g.fillStyle = v < 0.3 ? col("--line") : css(SCALES.climb.col(v));
      g.beginPath(); g.arc(cx, cy, r1, a0, a1); g.arc(cx, cy, r0, a1, a0, true); g.closePath(); g.fill();
    }
  }
  g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 1;
  for (let k = 1; k < ns; k++) { g.beginPath(); g.arc(cx, cy, (rad(k - 1) + rad(k)) / 2, 0, 2 * Math.PI); g.stroke(); }
  g.fillStyle = col("--fg"); g.font = "600 20px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["O", 270]].forEach(([t, a]) => { const r = R + 24, th = a * Math.PI / 180; g.fillText(t, cx + r * Math.sin(th), cy - r * Math.cos(th)); });
  g.font = "14px system-ui, sans-serif"; g.fillStyle = "#0b0d0e";
  for (let k = 1; k < ns; k++) g.fillText(String(f.speeds[k]), cx + 3, cy - rad(k) + 1);
  g.fillStyle = col("--muted"); g.textAlign = "left"; g.fillText("vent près du relief (km/h), direction d'où il vient", 8, W - 10);
  // vent prévu
  const amb = Math.hypot(...f.ambient) * 3.6, th = windFrom(...f.ambient) * Math.PI / 180;
  let r = 0;
  for (let k = 1; k < ns; k++) if (amb <= f.speeds[k]) { const t = (amb - f.speeds[k - 1]) / (f.speeds[k] - f.speeds[k - 1]); r = rad(k - 1) + t * (rad(k) - rad(k - 1)); break; } else r = R;
  g.beginPath(); g.arc(cx + r * Math.sin(th), cy - r * Math.cos(th), 9, 0, 2 * Math.PI);
  g.fillStyle = "#fff"; g.fill(); g.lineWidth = 3; g.strokeStyle = "#0b0d0e"; g.stroke();
}

function drawEmagram(D) {
  const c = $("emagram"), g = c.getContext("2d"), Wc = c.width, Hc = c.height, cs = getComputedStyle(document.documentElement);
  const col = k => cs.getPropertyValue(k).trim();
  const L0 = 58, R0 = 14, T0 = 14, B0 = 38, zmax = Math.max(5000, Math.ceil((D.z0 + 2500) / 1000) * 1000);
  const rows = D.rows.filter(r => r.z >= Math.max(0, D.z0 - 300) && r.z <= zmax);
  const all = rows.flatMap(r => [r.T, r.Td]).concat(D.parcel.map(r => r.T));
  const tmin = Math.floor((Math.min(...all) - 2) / 5) * 5, tmax = Math.ceil((Math.max(...all) + 2) / 5) * 5;
  const X = t => L0 + (t - tmin) / (tmax - tmin) * (Wc - L0 - R0), Y = z => Hc - B0 - z / zmax * (Hc - T0 - B0);
  g.clearRect(0, 0, Wc, Hc);
  g.font = "15px system-ui, sans-serif"; g.strokeStyle = col("--line"); g.fillStyle = col("--muted"); g.lineWidth = 1;
  g.textAlign = "right";
  for (let z = 0; z <= zmax; z += 1000) { g.beginPath(); g.moveTo(L0, Y(z)); g.lineTo(Wc - R0, Y(z)); g.stroke(); g.fillText(z + " m", L0 - 6, Y(z) + 5); }
  g.textAlign = "center";
  for (let t = tmin; t <= tmax; t += 5) { g.beginPath(); g.moveTo(X(t), T0); g.lineTo(X(t), Hc - B0); g.stroke(); g.fillText(t + "°", X(t), Hc - B0 + 20); }
  g.fillStyle = col("--ground"); g.fillRect(L0, Y(D.z0), Wc - L0 - R0, Hc - B0 - Y(D.z0));
  if (D.lid && D.lid > D.z0) {
    g.fillStyle = "rgba(251,191,36,.16)"; g.fillRect(L0, Y(D.lid + 300), Wc - L0 - R0, Y(D.lid) - Y(D.lid + 300));
    g.fillStyle = "#fbbf24"; g.textAlign = "right"; g.font = "13px system-ui, sans-serif";
    g.fillText("couvercle de l'air de vallée (estimé)", Wc - R0 - 4, Y(D.lid + 300) - 5);
  }
  if (D.climb > 0.1 && D.top > D.z0) {
    g.fillStyle = "rgba(249,115,22,.12)"; g.fillRect(L0, Y(D.top), Wc - L0 - R0, Y(D.z0) - Y(D.top));
    g.fillStyle = col("--accent"); g.textAlign = "left"; g.font = "600 14px system-ui, sans-serif";
    g.fillText("sommet des thermiques " + km(D.top) + " m", L0 + 6, Y(D.top) - 6);
  }
  const line = (pts, color, dash, lw) => { g.strokeStyle = color; g.lineWidth = lw; g.setLineDash(dash); g.beginPath(); pts.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.setLineDash([]); };
  const above = rows.filter(r => r.z >= D.z0 - 50);
  line(above.map(r => [X(r.T), Y(r.z)]), col("--fg"), [], 3);
  line(above.map(r => [X(r.Td), Y(r.z)]), "#3b82f6", [7, 5], 2.5);
  if (D.climb > 0.1 && D.u) {
    line(D.parcel.map(r => [X(r.T), Y(r.z)]), "#f97316", [9, 5], 3);
    g.strokeStyle = col("--fg"); g.lineWidth = 2; g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(L0, Y(D.u.ceil)); g.lineTo(Wc - R0, Y(D.u.ceil)); g.stroke(); g.setLineDash([]);
    g.fillStyle = col("--fg"); g.textAlign = "right"; g.font = "600 15px system-ui, sans-serif";
    g.fillText((D.cu ? "base des cumulus " : "plafond utilisable ") + km(D.u.ceil) + " m", Wc - R0 - 4, Y(D.u.ceil) - 7);
  }
}

// ---------------------------------------------------------------- comparaison des modèles
function startCompare() {
  if (!st.date) return;
  const my = ++st.cmpToken;
  st.cmp = { token: my, date: st.date, data: new Map(), errors: new Map(), done: false };
  $("cmpBox").hidden = false;
  $("cmpStatus").textContent = `Calcul du ${labelDate(st.date)} avec ${MODELS.length} modèles…`;
  $("cmpLegend").innerHTML = MODELS.map((m, k) => `<span><i style="background:${MCOL[k]}"></i>${m.short}</span>`).join("");
  $("cmpVerdict").textContent = ""; $("cmpEmagram").hidden = true;
  let i = null, j = null;
  if (st.point) { const m = st.meta; i = Math.floor((st.point.lng - m.west) / (m.east - m.west) * m.nx); j = Math.floor((m.north - st.point.lat) / (m.north - m.south) * m.ny); }
  drawCompare();
  worker.postMessage({ type: "compare", token: my, date: st.date, i, j });
  $("cmpBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function onCompare(m) {
  const C = st.cmp;
  if (!C || m.token !== C.token) return;
  if (m.type === "cmpError") { $("cmpStatus").textContent = "Comparaison impossible : " + m.message; return; }
  if (m.type === "cmpDone") { C.done = true; $("cmpStatus").textContent = `${labelDate(C.date)} : ${C.data.size} modèles calculés` + (C.errors.size ? ` (${[...C.errors.keys()].map(modelName).join(", ")} indisponible)` : "") + "."; verdict(); drawCmpEmagram(); return; }
  if (m.error) { C.errors.set(m.model, m.error); return; }
  if (m.wait) { $("cmpStatus").textContent = `${modelName(m.model)} : le service météo limite le nombre de requêtes par minute, attente de ${m.wait} s…`; return; }
  if (!C.data.has(m.model)) C.data.set(m.model, new Map());
  C.data.get(m.model).set(m.h, m);
  $("cmpStatus").textContent = `Calcul… ${modelName(m.model)} ${m.h} h`;
  drawCompare();
}

const QTY = [
  { key: "vz", label: "Vz des meilleures pompes (m/s)", get: r => r.vz, lo: 0, hi: 5, tol: 1, unit: " m/s", f: v => fr(v) },
  { key: "ceil", label: "Plafond médian (m)", get: r => r.ceil, lo: 1000, hi: 4500, tol: 500, unit: " m", f: v => km(v) },
  { key: "wind", label: "Vent moyen vers 2 500 m (km/h)", get: r => Math.hypot(...r.wind) * 3.6, lo: 0, hi: 50, tol: 12, unit: " km/h", f: v => String(Math.round(v)) },
  { key: "cloud", label: "Nébulosité (%)", get: r => r.cloud, lo: 0, hi: 100, tol: 35, unit: " %", f: v => String(Math.round(v)) },
];

function drawCompare() {
  const C = st.cmp, c = $("cmpChart"), g = c.getContext("2d"), W = c.width, H = c.height;
  const cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  g.clearRect(0, 0, W, H);
  const hours = [9, 11, 13, 15, 17], ph = H / QTY.length, L0 = 52, R0 = 12;
  const X = h => L0 + (h - 9) / 8 * (W - L0 - R0);
  QTY.forEach((q, qi) => {
    const top = qi * ph + 24, bot = (qi + 1) * ph - 22;
    let lo = q.lo, hi = q.hi;
    if (C) for (const [, hm] of C.data) for (const [, r] of hm) { const v = q.get(r); if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const Y = v => bot - (v - lo) / Math.max(1e-6, hi - lo) * (bot - top);
    g.fillStyle = col("--fg"); g.font = "600 15px system-ui, sans-serif"; g.textAlign = "left"; g.fillText(q.label, 8, top - 8);
    g.strokeStyle = col("--line"); g.lineWidth = 1; g.font = "13px system-ui, sans-serif"; g.fillStyle = col("--muted");
    for (const v of [lo, (lo + hi) / 2, hi]) { g.beginPath(); g.moveTo(L0, Y(v)); g.lineTo(W - R0, Y(v)); g.stroke(); g.textAlign = "right"; g.fillText(q.f(v), L0 - 6, Y(v) + 4); }
    g.textAlign = "center"; for (const h of hours) g.fillText(h + " h", X(h), bot + 16);
    if (!C) return;
    MODELS.forEach((m, k) => {
      const hm = C.data.get(m.id); if (!hm) return;
      const pts = hours.filter(h => hm.has(h)).map(h => [X(h), Y(q.get(hm.get(h)))]);
      g.strokeStyle = MCOL[k]; g.lineWidth = 2.5; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p)); g.stroke();
      g.fillStyle = MCOL[k]; for (const p of pts) { g.beginPath(); g.arc(p[0], p[1], 3.5, 0, 2 * Math.PI); g.fill(); }
    });
  });
}

function verdict() {
  const C = st.cmp, hours = [9, 11, 13, 15, 17], out = [];
  const ids = [...C.data.keys()];
  if (ids.length < 3) { $("cmpVerdict").textContent = "Trop peu de modèles disponibles pour juger."; return; }
  const spread = [];
  for (const q of QTY) {
    const dev = new Map(ids.map(id => [id, []]));
    let sp = 0, n = 0;
    for (const h of hours) {
      const vals = ids.map(id => C.data.get(id).get(h)).map(r => (r ? q.get(r) : NaN));
      const ok = vals.filter(v => v === v).sort((a, b) => a - b);
      if (ok.length < 3) continue;
      const med = ok[Math.floor(ok.length / 2)];
      ids.forEach((id, k) => { if (vals[k] === vals[k]) dev.get(id).push(vals[k] - med); });
      sp += ok[ok.length - 1] - ok[0]; n++;
    }
    for (const id of ids) {
      const d = dev.get(id); if (!d.length) continue;
      const m = d.reduce((s, x) => s + x, 0) / d.length;
      if (Math.abs(m) > q.tol) out.push(`<b>${modelName(id)}</b> ${m > 0 ? "au-dessus" : "en dessous"} des autres sur ${q.label.split(" (")[0].toLowerCase()} (${m > 0 ? "+" : "−"}${q.f(Math.abs(m))}${q.unit})`);
    }
    if (n) spread.push([q, sp / n]);
  }
  const unsure = spread.filter(([q, s]) => s > 2 * q.tol).map(([q]) => q.label.split(" (")[0].toLowerCase());
  $("cmpVerdict").innerHTML = (out.length ? "À surveiller : " + out.join(" ; ") + "." : "Les modèles sont d'accord à peu près sur tout.")
    + (unsure.length ? `<br>Désaccord général sur : ${unsure.join(", ")} — journée incertaine sur ce point.` : "");
}

function drawCmpEmagram() {
  const C = st.cmp, c = $("cmpEmagram");
  const want = [13, 15, 11, 9, 17].sort((a, b) => Math.abs(a - st.hour) - Math.abs(b - st.hour))[0];
  const sets = [];
  MODELS.forEach((m, k) => { const r = C.data.get(m.id) && C.data.get(m.id).get(want); if (r && r.sounding) sets.push({ k, r }); });
  if (!sets.length) { c.hidden = true; return; }
  c.hidden = false;
  const g = c.getContext("2d"), Wc = c.width, Hc = c.height, cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  const z0 = sets[0].r.z0, zmax = Math.max(5000, Math.ceil((z0 + 2500) / 1000) * 1000), L0 = 58, R0 = 14, T0 = 30, B0 = 38;
  const rows = sets.flatMap(s => s.r.sounding.filter(x => x[0] >= z0 - 50 && x[0] <= zmax));
  const all = rows.flatMap(x => [x[1], x[2]]);
  const tmin = Math.floor((Math.min(...all) - 2) / 5) * 5, tmax = Math.ceil((Math.max(...all) + 2) / 5) * 5;
  const X = t => L0 + (t - tmin) / (tmax - tmin) * (Wc - L0 - R0), Y = z => Hc - B0 - z / zmax * (Hc - T0 - B0);
  g.clearRect(0, 0, Wc, Hc);
  g.font = "15px system-ui, sans-serif"; g.strokeStyle = col("--line"); g.fillStyle = col("--muted"); g.lineWidth = 1; g.textAlign = "right";
  for (let z = 0; z <= zmax; z += 1000) { g.beginPath(); g.moveTo(L0, Y(z)); g.lineTo(Wc - R0, Y(z)); g.stroke(); g.fillText(z + " m", L0 - 6, Y(z) + 5); }
  g.textAlign = "center";
  for (let t = tmin; t <= tmax; t += 5) { g.beginPath(); g.moveTo(X(t), T0); g.lineTo(X(t), Hc - B0); g.stroke(); g.fillText(t + "°", X(t), Hc - B0 + 20); }
  g.fillStyle = col("--ground"); g.fillRect(L0, Y(z0), Wc - L0 - R0, Hc - B0 - Y(z0));
  for (const { k, r } of sets) {
    const pts = r.sounding.filter(x => x[0] >= z0 - 50 && x[0] <= zmax);
    g.strokeStyle = MCOL[k]; g.lineWidth = 2.5; g.setLineDash([]); g.beginPath(); pts.forEach((x, i) => i ? g.lineTo(X(x[1]), Y(x[0])) : g.moveTo(X(x[1]), Y(x[0]))); g.stroke();
    g.lineWidth = 1.5; g.setLineDash([5, 5]); g.beginPath(); pts.forEach((x, i) => i ? g.lineTo(X(x[2]), Y(x[0])) : g.moveTo(X(x[2]), Y(x[0]))); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.moveTo(Wc - R0 - 30, Y(r.top)); g.lineTo(Wc - R0, Y(r.top)); g.lineWidth = 4; g.stroke();
  }
  g.fillStyle = col("--fg"); g.textAlign = "left"; g.font = "600 15px system-ui, sans-serif";
  g.fillText(`Profils au point cliqué à ${want} h (tirets : point de rosée ; repère à droite : sommet des thermiques)`, 8, 18);
}

// ---------------------------------------------------------------- animation
function togglePlay() { st.playing ? stopPlay() : startPlay(); }
function startPlay() {
  $("play").textContent = "⏸ Pause";
  st.playing = setInterval(() => { st.hour = st.hour >= H1 ? H0 : st.hour + 1; $("hour").value = st.hour; render(); }, 1000);
}
function stopPlay() { if (st.playing) { clearInterval(st.playing); st.playing = null; $("play").textContent = "▶ Animer"; } }

init().catch(e => setStatus("Erreur : " + e.message, true));
// page installable et utilisable hors réseau (pas pendant les tests en local)
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
window.addEventListener("offline", () => setStatus("Hors réseau : dernière prévision enregistrée", true));
