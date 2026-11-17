// Modèle de prévision des ascendances thermiques sur relief (exécuté dans un Web Worker).
//
// Pour chaque maille de 150 m et chaque heure :
//  1. éclairement de la pente : soleil direct x cosinus de l'incidence, ombres portées (balayage dans
//     l'axe du soleil), diffus pondéré par le facteur de vue du ciel
//  2. bilan d'énergie du sol -> flux de chaleur sensible H (nature du sol, humidité du sol, neige),
//     recalé sur le flux moyen du modèle météo
//  3. sommet de la convection : couche limite du modèle météo, redistribuée sur le relief fin ;
//     base des cumulus par le niveau de condensation
//  4. thermique : vitesse convective w* (Deardorff), profil vertical et rayon d'Allen (2006), noyau
//     renforcé là où les brises de pente convergent ; Vz = vitesse de l'air sur le cercle d'un planeur
//     à 45° et 90 km/h, moins sa chute en virage
//  5. pompes probables : maxima locaux de l'indice de déclenchement ; pour chacune, tirage aléatoire
//     (Monte-Carlo) des erreurs du modèle -> intervalle à 95 % de la Vz et du plafond, ellipse à 95 %
//     de la position, probabilité qu'elle soit exploitable
import { sunPosition } from "./sun.js";
import { LEVELS_T, LEVELS_TD, LEVELS_W, NG, utcMillis } from "./weather.js";

const NZ = 61, DZ = 100;                       // profils verticaux : 0 à 6000 m tous les 100 m
const KAPPA = 0.2857;
// nature du sol : 0 hors données, 1 lac, 2 forêt, 3 fond de vallée, 4 alpage, 5 rocher, 6 glacier
const ALBEDO = [0, 0.07, 0.13, 0.20, 0.20, 0.25, 0.55];
const BOWEN = [0, 0.05, 0.70, 0.80, 1.20, 5.00, 0];
const GFRAC = [0, 0.60, 0.08, 0.12, 0.12, 0.25, 0];

// Paramètres du thermique et du planeur. Les deux premiers seront recalés sur les observations.
export const PARAM = {
  amp: 0.25,                // renforcement du noyau par la convergence : x (1 + amp · indice)
  rad: 0.25,                // élargissement du thermique par la convergence : x (1 + rad · indice)
  bankDeg: 45, vKmh: 90,    // spirale du planeur
  polarA: 2.38e-5, polarB: 8.02,   // polaire d'un planeur de classe standard : chute = a V³ + b n²/V
  heights: [0.3, 0.5, 0.7], // hauteurs relatives dans la couche convective où l'on spirale
  vzMin: 0.5, gainMin: 300, // « exploitable » : Vz d'au moins 0,5 m/s et 300 m de gain possible
  // Recalage sur les relevés du 8/07/2026 (8 pompes, Bauges, Aravis, Grand Arc, Belledonne) :
  wFac: 2.0, rFac: 2.0,     // thermiques exploités = les plus forts et les plus larges, accrochés au relief
  reliefZ: [700, 1500],     // ces facteurs passent de 1 (vallées, collines) à leur valeur (montagne) entre ces altitudes
  topSlope: 1.1,            // part maximale du relief que suit le sommet de la couche convective
  ceilFrac: 0.85,           // plafond sans cumulus : fraction de la couche convective (avant : 0,95)
};
const V = PARAM.vKmh / 3.6, BANK = PARAM.bankDeg * Math.PI / 180;
export const R_TURN = V * V / (9.81 * Math.tan(BANK));                                 // 63,7 m
export const SINK = PARAM.polarA * V ** 3 + PARAM.polarB / Math.cos(BANK) ** 2 / V;     // 1,01 m/s

// Téléchargement avec reprises : certains antivirus coupent les connexions locales en cours de transfert.
async function get(url, kind = "arrayBuffer", tries = 5) {
  for (let k = 0; ; k++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("fichier manquant : " + url);
      return await r[kind]();
    } catch (e) {
      if (k >= tries - 1) throw new Error("téléchargement impossible : " + url);
      if (k > 0) await new Promise(ok => setTimeout(ok, 400 * k));
    }
  }
}

