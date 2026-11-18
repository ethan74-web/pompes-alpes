// Traces de vol IGC : lecture, détection des spirales, comparaison avec la prévision.
// Tout se passe dans le navigateur : le fichier n'est envoyé nulle part.
const R_EARTH = 6371000, D2R = Math.PI / 180;

/** Lit un fichier IGC : date (UTC) et points B (heure UTC en s, lat, lon, altitude GPS ou pression). */
export function parseIGC(text) {
  let date = null;
  const fx = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith("HFDTE")) {
      const m = l.match(/^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/);
      if (m) date = `20${m[3]}-${m[2]}-${m[1]}`;
    } else if (l[0] === "B" && l.length >= 35) {
      const t = +l.slice(1, 3) * 3600 + +l.slice(3, 5) * 60 + +l.slice(5, 7);
      let lat = +l.slice(7, 9) + +l.slice(9, 14) / 60000, lon = +l.slice(15, 18) + +l.slice(18, 23) / 60000;
      if (l[14] === "S") lat = -lat;
      if (l[23] === "W") lon = -lon;
      const pa = +l.slice(25, 30), ga = +l.slice(30, 35);
      if (!(lat || lon)) continue;
      fx.push({ t, lat, lon, alt: ga > 0 ? ga : pa });
    }
  }
  // passage de minuit UTC
  for (let k = 1; k < fx.length; k++) if (fx[k].t < fx[k - 1].t - 43200) for (let m = k; m < fx.length; m++) fx[m].t += 86400;
  // points en double ou désordonnés
  const out = fx.filter((f, k) => k === 0 || f.t > fx[k - 1].t);
  if (!date || out.length < 30) throw new Error("fichier IGC illisible (date ou points manquants)");
  return { date, fixes: out };
}

const east = (a, b) => (b.lon - a.lon) * D2R * R_EARTH * Math.cos(a.lat * D2R);
const north = (a, b) => (b.lat - a.lat) * D2R * R_EARTH;

/** Décalage de l'heure française (s) à l'instant UTC ms : heure d'été du dernier dimanche de mars au dernier d'octobre, 1 h UTC. */
function offsetUTC(ms) {
  const y = new Date(ms).getUTCFullYear();
  const lastSun = m => { const d = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay()) + 3600e3; };
  return ms >= lastSun(2) && ms < lastSun(9) ? 7200 : 3600;
}
/** Heure locale (France) décimale d'un instant UTC du jour date (t en s depuis 0 h UTC). */
export function localHour(date, t) {
  const ms = Date.parse(date + "T00:00:00Z") + t * 1000;
  return ((t + offsetUTC(ms)) / 3600 + 48) % 24;
}

/**
 * Spirales : virage continu de plus de 5°/s (lissé sur 15 s), sur au moins 1,5 tour et 40 s ; trous de moins de 12 s
 * comblés. Pour chacune : début et fin, base et sommet, Vz moyenne (gain / durée) et meilleure Vz sur 30 s, centre du
 * premier tour (là où la pompe a été prise), dérive des centres de tours (vent), rayon v/ω et inclinaison atan(vω/g).
 */
