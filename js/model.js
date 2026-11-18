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
// nature du sol (ESA WorldCover 2021, type dominant par maille de 150 m) :
// 0 hors données, 1 lac, 2 forêt, 3 fond de vallée et cultures, 4 alpage et landes, 5 rocher et éboulis, 6 glacier, 7 bâti
const ALBEDO = [0, 0.07, 0.13, 0.20, 0.20, 0.25, 0.55, 0.15];
const BOWEN = [0, 0.05, 0.70, 0.80, 1.20, 5.00, 0, 3.0];
const GFRAC = [0, 0.60, 0.08, 0.12, 0.12, 0.25, 0, 0.30];
// mémoire de chaleur l'après-midi (part de la baisse horaire compensée) : la roche et le bâti stockent et restituent le plus
const MEM = [0, 0, 0.25, 0.3, 0.35, 0.55, 0, 0.5];
// voisins (D8) : est, nord-est, nord, nord-ouest, ouest, sud-ouest, sud, sud-est (j croît vers le sud)
const DI = [1, 1, 0, -1, -1, -1, 0, 1], DJ = [0, -1, -1, -1, 0, 1, 1, 1];

// Paramètres. Recalés sur le vol du 8/07/2026 (pompes choisies par le pilote) : voir theorie.html, section « Recalage ».
export const PARAM = {
  bankDeg: 45, vKmh: 90,    // spirale du planeur
  polarA: 2.38e-5, polarB: 8.02,   // polaire d'un planeur de classe standard : chute = a V³ + b n²/V
  vMinKmh: 72,              // vitesse de spirale de base (km/h) d'un classe standard sans ballast ; V = vMin √n
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
  maxSpots: 800,          // pompes retenues au plus (les plus fortes), sur toute la zone
  memory: 1,                // échelle de la mémoire de chaleur de l'après-midi (0 : sans)
  lagMin: 30,             // retard (min) entre la position du soleil et le flux de chaleur
  shelterDeg: [2, 14],      // abri : vent plein si le relief au vent est vu sous moins de 2°, réduit au minimum au-delà de 14°
  shelterMin: 0.1,          // part du vent qui atteint encore un versant abrité (décollement sous la crête)
  entL: 2000,               // entraînement : la particule perd son excès de chaleur sur cette distance (m)
  q0: 2e9,                  // chaleur collectée de référence (W) pour l'indice d'alimentation
  minSpacing: 1000,         // distance minimale entre deux pompes (m) ; plus près, elles se partagent l'air
  lidR: 6000,               // couvercle de vallée : rayon (m) sur lequel on mesure le fond de vallée et les crêtes
  lidDth: 5,            // force du couvercle de vallée (K) : excès de chaleur qu'un thermique de fond de vallée doit avoir pour le percer
  lidThick: 300,            // épaisseur de la couche stable au sommet de l'air de vallée (m)
  trigCurv: [0.1, 0.4],     // déclenchement : un sommet bombé (courbure) déclenche plus sûrement
  trigW: 0.6,               // poids de ce bonus de déclenchement dans la probabilité
  catchFrac: 0.4,           // bassin d'une pompe le long des convergences : rayon = catchFrac · zi ...
  catchMax: 1500,           // ... au plus catchMax (m)
  catchGain: 1.35,          // pompe isolée : même chaleur, en moyenne, qu'avec le noyau de 600 m recalé le 8/07
  relR: 15000,              // fiabilité relative : rang parmi les pompes à moins de 15 km ...
  relProb: [0.25, 0.9],     // ... ramené entre 25 % (la moins sûre du secteur) et 90 % (la plus sûre), × P_dév
  ringFrac: 0.4,          // part du débit montant qui redescend en anneau autour du thermique (vue 3D, inclinaison)
};
const V = PARAM.vKmh / 3.6, BANK = PARAM.bankDeg * Math.PI / 180;
export const R_TURN = V * V / (9.81 * Math.tan(BANK));                                 // 63,7 m
export const SINK = PARAM.polarA * V ** 3 + PARAM.polarB / Math.cos(BANK) ** 2 / V;     // 1,01 m/s
// Spirales possibles : inclinaison φ, vitesse 1,05 x vitesse de chute minimale x √n (n = 1/cos φ, facteur de charge),
// rayon V²/(g tan φ), chute a V³ + b n²/V. 35° : 76 km/h, 66 m, 0,79 m/s ; 45° : 82 km/h, 53 m, 0,99 m/s ; 55° : 91 km/h, 46 m, 1,35 m/s.
let VMS = PARAM.vMinKmh / 3.6;
export function circle(deg) {
  const ph = deg * Math.PI / 180, n = 1 / Math.cos(ph), V = VMS * Math.sqrt(n);
  return { deg, V, R: V * V / (9.81 * Math.tan(ph)), sink: PARAM.polarA * V ** 3 + PARAM.polarB * n * n / V };
}
export const CIRCLES = [35, 45, 55].map(circle);

/**
 * Planeurs : polaire s = a V³ + b n²/V ajustée sur deux points en ligne droite (vitesse km/h, chute m/s), à la charge
 * alaire de référence. Valeurs approchées des polaires publiées. Avec du ballast (masse × k), vitesses et chutes sont
 * multipliées par √k : a devient a/k et b devient b k.
 */