export async function loadTerrain(base) {
  const meta = await get(base + "meta.json", "json");
  const elev = new Int16Array(await get(base + "elev.i16"));
  const cover = new Uint8Array(await get(base + "cover.u8"));
  const svf8 = new Uint8Array(await get(base + "svf.u8"));
  const { nx, ny, dx } = meta, n = nx * ny;
  let zmin = 1e9;
  for (let p = 0; p < n; p++) if (cover[p] && elev[p] < zmin) zmin = elev[p];
  const E = new Float32Array(n), svf = new Float32Array(n);
  for (let p = 0; p < n; p++) { E[p] = cover[p] ? elev[p] : zmin; svf[p] = svf8[p] / 255; }
  // normale au terrain (est, nord, haut) x127
  const normal = new Int8Array(n * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = j * nx + i;
    const gx = (E[j * nx + Math.min(nx - 1, i + 1)] - E[j * nx + Math.max(0, i - 1)]) / (2 * dx);
    const gy = (E[Math.max(0, j - 1) * nx + i] - E[Math.min(ny - 1, j + 1) * nx + i]) / (2 * dx);   // vers le nord
    const m = Math.hypot(1, gx, gy);
    normal[p * 3] = Math.round(-gx / m * 127); normal[p * 3 + 1] = Math.round(-gy / m * 127); normal[p * 3 + 2] = Math.round(127 / m);
  }
  // relief légèrement lissé (~200 m) : direction de la montée et pente, pour les brises
  const Es = blur(E, nx, ny, 1, 3);
  const up = new Int8Array(n * 2), slope = new Uint8Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = j * nx + i;
    const gx = (Es[j * nx + Math.min(nx - 1, i + 1)] - Es[j * nx + Math.max(0, i - 1)]) / (2 * dx);
    const gy = (Es[Math.max(0, j - 1) * nx + i] - Es[Math.min(ny - 1, j + 1) * nx + i]) / (2 * dx);
    const s = Math.hypot(gx, gy);
    up[p * 2] = Math.round(gx / Math.max(s, 1e-4) * 127); up[p * 2 + 1] = Math.round(gy / Math.max(s, 1e-4) * 127);
    slope[p] = Math.min(255, Math.round(s * 100));
  }
  // poids d'interpolation vers le treillis météo
  const wi = new Uint8Array(n * 2), wf = new Float32Array(n * 2);
  for (let j = 0; j < ny; j++) {
    const fy = Math.min(NG - 1, Math.max(0, (j + 0.5) / ny * NG - 0.5)), y0 = Math.min(NG - 2, Math.floor(fy));
    for (let i = 0; i < nx; i++) {
      const fx = Math.min(NG - 1, Math.max(0, (i + 0.5) / nx * NG - 0.5)), x0 = Math.min(NG - 2, Math.floor(fx));
      const p = j * nx + i;
      wi[p * 2] = x0; wi[p * 2 + 1] = y0; wf[p * 2] = fx - x0; wf[p * 2 + 1] = fy - y0;
    }
  }
  // relief lissé sur ~2 km : celui que « voit » le modèle météo, et le niveau d'où part la convection
  const zs = blur(E, nx, ny, Math.round(1050 / dx), 2);
  // maille juste en contrebas (d'où vient la brise de pente)
  const below = new Int32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = j * nx + i;
    const bi = Math.min(nx - 1, Math.max(0, Math.round(i - up[p * 2] / 127 * 1.3)));
    const bj = Math.min(ny - 1, Math.max(0, Math.round(j + up[p * 2 + 1] / 127 * 1.3)));
    below[p] = bj * nx + bi;
  }
  return { meta, n, elev: E, cover, svf, normal, up, slope, wi, wf, zs, below };
}

export function cellLatLon(meta, i, j) {
  return [meta.north - (j + 0.5) / meta.ny * (meta.north - meta.south), meta.west + (i + 0.5) / meta.nx * (meta.east - meta.west)];
}

export function latLonCell(meta, lat, lon) {
  return [Math.floor((lon - meta.west) / (meta.east - meta.west) * meta.nx), Math.floor((meta.north - lat) / (meta.north - meta.south) * meta.ny)];
}

function pStd(z) { return 1013.25 * Math.pow(1 - 2.25577e-5 * z, 5.25588); }
function esat(T) { return 6.112 * Math.exp(17.67 * T / (T + 243.5)); }
function dewFromE(e) { const l = Math.log(Math.max(e, 0.01) / 6.112); return 243.5 * l / (17.67 - l); }

// flou en boîte séparable (rayon r mailles), répété « passes » fois
function blur(src, nx, ny, r, passes = 2) {
  let a = src;
  const b = new Float32Array(src.length);
  for (let it = 0; it < passes; it++) {
    for (let j = 0; j < ny; j++) {
      let s = 0; const o = j * nx;
      for (let i = -r; i <= r; i++) s += a[o + Math.min(nx - 1, Math.max(0, i))];
      for (let i = 0; i < nx; i++) {
        b[o + i] = s / (2 * r + 1);
        s += a[o + Math.min(nx - 1, i + r + 1)] - a[o + Math.max(0, i - r)];
      }
    }
    const c = new Float32Array(src.length);
    for (let i = 0; i < nx; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += b[Math.min(ny - 1, Math.max(0, j)) * nx + i];
      for (let j = 0; j < ny; j++) {
        c[j * nx + i] = s / (2 * r + 1);
        s += b[Math.min(ny - 1, j + r + 1) * nx + i] - b[Math.max(0, j - r) * nx + i];
      }
    }
    a = c;
  }
  return a;
}

function interpProfile(zs, vs) {
  const out = new Float32Array(NZ);
  if (zs.length < 2) { out.fill(vs.length ? vs[0] : NaN); return out; }
  let k = 0;
  for (let l = 0; l < NZ; l++) {
    const z = l * DZ;
    while (k < zs.length - 2 && zs[k + 1] < z) k++;
    const t = (z - zs[k]) / (zs[k + 1] - zs[k]);
    out[l] = vs[k] + (vs[k + 1] - vs[k]) * Math.min(1.5, Math.max(-0.5, t));
  }
  return out;
}

