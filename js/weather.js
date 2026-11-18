// Données météo : API publique Open-Meteo (prévisions et archives de prévisions), sans clé.
// On interroge un treillis de NG x NG points couvrant la zone ; tout le reste est calculé dans le navigateur.
// Les journées sèches passées du modèle par défaut sont stockées sur le site (data/meteo/) : chargement immédiat.

// Température sur tous les niveaux disponibles (les couvercles d'inversion sont fins) ; humidité et vent sur un niveau sur deux.
// L'altitude des niveaux est recalculée par l'équation hypsométrique : 59 variables, soit 6 « appels » Open-Meteo par point.
export const LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550, 500];
export const LEVELS_HW = [1000, 950, 900, 850, 800, 750, 700, 600, 500];
const SURFACE = ["temperature_2m", "dew_point_2m", "surface_pressure", "direct_normal_irradiance", "diffuse_radiation", "shortwave_radiation",
  "sensible_heat_flux", "soil_moisture_0_to_1cm", "snow_depth", "cloud_cover", "cloud_cover_low", "cape", "precipitation",
  "wind_speed_10m", "wind_direction_10m"];

// Treillis NG x NG (environ 19 x 22 km entre deux points) : 49 points x 59 variables ≈ 290 appels Open-Meteo par requête,
// sous la limite de 600 appels par minute pour deux requêtes rapprochées.
export const NG = 7;

// Modèles proposés : tous fournissent des profils verticaux (niveaux de pression), indispensables au calcul.
export const MODELS = [
  { id: "best_match", name: "Meilleur choix (Open-Meteo)", short: "Meilleur choix" },
  { id: "meteofrance_seamless", name: "AROME 2,5 km puis ARPEGE (Météo-France)", short: "AROME" },
  { id: "icon_seamless", name: "ICON-D2 2,2 km puis ICON-EU (DWD)", short: "ICON" },
  { id: "gfs_seamless", name: "GFS 13 km (NOAA)", short: "GFS" },
  { id: "ecmwf_ifs025", name: "IFS 25 km (ECMWF)", short: "ECMWF" },
  { id: "ukmo_seamless", name: "UKMO 2 à 10 km (Met Office)", short: "UKMO" },
];
export const DEFAULT_MODEL = "best_match";

