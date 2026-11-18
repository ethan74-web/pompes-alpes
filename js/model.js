// Modèle de prévision des ascendances thermiques sur relief (exécuté dans un Web Worker).
//
// Pour chaque maille de 150 m et chaque heure :
//  1. éclairement de la pente : soleil direct x cosinus de l'incidence, ombres portées (balayage dans
//     l'axe du soleil), diffus pondéré par le facteur de vue du ciel
//  2. bilan d'énergie du sol -> flux de chaleur sensible H (nature du sol, humidité du sol, neige),
//     recalé sur le flux moyen du modèle météo quand il le fournit
//  3. sommet des thermiques : particule partant du sol chauffé, comparée au profil du modèle météo en
//     température virtuelle (les couvercles d'inversion arrêtent les thermiques) ; base des cumulus
//  4. vent près du relief : vent du modèle ajusté au relief fin (méthode MicroMet), plus brises de pente ;
//     ces flux d'air ramassent la chaleur des pentes et la concentrent là où ils convergent
//  5. thermique : thermique moyen (Allen 2006, échelle w* de Deardorff), plus un panache concentré alimenté
//     par la chaleur collectée (Morton, Taylor et Turner) ; Vz = air sur le cercle d'un planeur à 45° et
//     90 km/h, moins sa chute en virage
//  6. pompes probables : maxima locaux de la Vz ; pour chacune, tirage aléatoire (Monte-Carlo) des erreurs
//     -> intervalle à 95 % de la Vz et du plafond, ellipse à 95 % de la position, probabilité
import { sunPosition } from "./sun.js";
import { LEVELS, NG, utcMillis } from "./weather.js";

const NZ = 61, DZ = 100;                       // profils verticaux : 0 à 6000 m tous les 100 m
const KAPPA = 0.2857;
const G_RCP = 9.81 / (300 * 1105);             // g / (θ ρ cp) : flux de chaleur (W) -> flux de flottabilité (m⁴/s³)
// nature du sol : 0 hors données, 1 lac, 2 forêt, 3 fond de vallée, 4 alpage, 5 rocher, 6 glacier
const ALBEDO = [0, 0.07, 0.13, 0.20, 0.20, 0.25, 0.55];
const BOWEN = [0, 0.05, 0.70, 0.80, 1.20, 5.00, 0];
const GFRAC = [0, 0.60, 0.08, 0.12, 0.12, 0.25, 0];
// voisins (D8) : est, nord-est, nord, nord-ouest, ouest, sud-ouest, sud, sud-est (j croît vers le sud)
const DI = [1, 1, 0, -1, -1, -1, 0, 1], DJ = [0, -1, -1, -1, 0, 1, 1, 1];

// Paramètres. Recalés sur le vol du 8/07/2026 (pompes choisies par le pilote) : voir theorie.html, section « Recalage ».
export const PARAM = {
  bankDeg: 45, vKmh: 90,    // spirale du planeur
  polarA: 2.38e-5, polarB: 8.02,   // polaire d'un planeur de classe standard : chute = a V³ + b n²/V
  heights: [0.3, 0.5, 0.7], // hauteurs relatives dans la couche convective où l'on spirale
  vzMin: 0.5, gainMin: 300, // « exploitable » : Vz d'au moins 0,5 m/s et 300 m de gain possible
  kField: 1.2,              // thermique moyen en montagne / thermique moyen en plaine (Allen)
  reliefZ: [700, 1500],     // kField passe de 1 à sa valeur entre ces altitudes
  kPlume: 1.3,              // panache : w = kPlume · B^(1/3) · z^(-1/3) (théorie MTT : 2,55 · rendement^(1/3))
  trigSd: 1000,             // écart type du point de déclenchement autour de la zone favorable (m) : 7 pompes sur 8 dans l'ellipse le 8/07
  z0Plume: 150,             // origine virtuelle du panache sous le sol (m)
  excess: [0.4, 1.6],       // surchauffe de la particule au départ : a + b · min(1, H/300) (K)
  ceilFrac: 0.93,           // plafond sans cumulus : fraction de la couche convective
  breeze: 3.0,              // brise de pente pleinement établie (m/s)
  ambient: 0.6,             // part du vent du modèle qui atteint les premières dizaines de mètres
  feedLen: 2500,            // distance sur laquelle la brise perd la moitié de sa chaleur (m, e-folding)
  feedMax: 3000,            // longueur maximale d'un trajet d'alimentation (m)
  entL: 2000,               // entraînement : la particule perd son excès de chaleur sur cette distance (m)
  q0: 2e9,                  // chaleur collectée de référence (W) pour l'indice d'alimentation
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
  // relief légèrement lissé (~200 m) : direction de la montée et pente, pour les brises et le vent
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
  // courbure du relief sur ~1 km (MicroMet), ramenée à [-0,5 ; 0,5]
  const eta = 7, curv = new Float32Array(n);
  const at = (i, j) => Es[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const z = Es[j * nx + i], d = eta * dx, d2 = d * Math.SQRT2;
    curv[j * nx + i] = ((z - (at(i - eta, j) + at(i + eta, j)) / 2) / (2 * d) + (z - (at(i, j - eta) + at(i, j + eta)) / 2) / (2 * d)
      + (z - (at(i - eta, j + eta) + at(i + eta, j - eta)) / 2) / (2 * d2) + (z - (at(i - eta, j - eta) + at(i + eta, j + eta)) / 2) / (2 * d2)) / 4;
  }
  const cmax = quantileAbs(curv, 0.99), smax = Math.atan(quantileAbs(slope, 0.99) / 100);
  for (let p = 0; p < n; p++) curv[p] = Math.max(-0.5, Math.min(0.5, curv[p] / (2 * cmax)));
  // pente ramenée à [0 ; 0,5] (MicroMet)
  const osS = new Float32Array(n);
  for (let p = 0; p < n; p++) osS[p] = Math.min(0.5, Math.atan(slope[p] / 100) / (2 * smax));
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
  return { meta, n, elev: E, cover, svf, normal, up, slope, curv, osS, smax, wi, wf, zs };
}