// régression sur l'altitude des mailles du modèle : valeur = b z + résidu local
function fitZ(z, y, bmin, bmax) {
  const K = z.length;
  let sz = 0, sy = 0, szz = 0, szy = 0;
  for (let k = 0; k < K; k++) { sz += z[k]; sy += y[k]; szz += z[k] * z[k]; szy += z[k] * y[k]; }
  let b = (K * szy - sz * sy) / Math.max(1e-6, K * szz - sz * sz);
  b = Math.min(bmax, Math.max(bmin, b));
  return { b, res: y.map((v, k) => v - b * z[k]) };
}

/** Grandeurs météo de l'heure aux points du treillis. */
function pointState(T, W, idx) {
  const K = W.pts.length;
  const S = { K, th: [], uu: [], vv: [], rr: [] };
  const f = name => W.pts.map(p => { const x = p.v[name] ? p.v[name][idx] : null; return x == null ? NaN : x; });
  S.dni = f("direct_normal_irradiance"); S.dif = f("diffuse_radiation"); S.ghi = f("shortwave_radiation");
  S.hApi = f("sensible_heat_flux").map(x => -x);                      // positif vers le haut
  S.soil = f("soil_moisture_0_to_1cm"); S.snow = f("snow_depth");
  S.cloud = f("cloud_cover"); S.cloudLow = f("cloud_cover_low"); S.cape = f("cape"); S.rain = f("precipitation").map(x => (x === x ? x : 0));
  S.blh = f("boundary_layer_height").map(x => (x === x ? x : 0));
  const t2 = f("temperature_2m"), td2 = f("dew_point_2m"), ps = f("surface_pressure"), ws = f("wind_speed_10m"), wd = f("wind_direction_10m");
  S.elev = W.pts.map(p => p.elev);                                    // altitude de la maille du modèle météo
  // Mailles « eau » : l'API les renvoie à l'altitude 0, pression et température ramenées au niveau de la mer.
  for (let k = 0; k < K; k++) {
    if (S.elev[k] > 50) continue;
    const [ci, cj] = latLonCell(T.meta, W.pts[k].lat, W.pts[k].lon);
    const z = T.elev[Math.min(T.meta.ny - 1, Math.max(0, cj)) * T.meta.nx + Math.min(T.meta.nx - 1, Math.max(0, ci))];
    ps[k] *= pStd(z) / pStd(S.elev[k]); t2[k] -= 0.0065 * (z - S.elev[k]); td2[k] -= 0.002 * (z - S.elev[k]);
    S.elev[k] = z;
  }
  S.pRatio = ps.map((p, k) => p / pStd(S.elev[k]));
  S.u10 = ws.map((s, k) => -s * Math.sin(wd[k] * Math.PI / 180)); S.v10 = ws.map((s, k) => -s * Math.cos(wd[k] * Math.PI / 180));
  const th2 = t2.map((t, k) => (t + 273.15) * Math.pow(1000 / ps[k], KAPPA));
  const r2 = td2.map((td, k) => 0.622 * esat(td) / (ps[k] - esat(td)));
  for (let k = 0; k < K; k++) {
    const v = W.pts[k].v;
    const lev = (name, p) => { const a = v[`${name}_${p}hPa`]; return a ? a[idx] : null; };
    const zs = [], ths = [];
    for (const p of LEVELS_T) {
      const Tt = lev("temperature", p), Z = lev("geopotential_height", p);
      if (Tt != null && Z != null) { zs.push(Z); ths.push((Tt + 273.15) * Math.pow(1000 / p, KAPPA)); }
    }
    S.th.push(interpProfile(zs, ths));
    const zw = [S.elev[k] + 10], us = [S.u10[k]], vs = [S.v10[k]];
    for (const p of LEVELS_W) {
      const sp = lev("wind_speed", p), di = lev("wind_direction", p), Z = lev("geopotential_height", p);
      if (sp != null && di != null && Z != null && Z > zw[zw.length - 1] + 50) { zw.push(Z); us.push(-sp * Math.sin(di * Math.PI / 180)); vs.push(-sp * Math.cos(di * Math.PI / 180)); }
    }
    S.uu.push(interpProfile(zw, us)); S.vv.push(interpProfile(zw, vs));
    const zr = [S.elev[k]], rs = [r2[k]];
    for (const p of LEVELS_TD) {
      const td = lev("dew_point", p), Z = lev("geopotential_height", p);
      if (td != null && Z != null && Z > zr[zr.length - 1] + 50) { zr.push(Z); rs.push(0.622 * esat(td) / (p - esat(td))); }
    }
    S.rr.push(interpProfile(zr, rs));
  }
  S.fTop = fitZ(S.elev, S.blh.map((h, k) => S.elev[k] + h), 0.0, PARAM.topSlope);     // sommet de la couche convective (m)
  S.fTh = fitZ(S.elev, th2, -0.002, 0.006);                                 // température potentielle à 2 m (K)
  S.fR = fitZ(S.elev, r2, -1e-5, 1e-5);                                     // rapport de mélange à 2 m
  // neige : au-dessus de la plus basse maille enneigée, et seulement dans les secteurs où il y en a
  S.snowAny = S.snow.map(s => (s > 0.03 ? 1 : 0));
  let snowLine = 9999;
  for (let k = 0; k < K; k++) if (S.snowAny[k]) snowLine = Math.min(snowLine, S.elev[k]);
  S.snowLine = snowLine;
  return S;
}

