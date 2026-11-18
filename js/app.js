// Interface : carte Leaflet, calques calculés en arrière-plan (worker.js), curseur horaire, diagnostic au clic,
// alimentation des pompes, choix et comparaison des modèles météo.
import { SCALES, css } from "./scales.js";
import { addDays, isoDate, MODELS, DEFAULT_MODEL } from "./weather.js";

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
let map, bounds, fieldLayer, windLayer, spotsLayer, namesLayer, feedLayer, baseLayers, canvas, ctx, wcanvas, wctx, worker;
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
  for (const id of ["showSpots", "showWind", "showNames", "minProb"]) $(id).addEventListener("change", render);
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
  $("pointClose").addEventListener("click", () => { st.point = null; $("pointBox").hidden = true; clearFeed(); });
  $("daychart").addEventListener("click", e => {
    const r = e.target.getBoundingClientRect();
    st.hour = Math.min(H1, Math.max(H0, Math.floor(H0 + (e.clientX - r.left) / r.width * (H1 - H0 + 1))));
    $("hour").value = st.hour; stopPlay(); render();
  });

  const today = isoDate(new Date());
  $("date").max = addDays(today, 14);
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
    drawDayChart();
    setStatus(`Calcul ${st.hours.size}/${H1 - H0 + 1}…`);
  } else if (m.type === "dayDone") {
    st.done = true;
    setStatus(`${st.source} · ${modelName(st.model)} · ${labelDate(st.date)}`);
    let best = 0;
    for (const x of st.hours.values()) best = Math.max(best, x.stats.spotClimb);
    st.dayScores.set(st.date, best);
    paintDays();
    if (st.week && st.weekRange) {
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
  worker.postMessage({ type: "day", token: my, date, hour: st.hour, model: st.model, start: inWeek ? st.weekRange[0] : date, end: inWeek ? st.weekRange[1] : date });
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
  drawLegend(); writeSummary(X.stats);
  if (st.point) askPoint(st.point, true, st.feed);
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
  const minP = +$("minProb").value;
  const rf = Math.min(1.2, Math.max(0.5, Math.pow(2, map.getZoom() - 10.5)));
  for (const s of X.spots) {
    if (s.prob < minP) continue;
    const [lat, lon] = cellCenter(s.i, s.j);
    const col = css(SCALES.climb.col(s.vz));
    const [clat, clon] = offset(lat, lon, s.ex, s.ey);
    const zone = L.polygon(ellipse(clat, clon, s.ea, s.eb, s.eang), { color: col, weight: 1.6, opacity: 0.95, fillColor: col,
      fillOpacity: 0.10 + 0.30 * s.prob, dashArray: s.prob < 0.5 ? "4 4" : null });
    const [tlat, tlon] = offset(lat, lon, s.tx, s.ty);
    if (Math.hypot(s.tx, s.ty) > 300) spotsLayer.addLayer(L.polyline([[lat, lon], [tlat, tlon]], { color: "#0b0d0e", weight: 3.5, opacity: 0.7, interactive: false }));
    if (Math.hypot(s.tx, s.ty) > 300) spotsLayer.addLayer(L.polyline([[lat, lon], [tlat, tlon]], { color: col, weight: 1.6, interactive: false }));
    const dot = L.circleMarker([lat, lon], { radius: rf * (3 + 1.2 * Math.min(5, Math.max(0, s.vz))), color: "#0b0d0e", weight: 1.3, fillColor: col, fillOpacity: 1 });
    const w = Math.hypot(s.wu, s.wv);
    const tip = `<b>Pompe : Vz +${fr(Math.max(0, s.vz))} m/s</b> <span class="muted">(95 % : ${fr(Math.max(0, s.vzLo))} à ${fr(s.vzHi)})</span>`
      + `<br>probabilité qu'elle soit exploitable : <b>${pct(s.prob)}</b>`
      + `<br>plafond ${km(s.ceil)} m <span class="muted">(${km(s.ceilLo)} à ${km(s.ceilHi)})</span> · ${s.cu ? "cumulus" : "thermique bleu"}`
      + `<br>départ vers ${km(s.elev)} m · vent ${Math.round(w * 3.6)} km/h ${du(windFrom(s.wu, s.wv))}`
      + `<br>zone à 95 % : ${fr(2 * s.ea / 1000)} × ${fr(2 * s.eb / 1000)} km`
      + (s.vz >= 3 ? `<br><span class="muted">cliquer : d'où vient son air, effet du vent</span>` : "");
    for (const l of [zone, dot]) {
      l.bindTooltip(tip, { className: "spot", direction: "top", sticky: l === zone });
      l.on("click", e => { L.DomEvent.stopPropagation(e); askPoint(L.latLng(lat, lon), false, s.vz >= 3); });
      spotsLayer.addLayer(l);
    }
  }
}

function drawLegend() {
  const sc = SCALES[st.layer], t = sc.ticks;
  const stops = [];
  for (let k = 0; k <= 20; k++) { const v = t[0] + (t[t.length - 1] - t[0]) * k / 20; stops.push(`${css(sc.col(v))} ${k * 5}%`); }
  const fmt = v => st.layer === "climb" || st.layer === "conv" ? fr(v, v % 1 ? (v * 4 % 1 ? 2 : 1) : 0) : String(v);
  $("legend").innerHTML = `<div class="cap">${sc.cap}</div><div class="bar" style="background:linear-gradient(90deg,${stops.join(",")})"></div>
    <div class="ticks">${t.map(v => `<span>${fmt(v)}</span>`).join("")}</div>
    <div class="spots"><span class="ell"></span> pompe : zone où la trouver à 95 % (pleine si probabilité ≥ 50 %, tiretée sinon)
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
    }
    g.fillStyle = h === st.hour ? cs.getPropertyValue("--fg") : cs.getPropertyValue("--muted");
    g.fillText(h % 2 ? String(h) : "", x + bw / 2, Hc - 6);
  }
  g.fillStyle = cs.getPropertyValue("--muted"); g.textAlign = "left"; g.font = "14px system-ui, sans-serif";
  g.fillText("Vz moyenne des 12 meilleures pompes (m/s), heure locale", 8, 16);
}

function writeSummary(s) {
  if (s.sunEl <= 1) { $("summary").innerHTML = "Soleil couché : pas de convection."; $("flags").textContent = ""; return; }
  if (s.nAll === 0 || s.spotClimb < 0.3) {
    $("summary").innerHTML = "<b>Pas d'ascendance thermique exploitable</b> à cette heure" + (s.cloud > 70 ? " (ciel couvert)." : s.hMean < 40 ? " (le sol chauffe trop peu)." : " (air stable).");
  } else {
    const rng = s.ceilHi - s.ceilLo >= 200 ? `<b>${km(s.ceilLo)} m</b> sur les premiers reliefs à <b>${km(s.ceilHi)} m</b> sur les plus hauts` : `vers <b>${km(s.ceilHi)} m</b>`;
    const sky = s.cuFrac > 0.6 ? `cumulus, base de ${rng}` : s.cuFrac > 0.2 ? `quelques cumulus, plafond de ${rng}` : `thermiques bleus, plafond de ${rng}`;
    $("summary").innerHTML = `<b>${s.nSpots} pompes</b> à plus de 50 % de chances · Vz typique <b>+${fr(s.spotClimb)} m/s</b> au vario dans les meilleures · ${sky}`;
  }
  const fl = [];
  if (s.rain > 0.3) fl.push("averses prévues");
  if (s.cape > 800) fl.push(`risque de surdéveloppement ou d'orage (CAPE ${Math.round(s.cape)} J/kg)`);
  if (s.wind10 > 7) fl.push(`vent soutenu au sol (${Math.round(s.wind10 * 3.6)} km/h)`);
  if (s.cloud > 75 && s.spotClimb >= 0.3) fl.push("ciel très nuageux : pompes irrégulières");
  if (s.snowLine < 2600) fl.push(`neige au-dessus de ${km(s.snowLine)} m environ`);
  if (s.challes) {
    const [u, v] = s.challes, sp = Math.hypot(u, v), d = windFrom(u, v);
    if (sp >= 3 && d >= 135 && d <= 225 && st.hour <= 16)
      fl.push(`sud annoncé vers 1 500 m (${Math.round(sp * 3.6)} km/h) : souvent de l'est sur la piste de Challes, premières pompes au treuil déstructurées`);
  }
  $("flags").textContent = fl.length ? "⚠ " + fl.join(" · ") : "";
}

// ---------------------------------------------------------------- diagnostic en un point
function askPoint(latlng, keep = false, feed = false) {
  const m = st.meta;
  const i = Math.floor((latlng.lng - m.west) / (m.east - m.west) * m.nx), j = Math.floor((m.north - latlng.lat) / (m.north - m.south) * m.ny);
  if (i < 0 || j < 0 || i >= m.nx || j >= m.ny || !st.hours.has(st.hour)) return;
  st.point = latlng; st.keep = keep; st.feed = feed;
  if (!feed) clearFeed();
  $("pointBox").hidden = false;
  if (!keep) $("pointText").textContent = feed ? "Calcul de l'alimentation de la pompe…" : "Calcul…";
  worker.postMessage({ type: "point", token: st.token, h: st.hour, i, j, feed });
}

function showPoint(D) {
  const w = Math.hypot(D.wu, D.wv), u = D.u, s = Math.hypot(D.su, D.sv);
  $("pointTitle").textContent = D.feed ? `Pompe à ${km(D.z0)} m` : `Point à ${km(D.z0)} m`;
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
      : weak.length ? `<br>Elle faiblit beaucoup ou se déplace par vent <b>${names(weak)}</b> (20 km/h).` : "");
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
