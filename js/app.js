// Interface : carte Leaflet, calques calculés en arrière-plan (worker.js), curseur horaire, diagnostic au clic.
import { SCALES, css } from "./scales.js";
import { addDays, isoDate } from "./weather.js";

const $ = id => document.getElementById(id);
const H0 = 7, H1 = 21;
const fr = (x, n = 1) => x.toFixed(n).replace(".", ",").replace(/^-0,0$/, "0,0");
const km = x => String(Math.round(x / 50) * 50).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const pct = x => Math.round(x * 100) + " %";
const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

const st = { meta: null, date: null, hour: 14, layer: "climb", hours: new Map(), dayScores: new Map(), token: 0, point: null, playing: null,
  week: null, wanted: null, deferred: false, done: false, source: "" };
let map, bounds, fieldLayer, windLayer, spotsLayer, namesLayer, baseLayers, canvas, ctx, wcanvas, wctx, worker;
window.__pompes = st;                       // accès pour le débogage dans la console

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
  $("pointClose").addEventListener("click", () => { st.point = null; $("pointBox").hidden = true; });
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

// ---------------------------------------------------------------- dialogue avec le calcul
function onWorker(m) {
  if (m.type === "ready") return onReady(m.meta);
  if (m.type === "error") {
    if (m.token != null && m.token !== st.token) return;
    setStatus("Impossible d'afficher le " + (st.wanted || "jour demandé") + " : " + m.message, true);
    if (st.deferred) { st.deferred = false; selectDate(st.wanted, true); }
    return;
  }
  if (m.token !== st.token) return;
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
    setStatus(`${st.source} · ${labelDate(st.date)}`);
    let best = 0;
    for (const x of st.hours.values()) best = Math.max(best, x.stats.spotClimb);
    st.dayScores.set(st.date, best);
    paintDays();
    if (st.week && st.weekRange) {
      const dates = st.week.filter(d => !st.dayScores.has(d));
      if (dates.length) worker.postMessage({ type: "overview", token: st.token, dates, start: st.weekRange[0], end: st.weekRange[1] });
    }
  } else if (m.type === "dayScore") {
    st.dayScores.set(m.date, m.best); paintDays();
  } else if (m.type === "image") {
    if (m.h !== st.hour || m.layer !== st.layer) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(m.img), st.meta.nx, st.meta.ny), 0, 0);
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
    if (v == null) continue;
    b.querySelector("i").style.background = v < 0.3 ? "var(--line)" : css(SCALES.climb.col(v));
    b.title = v < 0.3 ? "pas de convection exploitable" : `jusqu'à ${fr(v)} m/s au vario`;
  }
}

function selectDate(date, custom) {
  stopPlay();
  st.wanted = date;
  const my = ++st.token;
  const inWeek = st.week && st.week.includes(date) && !custom;
  setStatus("Récupération des données du " + labelDate(date) + "…");
  worker.postMessage({ type: "day", token: my, date, hour: st.hour, start: inWeek ? st.weekRange[0] : date, end: inWeek ? st.weekRange[1] : date });
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
  if (st.point) askPoint(st.point, true);
}

function drawArrows(a) { st.arrows = a; updateWind(); }

// Vent : dessiné sur le calque image quand on voit toute la zone, en marqueurs de taille fixe quand on zoome
// (sinon les flèches grossiraient avec la carte).
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
  const view = map.getBounds().pad(0.2);
  for (let k = 0; k < a.length; k += 4) {
    const u = a[k + 2], v = a[k + 3], s = Math.hypot(u, v);
    const ll = cellCenter(a[k], a[k + 1]);
    if (s < 0.5 || !view.contains(ll)) continue;
    const len = Math.min(34, 12 + s * 2.4), ang = Math.atan2(u, v) * 180 / Math.PI;
    const svg = `<svg width="${len + 8}" height="${len + 8}" viewBox="${-(len + 8) / 2} ${-(len + 8) / 2} ${len + 8} ${len + 8}" style="transform:rotate(${ang}deg)">`
      + `<path d="M0 ${len / 2} V${-len / 2} M-5 ${-len / 2 + 7} L0 ${-len / 2} L5 ${-len / 2 + 7}" stroke="rgba(0,0,0,.7)" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<path d="M0 ${len / 2} V${-len / 2} M-5 ${-len / 2 + 7} L0 ${-len / 2} L5 ${-len / 2 + 7}" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
function offset(lat, lon, east, north) { return [lat + north / 111320, lon + east / (111320 * Math.cos(lat * Math.PI / 180))]; }
function cellCenter(i, j) { const m = st.meta; return [m.north - (j + 0.5) / m.ny * (m.north - m.south), m.west + (i + 0.5) / m.nx * (m.east - m.west)]; }

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
    const dot = L.circleMarker([lat, lon], { radius: rf * (3 + 1.4 * Math.min(4, Math.max(0, s.vz))), color: "#0b0d0e", weight: 1.3, fillColor: col, fillOpacity: 1 });
    const w = Math.hypot(s.wu, s.wv), dir = (Math.atan2(-s.wu, -s.wv) * 180 / Math.PI + 360) % 360;
    const tip = `<b>Pompe : Vz +${fr(Math.max(0, s.vz))} m/s</b> <span class="muted">(95 % : ${fr(Math.max(0, s.vzLo))} à ${fr(s.vzHi)})</span>`
      + `<br>probabilité qu'elle soit exploitable : <b>${pct(s.prob)}</b>`
      + `<br>plafond ${km(s.ceil)} m <span class="muted">(${km(s.ceilLo)} à ${km(s.ceilHi)})</span> · ${s.cu ? "cumulus" : "thermique bleu"}`
      + `<br>départ vers ${km(s.elev)} m · vent ${Math.round(w * 3.6)} km/h du ${cardinal(dir)}`
      + `<br>zone à 95 % : ${fr(2 * s.ea / 1000)} × ${fr(2 * s.eb / 1000)} km`;
    for (const l of [zone, dot]) {
      l.bindTooltip(tip, { className: "spot", direction: "top", sticky: l === zone });
      l.on("click", e => { L.DomEvent.stopPropagation(e); askPoint(L.latLng(lat, lon)); });
      spotsLayer.addLayer(l);
    }
  }
}