// Interpolation bilinéaire depuis le treillis météo
function lerp4(T, arr, p) {
  const x0 = T.wi[p * 2], y0 = T.wi[p * 2 + 1], fx = T.wf[p * 2], fy = T.wf[p * 2 + 1], k = y0 * NG + x0;
  return (arr[k] * (1 - fx) + arr[k + 1] * fx) * (1 - fy) + (arr[k + NG] * (1 - fx) + arr[k + NG + 1] * fx) * fy;
}
function prof4(T, profs, p, l) {
  const x0 = T.wi[p * 2], y0 = T.wi[p * 2 + 1], fx = T.wf[p * 2], fy = T.wf[p * 2 + 1], k = y0 * NG + x0;
  return (profs[k][l] * (1 - fx) + profs[k + 1][l] * fx) * (1 - fy) + (profs[k + NG][l] * (1 - fx) + profs[k + NG + 1][l] * fx) * fy;
}
/** Vent (est, nord) dans la couche convective au-dessus de la maille p. */
export function windAt(T, S, p) {
  const zb = Math.min(T.elev[p], T.zs[p]);
  const l = Math.min(NZ - 1, Math.max(0, Math.floor(zb / DZ) + 8));
  return [prof4(T, S.uu, p, l), prof4(T, S.vv, p, l)];
}

/** Ombres portées : part éclairée de chaque maille (0 à 1), par balayage dans l'axe du soleil. */
function shadows(T, sunEl, sunAz, out) {
  const { nx, ny, dx } = T.meta, E = T.elev;
  const tanEl = Math.tan(sunEl * Math.PI / 180), az = sunAz * Math.PI / 180;
  const di = -Math.sin(az), dj = Math.cos(az);           // sens des ombres, en mailles (i vers l'est, j vers le sud)
  const lit = (e, m) => Math.min(1, Math.max(0, (e - m + 10) / 30 + 0.5));
  if (Math.abs(di) >= Math.abs(dj)) {
    const t = dj / Math.abs(di), drop = dx * Math.hypot(1, t) * tanEl, step = di > 0 ? 1 : -1, i0 = di > 0 ? 0 : nx - 1;
    let M = new Float32Array(ny), M2 = new Float32Array(ny);
    for (let j = 0; j < ny; j++) { M[j] = E[j * nx + i0]; out[j * nx + i0] = 1; }
    for (let i = i0 + step; i >= 0 && i < nx; i += step) {
      for (let j = 0; j < ny; j++) {
        const y = j - t;
        let m = -1e9;
        if (y >= 0 && y <= ny - 1) { const y0 = Math.min(ny - 2, y | 0), f = y - y0; m = M[y0] * (1 - f) + M[y0 + 1] * f - drop; }
        const p = j * nx + i, e = E[p];
        out[p] = lit(e, m);
        M2[j] = e > m ? e : m;
      }
      const tmp = M; M = M2; M2 = tmp;
    }
  } else {
    const t = di / Math.abs(dj), drop = dx * Math.hypot(1, t) * tanEl, step = dj > 0 ? 1 : -1, j0 = dj > 0 ? 0 : ny - 1;
    let M = new Float32Array(nx), M2 = new Float32Array(nx);
    for (let i = 0; i < nx; i++) { M[i] = E[j0 * nx + i]; out[j0 * nx + i] = 1; }
    for (let j = j0 + step; j >= 0 && j < ny; j += step) {
      for (let i = 0; i < nx; i++) {
        const x = i - t;
        let m = -1e9;
        if (x >= 0 && x <= nx - 1) { const x0 = Math.min(nx - 2, x | 0), f = x - x0; m = M[x0] * (1 - f) + M[x0 + 1] * f - drop; }
        const p = j * nx + i, e = E[p];
        out[p] = lit(e, m);
        M2[i] = e > m ? e : m;
      }
      const tmp = M; M = M2; M2 = tmp;
    }
  }
}

/** Facteurs [cœur, rayon] des thermiques de montagne à l'altitude z. */
export function reliefGain(z) {
  const [z0, z1] = PARAM.reliefZ, g = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  return [1 + (PARAM.wFac - 1) * g, 1 + (PARAM.rFac - 1) * g];
}

/**
 * Vz au vario d'un planeur spiralant dans un thermique, moyennée sur les hauteurs PARAM.heights.
 * Profil d'Allen (2006) : vitesse moyenne w̄ = w*(z/zi)^(1/3)(1 - 1,1 z/zi), rayon r2 = 0,102 (z/zi)^(1/3)(1 - 0,25 z/zi) zi,
 * vitesse au cœur 3 w̄ (1 - q)/(1 - q³) avec q = r1/r2 ; profil radial gaussien de rayon 0,75 r2.
 * c : indice de convergence ; fa, fr : facteurs d'erreur sur le renforcement et le rayon ; fw : vent et pluie.
 * Retourne [Vz, vitesse de l'air sur le cercle, vitesse au cœur].
 */