export function variables() {
  const v = [...SURFACE];
  for (const p of LEVELS) v.push(`temperature_${p}hPa`);
  for (const p of LEVELS_HW) v.push(`dew_point_${p}hPa`, `wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
  return v;
}

export function samplePoints(meta) {
  const pts = [];
  for (let gy = 0; gy < NG; gy++) {
    for (let gx = 0; gx < NG; gx++) {
      const fx = (gx + 0.5) / NG, fy = (gy + 0.5) / NG;            // gy = 0 : nord
      pts.push({ gx, gy, lon: meta.west + fx * (meta.east - meta.west), lat: meta.north - fy * (meta.north - meta.south) });
    }
  }
  return pts;
}

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

const cache = new Map();
let archive = null;                        // index des journées stockées (data/meteo/index.json)

async function archiveIndex(base) {
  if (archive) return archive;
  try {
    const r = await fetch(base + "meteo/index.json", { cache: "no-cache" });
    archive = r.ok ? await r.json() : { days: [] };
  } catch (e) { archive = { days: [] }; }
  archive.set = new Map(archive.days.map(d => [d[0], d[1]]));
  return archive;
}

/** Journées stockées : treillis identique, heures archive.h0 à archive.h1, entiers 16 bits mis à l'échelle. */
async function fromArchive(base, meta, A, start, end) {
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const bufs = await Promise.all(days.map(d => fetch(`${base}meteo/${d.slice(0, 4)}/${d}.bin`).then(r => { if (!r.ok) throw new Error(d); return r.arrayBuffer(); })));
  const pts = samplePoints(meta), NP = pts.length, nh = A.h1 - A.h0 + 1;
  const time = [], offs = [];
  for (const d of days) for (let h = A.h0; h <= A.h1; h++) { time.push(`${d}T${String(h).padStart(2, "0")}:00`); offs.push(A.set.get(d)); }
  const v = pts.map(() => ({}));
  let elev = null;
  bufs.forEach((buf, di) => {
    const a = new Int16Array(buf);
    if (!elev) elev = Array.from(a.subarray(0, NP));
    let o = NP;
    A.vars.forEach((name, vi) => {
      const sc = A.scale[vi];
      for (let k = 0; k < NP; k++) {
        const arr = v[k][name] || (v[k][name] = new Array(days.length * nh));
        for (let h = 0; h < nh; h++, o++) arr[di * nh + h] = a[o] === -32768 ? null : a[o] * sc;
      }
    });
  });
  return { at: Date.now(), time, offs, utcOffset: offs[0], source: "archives stockées", model: A.model, pts: pts.map((p, k) => ({ ...p, elev: elev[k], v: v[k] })) };
}

/** Récupère les données horaires du start au end (dates locales AAAA-MM-JJ, incluses) pour un modèle. */
export async function fetchRange(meta, start, end, model = DEFAULT_MODEL, base = null, onWait = null) {
  const key = `${model}_${start}_${end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit;         // les prévisions sont rafraîchies au-delà de 30 min
  if (base && model === DEFAULT_MODEL) {
    const A = await archiveIndex(base);
    let all = A.days.length > 0 && A.ng === NG;
    for (let d = start; all && d <= end; d = addDays(d, 1)) all = A.set.has(d);
    if (all) {
      try { const W = await fromArchive(base, meta, A, start, end); cache.set(key, W); return W; } catch (e) { /* on passe par l'API */ }
    }
  }
  const pts = samplePoints(meta);
  const today = isoDate(new Date());
  // les archives de prévisions couvrent le passé ; l'API de prévision ne garde les variables de surface qu'environ 60 jours
  const old = end < addDays(today, -55);
  const host = old ? "https://historical-forecast-api.open-meteo.com/v1/forecast" : "https://api.open-meteo.com/v1/forecast";
  const q = new URLSearchParams({
    latitude: pts.map(p => p.lat.toFixed(4)).join(","),
    longitude: pts.map(p => p.lon.toFixed(4)).join(","),
    // « nan » : valeurs brutes de la maille du modèle, et son altitude réelle en retour
    elevation: pts.map(() => "nan").join(","),
    hourly: variables().join(","),
    models: model,
    timezone: "Europe/Paris",
    wind_speed_unit: "ms",
    start_date: start,
    end_date: end,
  });
  let res, err;
  for (let k = 0, minute = 0; k < 3; k++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45e3);   // une connexion bloquée ne doit pas tout figer
    try { res = await fetch(`${host}?${q}`, { signal: ctl.signal }); } catch (e) { err = e; res = null; }
    finally { clearTimeout(timer); }
    if (res && res.status === 429 && minute < 3) {
      // limite par minute d'Open-Meteo : on attend et on recommence (la limite par jour, elle, est définitive)
      const why = await res.clone().json().then(j => j.reason || "", () => "");
      if (/minute/i.test(why)) { minute++; k--; if (onWait) onWait(61); await new Promise(ok => setTimeout(ok, 61e3)); continue; }
    }
    if (res && (res.ok || res.status < 500)) break;
    await new Promise(ok => setTimeout(ok, 1500 * (k + 1)));
  }
  if (!res) throw new Error("service météo injoignable" + (err ? " (" + err.message + ")" : ""));
  if (!res.ok) {
    let msg = `erreur ${res.status}`;
    try { msg = (await res.json()).reason || msg; } catch (e) { /* réponse non JSON */ }
    throw new Error(msg);
  }
  let data = await res.json();
  if (!Array.isArray(data)) data = [data];
  const W = {
    at: Date.now(),
    time: data[0].hourly.time,                      // heures locales "AAAA-MM-JJTHH:00"
    utcOffset: data[0].utc_offset_seconds,
    source: old ? "archives de prévisions" : "prévisions",
    model,
    pts: pts.map((p, k) => ({ ...p, elev: data[k].elevation, v: data[k].hourly })),
  };
  cache.set(key, W);
  return W;
}

/** Indice horaire de "AAAA-MM-JJ" à l'heure locale h, ou -1. */
export function hourIndex(W, date, h) {
  return W.time.indexOf(`${date}T${String(h).padStart(2, "0")}:00`);
}

// Décalage de l'heure de Paris, heure d'été comprise (l'API ne donne que le décalage du jour où on l'interroge).
function lastSunday(y, m) { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); }
export function parisOffset(t) {
  const y = +t.slice(0, 4), u = Date.parse(t + ":00Z") - 7200e3;
  return u >= lastSunday(y, 2) + 3600e3 && u < lastSunday(y, 9) + 3600e3 ? 7200 : 3600;
}

export function utcMillis(W, idx) {
  return Date.parse(W.time[idx] + ":00Z") - parisOffset(W.time[idx]) * 1000;
}