export function findThermals(F) {
  const P = F.fixes, n = P.length;
  if (n < 30) return [];
  const hd = new Float64Array(n), gs = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) {
    const dx = east(P[k], P[k + 1]), dy = north(P[k], P[k + 1]), dt = Math.max(1, P[k + 1].t - P[k].t);
    hd[k] = Math.atan2(dx, dy); gs[k] = Math.hypot(dx, dy) / dt;
  }
  hd[n - 1] = hd[n - 2]; gs[n - 1] = gs[n - 2];
  // cap déroulé
  const uh = new Float64Array(n);
  uh[0] = hd[0];
  for (let k = 1; k < n; k++) { let d = hd[k] - hd[k - 1]; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); uh[k] = uh[k - 1] + d; }
  // taux de virage lissé sur ±7,5 s
  const rate = new Float64Array(n);
  for (let k = 0, a = 0, b = 0; k < n; k++) {
    while (P[a].t < P[k].t - 7.5) a++;
    while (b < n - 1 && P[b + 1].t <= P[k].t + 7.5) b++;
    rate[k] = b > a ? (uh[b] - uh[a]) / (P[b].t - P[a].t) : 0;
  }
  const circ = Array.from(rate, r => Math.abs(r) > 5 * D2R && Math.abs(r) < 45 * D2R);
  // segments
  const seg = [];
  for (let k = 0; k < n;) {
    if (!circ[k]) { k++; continue; }
    let e = k;
    while (e + 1 < n && (circ[e + 1] || (P[e + 1].t - P[e].t < 12 && nextCirc(circ, P, e + 1, 12)))) e++;
    seg.push([k, e]); k = e + 1;
  }
  const out = [];
  for (const [a, b] of seg) {
    const dur = P[b].t - P[a].t, turn = Math.abs(uh[b] - uh[a]);
    if (dur < 40 || turn < 3 * Math.PI) continue;
    // centres des tours successifs
    const centers = [];
    let s = a;
    for (let k = a + 1; k <= b; k++) if (Math.abs(uh[k] - uh[s]) >= 2 * Math.PI) {
      let la = 0, lo = 0, al = 0, m = 0;
      for (let q = s; q <= k; q++) { la += P[q].lat; lo += P[q].lon; al += P[q].alt; m++; }
      centers.push({ lat: la / m, lon: lo / m, alt: al / m, t: (P[s].t + P[k].t) / 2 });
      s = k;
    }
    if (!centers.length) continue;
    // altitudes lissées (bruit GPS)
    const altAt = k => { let x = 0, m = 0; for (let q = Math.max(a, k - 3); q <= Math.min(b, k + 3); q++) { x += P[q].alt; m++; } return x / m; };
    const base = altAt(a), top = altAt(b);
    // meilleure montée sur 30 s, altitudes lissées (sauts du GPS écartés)
    let best = -9;
    for (let k = a, q = a; k <= b; k++) {
      while (q < b && P[q].t < P[k].t + 30) q++;
      const dt = P[q].t - P[k].t;
      if (dt >= 25 && dt <= 40) { const v = (altAt(q) - altAt(k)) / dt; if (v < 12) best = Math.max(best, v); }
    }
    // « vario moyen » : ce qu'affiche l'intégrateur (moyenne sur 30 s) une fois centré : médiane des montées sur 30 s,
    // fenêtres glissantes tous les ~5 s, après le premier tour (centrage)
    const after = centers.length > 1 ? centers[0].t + 0.5 * (centers[1].t - centers[0].t) : P[a].t;
    const win = [];
    for (let k = a, q = a; k <= b; k += Math.max(1, Math.round(5 / Math.max(1, (P[b].t - P[a].t) / (b - a))))) {
      if (P[k].t < after) continue;
      while (q < b && P[q].t < P[k].t + 30) q++;
      const dt = P[q].t - P[k].t;
      if (dt >= 25 && dt <= 40) { const vv = (altAt(q) - altAt(k)) / dt; if (vv < 12) win.push(vv); }
    }
    win.sort((x, y) => x - y);
    const avg = win.length ? win[win.length >> 1] : (top - base) / dur;
    let v = 0, w = 0, m = 0;
    for (let k = a; k < b; k++) { v += gs[k]; w += Math.abs(rate[k]); m++; }
    v /= m; w /= m;
    const c0 = centers[0], c1 = centers[centers.length - 1], dtc = Math.max(1, c1.t - c0.t);
    out.push({
      t0: P[a].t, t1: P[b].t, dur, circles: turn / (2 * Math.PI), lat: c0.lat, lon: c0.lon, latTop: c1.lat, lonTop: c1.lon,
      base, top, gain: top - base, climb: (top - base) / dur, best, avg,
      radius: v / w, bank: Math.atan(v * w / 9.81) / D2R,
      drift: centers.length > 1 ? [east(c0, c1) / dtc, north(c0, c1) / dtc] : null,
      h: localHour(F.date, (P[a].t + P[b].t) / 2), a, b,
    });
  }
  return out;
}
function nextCirc(circ, P, k, gap) { for (let q = k; q < circ.length && P[q].t - P[k].t <= gap; q++) if (circ[q]) return true; return false; }