export function thermal(wstar, zi, c, fa = 1, fr = 1, sink = SINK, fw = 1) {
  let vz = 0, air = 0, core = 0;
  for (const zr of PARAM.heights) {
    const s = Math.cbrt(zr);
    const wbar = wstar * s * (1 - 1.1 * zr);
    const r2 = Math.max(10, 0.102 * s * (1 - 0.25 * zr) * zi);
    const q = r2 > 600 ? 0.8 : 0.0011 * r2 + 0.14;
    const w0 = 3 * wbar * (1 - q) / (1 - q * q * q) * (1 + PARAM.amp * fa * c) * fw;
    const Rg = 0.75 * r2 * (1 + PARAM.rad * c) * fr;
    const w = w0 * Math.exp(-((R_TURN / Rg) ** 2));
    vz += w - sink; air += w; core += w0;
  }
  const k = PARAM.heights.length;
  return [vz / k, air / k, core / k];
}

// Générateur pseudo-aléatoire reproductible (mêmes tirages à chaque affichage)
function rng(seed) {
  let a = seed >>> 0, spare = null;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const r = Math.sqrt(-2 * Math.log(u() + 1e-12)), th = 2 * Math.PI * u();
    spare = r * Math.sin(th); return r * Math.cos(th);
  };
}

/**
 * Incertitudes d'une pompe par tirage aléatoire des erreurs du modèle (N tirages).
 * s : { z, zb, zi, H, c, cu, zl, wu, wv, fw, cov:[xx, xy, yy] (m²) }
 * Écarts types retenus : H ±25 %, épaisseur de couche ±15 %, renforcement ±35 %, rayon ±25 %,
 * force d'un thermique à l'autre ±15 %, chute du planeur ±0,1 m/s, vent ±30 % et ±0,8 m/s, direction ±20°,
 * base des cumulus ±250 m, point de déclenchement : étendue de la zone favorable + 400 m.
 * (Force, base et déclenchement élargis après comparaison aux relevés du 8/07/2026.)
 */
export function uncertainty(s, seed, N = 300) {
  const n = rng(seed);
  const vz = new Float32Array(N), ce = new Float32Array(N), air = new Float32Array(N), core = new Float32Array(N);
  const xs = new Float32Array(N), ys = new Float32Array(N);
  const l11 = Math.sqrt(Math.max(0, s.cov[0])), l21 = l11 > 0 ? s.cov[1] / l11 : 0, l22 = Math.sqrt(Math.max(0, s.cov[2] - l21 * l21));
  const U0 = Math.hypot(s.wu, s.wv), th0 = Math.atan2(s.wu, s.wv);
  let ok = 0;
  for (let k = 0; k < N; k++) {
    const fH = Math.exp(0.25 * n()), fZ = Math.exp(0.15 * n()), fa = Math.exp(0.35 * n()), fr = Math.exp(0.25 * n()), sink = SINK + 0.1 * n();
    const fs = Math.exp(0.15 * n());                     // d'un thermique à l'autre, le même jour (relevés du 8/07)
    const zi = s.zi * fZ, wst = Math.cbrt(9.81 / 300 * s.H * fH / 1105 * zi);
    const [kw, kr] = reliefGain(s.z);
    const [v, a, c0] = thermal(wst, zi, s.c, fa, fr * kr, sink, s.fw * fs * kw);
    const top = s.zb + zi;
    const ceil = Math.max(s.z, s.cu ? Math.min(s.zl + 250 * n(), top) : s.zb + PARAM.ceilFrac * zi);
    vz[k] = v; ce[k] = ceil; air[k] = a; core[k] = c0;
    if (v >= PARAM.vzMin && ceil - s.z >= PARAM.gainMin) ok++;
    // position du thermique à mi-hauteur de la bande exploitable
    const U = Math.max(0, U0 * Math.exp(0.3 * n()) + 0.8 * n()), th = th0 + 0.35 * n();
    const t = 0.5 * Math.max(0, ceil - s.z) / Math.max(0.7, a);
    const n1 = n(), n2 = n();
    xs[k] = l11 * n1 + 400 * n() + U * Math.sin(th) * t;
    ys[k] = l21 * n1 + l22 * n2 + 400 * n() + U * Math.cos(th) * t;
  }
  const q = (arr, f) => { const b = Array.from(arr).sort((x, y) => x - y); return b[Math.min(N - 1, Math.floor(f * N))]; };
  let mx = 0, my = 0;
  for (let k = 0; k < N; k++) { mx += xs[k]; my += ys[k]; }
  mx /= N; my /= N;
  let sxx = 0, sxy = 0, syy = 0;
  for (let k = 0; k < N; k++) { const a = xs[k] - mx, b = ys[k] - my; sxx += a * a; sxy += a * b; syy += b * b; }
  sxx /= N - 1; sxy /= N - 1; syy /= N - 1;
  const tr = (sxx + syy) / 2, dd = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  const CHI2 = 5.991;                                     // khi² à 2 degrés de liberté, 95 %
  const ceilMed = q(ce, 0.5), airMed = q(air, 0.5);
  const tTop = Math.max(0, ceilMed - s.z) / Math.max(0.7, airMed);
  return {
    vz: q(vz, 0.5), vzLo: q(vz, 0.025), vzHi: q(vz, 0.975), core: q(core, 0.5),
    ceil: ceilMed, ceilLo: q(ce, 0.025), ceilHi: q(ce, 0.975),
    pdev: ok / N,
    ex: mx, ey: my,                                       // centre de l'ellipse (m, est et nord, depuis le point de départ)
    ea: Math.sqrt(CHI2 * (tr + dd)), eb: Math.sqrt(CHI2 * Math.max(1, tr - dd)),
    eang: 0.5 * Math.atan2(2 * sxy, sxx - syy),           // angle du grand axe depuis l'est, sens trigonométrique
    tx: U0 * Math.sin(th0) * tTop, ty: U0 * Math.cos(th0) * tTop,   // dérive jusqu'au plafond
  };
}