function quantileAbs(arr, f) {
  const step = Math.max(1, Math.floor(arr.length / 20000)), s = [];
  for (let p = 0; p < arr.length; p += step) s.push(Math.abs(arr[p]));
  s.sort((a, b) => a - b);
  return Math.max(1e-6, s[Math.floor(f * (s.length - 1))]);
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
  const S = { K, th: [], uu: [], vv: [], rr: [], thv: [] };
  const f = name => W.pts.map(p => { const x = p.v[name] ? p.v[name][idx] : null; return x == null ? NaN : x; });
  const fill = (a, b) => a.map((x, k) => (x === x ? x : b[k]));
  S.dni = f("direct_normal_irradiance"); S.dif = f("diffuse_radiation"); S.ghi = f("shortwave_radiation");
  S.hApi = f("sensible_heat_flux").map(x => -x);                      // positif vers le haut (absent de certains modèles)
  S.soil = f("soil_moisture_0_to_1cm"); S.snow = f("snow_depth");
  S.cloud = fill(f("cloud_cover"), S.dni.map(() => 0));
  S.cloudLow = fill(f("cloud_cover_low"), S.cloud);
  S.cape = f("cape"); S.rain = f("precipitation").map(x => (x === x ? x : 0));
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
  S.pRatio = ps.map((p, k) => (p === p ? p / pStd(S.elev[k]) : 1));
  S.u10 = ws.map((s, k) => -s * Math.sin(wd[k] * Math.PI / 180)); S.v10 = ws.map((s, k) => -s * Math.cos(wd[k] * Math.PI / 180));
  const psx = ps.map((p, k) => (p === p ? p : pStd(S.elev[k])));
  const th2 = t2.map((t, k) => (t + 273.15) * Math.pow(1000 / psx[k], KAPPA));
  const r2 = td2.map((td, k) => 0.622 * esat(td) / (psx[k] - esat(td)));
  for (let k = 0; k < K; k++) {
    const v = W.pts[k].v;
    const lev = (name, p) => { const a = v[`${name}_${p}hPa`]; return a && a[idx] != null ? a[idx] : null; };
    // température : tous les niveaux au-dessus du sol du modèle, plus le point à 2 m
    const zs = [S.elev[k] + 2], ths = [th2[k]];
    const zw = [S.elev[k] + 10], us = [S.u10[k]], vs = [S.v10[k]];
    const zr = [S.elev[k]], rs = [r2[k]];
    // altitude des niveaux : équation hypsométrique depuis la pression au sol, z2 - z1 = (Rd/g) T̄ ln(p1/p2)
    const Zof = {};
    let pPrev = psx[k], tPrev = t2[k] + 273.15, zPrev = S.elev[k];
    for (const p of LEVELS) {
      const Tt = lev("temperature", p);
      if (Tt == null || p >= pPrev) continue;
      const tk = Tt + 273.15;
      zPrev += 29.27 * (tPrev + tk) / 2 * Math.log(pPrev / p);
      Zof[p] = zPrev; pPrev = p; tPrev = tk;
    }
    for (const p of LEVELS) {
      const Z = lev("geopotential_height", p) ?? Zof[p];
      if (Z == null) continue;
      const Tt = lev("temperature", p);
      if (Tt != null && Z > zs[zs.length - 1] + 30) { zs.push(Z); ths.push((Tt + 273.15) * Math.pow(1000 / p, KAPPA)); }
      const sp = lev("wind_speed", p), di = lev("wind_direction", p);
      if (sp != null && di != null && Z > zw[zw.length - 1] + 30) { zw.push(Z); us.push(-sp * Math.sin(di * Math.PI / 180)); vs.push(-sp * Math.cos(di * Math.PI / 180)); }
      const td = lev("dew_point", p);
      if (td != null && Z > zr[zr.length - 1] + 30) { zr.push(Z); rs.push(0.622 * esat(td) / (p - esat(td))); }
    }
    const th = interpProfile(zs, ths), rr = interpProfile(zr, rs);
    // sous le sol du modèle : air de la couche de surface prolongé (vallées plus profondes que le relief du modèle)
    for (let l = 0; l < NZ && l * DZ < S.elev[k]; l++) { th[l] = th2[k]; rr[l] = r2[k]; }
    S.th.push(th); S.rr.push(rr); S.uu.push(interpProfile(zw, us)); S.vv.push(interpProfile(zw, vs));
    const thv = new Float32Array(NZ);
    for (let l = 0; l < NZ; l++) thv[l] = th[l] * (1 + 0.61 * Math.max(0, rr[l]));
    S.thv.push(thv);
  }
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
/** Vent (est, nord) dans la couche convective au-dessus de la maille p : celui qui fait dériver les thermiques. */
export function windAt(T, S, p) {
  const zb = Math.min(T.elev[p], T.zs[p]);
  const l = Math.min(NZ - 1, Math.max(0, Math.floor(zb / DZ) + 8));
  return [prof4(T, S.uu, p, l), prof4(T, S.vv, p, l)];
}

/**
 * Vent ajusté au relief fin (Liston et Elder 2006, MicroMet) : accéléré sur les pentes au vent et les bosses,
 * ralenti sous le vent et dans les creux, dévié le long des pentes. (u, v) vent du modèle vers l'est et le nord.
 */
function microMet(T, p, u, v) {
  const U = Math.hypot(u, v);
  if (U < 0.05) return [u, v];
  const wx = -u / U, wy = -v / U;                                       // direction d'où vient le vent
  const ax = -T.up[p * 2] / 127, ay = -T.up[p * 2 + 1] / 127;          // direction vers laquelle regarde la pente
  const c = wx * ax + wy * ay, sAF = wy * ax - wx * ay;                 // cos(pente - vent), sin(pente - vent)
  const os = T.osS[p] * c;                                              // > 0 : pente au vent
  const ww = Math.max(0.2, 1 + 0.5 * os + 0.5 * T.curv[p]);
  const th = -os * sAF * c;                                             // déviation (rad) : -0,5 Ωs sin 2(ξ - θ)
  const cs = 1 - th * th / 2;
  return [ww * (u * cs + v * th), ww * (-u * th + v * cs)];
}

/** Brise de pente montante (m/s) pour un flux H (W/m²) et une pente s (tangente). */
function breeze(H, s) {
  return PARAM.breeze * Math.cbrt(Math.min(1.3, Math.max(0, H) / 300)) * Math.sqrt(Math.min(1, s / 0.35));
}

/**
 * Flux d'air près du sol et chaleur qu'il collecte, sur une fenêtre [i0,i1[ x [j0,j1[ (ou toute la grille).
 * amb(p) -> [u, v] vent du modèle près du relief ; renvoie direction D8 de sortie (-1 : l'air monte ici),
 * vitesse (u, v) et chaleur accumulée (W) le long des trajets.
 */
function feedFlow(T, Hreg, amb, i0, i1, j0, j1) {
  const { nx, dx } = T.meta, w = i1 - i0, h = j1 - j0, m = w * h;
  const down = new Int32Array(m).fill(-1), fu = new Float32Array(m), fv = new Float32Array(m), src = new Float32Array(m);
  const loc = (i, j) => (j - j0) * w + (i - i0);
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const p = j * nx + i, q = loc(i, j);
    if (!T.cover[p]) continue;
    const s = T.slope[p] / 100, vb = breeze(Hreg[p], s);
    const [eu, ev] = amb(p);
    const u = vb * T.up[p * 2] / 127 + PARAM.ambient * eu, v = vb * T.up[p * 2 + 1] / 127 + PARAM.ambient * ev;
    fu[q] = u; fv[q] = v; src[q] = Math.max(0, Hreg[p]) * dx * dx;
    const au = Math.abs(u), av = Math.abs(v);
    if (au + av < 0.35) continue;
    const k = av < 0.4142 * au ? (u > 0 ? 0 : 4) : au < 0.4142 * av ? (v > 0 ? 2 : 6) : u > 0 ? (v > 0 ? 1 : 7) : (v > 0 ? 3 : 5);
    const ii = i + DI[k], jj = j + DJ[k];
    if (ii < i0 || jj < j0 || ii >= i1 || jj >= j1 || !T.cover[jj * nx + ii]) continue;
    down[q] = loc(ii, jj);
  }
  // deux mailles qui s'envoient l'air l'une à l'autre : l'air monte dans la plus haute (crête de convergence)
  for (let q = 0; q < m; q++) {
    const d = down[q];
    if (d >= 0 && down[d] === q) {
      const pq = (j0 + Math.floor(q / w)) * nx + i0 + (q % w), pd = (j0 + Math.floor(d / w)) * nx + i0 + (d % w);
      if (T.elev[pq] >= T.elev[pd]) down[q] = -1; else down[d] = -1;
    }
  }
  const decay = Math.exp(-dx / PARAM.feedLen), it = Math.round(PARAM.feedMax / dx);
  let acc = src.slice(), nxt = new Float32Array(m);
  for (let k = 0; k < it; k++) {
    nxt.set(src);
    for (let q = 0; q < m; q++) { const d = down[q]; if (d >= 0) nxt[d] += decay * acc[q]; }
    const t = acc; acc = nxt; nxt = t;
  }
  return { w, h, down, fu, fv, acc, src, decay, it };
}