// vm : vitesse de chute minimale réelle (km/h, sans ballast), base de la vitesse en spirale V = vm √n
export const GLIDERS = [
  { id: "std", name: "Classe standard (LS8, Discus 2)", p: [[75, 0.60], [100, 0.80]], vm: PARAM.vMinKmh },
  { id: "club", name: "Classe club (LS4, Astir, DG-100)", p: [[75, 0.62], [110, 0.85]], vm: PARAM.vMinKmh - 3 },
  { id: "school", name: "Biplace école (ASK 21)", p: [[75, 0.67], [110, 1.05]], vm: PARAM.vMinKmh - 5 },
  { id: "15m", name: "15 m (ASW 27, Ventus 2a)", p: [[78, 0.53], [110, 0.68]], vm: PARAM.vMinKmh + 2 },
  { id: "18m", name: "18 m (LS8-18, ASG 29)", p: [[78, 0.48], [110, 0.60]], vm: PARAM.vMinKmh + 3 },
  { id: "duo", name: "Biplace performance (Duo Discus, Arcus)", p: [[80, 0.55], [110, 0.68]], vm: PARAM.vMinKmh + 5 },
];
export function polarOf(id, ballast = 0) {
  const g = GLIDERS.find(x => x.id === id) || GLIDERS[0];
  const [[v1, s1], [v2, s2]] = g.p.map(([v, s]) => [v / 3.6, s]);
  // s = a v³ + b / v en deux points
  const a = (s1 * v1 - s2 * v2) / (v1 ** 4 - v2 ** 4), b = s1 * v1 - a * v1 ** 4, k = 1 + ballast;
  return { a: a / k, b: b * k, vm: g.vm / 3.6 * Math.sqrt(k) };
}
/** Change de planeur : polaire et spirales possibles (la carte doit être recalculée). */
export function setPolar(a, b, vm) {
  PARAM.polarA = a; PARAM.polarB = b; VMS = vm;
  [35, 45, 55].forEach((d, k) => { CIRCLES[k] = circle(d); });
}

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
  // abri (Winstral) : plus grand angle (degrés) sous lequel on voit le relief au vent, jusqu'à ~1 km, pour 16 directions
  // d'où vient le vent. > 0 : la maille est sous le vent d'une crête proche, l'écoulement décolle et ne l'atteint pas.
  const NDIR = 16, shelter = new Int8Array(n * NDIR), SH_STEPS = [1, 2, 3, 4, 5, 7];
  for (let d = 0; d < NDIR; d++) {
    const a = d * 2 * Math.PI / NDIR, sx = Math.sin(a), sy = -Math.cos(a);   // vers l'amont du vent (j croît vers le sud)
    const offs = SH_STEPS.map(k => [Math.round(k * sx), Math.round(k * sy), Math.hypot(Math.round(k * sx), Math.round(k * sy)) * dx]);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const p = j * nx + i, z = Es[p];
      let best = -1;
      for (const [oi, oj, dist] of offs) {
        const ii = i + oi, jj = j + oj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || dist === 0) continue;
        const t = (Es[jj * nx + ii] - z) / dist;
        if (t > best) best = t;
      }
      shelter[p * NDIR + d] = Math.max(-90, Math.min(90, Math.round(Math.atan(best) * 180 / Math.PI)));
    }
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
  // Air de vallée. Dans une vallée large et encaissée, la couche brassée reste sous les crêtes : les brises exportent
  // la chaleur vers les sommets et l'air qui redescend au-dessus de la vallée la stabilise ; la brise de vallée y amène
  // en plus l'air plus frais des plaines. Fond (5e centile) et crêtes (98e centile) du relief dans un rayon de lidR ;
  // part du disque au-dessus de 60 % de la hauteur (vallée fermée, pas plaine au pied d'un seul relief).
  const VC = 4, vcx = Math.ceil(nx / VC) + 1, vcy = Math.ceil(ny / VC) + 1;
  const vFl = new Float32Array(vcx * vcy), vTp = new Float32Array(vcx * vcy), vEn = new Float32Array(vcx * vcy);
  const RV = Math.round(PARAM.lidR / dx), SV = 3, hist = new Uint16Array(100), disk = [];
  for (let dj = -RV; dj <= RV; dj += SV) for (let di = -RV; di <= RV; di += SV) if (di * di + dj * dj <= RV * RV) disk.push(di, dj);
  for (let cj = 0; cj < vcy; cj++) for (let ci = 0; ci < vcx; ci++) {
    const i = Math.min(nx - 1, ci * VC), j = Math.min(ny - 1, cj * VC);
    hist.fill(0); let m = 0;
    for (let k = 0; k < disk.length; k += 2) {
      const ii = i + disk[k], jj = j + disk[k + 1];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || !cover[jj * nx + ii]) continue;
      hist[Math.min(99, Math.max(0, Math.floor(E[jj * nx + ii] / 50)))]++; m++;
    }
    let c = 0, b5 = -1, b98 = 99;
    for (let b = 0; b < 100; b++) { c += hist[b]; if (b5 < 0 && c >= 0.05 * m) b5 = b; if (c >= 0.98 * m) { b98 = b; break; } }
    const fl = b5 * 50 + 25, tp = b98 * 50 + 25, mid = Math.floor((fl + 0.6 * (tp - fl)) / 50);
    let hi = 0;
    for (let b = mid; b < 100; b++) hi += hist[b];
    const q = cj * vcx + ci;
    vFl[q] = fl; vTp[q] = tp; vEn[q] = m ? hi / m : 0;
  }
  // poids du couvercle par maille : vallée assez profonde, fermée, et départ des thermiques dans le bas de la vallée
  const lidZ = new Uint16Array(n), lidF = new Float32Array(n);
  for (let j = 0; j < ny; j++) {
    const fy = j / VC, y0 = Math.min(vcy - 2, Math.floor(fy)), ay = fy - y0;
    for (let i = 0; i < nx; i++) {
      const fx = i / VC, x0 = Math.min(vcx - 2, Math.floor(fx)), ax = fx - x0, q = y0 * vcx + x0;
      const bil = a => (a[q] * (1 - ax) + a[q + 1] * ax) * (1 - ay) + (a[q + vcx] * (1 - ax) + a[q + vcx + 1] * ax) * ay;
      const fl = bil(vFl), tp = bil(vTp), en = bil(vEn), p = j * nx + i, D = tp - fl;
      lidZ[p] = Math.round(tp);
      const hs = (zs[p] - fl) / Math.max(1, D);
      lidF[p] = clip01((D - 500) / 400) * clip01((en - 0.05) / 0.15) * clip01((0.5 - hs) / 0.15);
    }
  }
  return { meta, n, elev: E, cover, svf, normal, up, slope, curv, osS, smax, shelter, wi, wf, zs, lidZ, lidF };
}

const clip01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

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