/** Calcule tous les champs pour l'heure d'indice idx. */
export function computeHour(T, W, idx) {
  const { meta, n, elev, normal, cover, up, slope, svf, zs, below } = T;
  const { nx, ny, dx } = meta;
  const S = pointState(T, W, idx);
  const sun = sunPosition(utcMillis(W, idx) - 1800e3, meta.lat0, meta.lon0);      // milieu de l'heure écoulée
  const el = sun.el * Math.PI / 180, az = sun.az * Math.PI / 180;
  const sx = Math.cos(el) * Math.sin(az), sy = Math.cos(el) * Math.cos(az), sz = Math.sin(el);
  const day = sun.el > 1;
  const L4 = (arr, p) => lerp4(T, arr, p);

  // ---- 1 et 2 : éclairement de la pente et flux de chaleur sensible
  const H = new Float32Array(n);
  if (day) {
    const lit = new Float32Array(n);
    shadows(T, sun.el, sun.az, lit);
    for (let p = 0; p < n; p++) {
      const c = cover[p];
      if (c === 0 || c === 1 || c === 6) continue;          // hors données, lacs, glaciers (air plus chaud que la glace)
      const cosi = Math.max(0, (normal[p * 3] * sx + normal[p * 3 + 1] * sy + normal[p * 3 + 2] * sz) / 127);
      const dni = L4(S.dni, p), dif = L4(S.dif, p), ghi = L4(S.ghi, p);
      const snowy = elev[p] > S.snowLine && L4(S.snowAny, p) > 0.15;
      const alb = snowy ? 0.6 : ALBEDO[c];
      const sg = dni * cosi * lit[p] + dif * svf[p] + 0.2 * ghi * (1 - svf[p]);
      const rn = (1 - alb) * sg - (95 - 55 * L4(S.cloudLow, p) / 100);
      let bo = BOWEN[c];
      if (c !== 5) { const sm = L4(S.soil, p); if (sm === sm) bo *= 1.5 - 0.9 * Math.min(1, Math.max(0, (sm - 0.10) / 0.25)); }
      if (snowy) bo = 0.15;
      H[p] = Math.max(0, (1 - GFRAC[c]) * rn * bo / (1 + bo));
    }
    // recalage sur le flux de chaleur moyen du modèle météo
    const half = Math.round(nx / NG / 2);
    let mine = 0, api = 0, cnt = 0;
    for (let k = 0; k < S.K; k++) {
      if (!(S.hApi[k] === S.hApi[k])) continue;
      const ci = Math.round((W.pts[k].gx + 0.5) / NG * nx), cj = Math.round((W.pts[k].gy + 0.5) / NG * ny);
      let s = 0, m = 0;
      for (let j = Math.max(0, cj - half); j < Math.min(ny, cj + half); j += 4) for (let i = Math.max(0, ci - half); i < Math.min(nx, ci + half); i += 4) {
        const p = j * nx + i; if (cover[p]) { s += H[p]; m++; }
      }
      if (m < 20) continue;
      mine += s / m; api += Math.max(0, S.hApi[k]); cnt++;
    }
    if (cnt > 0 && mine / cnt > 15) {
      const k = Math.min(1.6, Math.max(0.4, api / mine));
      for (let p = 0; p < n; p++) H[p] *= k;
    }
  }
  const Hreg = blur(H, nx, ny, Math.round(450 / dx), 2);    // moyenne sur ~1 km : ce que « voit » un thermique

  // ---- convergence des brises de pente
  const ax = new Float32Array(n), ay = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const a = Math.min(1, Hreg[p] / 320) * Math.min(1, slope[p] / 35);
    ax[p] = a * up[p * 2] / 127; ay[p] = a * up[p * 2 + 1] / 127;
  }
  const conv = new Float32Array(n);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const p = j * nx + i;
    conv[p] = -((ax[p + 1] - ax[p - 1]) + (ay[p - nx] - ay[p + nx])) / 2;    // -div, par maille
  }
  const C = blur(conv, nx, ny, 2, 2);
  const C0 = 0.30 * dx / 120;                              // même seuil physique qu'à 120 m
  // chaleur collectée par la brise en remontant la pente (sur ~4 km, avec pertes)
  const src = new Float32Array(n);
  for (let p = 0; p < n; p++) src[p] = Hreg[p] * Math.min(1, slope[p] / 30);
  const decay = Math.pow(0.95, dx / 120), iters = Math.round(32 * 120 / dx), FEED0 = 4200 * 120 / dx;
  let acc = src.slice(), nxt = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let p = 0; p < n; p++) nxt[p] = src[p] + decay * acc[below[p]];
    const t = acc; acc = nxt; nxt = t;
  }
  const feed = blur(acc, nx, ny, 1, 1);

  // ---- 3 et 4 : sommet de la convection, condensation, Vz en spirale
  const top = new Uint16Array(n), ceil = new Uint16Array(n), cu = new Uint8Array(n), climb = new Float32Array(n), cidx = new Float32Array(n);
  const zlA = new Uint16Array(n), fwA = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const z = elev[p], zr = zs[p], zb = Math.min(z, zr);
    cidx[p] = Math.min(1, Math.max(0, C[p] / C0)) * Math.min(1.25, feed[p] / FEED0);
    top[p] = z; ceil[p] = z;
    if (!day || cover[p] === 0 || cover[p] === 1 || Hreg[p] < 25) continue;
    let zt = L4(S.fTop.res, p) + S.fTop.b * zr;
    if (zt < z + 120) zt = z + 120 * Math.min(1.5, Hreg[p] / 200);     // relief qui dépasse : petite couche locale
    const zi = zt - zb;
    top[p] = zt;
    if (zi < 250) continue;
    const excess = 0.4 + 1.6 * Math.min(1, Hreg[p] / 300);             // surchauffe de la couche de surface (K)
    const pz = pStd(zb) * L4(S.pRatio, p);
    const Tp = (L4(S.fTh.res, p) + S.fTh.b * zr + excess) * Math.pow(pz / 1000, KAPPA) - 273.15;
    const lmix = Math.min(NZ - 1, Math.floor(zb / DZ) + Math.max(1, Math.round(zi / DZ / 3)));
    const r = Math.max(2e-4, 0.6 * (L4(S.fR.res, p) + S.fR.b * zr) + 0.4 * prof4(T, S.rr, p, lmix));
    const zl = zb + 125 * Math.max(0, Tp - dewFromE(r * pz / (0.622 + r)));
    zlA[p] = zl;
    const isCu = zl < zt - 80;
    cu[p] = isCu ? 1 : 0;
    ceil[p] = Math.max(z, isCu ? zl : zb + PARAM.ceilFrac * zi);
    const [wu, wv] = windAt(T, S, p), wind = Math.hypot(wu, wv);
    let fw = 1;
    if (wind > 9) fw *= Math.max(0.6, 1 - (wind - 9) / 15);           // thermiques hachés par vent fort
    if (L4(S.rain, p) > 0.3) fw *= 0.35;                               // averses
    fwA[p] = fw;
    const wstar = Math.cbrt(9.81 / 300 * Hreg[p] / 1105 * zi);
    const [kw, kr] = reliefGain(z);
    climb[p] = Math.max(0, thermal(wstar, zi, cidx[p], 1, kr, SINK, fw * kw)[0]);
    if (ceil[p] < z + 150) climb[p] = 0;                               // rien d'exploitable sous 150 m de gain
  }

  // ---- 5 : pompes probables = maxima locaux de l'indice de déclenchement
  const score = new Float32Array(n);
  for (let p = 0; p < n; p++) score[p] = climb[p] * (0.30 + cidx[p]) * (0.6 + 0.4 * Math.min(1, feed[p] / FEED0));
  const sm = blur(score, nx, ny, 1, 1);
  const cand = [];
  const R = Math.round(500 / dx), B = 6;
  for (let j = B; j < ny - B; j++) for (let i = B; i < nx - B; i++) {
    const p = j * nx + i, v = sm[p];
    if (v < 0.30 || climb[p] < 0.4) continue;
    let isMax = true;
    for (let dj = -R; dj <= R && isMax; dj++) for (let di = -R; di <= R; di++) if (sm[p + dj * nx + di] > v) { isMax = false; break; }
    if (isMax) cand.push({ i, j, s: v });
  }
  cand.sort((a, b) => b.s - a.s);
  const spots = [];
  const minD = 1650 / dx;                                     // ~1,7 km entre deux pompes
  for (const c of cand) {
    if (spots.length >= 300) break;
    if (spots.some(s => Math.hypot(s.i - c.i, s.j - c.j) < minD)) continue;
    spots.push(c);
  }
  // incertitudes et probabilité de chaque pompe
  const out = spots.map(c => {
    const p = c.j * nx + c.i;
    // zone favorable autour du maximum : mailles à plus de 70 % du pic, rayon 1,2 km
    const rr = Math.round(1200 / dx), thr = 0.7 * c.s;
    let w = 0, mx = 0, my = 0, xx = 0, xy = 0, yy = 0, ring = 0, nr = 0;
    for (let dj = -2 * rr; dj <= 2 * rr; dj++) for (let di = -2 * rr; di <= 2 * rr; di++) {
      const i = c.i + di, j = c.j + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const d = Math.hypot(di, dj), v = sm[j * nx + i];
      if (d > rr && d <= 2 * rr) { ring += v; nr++; }
      if (d > rr || v < thr) continue;
      const wt = v - thr, X = di * dx, Y = -dj * dx;
      w += wt; mx += wt * X; my += wt * Y; xx += wt * X * X; xy += wt * X * Y; yy += wt * Y * Y;
    }
    mx /= w; my /= w;
    const cov = [xx / w - mx * mx, xy / w - mx * my, yy / w - my * my];
    const prom = Math.max(0, 1 - (nr ? ring / nr : 0) / c.s);         // la pompe ressort-elle de son voisinage ?
    const z = elev[p], zb = Math.min(z, zs[p]);
    const [wu, wv] = windAt(T, S, p);
    const u = uncertainty({ z, zb, zi: top[p] - zb, H: Hreg[p], c: cidx[p], cu: cu[p], zl: zlA[p], wu, wv, fw: fwA[p], cov }, p * 31 + idx);
    // le déclenchement est d'autant plus sûr que la convergence est forte et qu'elle ressort de son voisinage
    const psite = 0.25 + 0.65 * Math.min(1, cidx[p]) * (0.4 + 0.6 * prom);
    const prob = Math.min(0.95, Math.max(0.02, u.pdev * psite));
    return { i: c.i, j: c.j, score: c.s, elev: z, cu: cu[p], conv: cidx[p], h: Hreg[p], wu, wv, prob, psite, ...u };
  });

  // ---- statistiques de l'heure
  const best = out.slice(0, 12);
  const mean = (a, g) => (a.length ? a.reduce((s, x) => s + g(x), 0) / a.length : 0);
  const ceils = out.filter(s => s.prob >= 0.3).map(s => s.ceil).sort((a, b) => a - b);
  let hm = 0, nv = 0;
  for (let p = 0; p < n; p += 5) if (cover[p]) { hm += Hreg[p]; nv++; }
  const stats = {
    sunEl: sun.el, sunAz: sun.az,
    spotClimb: mean(best, x => x.vz), spotCeil: mean(best, x => x.ceil), cuFrac: mean(best, x => x.cu),
    nSpots: out.filter(s => s.prob >= 0.5).length, nAll: out.length,
    ceilLo: ceils.length ? ceils[Math.floor(ceils.length * 0.25)] : 0,
    ceilHi: ceils.length ? ceils[Math.floor(ceils.length * 0.9)] : 0,
    cape: Math.max(...S.cape.filter(x => x === x), 0),
    rain: Math.max(...S.rain, 0),
    cloud: S.cloud.reduce((s, x) => s + (x === x ? x : 0), 0) / S.K,
    wind10: Math.hypot(S.u10.reduce((s, x) => s + x, 0) / S.K, S.v10.reduce((s, x) => s + x, 0) / S.K),
    hMean: nv ? hm / nv : 0,
    snowLine: S.snowLine,
  };
  return { H: Hreg, top, ceil, cu, climb, conv: cidx, zl: zlA, fw: fwA, spots: out, stats, S };
}

