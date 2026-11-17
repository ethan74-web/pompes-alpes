// Données météo : API publique Open-Meteo (prévisions et archives de prévisions), sans clé.
// On interroge un treillis de 7 x 7 points couvrant la zone ; tout le reste est calculé dans le navigateur.

export const LEVELS_T = [1000, 950, 925, 900, 850, 800, 700, 600, 500];      // température + altitude
export const LEVELS_TD = [925, 850, 800, 700];                              // point de rosée
export const LEVELS_W = [925, 850, 800, 700, 600];                          // vent
const SURFACE = ["temperature_2m", "dew_point_2m", "surface_pressure", "direct_normal_irradiance", "diffuse_radiation", "shortwave_radiation",
  "sensible_heat_flux", "boundary_layer_height", "soil_moisture_0_to_1cm", "snow_depth", "cloud_cover", "cloud_cover_low", "cape", "precipitation",
  "wind_speed_10m", "wind_direction_10m"];

export const NG = 7;                       // treillis NG x NG (environ 16 km entre deux points)

export function variables() {
  const v = [...SURFACE];
  for (const p of LEVELS_T) v.push(`temperature_${p}hPa`, `geopotential_height_${p}hPa`);
  for (const p of LEVELS_TD) v.push(`dew_point_${p}hPa`);
  for (const p of LEVELS_W) v.push(`wind_speed_${p}hPa`, `wind_direction_${p}hPa`);
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

/** Récupère les données horaires du start au end (dates locales AAAA-MM-JJ, incluses). */
export async function fetchRange(meta, start, end) {
  const key = `${start}_${end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit;         // les prévisions sont rafraîchies au-delà de 30 min
  const pts = samplePoints(meta);
  const today = isoDate(new Date());
  // les archives de prévisions couvrent le passé ; l'API de prévision couvre environ J-90 à J+15
  const old = end < addDays(today, -80);
  const host = old ? "https://historical-forecast-api.open-meteo.com/v1/forecast" : "https://api.open-meteo.com/v1/forecast";
  const q = new URLSearchParams({
    latitude: pts.map(p => p.lat.toFixed(4)).join(","),
    longitude: pts.map(p => p.lon.toFixed(4)).join(","),
    // « nan » : valeurs brutes de la maille du modèle, et son altitude réelle en retour
    elevation: pts.map(() => "nan").join(","),
    hourly: variables().join(","),
    timezone: "Europe/Paris",
    wind_speed_unit: "ms",
    start_date: start,
    end_date: end,
  });
  let res, err;
  for (let k = 0; k < 3; k++) {
    try { res = await fetch(`${host}?${q}`); if (res.ok || res.status < 500) break; } catch (e) { err = e; }
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
    pts: pts.map((p, k) => ({ ...p, elev: data[k].elevation, v: data[k].hourly })),
  };
  cache.set(key, W);
  return W;
}

/** Indice horaire de "AAAA-MM-JJ" à l'heure locale h, ou -1. */
export function hourIndex(W, date, h) {
  return W.time.indexOf(`${date}T${String(h).padStart(2, "0")}:00`);
}

export function utcMillis(W, idx) {
  return Date.parse(W.time[idx] + ":00Z") - W.utcOffset * 1000;
}