/** Chaleur (W) relâchée en montée dans un rayon de 2 mailles (~300 m) : celle qui nourrit un panache. */
function plumeHeat(fl) {
  const { w, h, down, acc } = fl, sink = new Float32Array(w * h);
  for (let q = 0; q < w * h; q++) if (down[q] < 0) sink[q] = acc[q];
  // somme pondérée (noyau en cloche presque rond, ~300 m) : moyenne x 25 mailles
  const out = blur(sink, w, h, 1, 4);
  for (let q = 0; q < w * h; q++) out[q] *= 25;
  return out;
}

/** Facteur du thermique moyen à l'altitude z (1 en vallée, kField en montagne). */
export function reliefGain(z) {
  const z0 = PARAM.reliefZ[0], z1 = PARAM.reliefZ[1], g = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
  return 1 + (PARAM.kField - 1) * g;
}

/**
 * Vz au vario d'un planeur spiralant dans un thermique, moyennée sur les hauteurs PARAM.heights.
 * Thermique moyen d'Allen (2006) : w̄ = w*(z/zi)^(1/3)(1 - 1,1 z/zi), rayon r2 = 0,102 (z/zi)^(1/3)(1 - 0,25 z/zi) zi,
 * cœur 3 w̄ (1 - q)/(1 - q³), profil gaussien de rayon 0,75 r2, multipliés par kf.
 * Panache concentré (Morton, Taylor, Turner 1956) alimenté par le flux de flottabilité B (m⁴/s³) :
 * w = kPlume B^(1/3) z'^(-1/3) (1 - (z/zi)²), rayon 0,12 z', avec z' hauteur au-dessus de l'origine virtuelle.
 * fa, fr : facteurs d'erreur sur l'alimentation et le rayon ; fw : vent, pluie, variabilité.
 * Retourne [Vz, vitesse de l'air sur le cercle, vitesse au cœur].
 */