/** Diagnostic en un point : profil de l'atmosphère, particule partant du sol, Vz et incertitudes. */
export function pointSounding(T, F, i, j) {
  const { meta, elev, zs } = T, S = F.S;
  const p = j * meta.nx + i;
  const pr = lerp4(T, S.pRatio, p);
  const rows = [];
  for (let l = 0; l < NZ; l++) {
    const z = l * DZ, pz = pStd(z) * pr;
    const th = prof4(T, S.th, p, l), r = prof4(T, S.rr, p, l);
    rows.push({ z, T: th * Math.pow(pz / 1000, KAPPA) - 273.15, Td: dewFromE(r * pz / (0.622 + r)), u: prof4(T, S.uu, p, l), v: prof4(T, S.vv, p, l) });
  }
  const z0 = elev[p], zb = Math.min(z0, zs[p]);
  const thP = lerp4(T, S.fTh.res, p) + S.fTh.b * zs[p] + 0.4 + 1.6 * Math.min(1, F.H[p] / 300);
  const parcel = [];
  for (let z = z0; z <= Math.max(z0 + 100, F.top[p]); z += 100) { const pz = pStd(z) * pr; parcel.push({ z, T: thP * Math.pow(pz / 1000, KAPPA) - 273.15 }); }
  const [wu, wv] = windAt(T, S, p);
  let u = null;
  if (F.climb[p] > 0) u = uncertainty({ z: z0, zb, zi: F.top[p] - zb, H: F.H[p], c: F.conv[p], cu: F.cu[p], zl: F.zl[p], wu, wv, fw: F.fw[p], cov: [0, 0, 0] }, p * 31 + 7);
  return { rows, parcel, z0, top: F.top[p], ceil: F.ceil[p], cu: F.cu[p], climb: F.climb[p], H: F.H[p], conv: F.conv[p], wu, wv, u };
}