/** Part du vent (u, v) qui atteint le sol en p : 1 à découvert, jusqu'à PARAM.shelterMin sous le vent d'une crête proche. */
function shelterFactor(T, p, u, v) {
  if (Math.abs(u) + Math.abs(v) < 0.1) return 1;
  const from = Math.atan2(-u, -v), d = ((Math.round(from / (Math.PI / 8)) % 16) + 16) % 16;
  const sx = T.shelter[p * 16 + d];
  return Math.min(1, Math.max(PARAM.shelterMin, 1 - (sx - PARAM.shelterDeg[0]) / (PARAM.shelterDeg[1] - PARAM.shelterDeg[0])));
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
function feedFlow(T, Hreg, amb, i0, i1, j0, j1, Hsrc = Hreg) {
  const { nx, dx } = T.meta, w = i1 - i0, h = j1 - j0, m = w * h;
  const down = new Int32Array(m).fill(-1), fu = new Float32Array(m), fv = new Float32Array(m), src = new Float32Array(m);
  const loc = (i, j) => (j - j0) * w + (i - i0);
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    const p = j * nx + i, q = loc(i, j);
    if (!T.cover[p]) continue;
    const s = T.slope[p] / 100, vb = breeze(Hreg[p], s);
    const [eu, ev] = amb(p), fa = PARAM.ambient * shelterFactor(T, p, eu, ev);
    const u = vb * T.up[p * 2] / 127 + fa * eu, v = vb * T.up[p * 2 + 1] / 127 + fa * ev;
    fu[q] = u; fv[q] = v; src[q] = Math.max(0, Hsrc[p]) * dx * dx;
    const au = Math.abs(u), av = Math.abs(v);
    if (au + av < 0.35) continue;
    const k = av < 0.4142 * au ? (u > 0 ? 0 : 4) : au < 0.4142 * av ? (v > 0 ? 2 : 6) : u > 0 ? (v > 0 ? 1 : 7) : (v > 0 ? 3 : 5);
    const ii = i + DI[k], jj = j + DJ[k];
    if (ii < i0 || jj < j0 || ii >= i1 || jj >= j1 || !T.cover[jj * nx + ii]) continue;
    down[q] = loc(ii, jj);
  }
  // air qui tourne en rond (deux mailles qui s'envoient l'air l'une à l'autre, ou boucle plus longue sur un sommet
  // aplati) : il converge, et monte dans la plus haute maille de la boucle
  const zq = q => T.elev[(j0 + Math.floor(q / w)) * nx + i0 + (q % w)];
  const state = new Uint8Array(m), stack = [];
  for (let s = 0; s < m; s++) {
    if (state[s]) continue;
    let c = s;
    while (c >= 0 && state[c] === 0) { state[c] = 1; stack.push(c); c = down[c]; }
    if (c >= 0 && state[c] === 1) {
      let best = c, bz = zq(c);
      for (let x = down[c]; x !== c; x = down[x]) { const z = zq(x); if (z > bz) { bz = z; best = x; } }
      down[best] = -1;
    }
    for (const y of stack) state[y] = 2;
    stack.length = 0;
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

/**
 * Bassin de chaque pompe et partage de l'air. L'air chaud qui monte le long d'une ligne de convergence (crête) ne s'élève
 * pas en un rideau continu : il s'organise en thermiques espacés de l'ordre de l'épaisseur de la couche convective zi.
 * Chaque pompe puise donc la chaleur des points de convergence jusqu'à R = min(catchMax, catchFrac · zi), avec un poids
 * en cloche exp(-(d/R)²). Un point vu par plusieurs pompes est partagé au prorata poids × force de chaque pompe :
 * la chaleur qui nourrit une pompe ne nourrit plus sa voisine. Renvoie la chaleur (W) de chaque pompe et sa part partagée.
 */
function shareHeat(fl, Q, spots, nx, ny, dx, ziOf) {
  const { down, acc } = fl, K = spots.length, out = new Float64Array(K), lost = new Float64Array(K);
  const R = spots.map(s => Math.max(300, Math.min(PARAM.catchMax, PARAM.catchFrac * ziOf(s.j * nx + s.i))) / dx);
  const qk = spots.map(s => Math.max(1, Q[s.j * nx + s.i]));
  // grille de recherche des voisines
  const G = Math.ceil(2 * PARAM.catchMax / dx), cell = new Map();
  spots.forEach((s, k) => { const key = Math.floor(s.i / G) * 4096 + Math.floor(s.j / G); if (!cell.has(key)) cell.set(key, []); cell.get(key).push(k); });
  for (let k = 0; k < K; k++) {
    const a = spots[k], r = R[k], rr = Math.ceil(2 * r), nb = [];
    const gi = Math.floor(a.i / G), gj = Math.floor(a.j / G);
    for (let u = gi - 1; u <= gi + 1; u++) for (let v = gj - 1; v <= gj + 1; v++) for (const m of cell.get(u * 4096 + v) || []) if (m !== k) nb.push(m);
    let sum = 0, alone = 0;
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const i = a.i + di, j = a.j + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const q = j * nx + i;
      if (down[q] >= 0 || !(acc[q] > 0)) continue;
      const wk = Math.exp(-(di * di + dj * dj) / (r * r));
      if (wk < 0.02) continue;
      let den = wk * qk[k];
      for (const m of nb) {
        const ei = i - spots[m].i, ej = j - spots[m].j, rm = R[m], d2 = ei * ei + ej * ej;
        if (d2 < 4 * rm * rm) den += Math.exp(-d2 / (rm * rm)) * qk[m];
      }
      sum += acc[q] * wk * (wk * qk[k] / den); alone += acc[q] * wk;
    }
    out[k] = PARAM.catchGain * sum; lost[k] = alone > 0 ? 1 - sum / alone : 0;
  }
  return { Q: out, shared: lost };
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
 * fa, fr : facteurs d'erreur sur l'alimentation et le rayon ; fw : vent, pluie, variabilité ; dS : écart sur la chute du planeur.
 * Le pilote serre ou élargit selon la largeur du thermique : on garde la meilleure des spirales CIRCLES.
 * Retourne [Vz, vitesse de l'air sur le cercle, vitesse au cœur, indice de la spirale retenue].
 */
const HZ = PARAM.heights, HS = HZ.map(Math.cbrt);
/** Thermique moyen (A) et panache (P) à la hauteur relative zr : vitesses au centre et rayons gaussiens. */
export function layer(wstar, zi, B, kf, fa, fr, zr) {
  const s = Math.cbrt(zr);
  const wbar = wstar * s * (1 - 1.1 * zr);
  const r2 = Math.max(10, 0.102 * s * (1 - 0.25 * zr) * zi);
  const q = r2 > 600 ? 0.8 : 0.0011 * r2 + 0.14;
  const zp = zr * zi + PARAM.z0Plume, cb = B > 0 ? Math.cbrt(B * fa) : 0;
  return { wA: Math.max(0, 3 * wbar * (1 - q) / (1 - q * q * q) * kf), RA: 0.75 * r2 * kf * fr,
    wP: cb > 0 ? Math.max(0, PARAM.kPlume * cb / Math.cbrt(zp) * (1 - zr * zr)) : 0, RP: Math.max(25, 0.12 * zp) * fr };
}
const NCIR = 3, acc3 = new Float64Array(NCIR);
export function thermal(wstar, zi, B, kf = 1, fa = 1, fr = 1, dS = 0, fw = 1) {
  let core = 0;
  acc3.fill(0);
  for (let h = 0; h < HZ.length; h++) {
    const L = layer(wstar, zi, B, kf, fa, fr, HZ[h]), iA = 1 / (L.RA * L.RA), iP = 1 / (L.RP * L.RP);
    for (let c = 0; c < NCIR; c++) {
      const R2 = CIRCLES[c].R * CIRCLES[c].R;
      acc3[c] += (L.wA * Math.exp(-R2 * iA) + (L.wP > 0 ? L.wP * Math.exp(-R2 * iP) : 0)) * fw;
    }
    core += (L.wA + L.wP) * fw;
  }
  const k = HZ.length;
  let best = 0, bv = -1e9;
  for (let c = 0; c < NCIR; c++) { const v = acc3[c] / k - CIRCLES[c].sink - dS; if (v > bv) { bv = v; best = c; } }
  return [bv, acc3[best] / k, core / k, best];
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
export function uncertainty(s, seed, N = 200) {
  const n = rng(seed);
  const vz = new Float32Array(N), ce = new Float32Array(N), air = new Float32Array(N), core = new Float32Array(N);
  const xs = new Float32Array(N), ys = new Float32Array(N);
  const l11 = Math.sqrt(Math.max(0, s.cov[0])), l21 = l11 > 0 ? s.cov[1] / l11 : 0, l22 = Math.sqrt(Math.max(0, s.cov[2] - l21 * l21));
  const U0 = Math.hypot(s.wu, s.wv), th0 = Math.atan2(s.wu, s.wv);
  const bankCount = new Uint16Array(CIRCLES.length);
  let ok = 0;
  for (let k = 0; k < N; k++) {
    const fH = Math.exp(0.25 * n()), fZ = Math.exp(0.15 * n()), fa = Math.exp(0.35 * n()), fr = Math.exp(0.25 * n()), sink = 0.1 * n();
    const fs = Math.exp(0.15 * n());
    const zi = s.zi * fZ, wst = Math.cbrt(9.81 / 300 * s.H * fH / 1105 * zi);
    const [v, a, c0, bi] = thermal(wst, zi, s.B * fH, s.kf, fa, fr, sink, s.fw * fs);
    bankCount[bi]++;
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
    pdev: ok / N, bank: CIRCLES[bankCount.indexOf(Math.max(...bankCount))].deg,
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
function parcelTop(T, S, p, zb, thP, rP, zLid = 0, dLid = 0) {
  let thvP = thP * (1 + 0.61 * rP);
  const e = Math.min(1, DZ / PARAM.entL);
  const l0 = Math.min(NZ - 2, Math.max(0, Math.ceil(zb / DZ)));
  let prev = thvP - prof4(T, S.thv, p, l0);
  for (let l = l0 + 1; l < NZ; l++) {
    const z = l * DZ;
    // couvercle de vallée : couche plus chaude de dLid au sommet de l'air de vallée
    const env = prof4(T, S.thv, p, l) + (dLid && z >= zLid && z < zLid + PARAM.lidThick ? dLid : 0);
    thvP -= e * (thvP - env);
    const d = thvP - env;
    if (d < 0) return (l - 1) * DZ + DZ * prev / Math.max(1e-6, prev - d);
    prev = d;
  }
  return (NZ - 1) * DZ;
}

/** Éclairement de chaque pente (soleil direct, ombres, diffus) et flux de chaleur sensible H (W/m²) à l'heure idx. */
function surfaceHeat(T, W, S, idx) {
  const { meta, n, elev, normal, cover, svf } = T;
  const { nx, ny } = meta;
  // soleil un peu avant l'heure affichée : milieu de l'heure écoulée, plus le retard du sol qui restitue sa chaleur
  const sun = sunPosition(utcMillis(W, idx) - PARAM.lagMin * 60e3, meta.lat0, meta.lon0);
  const el = sun.el * Math.PI / 180, az = sun.az * Math.PI / 180;
  const sx = Math.cos(el) * Math.sin(az), sy = Math.cos(el) * Math.cos(az), sz = Math.sin(el);
  const L4 = (arr, p) => lerp4(T, arr, p);
  const H = new Float32Array(n);
  if (sun.el <= 1) return { H, sun };

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
    if (c !== 5 && c !== 7) { const sm = L4(S.soil, p); if (sm === sm) bo *= 1.5 - 0.9 * Math.min(1, Math.max(0, (sm - 0.10) / 0.25)); }
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
  return { H, sun };
}

/** Calcule tous les champs pour l'heure d'indice idx. */
export function computeHour(T, W, idx) {
  const { meta, n, elev, normal, cover, slope, svf, zs } = T;
  const { nx, ny, dx } = meta;
  const S = pointState(T, W, idx);
  const sun = sunPosition(utcMillis(W, idx) - PARAM.lagMin * 60e3, meta.lat0, meta.lon0);
  const day = sun.el > 1;
  const L4 = (arr, p) => lerp4(T, arr, p);
  const ms = {}, t0 = performance.now(); let tl = t0;
  const lap = k => { const t = performance.now(); ms[k] = Math.round(t - tl); tl = t; };

  // ---- 1 et 2 : éclairement de la pente et flux de chaleur sensible
  const { H } = surfaceHeat(T, W, S, idx);
  // Mémoire de chaleur : l'après-midi, quand le chauffage baisse, la roche et l'air chaud près des pentes continuent
  // de nourrir les thermiques. On garde une part MEM de la baisse depuis l'heure précédente (le matin, rien ne change).
  if (day && sun.az > 180 && idx > 0) {
    const H1 = surfaceHeat(T, W, pointState(T, W, idx - 1), idx - 1).H;
    for (let p = 0; p < n; p++) if (H1[p] > H[p]) H[p] += PARAM.memory * MEM[cover[p]] * (H1[p] - H[p]);
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
  // chaleur ramassée : celle de chaque pente (non lissée), pour ne pas mélanger les deux versants d'une crête
  const Hloc = blur(H, nx, ny, 1, 1);
  const fl = feedFlow(T, Hreg, p => [ua[p], va[p]], 0, nx, 0, ny, Hloc);
  lap("flux");
  const Q = plumeHeat(fl);
  const cidx = new Float32Array(n);
  for (let p = 0; p < n; p++) cidx[p] = Math.min(1.5, Q[p] / PARAM.q0);

  // ---- 3 et 5 : sommet des thermiques, condensation, Vz en spirale
  const top = new Uint16Array(n), ceil = new Uint16Array(n), cu = new Uint8Array(n), climb = new Float32Array(n);
  const zlA = new Uint16Array(n), fwA = new Float32Array(n);
  // sommet de la particule sur une grille de 450 m (il varie lentement), interpolé ensuite
  const CS = 3, ncx = Math.ceil(nx / CS) + 1, ncy = Math.ceil(ny / CS) + 1, topC = new Float32Array(ncx * ncy), topL = new Float32Array(ncx * ncy);
  if (day) for (let cj = 0; cj < ncy; cj++) for (let ci = 0; ci < ncx; ci++) {
    const p = Math.min(ny - 1, cj * CS) * nx + Math.min(nx - 1, ci * CS), zr = zs[p];
    const excess = PARAM.excess[0] + PARAM.excess[1] * Math.min(1, Hreg[p] / 300);   // surchauffe de la couche de surface (K)
    const thP = L4(S.fTh.res, p) + S.fTh.b * zr + excess, rP = Math.max(2e-4, L4(S.fR.res, p) + S.fR.b * zr), k = cj * ncx + ci;
    topC[k] = parcelTop(T, S, p, zr, thP, rP);
    // même particule partant du bas d'une vallée, sous le couvercle de l'air de vallée
    topL[k] = T.lidF[p] > 0.01 && T.lidZ[p] > zr + 100 ? parcelTop(T, S, p, zr, thP, rP, T.lidZ[p], PARAM.lidDth * T.lidF[p]) : topC[k];
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
    if (T.lidF[p] > 0.01) zt = (topL[k0] * (1 - ax) + topL[k0 + 1] * ax) * (1 - ay) + (topL[k0 + ncx] * (1 - ax) + topL[k0 + ncx + 1] * ax) * ay;
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
    climb[p] = Math.max(0, thermal(wstar, zi, G_RCP * Q[p], reliefGain(z), 1, 1, 0, fw)[0]);
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
  const minD = PARAM.minSpacing / dx, gapD = 2000 / dx;
  for (const c of cand) {
    if (spots.length >= PARAM.maxSpots) break;
    if (spots.some(s => Math.hypot(s.i - c.i, s.j - c.j) < minD)) continue;
    spots.push(c);
  }
  // les jours forts, la limite est atteinte par les pompes de montagne : on garde aussi les pompes plus faibles
  // isolées (à plus de 2 km de toute autre), celles des bas reliefs près des terrains (MSM au-dessus de Challes)
  for (const c of cand) {
    if (spots.length >= PARAM.maxSpots + 400) break;
    if (c.s < 1 || spots.some(s => Math.hypot(s.i - c.i, s.j - c.j) < gapD)) continue;
    spots.push(c);
  }
  // Partage de l'air : la chaleur qui monte en un point de convergence ne nourrit qu'un panache. Quand deux pompes sont
  // assez proches pour puiser aux mêmes points, chacune en reçoit une part proportionnelle à sa force d'attraction.
  const SH = shareHeat(fl, Q, spots, nx, ny, dx, p => top[p] - Math.min(elev[p], zs[p])), sharedQ = SH.Q;
  // incertitudes et probabilité de chaque pompe
  const out = spots.map((c, k) => {
    const p = c.j * nx + c.i, Qs = sharedQ[k], ci = Math.min(1.5, Qs / PARAM.q0);
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
    const u = uncertainty({ z, zb, zi: top[p] - zb, H: Hreg[p], B: G_RCP * Qs, kf: reliefGain(z), cu: cu[p], zl: zlA[p], wu, wv, fw: fwA[p], cov }, p * 31 + idx);
    // le déclenchement est d'autant plus sûr que l'alimentation est forte et que la pompe ressort de son voisinage ;
    // un sommet ou un éperon bien bombé fixe le déclenchement (« pompe maison » : chapelle du MSM, Penay)
    const trig = clip01((T.curv[p] - PARAM.trigCurv[0]) / (PARAM.trigCurv[1] - PARAM.trigCurv[0]));
    const pfeed = 0.2 + 0.7 * Math.min(1, ci) * (0.3 + 0.7 * prom);
    const psite = pfeed + Math.max(0, 0.92 - pfeed) * PARAM.trigW * trig;
    const prob = Math.min(0.95, Math.max(0.02, u.pdev * psite));
    return { i: c.i, j: c.j, score: c.s, elev: z, cu: cu[p], depth: cu[p] ? Math.max(0, top[p] - zlA[p]) : 0, conv: ci, convAlone: cidx[p], shared: SH.shared[k], qs: Qs, h: Hreg[p], wu, wv, prob, psite, trig, lid: T.lidF[p], ...u };
  });

  relativeProb(out, dx);
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
    fields: fieldSummary(T, S, out),
    over: overDev(out, S),
    wave: waveDiag(S),
  };
  const wave = stats.wave.idx > 0.25 ? waveField(T, stats.wave) : null;
  return { H: Hreg, Hloc, top, ceil, cu, climb, conv: cidx, Q, zl: zlA, fw: fwA, ua, va, flow: fl, spots: out, stats, S, wave };
}

/**
 * Fiabilité relative. Les jours forts, presque tous les tirages donnent un thermique exploitable (P_dév ≈ 1) et l'ancienne
 * probabilité ne reflétait plus que le facteur de site, hypothétique : 600 pompes au-dessus de 75 %. On classe donc chaque
 * pompe parmi ses voisines à moins de relR (rang du facteur de site, puis de la Vz), avec un a priori de 2 pompes moyennes
 * pour les secteurs presque vides, et P = P_dév × (relProb[0] + (relProb[1] - relProb[0]) × rang).
 * Chaque secteur garde ses pompes les plus sûres ; une journée faible reste faible par P_dév. À recaler sur les traces IGC.
 */
function relativeProb(spots, dx) {
  const R2 = (PARAM.relR / dx) ** 2, [a, b] = PARAM.relProb, k0 = 2;
  for (const s of spots) {
    let below = 0, tot = 0;
    for (const o of spots) {
      if ((o.i - s.i) ** 2 + (o.j - s.j) ** 2 > R2 || o === s) continue;
      tot++;
      if (o.psite < s.psite || (o.psite === s.psite && o.vz < s.vz)) below++;
    }
    s.rank = (below + 0.5 * k0) / (tot + k0);
    s.nSector = tot + 1;
    s.pabs = s.prob;
  }
  for (const s of spots) s.prob = Math.min(0.95, Math.max(0.02, s.pdev * (a + (b - a) * s.rank)));
}

/** Pour chaque aérodrome : meilleure pompe à moins de 10 km, pompe basse la plus proche, plafond local, vent au sol et vers 1 500 m. */
function fieldSummary(T, S, spots) {
  const { meta } = T, { nx, ny, dx } = meta;
  return meta.places.filter(f => f.kind === "field").map(f => {
    const [ci, cj] = latLonCell(meta, f.lat, f.lon), i = Math.max(0, Math.min(nx - 1, ci)), j = Math.max(0, Math.min(ny - 1, cj)), p = j * nx + i, z = T.elev[p];
    const near = spots.map(s => ({ s, d: Math.hypot(s.i - i, s.j - j) * dx })).filter(x => x.d <= 10000 && x.s.prob >= 0.4);
    const pick = x => x && { vz: x.s.vz, prob: x.s.prob, ceil: x.s.ceil, d: x.d, elev: x.s.elev, bank: x.s.bank, az: Math.atan2(x.s.i - i, j - x.s.j) * 180 / Math.PI };
    const best = near.reduce((m, x) => (!m || x.s.vz * x.s.prob > m.s.vz * m.s.prob ? x : m), null);
    const low = near.filter(x => x.s.elev < z + 700 && x.d <= 6000).reduce((m, x) => (!m || x.d < m.d ? x : m), null);
    const ceils = near.map(x => x.s.ceil).sort((x, y) => x - y);
    return { name: f.name, z, best: pick(best), low: pick(low), ceil: ceils.length ? ceils[ceils.length >> 1] : 0, n: near.length,
      w10: [lerp4(T, S.u10, p), lerp4(T, S.v10, p)], w15: [prof4(T, S.uu, p, 15), prof4(T, S.vv, p, 15)] };
  });
}

/**
 * Surdéveloppement : épaisseur des cumulus (sommet des thermiques − base) parmi les pompes sûres à cumulus, et CAPE.
 * Niveau 0 : rien ; 1 : cumulus épais, étalements ou surdéveloppements possibles ; 2 : congestus, averses ou orages probables.
 */
function overDev(spots, S) {
  const d = spots.filter(s => s.cu && s.prob >= 0.5).map(s => s.depth).sort((a, b) => a - b);
  const depth = d.length >= 5 ? d[Math.floor(d.length * 0.75)] : 0, cape = Math.max(0, ...S.cape.filter(x => x === x));
  const level = depth > 3500 || cape > 1200 ? 2 : depth > 2200 || cape > 600 ? 1 : 0;
  return { level, depth, cape, frac: spots.length ? d.length / spots.length : 0 };
}

/**
 * Onde de relief (théorie linéaire). Profil moyen du domaine : fréquence de Brunt-Väisälä N² = (g/θ) dθ/dz et vent U
 * dans la couche des crêtes (2 500 – 3 500 m) et au-dessus (4 000 – 5 500 m). Nombre de Froude Fr = U/(N h), h = 1 500 m ;
 * paramètre de Scorer l² = N²/U² : des ondes piégées (en série sous le vent) quand il décroît avec l'altitude ;
 * longueur d'onde λ = 2π U/N. Indice entre 0 et 1, à prendre comme une alerte, pas une prévision de la position des ondes.
 * Foehn du sud : vent du sud fort au niveau des crêtes, air stable.
 */
function waveDiag(S) {
  const K = S.K, at = (prof, l) => { let s = 0; for (let k = 0; k < K; k++) s += prof[k][l]; return s / K; };
  const th = l => at(S.th, l), u = l => at(S.uu, l), v = l => at(S.vv, l), U = l => Math.hypot(u(l), v(l));
  const N2 = (l1, l2) => 9.81 / th((l1 + l2) >> 1) * (th(l2) - th(l1)) / ((l2 - l1) * DZ);
  const nLow = Math.sqrt(Math.max(1e-8, N2(25, 35))), nUp = Math.sqrt(Math.max(1e-8, N2(40, 55)));
  const uLow = (U(25) + U(30) + U(35)) / 3, uUp = (U(45) + U(50) + U(55)) / 3;
  const dir = (Math.atan2(-u(30), -v(30)) * 180 / Math.PI + 360) % 360;
  const fr = uLow / (nLow * 1500), lam = 2 * Math.PI * uLow / nLow;
  const trapped = nLow * nLow / (uLow * uLow + 1) > 1.3 * nUp * nUp / (uUp * uUp + 1);
  // crêtes des Préalpes orientées vers le nord-nord-est (vent d'ouest ou d'est le plus efficace), chaîne principale et
  // Belledonne vers le nord-est (vent de nord-ouest ou de sud-est) : on garde la plus favorable des deux
  const perp = Math.max(0.3, Math.abs(Math.cos((dir - 290) * Math.PI / 180)), Math.abs(Math.cos((dir - 315) * Math.PI / 180)));
  const idx = clip01((uLow - 8) / 7) * clip01((nLow - 0.004) / 0.006) * Math.exp(-((Math.log(Math.max(0.05, fr) / 0.8) / 0.9) ** 2)) * (trapped ? 1 : 0.6) * perp;
  const foehn = dir >= 150 && dir <= 240 && uLow >= 12 && nLow > 0.005;
  return { idx, lambda: lam, u: uLow, uUp, n: nLow, fr, dir, trapped, foehn };
}

/** Zones où chercher l'onde : à λ/2 et 3λ/2 sous le vent des crêtes exposées (indice 0 – 255 par maille). */
function waveField(T, D) {
  const { nx, ny, dx } = T.meta, n = T.n, out = new Uint8Array(n);
  const from = D.dir * Math.PI / 180, ex = -Math.sin(from), ey = Math.cos(from);       // vers l'aval, i vers l'est, j vers le sud
  const d16 = ((Math.round(from / (Math.PI / 8)) % 16) + 16) % 16;
  const steps = [0.5, 1.5].map(f => Math.round(f * D.lambda / dx)), w = Math.max(2, Math.round(0.12 * D.lambda / dx));
  for (let j = 0; j < ny; j += 2) for (let i = 0; i < nx; i += 2) {
    const p = j * nx + i;
    if (T.elev[p] < 1400 || T.curv[p] < 0.2 || T.shelter[p * 16 + d16] > 2) continue;       // crête exposée au vent
    steps.forEach((s, k) => {
      const ci = Math.round(i + ex * s), cj = Math.round(j + ey * s), amp = (k ? 140 : 255) * D.idx;
      for (let dj = -w; dj <= w; dj++) for (let di = -w; di <= w; di++) {
        const ii = ci + di, jj = cj + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const q = jj * nx + ii, a = amp * Math.exp(-(di * di + dj * dj) / (w * w / 2));
        if (a > out[q]) out[q] = a;
      }
    });
  }
  return out;
}

/** Diagnostic d'onde seul (sans calcul de la carte), pour l'aperçu des jours et les tests. */
export function waveAt(T, W, idx) { return waveDiag(pointState(T, W, idx)); }

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
  const fl = feedFlow(T, F.H, p => [F.ua[p], F.va[p]], i0, i1, j0, j1, F.Hloc);
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
    return thermal(wstar, zi, G_RCP * Qmax, kf, 1, 1, 0, fw)[0];
  };
  const best = fx => { const Qw = plumeHeat(fx); let m = 0; for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) { if (di * di + dj * dj > 16) continue; const qi = i - i0 + di, qj = j - j0 + dj; if (qi >= 0 && qj >= 0 && qi < w && qj < h) m = Math.max(m, Qw[qj * w + qi]); } return m; };
  for (let d = 0; d < dirs; d++) {
    const row = [];
    const from = d * 2 * Math.PI / dirs;
    for (const kmh of speeds) {
      const U = kmh / 3.6, u = -U * Math.sin(from), v = -U * Math.cos(from);
      const fx = feedFlow(T, F.H, p => microMet(T, p, u, v), i0, i1, j0, j1, F.Hloc);
      row.push(vzAt(best(fx), U));
    }
    rose.push(row);
  }
  const amb = microMet(T, p0, ...(() => { const l = Math.min(NZ - 1, Math.round((z + 200) / DZ)); return [prof4(T, S.uu, p0, l), prof4(T, S.vv, p0, l)]; })());
  const raster = new Uint8Array(w * h);
  for (let q = 0; q < w * h; q++) raster[q] = cmax > 0 ? Math.round(255 * Math.sqrt(contrib[q] / cmax)) : 0;
  return { i0, j0, w, h, raster, paths, total, rose, speeds, dirs, ambient: amb, vzNow: vzAt(best(fl), Math.hypot(...amb)) };
}

/**
 * Structure d'une pompe pour la vue en 3 dimensions : relief autour, colonne (vitesse au cœur, rayon, dérive) de 25 niveaux,
 * anneau de descendance, Vz selon l'inclinaison, turbulence, points d'où l'air part vraiment.
 * Anneau de descendance : chaque composante gaussienne w e^(-r²/R²) rend la part ringFrac de son débit πR²w dans un
 * anneau gaussien centré à 1,6 R, de demi-largeur 0,4 R (amplitude 0,44 · ringFrac · w).
 */
export function pumpStructure(T, F, i, j) {
  const { nx, ny, dx } = T.meta, p = j * nx + i, S = F.S;
  const spot = F.spots.find(s => s.i === i && s.j === j);
  const z0 = T.elev[p], zb = Math.min(z0, T.zs[p]), zi = Math.max(250, F.top[p] - zb);
  const H = F.H[p], wstar = Math.cbrt(9.81 / 300 * H / 1105 * zi), kf = reliefGain(z0), fw = F.fw[p] || 1;
  const Qs = spot ? spot.qs : F.Q[p], B = G_RCP * Qs;
  const ceil = spot ? spot.ceil : F.ceil[p];
  const ring = PARAM.ringFrac * 0.44;
  const wAt = (L, r) => {
    let w = L.wA * Math.exp(-(r * r) / (L.RA * L.RA)) + L.wP * Math.exp(-(r * r) / (L.RP * L.RP));
    w -= ring * L.wA * Math.exp(-(((r - 1.6 * L.RA) / (0.4 * L.RA)) ** 2)) + ring * L.wP * Math.exp(-(((r - 1.6 * L.RP) / (0.4 * L.RP)) ** 2));
    return w * fw;
  };
  // colonne : du sol au plafond, avec la dérive due au vent (temps de montée de l'air au cœur)
  const NL = 24, levels = [];
  let x = 0, y = 0;
  for (let k = 0; k <= NL; k++) {
    // (sous 8 % de la couche, le panache idéal surestime la vitesse près de son origine : on garde la valeur à 8 %)
    const z = z0 + (Math.max(z0 + 100, ceil) - z0) * k / NL, zr = Math.min(0.97, Math.max(0.08, (z - zb) / zi));
    const L = layer(wstar, zi, B, kf, 1, 1, zr);
    const l = Math.min(NZ - 1, Math.max(0, Math.round(z / DZ))), u = prof4(T, S.uu, p, l), v = prof4(T, S.vv, p, l);
    // rayon utile : où l'air monte encore à la moitié de la vitesse au cœur ; bord : où il ne monte plus
    const core = wAt(L, 0);
    let rHalf = 0, rEdge = 0, rSink = 0, wMin = 0;
    for (let r = 5; r <= 600; r += 5) {
      const w = wAt(L, r);
      if (!rHalf && w < core / 2) rHalf = r;
      if (!rEdge && w < 0) rEdge = r;
      if (w < wMin) { wMin = w; rSink = r; }
    }
    // inclinaison : meilleure spirale à ce niveau
    let best = null;
    for (let deg = 25; deg <= 60; deg += 5) { const c = circle(deg), vz = wAt(L, c.R) - c.sink; if (!best || vz > best.vz) best = { deg, vz, R: c.R }; }
    levels.push({ z, x, y, u, v, core, rHalf, rEdge: rEdge || 600, rSink, wMin, wA: L.wA * fw, RA: L.RA, wP: L.wP * fw, RP: L.RP, best });
    if (k < NL) { const dz = (Math.max(z0 + 100, ceil) - z0) / NL, dt = dz / Math.max(1.5, core * 0.7); x += u * dt; y += v * dt; }
  }
  // Vz selon l'inclinaison, moyenne sur la bande où l'on spirale (30 à 70 % de la couche, comme la carte)
  const band = PARAM.heights.map(zr => layer(wstar, zi, B, kf, 1, 1, zr));
  const banks = [];
  for (let deg = 25; deg <= 60; deg += 2.5) {
    const c = circle(deg);
    const air = band.reduce((s, L) => s + wAt(L, c.R), 0) / band.length;
    // turbulence ressentie : écart de vitesse verticale entre les deux bouts d'aile (15 m) sur ce cercle
    const grad = band.reduce((s, L) => s + Math.abs(wAt(L, c.R + 7.5) - wAt(L, c.R - 7.5)), 0) / band.length;
    banks.push({ deg, V: c.V, R: c.R, sink: c.sink, vz: air - c.sink, wing: grad });
  }
  const bestBank = banks.reduce((a, b) => (b.vz > a.vz ? b : a));
  // entrée dans la pompe : plus fort écart entre bouts d'aile en traversant le bord ; descendance autour
  const mid = band[1];
  let edge = 0;
  for (let r = 0; r <= 400; r += 5) edge = Math.max(edge, Math.abs(wAt(mid, r + 7.5) - wAt(mid, r - 7.5)));
  const lv = levels.filter(L => L.z > z0 + 0.2 * (ceil - z0) && L.z < z0 + 0.8 * (ceil - z0));
  const shear = lv.length > 1 ? Math.hypot(lv[lv.length - 1].u - lv[0].u, lv[lv.length - 1].v - lv[0].v) : 0;
  // relief autour (±3 km), chaleur du sol, et points de convergence qui nourrissent la pompe
  const RW = Math.round(3000 / dx), i0 = Math.max(0, i - RW), j0 = Math.max(0, j - RW), i1 = Math.min(nx - 1, i + RW), j1 = Math.min(ny - 1, j + RW);
  const w = i1 - i0 + 1, h = j1 - j0 + 1, elev = new Float32Array(w * h), heat = new Uint8Array(w * h);
  for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
    const q = (jj - j0) * w + ii - i0, pp = jj * nx + ii;
    elev[q] = T.elev[pp]; heat[q] = Math.min(255, Math.round((F.Hloc ? F.Hloc[pp] : F.H[pp]) / 2));
  }
  const Rc = Math.max(300, Math.min(PARAM.catchMax, PARAM.catchFrac * zi)), sources = [];
  for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
    const pp = jj * nx + ii, d = Math.hypot(ii - i, jj - j) * dx;
    if (d > 2 * Rc || F.flow.down[pp] >= 0 || !(F.flow.acc[pp] > 0)) continue;
    const wt = F.flow.acc[pp] * Math.exp(-(d * d) / (Rc * Rc));
    if (wt > 0.02 * Qs) sources.push([ii, jj, wt]);
  }
  sources.sort((a, b) => b[2] - a[2]);
  // vent près du sol au pied de la pompe : d'où arrive l'air
  return { i, j, i0, j0, w, h, dx, elev, heat, z0, zb, zi, ceil, top: F.top[p], levels, banks, bestBank, edge, shear, Rc, Qs,
    sources: sources.slice(0, 40), shared: spot ? spot.shared : 0, vz: spot ? spot.vz : null, bank: spot ? spot.bank : null, lid: T.lidF[p] > 0.3 ? T.lidZ[p] : 0 };
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
    wu, wv, su: F.flow.fu[p], sv: F.flow.fv[p], u, lid: T.lidF[p] > 0.3 ? T.lidZ[p] : 0 };
}