const HZ = PARAM.heights, HS = HZ.map(Math.cbrt);
export function thermal(wstar, zi, B, kf = 1, fa = 1, fr = 1, sink = SINK, fw = 1) {
  let vz = 0, air = 0, core = 0;
  const cb = B > 0 ? Math.cbrt(B * fa) : 0;
  for (let h = 0; h < HZ.length; h++) {
    const zr = HZ[h], s = HS[h];
    const wbar = wstar * s * (1 - 1.1 * zr);
    const r2 = Math.max(10, 0.102 * s * (1 - 0.25 * zr) * zi);
    const q = r2 > 600 ? 0.8 : 0.0011 * r2 + 0.14;
    const wA = 3 * wbar * (1 - q) / (1 - q * q * q) * kf, RA = 0.75 * r2 * kf * fr;
    const zp = zr * zi + PARAM.z0Plume;
    const wP = cb > 0 ? PARAM.kPlume * cb / Math.cbrt(zp) * (1 - zr * zr) : 0, RP = Math.max(25, 0.12 * zp) * fr;
    const w = (wA * Math.exp(-(R_TURN * R_TURN) / (RA * RA)) + (wP > 0 ? wP * Math.exp(-(R_TURN * R_TURN) / (RP * RP)) : 0)) * fw;
    vz += w - sink; air += w; core += (wA + wP) * fw;
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
 * s : { z, zb, zi, H, B, kf, cu, zl, wu, wv, fw, cov:[xx, xy, yy] (m²) }
 * Écarts types : H ±25 %, épaisseur de couche ±15 %, alimentation du panache ±35 %, rayon ±25 %,
 * force d'un thermique à l'autre ±15 %, chute du planeur ±0,1 m/s, vent ±30 % et ±0,8 m/s, direction ±20°,
 * base des cumulus ±250 m, point de déclenchement : étendue de la zone favorable + PARAM.trigSd.
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
    const fs = Math.exp(0.15 * n());
    const zi = s.zi * fZ, wst = Math.cbrt(9.81 / 300 * s.H * fH / 1105 * zi);
    const [v, a, c0] = thermal(wst, zi, s.B * fH, s.kf, fa, fr, sink, s.fw * fs);
    const top = s.zb + zi;
    const ceil = Math.max(s.z, s.cu ? Math.min(s.zl + 250 * n(), top) : s.zb + PARAM.ceilFrac * zi);
    vz[k] = v; ce[k] = ceil; air[k] = a; core[k] = c0;
    if (v >= PARAM.vzMin && ceil - s.z >= PARAM.gainMin) ok++;
    // position du thermique à mi-hauteur de la bande exploitable
    const U = Math.max(0, U0 * Math.exp(0.3 * n()) + 0.8 * n()), th = th0 + 0.35 * n();
    const t = 0.5 * Math.max(0, ceil - s.z) / Math.max(0.7, a);
    const n1 = n(), n2 = n();
    xs[k] = l11 * n1 + PARAM.trigSd * n() + U * Math.sin(th) * t;
    ys[k] = l21 * n1 + l22 * n2 + PARAM.trigSd * n() + U * Math.cos(th) * t;
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

/**
 * Particule partant de zb (θ, r au départ), qui se mélange à l'air ambiant en montant (entraînement sur PARAM.entL) :
 * sommet où elle n'est plus plus légère que l'air, en température virtuelle.
 */
function parcelTop(T, S, p, zb, thP, rP) {
  let thvP = thP * (1 + 0.61 * rP);
  const e = Math.min(1, DZ / PARAM.entL);
  const l0 = Math.min(NZ - 2, Math.max(0, Math.ceil(zb / DZ)));
  let prev = thvP - prof4(T, S.thv, p, l0);
  for (let l = l0 + 1; l < NZ; l++) {
    const env = prof4(T, S.thv, p, l);
    thvP -= e * (thvP - env);
    const d = thvP - env;
    if (d < 0) return (l - 1) * DZ + DZ * prev / Math.max(1e-6, prev - d);
    prev = d;
  }
  return (NZ - 1) * DZ;
}

/** Calcule tous les champs pour l'heure d'indice idx. */
export function computeHour(T, W, idx) {
  const { meta, n, elev, normal, cover, slope, svf, zs } = T;
  const { nx, ny, dx } = meta;
  const S = pointState(T, W, idx);
  const sun = sunPosition(utcMillis(W, idx) - 1800e3, meta.lat0, meta.lon0);      // milieu de l'heure écoulée
  const el = sun.el * Math.PI / 180, az = sun.az * Math.PI / 180;
  const sx = Math.cos(el) * Math.sin(az), sy = Math.cos(el) * Math.cos(az), sz = Math.sin(el);
  const day = sun.el > 1;
  const L4 = (arr, p) => lerp4(T, arr, p);
  const ms = {}, t0 = performance.now(); let tl = t0;
  const lap = k => { const t = performance.now(); ms[k] = Math.round(t - tl); tl = t; };

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
      const h = (1 - GFRAC[c]) * rn * bo / (1 + bo);
      H[p] = h > 0 ? h : 0;
    }
    // recalage sur le flux de chaleur moyen du modèle météo, quand il le fournit
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
  lap("chaleur");

  // ---- 4 : vent près du relief, brises, chaleur collectée
  const ua = new Float32Array(n), va = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (!cover[p]) continue;
    const l = Math.min(NZ - 1, Math.max(0, Math.round((elev[p] + 200) / DZ)));
    const [u, v] = microMet(T, p, prof4(T, S.uu, p, l), prof4(T, S.vv, p, l));
    ua[p] = u; va[p] = v;
  }
  lap("vent");
  const fl = feedFlow(T, Hreg, p => [ua[p], va[p]], 0, nx, 0, ny);
  lap("flux");
  const Q = plumeHeat(fl);
  const cidx = new Float32Array(n);
  for (let p = 0; p < n; p++) cidx[p] = Math.min(1.5, Q[p] / PARAM.q0);

  // ---- 3 et 5 : sommet des thermiques, condensation, Vz en spirale
  const top = new Uint16Array(n), ceil = new Uint16Array(n), cu = new Uint8Array(n), climb = new Float32Array(n);
  const zlA = new Uint16Array(n), fwA = new Float32Array(n);
  // sommet de la particule sur une grille de 450 m (il varie lentement), interpolé ensuite
  const CS = 3, ncx = Math.ceil(nx / CS) + 1, ncy = Math.ceil(ny / CS) + 1, topC = new Float32Array(ncx * ncy);
  if (day) for (let cj = 0; cj < ncy; cj++) for (let ci = 0; ci < ncx; ci++) {
    const p = Math.min(ny - 1, cj * CS) * nx + Math.min(nx - 1, ci * CS), zr = zs[p];
    const excess = PARAM.excess[0] + PARAM.excess[1] * Math.min(1, Hreg[p] / 300);   // surchauffe de la couche de surface (K)
    topC[cj * ncx + ci] = parcelTop(T, S, p, zr, L4(S.fTh.res, p) + S.fTh.b * zr + excess, Math.max(2e-4, L4(S.fR.res, p) + S.fR.b * zr));
  }
  lap("sommet");
  for (let p = 0; p < n; p++) {
    const z = elev[p], zr = zs[p], zb = Math.min(z, zr);
    top[p] = z; ceil[p] = z;
    if (!day || cover[p] === 0 || cover[p] === 1 || Hreg[p] < 25) continue;
    const excess = PARAM.excess[0] + PARAM.excess[1] * Math.min(1, Hreg[p] / 300);
    const thP = L4(S.fTh.res, p) + S.fTh.b * zr + excess;
    const rP = Math.max(2e-4, L4(S.fR.res, p) + S.fR.b * zr);
    const i = p % nx, j = (p - i) / nx, fx = i / CS, fy = j / CS, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, k0 = y0 * ncx + x0;
    let zt = (topC[k0] * (1 - ax) + topC[k0 + 1] * ax) * (1 - ay) + (topC[k0 + ncx] * (1 - ax) + topC[k0 + ncx + 1] * ax) * ay;
    if (zt < z + 120) zt = z + 120 * Math.min(1.5, Hreg[p] / 200);     // relief qui dépasse : petite couche locale
    const zi = zt - zb;
    top[p] = zt;
    if (zi < 250) continue;
    const pz = pStd(zb) * L4(S.pRatio, p);
    const Tp = thP * Math.pow(pz / 1000, KAPPA) - 273.15;
    const lmix = Math.min(NZ - 1, Math.floor(zb / DZ) + Math.max(1, Math.round(zi / DZ / 3)));
    const r = Math.max(2e-4, 0.6 * rP + 0.4 * prof4(T, S.rr, p, lmix));
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
    climb[p] = Math.max(0, thermal(wstar, zi, G_RCP * Q[p], reliefGain(z), 1, 1, SINK, fw)[0]);
    if (ceil[p] < z + 150) climb[p] = 0;                               // rien d'exploitable sous 150 m de gain
  }
  lap("thermiques");

  // ---- 6 : pompes probables = maxima locaux de la Vz, d'autant plus sûrs que l'alimentation est forte
  const score = new Float32Array(n);
  for (let p = 0; p < n; p++) score[p] = climb[p] * (0.7 + 0.3 * Math.min(1, cidx[p]));
  const sm = blur(score, nx, ny, 1, 1);
  const cand = [];
  const R = Math.round(500 / dx), Bd = 6;
  for (let j = Bd; j < ny - Bd; j++) for (let i = Bd; i < nx - Bd; i++) {
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
    const u = uncertainty({ z, zb, zi: top[p] - zb, H: Hreg[p], B: G_RCP * Q[p], kf: reliefGain(z), cu: cu[p], zl: zlA[p], wu, wv, fw: fwA[p], cov }, p * 31 + idx);
    // le déclenchement est d'autant plus sûr que l'alimentation est forte et que la pompe ressort de son voisinage
    const psite = 0.2 + 0.7 * Math.min(1, cidx[p]) * (0.3 + 0.7 * prom);
    const prob = Math.min(0.95, Math.max(0.02, u.pdev * psite));
    return { i: c.i, j: c.j, score: c.s, elev: z, cu: cu[p], conv: cidx[p], h: Hreg[p], wu, wv, prob, psite, ...u };
  });

  lap("pompes");
  // ---- statistiques de l'heure
  const best = out.slice().sort((a, b) => b.vz - a.vz).slice(0, 12);
  const mean = (a, g) => (a.length ? a.reduce((s, x) => s + g(x), 0) / a.length : 0);
  const ceils = out.filter(s => s.prob >= 0.3).map(s => s.ceil).sort((a, b) => a - b);
  let hm = 0, nv = 0;
  for (let p = 0; p < n; p += 5) if (cover[p]) { hm += Hreg[p]; nv++; }
  // vent vers 1 500 m au-dessus de Challes : le sud annoncé donne souvent de l'est sur la piste
  const [ci, cj] = latLonCell(meta, 45.561, 5.976), pc = Math.max(0, Math.min(ny - 1, cj)) * nx + Math.max(0, Math.min(nx - 1, ci));
  const cu15 = prof4(T, S.uu, pc, 15), cv15 = prof4(T, S.vv, pc, 15);
  const stats = {
    sunEl: sun.el, sunAz: sun.az,
    spotClimb: mean(best, x => x.vz), spotCeil: mean(best, x => x.ceil), cuFrac: mean(best, x => x.cu),
    nSpots: out.filter(s => s.prob >= 0.5).length, nAll: out.length,
    ceilLo: ceils.length ? ceils[Math.floor(ceils.length * 0.25)] : 0,
    ceilHi: ceils.length ? ceils[Math.floor(ceils.length * 0.9)] : 0,
    ceilMed: ceils.length ? ceils[Math.floor(ceils.length * 0.5)] : 0,
    cape: Math.max(...S.cape.filter(x => x === x), 0),
    rain: Math.max(...S.rain, 0),
    cloud: S.cloud.reduce((s, x) => s + (x === x ? x : 0), 0) / S.K,
    wind10: Math.hypot(S.u10.reduce((s, x) => s + (x === x ? x : 0), 0) / S.K, S.v10.reduce((s, x) => s + (x === x ? x : 0), 0) / S.K),
    wind25: meanWind(S, 25), challes: [cu15, cv15],
    hMean: nv ? hm / nv : 0,
    snowLine: S.snowLine, ms,
  };
  return { H: Hreg, top, ceil, cu, climb, conv: cidx, Q, zl: zlA, fw: fwA, ua, va, flow: fl, spots: out, stats, S };
}