/** Distance (m) entre deux points géographiques. */
export function dist(a, b) { return Math.hypot(east(a, b), north(a, b)); }

/**
 * Comparaison avec la prévision. spotsAt(h) : pompes prévues à l'heure locale h (avec lat, lon, ex, ey, ea, eb, eang).
 * Pour chaque spirale avec du gain : pompe prévue la plus proche (et dans l'ellipse ?). Pour chaque pompe prévue survolée
 * en vol plané sous son plafond, sans spirale à moins de 1,2 km dans les 5 min : « passée sans spiraler ».
 */
export function compareFlight(F, th, spotsAt) {
  const rows = [];
  for (const T of th) {
    const S = spotsAt(Math.round(T.h));
    if (!S) { rows.push({ T, s: null }); continue; }
    let best = null, bd = 1e9;
    for (const s of S) { const d = dist(T, s); if (d < bd) { bd = d; best = s; } }
    let inside = false;
    if (best) {
      const c = { lat: best.lat + best.ey / 111320, lon: best.lon + best.ex / (111320 * Math.cos(best.lat * D2R)) };
      const X = east(c, T), Y = north(c, T), ca = Math.cos(best.eang), sa = Math.sin(best.eang);
      const u = X * ca + Y * sa, v = -X * sa + Y * ca;
      inside = (u / best.ea) ** 2 + (v / best.eb) ** 2 <= 1;
    }
    rows.push({ T, s: best, d: bd, inside });
  }
  // pompes survolées sans spiraler
  const P = F.fixes, passed = [], seen = new Set();
  for (let k = 0; k < P.length; k += 5) {
    const h = Math.round(localHour(F.date, P[k].t)), S = spotsAt(h);
    if (!S) continue;
    for (const s of S) {
      const key = h + ":" + s.i + ":" + s.j;
      if (seen.has(key) || s.prob < 0.25 || dist(P[k], s) > 400) continue;
      if (P[k].alt > s.ceil - 300 || P[k].alt < s.elev + 100) continue;
      seen.add(key);
      const used = th.some(T => Math.abs((T.t0 + T.t1) / 2 - P[k].t) < 300 && dist(T, s) < 1200);
      passed.push({ s, h, t: P[k].t, alt: P[k].alt, used });
    }
  }
  return { rows, passed };
}

/** Statistiques : Vz (spirales d'au moins 200 m de gain), plafonds, et taux d'utilisation des pompes survolées par fiabilité. */
export function flightStats(cmp) {
  const R = cmp.rows.filter(r => r.s && r.d < 2000 && r.T.gain >= 200);
  const n = R.length, mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const st = { n, all: cmp.rows.length };
  if (n) {
    const o = R.map(r => r.T.climb), m = R.map(r => r.s.vz), om = mean(o), mm = mean(m);
    st.bias = mean(m.map((x, k) => x - o[k]));
    st.rms = Math.sqrt(mean(m.map((x, k) => (x - o[k]) ** 2)));
    st.rmsConst = Math.sqrt(mean(o.map(x => (x - om) ** 2)));
    const cov = mean(o.map((x, k) => (x - om) * (m[k] - mm))), so = Math.sqrt(mean(o.map(x => (x - om) ** 2))), sm = Math.sqrt(mean(m.map(x => (x - mm) ** 2)));
    st.corr = so > 0 && sm > 0 ? cov / (so * sm) : 0;
    st.within1 = R.filter(r => r.d < 1000).length / n;
    st.inside = R.filter(r => r.inside).length / n;
    st.ceilBias = mean(R.map(r => r.s.ceil - r.T.top));
  }
  const bins = [[0.25, 0.5], [0.5, 0.75], [0.75, 1.01]].map(([lo, hi]) => {
    const p = cmp.passed.filter(x => x.s.prob >= lo && x.s.prob < hi);
    return { lo, hi, n: p.length, used: p.filter(x => x.used).length };
  });
  st.bins = bins;
  return st;
}