function drawLegend() {
  const sc = SCALES[st.layer], t = sc.ticks;
  const stops = [];
  for (let k = 0; k <= 20; k++) { const v = t[0] + (t[t.length - 1] - t[0]) * k / 20; stops.push(`${css(sc.col(v))} ${k * 5}%`); }
  const fmt = v => st.layer === "climb" || st.layer === "conv" ? fr(v, v % 1 ? 1 : 0) : String(v);
  $("legend").innerHTML = `<div class="cap">${sc.cap}</div><div class="bar" style="background:linear-gradient(90deg,${stops.join(",")})"></div>
    <div class="ticks">${t.map(v => `<span>${fmt(v)}</span>`).join("")}</div>
    <div class="spots"><span class="ell"></span> pompe : zone où la trouver à 95 % (pleine si probabilité ≥ 50 %, tiretée sinon)
    · point : départ au sol · trait : dérive jusqu'au plafond · flèches : vent dans la couche convective</div>`;
}

function drawDayChart() {
  const c = $("daychart"), g = c.getContext("2d"), Wc = c.width, Hc = c.height;
  const cs = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, Wc, Hc);
  const n = H1 - H0 + 1, bw = Wc / n, base = Hc - 26, vmax = 4;
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
    $("summary").innerHTML = `<b>${s.nSpots} pompes</b> à plus de 50 % de chances · Vz typique <b>+${fr(s.spotClimb)} m/s</b> au vario · ${sky}`;
  }
  const fl = [];
  if (s.rain > 0.3) fl.push("averses prévues");
  if (s.cape > 800) fl.push(`risque de surdéveloppement ou d'orage (CAPE ${Math.round(s.cape)} J/kg)`);
  if (s.wind10 > 7) fl.push(`vent soutenu au sol (${Math.round(s.wind10 * 3.6)} km/h)`);
  if (s.cloud > 75 && s.spotClimb >= 0.3) fl.push("ciel très nuageux : pompes irrégulières");
  if (s.snowLine < 2600) fl.push(`neige au-dessus de ${km(s.snowLine)} m environ`);
  $("flags").textContent = fl.length ? "⚠ " + fl.join(" · ") : "";
}

// ---------------------------------------------------------------- diagnostic en un point
function askPoint(latlng, keep = false) {
  const m = st.meta;
  const i = Math.floor((latlng.lng - m.west) / (m.east - m.west) * m.nx), j = Math.floor((m.north - latlng.lat) / (m.north - m.south) * m.ny);
  if (i < 0 || j < 0 || i >= m.nx || j >= m.ny || !st.hours.has(st.hour)) return;
  st.point = latlng; st.keep = keep;
  $("pointBox").hidden = false;
  if (!keep) $("pointText").textContent = "Calcul…";
  worker.postMessage({ type: "point", token: st.token, h: st.hour, i, j });
}

function showPoint(D) {
  const w = Math.hypot(D.wu, D.wv), dir = (Math.atan2(-D.wu, -D.wv) * 180 / Math.PI + 360) % 360, u = D.u;
  $("pointTitle").textContent = `Point à ${km(D.z0)} m`;
  $("pointText").innerHTML = u && D.climb > 0.1
    ? `Vz au vario <b>+${fr(Math.max(0, u.vz))} m/s</b> (95 % : ${fr(Math.max(0, u.vzLo))} à ${fr(u.vzHi)}) · au cœur ${fr(u.core)} m/s<br>`
      + `${D.cu ? "base des cumulus" : "thermique bleu, plafond utilisable"} <b>${km(u.ceil)} m</b> (${km(u.ceilLo)} à ${km(u.ceilHi)}) · sommet de la convection ${km(D.top)} m<br>`
      + `chances d'un thermique exploitable ici : ${pct(u.pdev)} · sol ${Math.round(D.H)} W/m² · convergence ${fr(D.conv, 2)} · vent ${Math.round(w * 3.6)} km/h du ${cardinal(dir)}`
    : `Pas d'ascendance exploitable ici à ${st.hour} h (sol : ${Math.round(D.H)} W/m²).`;
  drawEmagram(D);
  if (!st.keep) $("pointBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    g.fillText("sommet de la convection " + km(D.top) + " m", L0 + 6, Y(D.top) - 6);
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

// ---------------------------------------------------------------- animation
function togglePlay() { st.playing ? stopPlay() : startPlay(); }
function startPlay() {
  $("play").textContent = "⏸ Pause";
  st.playing = setInterval(() => { st.hour = st.hour >= H1 ? H0 : st.hour + 1; $("hour").value = st.hour; render(); }, 1000);
}
function stopPlay() { if (st.playing) { clearInterval(st.playing); st.playing = null; $("play").textContent = "▶ Animer"; } }

init().catch(e => setStatus("Erreur : " + e.message, true));