function meanWind(S, l) {
  let u = 0, v = 0;
  for (let k = 0; k < S.K; k++) { u += S.uu[k][l]; v += S.vv[k][l]; }
  return [u / S.K, v / S.K];
}

/**
 * Alimentation d'une pompe (i, j) : d'où vient l'air qui la nourrit, et ce que devient la pompe selon le vent.
 * Renvoie une fenêtre de contributions, quelques trajets d'air, et la Vz attendue pour 16 directions x 5 forces de vent.
 */
export function feedAnalysis(T, F, i, j) {
  const { nx, ny, dx } = T.meta, S = F.S, p0 = j * nx + i;
  const RW = Math.round(9000 / dx);
  const i0 = Math.max(0, i - RW), i1 = Math.min(nx, i + RW + 1), j0 = Math.max(0, j - RW), j1 = Math.min(ny, j + RW + 1);
  const w = i1 - i0, h = j1 - j0;
  const fl = feedFlow(T, F.H, p => [F.ua[p], F.va[p]], i0, i1, j0, j1);
  // contributions : pour chaque maille, son trajet atteint-il la pompe (à moins de 300 m) ?
  const near = q => { const qi = i0 + (q % w), qj = j0 + Math.floor(q / w); return Math.hypot(qi - i, qj - j) <= 2.01; };
  const contrib = new Float32Array(w * h), steps = new Int16Array(w * h).fill(-1);
  for (let q = 0; q < w * h; q++) {
    if (fl.src[q] <= 0) continue;
    let c = q, k = 0;
    while (k <= fl.it && c >= 0 && !near(c)) { c = fl.down[c]; k++; }
    if (c >= 0 && k <= fl.it) { contrib[q] = fl.src[q] * Math.pow(fl.decay, k); steps[q] = k; }
  }
  let total = 0, cmax = 0;
  for (let q = 0; q < w * h; q++) { total += contrib[q]; cmax = Math.max(cmax, contrib[q]); }
  // trajets : départs les plus lointains et les plus contributifs, espacés d'au moins 600 m
  const starts = [];
  const order = [];
  for (let q = 0; q < w * h; q++) if (steps[q] >= 6) order.push(q);
  order.sort((a, b) => contrib[b] * steps[b] - contrib[a] * steps[a]);
  for (const q of order) {
    if (starts.length >= 14) break;
    const qi = q % w, qj = Math.floor(q / w);
    if (starts.some(s => Math.hypot(s % w - qi, Math.floor(s / w) - qj) < 4)) continue;
    starts.push(q);
  }
  const paths = starts.map(q => { const pts = []; let c = q, k = 0; while (c >= 0 && k <= fl.it + 1) { pts.push(i0 + (c % w), j0 + Math.floor(c / w)); if (near(c)) break; c = fl.down[c]; k++; } return pts; });
  // rose des vents : vent uniforme imposé dans la fenêtre (direction d'où il vient, force en km/h)
  const z = T.elev[p0], zb = Math.min(z, T.zs[p0]), zi = Math.max(250, F.top[p0] - zb);
  const wstar = Math.cbrt(9.81 / 300 * F.H[p0] / 1105 * zi), kf = reliefGain(z);
  const speeds = [0, 10, 20, 30, 40], dirs = 16, rose = [];
  const vzAt = (Qmax, U) => {
    let fw = F.fw[p0] || 1;
    if (U > 9) fw *= Math.max(0.6, 1 - (U - 9) / 15);
    return thermal(wstar, zi, G_RCP * Qmax, kf, 1, 1, SINK, fw)[0];
  };
  const best = fx => { const Qw = plumeHeat(fx); let m = 0; for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) { if (di * di + dj * dj > 16) continue; const qi = i - i0 + di, qj = j - j0 + dj; if (qi >= 0 && qj >= 0 && qi < w && qj < h) m = Math.max(m, Qw[qj * w + qi]); } return m; };
  for (let d = 0; d < dirs; d++) {
    const row = [];
    const from = d * 2 * Math.PI / dirs;
    for (const kmh of speeds) {
      const U = kmh / 3.6, u = -U * Math.sin(from), v = -U * Math.cos(from);
      const fx = feedFlow(T, F.H, p => microMet(T, p, u, v), i0, i1, j0, j1);
      row.push(vzAt(best(fx), U));
    }
    rose.push(row);
  }
  const amb = microMet(T, p0, ...(() => { const l = Math.min(NZ - 1, Math.round((z + 200) / DZ)); return [prof4(T, S.uu, p0, l), prof4(T, S.vv, p0, l)]; })());
  const raster = new Uint8Array(w * h);
  for (let q = 0; q < w * h; q++) raster[q] = cmax > 0 ? Math.round(255 * Math.sqrt(contrib[q] / cmax)) : 0;
  return { i0, j0, w, h, raster, paths, total, rose, speeds, dirs, ambient: amb, vzNow: vzAt(best(fl), Math.hypot(...amb)) };
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
  const thP = lerp4(T, S.fTh.res, p) + S.fTh.b * zs[p] + PARAM.excess[0] + PARAM.excess[1] * Math.min(1, F.H[p] / 300);
  const parcel = [];
  for (let z = z0; z <= Math.max(z0 + 100, F.top[p]); z += 100) { const pz = pStd(z) * pr; parcel.push({ z, T: thP * Math.pow(pz / 1000, KAPPA) - 273.15 }); }
  const [wu, wv] = windAt(T, S, p);
  let u = null;
  if (F.climb[p] > 0) u = uncertainty({ z: z0, zb, zi: F.top[p] - zb, H: F.H[p], B: G_RCP * F.Q[p], kf: reliefGain(z0), cu: F.cu[p], zl: F.zl[p], wu, wv, fw: F.fw[p], cov: [0, 0, 0] }, p * 31 + 7);
  return { rows, parcel, z0, top: F.top[p], ceil: F.ceil[p], cu: F.cu[p], climb: F.climb[p], H: F.H[p], conv: F.conv[p], Q: F.Q[p],
    wu, wv, su: F.flow.fu[p], sv: F.flow.fv[p], u };
}
