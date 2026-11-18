"""Exporte le relief des Préalpes et des massifs savoyards pour le site.
  python site/tools/export_terrain.py
Zone : Vercors, Chartreuse, Belledonne, Taillefer, Bauges, Bugey, Bornes, Aravis, Beaufortain, Haut-Giffre, Mont-Blanc.
Source : tuiles SRTM 1" (data/dem/*.hgt.gz). Grille équirectangulaire locale, maille de 150 m.
Sorties dans site/data/ (ligne 0 = nord) :
  elev.i16     altitude (m) ; -32768 = hors données
  cover.u8     nature du sol : 0 hors données, 1 lac, 2 forêt, 3 fond de vallée, 4 alpage, 5 rocher, 6 glacier
  svf.u8       facteur de vue du ciel x255
  relief.jpg   fond ombré
  meta.json    géoréférencement et lieux
Le reste (normales, pentes, ombres portées heure par heure) est calculé dans le navigateur.
"""
import gzip
import json
import os

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEM = os.path.join(ROOT, "data", "dem")
OUT = os.path.join(ROOT, "site", "data")
os.makedirs(OUT, exist_ok=True)

WEST, EAST, SOUTH, NORTH = 5.38, 7.08, 44.82, 46.20
LAT0, LON0 = 45.64, 6.35
DX = 150.0
R = 6371000.0
KX = R * np.cos(np.radians(LAT0)) * np.pi / 180          # mètres par degré de longitude
KY = R * np.pi / 180


def tile(lat, lon):
    f = os.path.join(DEM, f"N{lat:02d}E{lon:03d}.hgt")
    if not os.path.exists(f) and os.path.exists(f + ".gz"):
        with gzip.open(f + ".gz", "rb") as g, open(f, "wb") as h:
            h.write(g.read())
    if not os.path.exists(f):
        return None
    a = np.fromfile(f, ">i2").reshape(3601, 3601).astype(np.float32)
    a[a < -500] = np.nan
    return a


# --- mosaïque 1" sur la zone (lignes : nord -> sud)
lats, lons = range(int(SOUTH), int(NORTH) + 1), range(int(WEST), int(EAST) + 1)
rows = []
for la in sorted(lats, reverse=True):
    row = []
    for lo in lons:
        t = tile(la, lo)
        row.append(np.full((3601, 3601), np.nan, np.float32) if t is None else t)
        print(f"tuile N{la}E{lo:03d} :", "absente" if t is None else "ok")
    rows.append(np.concatenate([r[:, :-1] for r in row[:-1]] + [row[-1]], axis=1))
mos = np.concatenate([r[:-1] for r in rows[:-1]] + [rows[-1]], axis=0)
mlat_top, mlon_left = max(lats) + 1, min(lons)

# --- grille 30 m puis moyenne 5 x 5 -> 150 m
F = 5
x0, x1 = (WEST - LON0) * KX, (EAST - LON0) * KX
y0, y1 = (SOUTH - LAT0) * KY, (NORTH - LAT0) * KY
nx, ny = int((x1 - x0) // DX), int((y1 - y0) // DX)
xs = x0 + (np.arange(nx * F) + 0.5) * DX / F
ys = y1 - (np.arange(ny * F) + 0.5) * DX / F               # nord -> sud
LON = LON0 + xs / KX
LAT = LAT0 + ys / KY
ci = (LON - mlon_left) * 3600
ri = (mlat_top - LAT) * 3600
RI, CI = np.meshgrid(ri, ci, indexing="ij")
Z30 = map_coordinates(np.nan_to_num(mos, nan=-9999), [RI, CI], order=1, mode="nearest")
Z30[Z30 < -500] = np.nan
Z = Z30.reshape(ny, F, nx, F).mean(axis=(1, 3))
valid = np.isfinite(Z)
print(f"grille {nx} x {ny} = {nx * ny} mailles de {DX:.0f} m ; données sur {100 * valid.mean():.1f} % ; altitude {np.nanmin(Z):.0f} à {np.nanmax(Z):.0f} m")
Zf = np.where(valid, Z, np.nanmin(Z))
lonc = LON0 + (x0 + (np.arange(nx) + 0.5) * DX) / KX
latc = LAT0 + (y1 - (np.arange(ny) + 0.5) * DX) / KY
LONC, LATC = np.meshgrid(lonc, latc)

# --- pente
gy, gx = np.gradient(Zf, DX)
slope = np.degrees(np.arctan(np.hypot(gx, gy)))

# --- nature du sol (heuristique tirée du relief)
gy30, gx30 = np.gradient(np.nan_to_num(Z30, nan=0), DX / F)
sl30 = np.degrees(np.arctan(np.hypot(gx30, gy30)))
LON30, LAT30 = np.meshgrid(LON, LAT)
LAKES = [  # nom, ouest, est, sud, nord
    ("Bourget", 5.83, 5.93, 45.62, 45.81), ("Annecy", 6.11, 6.25, 45.77, 45.92), ("Aiguebelette", 5.77, 5.83, 45.53, 45.58),
    ("Monteynard", 5.66, 5.72, 44.88, 44.98)]
lake30 = np.zeros(Z30.shape, bool)
for name, w, e, s, n in LAKES:
    box = (LON30 > w) & (LON30 < e) & (LAT30 > s) & (LAT30 < n) & (sl30 < 0.8)
    vals = np.round(Z30[box & np.isfinite(Z30)])
    level = np.bincount(vals.astype(int) - int(vals.min())).argmax() + vals.min()
    m = box & (np.abs(Z30 - level) < 1.5)
    lake30 |= m
    print(f"lac {name} : niveau SRTM {level:.0f} m, {m.sum() * (DX / F) ** 2 / 1e6:.1f} km²")
lake = lake30.reshape(ny, F, nx, F).mean(axis=(1, 3)) > 0.5
glacier = valid & ~lake & (slope < 38) & (((LONC > 6.72) & (Zf > 2750)) | (Zf > 3100))
rock = valid & ~lake & ~glacier & ((slope > 36) | (Zf > 2650))
alp = valid & ~lake & ~glacier & ~rock & (Zf > 1750)
plain = valid & ~lake & (Zf < 650) & (slope < 4)
cover = np.full(Z.shape, 2, np.uint8)
cover[plain] = 3; cover[alp] = 4; cover[rock] = 5; cover[glacier] = 6; cover[lake] = 1; cover[~valid] = 0

# --- facteur de vue du ciel (16 directions, jusqu'à 14 km)
NAZ = 16
jj, ii = np.mgrid[0:ny, 0:nx].astype(np.float32)
steps = np.unique(np.round(np.geomspace(1, 14000 / DX, 50)).astype(int))
svf = np.zeros(Z.shape, np.float32)
for k in range(NAZ):
    az = np.radians(k * 360.0 / NAZ)
    sx, sy = np.sin(az), np.cos(az)
    best = np.zeros(Z.shape, np.float32)
    for s in steps:
        zq = map_coordinates(Zf, [jj - s * sy, ii + s * sx], order=1, mode="nearest")
        best = np.maximum(best, (zq - Zf) / (s * DX))
    svf += np.cos(np.arctan(best)) ** 2 / NAZ
    print(f"  horizon {k + 1}/{NAZ}", end="\r")
print(f"facteur de vue du ciel : moyenne {svf[valid].mean():.3f}, min {svf[valid].min():.3f}")

np.where(valid, np.round(Zf), -32768).astype("<i2").tofile(os.path.join(OUT, "elev.i16"))
cover.tofile(os.path.join(OUT, "cover.u8"))
np.clip(np.round(svf * 255), 0, 255).astype(np.uint8).tofile(os.path.join(OUT, "svf.u8"))
for old in ("normal.i8", "horizon.u8", "up.i8", "slope.u8"):
    p = os.path.join(OUT, old)
    if os.path.exists(p):
        os.remove(p)

# --- fond ombré (2 x la résolution de la grille)
S2 = 2
zc = [200, 400, 800, 1300, 1700, 2100, 2800, 3600, 4800]
cc = np.array([[52, 66, 56], [60, 86, 62], [68, 100, 68], [104, 118, 78], [160, 152, 116], [196, 188, 168], [228, 222, 212], [240, 242, 245], [252, 252, 255]]) / 255
img_h, img_w = ny * S2, nx * S2
yi = (np.arange(img_h) + 0.5) / S2 * F - 0.5
xi = (np.arange(img_w) + 0.5) / S2 * F - 0.5
YI, XI = np.meshgrid(yi, xi, indexing="ij")
Zi = map_coordinates(np.nan_to_num(Z30, nan=-9999), [YI, XI], order=1, mode="nearest")
vi = Zi > -500
Zi = np.where(vi, Zi, 0)
d = DX / S2
gyi, gxi = np.gradient(Zi, d)
gyi = -gyi                                                   # lignes vers le sud -> gradient nord
lx, ly, lz = np.cos(np.radians(42)) * np.sin(np.radians(315)), np.cos(np.radians(42)) * np.cos(np.radians(315)), np.sin(np.radians(42))
n = np.sqrt(1 + (1.6 * gxi) ** 2 + (1.6 * gyi) ** 2)
sh = 0.35 + 0.85 * np.clip((-1.6 * gxi * lx - 1.6 * gyi * ly + lz) / n, 0, 1)
rgb = np.stack([np.interp(Zi, zc, cc[:, k]) for k in range(3)], axis=-1) * sh[..., None]
lake_i = map_coordinates(lake30.astype(np.float32), [YI, XI], order=1) > 0.5
glac_i = map_coordinates((glacier.repeat(F, 0).repeat(F, 1)).astype(np.float32), [YI, XI], order=0) > 0.5
rgb[glac_i] = rgb[glac_i] * 0.35 + np.array([0.86, 0.92, 0.97]) * 0.65 * sh[glac_i][:, None]
rgb[lake_i] = [0.22, 0.46, 0.72]
rgb[~vi] = [0.16, 0.17, 0.18]
Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(os.path.join(OUT, "relief.jpg"), quality=84)

# --- lieux : sommets recalés sur le point le plus haut à moins de 1,2 km
PLACES = [
    # Bauges
    ("Nivolet", 45.6210, 5.9676, "peak", 1547), ("Revard", 45.6838, 5.9761, "peak", 1562), ("Mont Peney", 45.5986, 5.9900, "peak", 1356),
    ("Margériaz", 45.6307, 6.0344, "peak", 1845), ("Colombier", 45.6444, 6.1193, "peak", 2045), ("Trélod", 45.6925, 6.1969, "peak", 2181),
    ("Arcalod", 45.6844, 6.2285, "peak", 2217), ("Pécloz", 45.6315, 6.2293, "peak", 2197), ("Arclusaz", 45.6072, 6.2065, "peak", 2041),
    ("Galoppaz", 45.5662, 6.0664, "peak", 1681), ("Semnoz", 45.7969, 6.1046, "peak", 1699),
    # Bugey, Vercors, Taillefer (OpenStreetMap)
    ("Grand Colombier", 45.90123, 5.76090, "peak", 1534), ("Dent du Chat", 45.67501, 5.83331, "peak", 1390),
    ("Moucherotte", 45.14760, 5.63945, "peak", 1901), ("Grand Veymont", 44.86974, 5.52670, "peak", 2341),
    ("Taillefer", 45.03936, 5.92424, "peak", 2857),
    # Chartreuse
    ("Granier", 45.4640, 5.9300, "peak", 1933), ("Dent de Crolles", 45.3093, 5.8530, "peak", 2062), ("Chamechaude", 45.2876, 5.7884, "peak", 2082),
    ("Grand Som", 45.37056, 5.81194, "peak", 2026), ("Charmant Som", 45.32528, 5.76417, "peak", 1867),
    # Belledonne
    ("Croix de Chamrousse", 45.12585, 5.90247, "peak", 2253), ("Grand Pic de Belledonne", 45.17111, 5.99167, "peak", 2977),
    # Bornes, Aravis
    ("Parmelan", 45.94156, 6.24551, "peak", 1856), ("Tournette", 45.82722, 6.28610, "peak", 2350),
    ("Jallouvre", 45.99583, 6.45222, "peak", 2408), ("Pointe Percée", 45.95583, 6.55560, "peak", 2750), ("Charvin", 45.80250, 6.42028, "peak", 2409),
    # Beaufortain
    ("Pierra Menta", 45.63806, 6.65083, "peak", 2714), ("Mirantin", 45.68444, 6.49889, "peak", 2460),
    # Haut-Giffre, Mont-Blanc
    ("Buet", 46.0277, 6.8553, "peak", 3096), ("Tenneverge", 46.09417, 6.87944, "peak", 2989),
    ("Mont Blanc", 45.8326, 6.8652, "peak", 4806), ("Aiguille du Midi", 45.8786, 6.8873, "peak", 3842), ("Aiguille Verte", 45.9349, 6.9703, "peak", 4122),
    # villes et terrains
    ("Grenoble", 45.1885, 5.7245, "town", 0), ("Chambéry", 45.5660, 5.9210, "town", 0), ("Annecy", 45.8992, 6.1294, "town", 0),
    ("Albertville", 45.6760, 6.3930, "town", 0), ("Aix-les-Bains", 45.6890, 5.9150, "town", 0), ("Montmélian", 45.5030, 6.0560, "town", 0),
    ("Cluses", 46.0600, 6.5790, "town", 0), ("Sallanches", 45.9360, 6.6310, "town", 0), ("Chamonix", 45.9237, 6.8694, "town", 0),
    ("Beaufort", 45.7190, 6.5730, "town", 0), ("Allevard", 45.3950, 6.0750, "town", 0), ("Samoëns", 46.0830, 6.7280, "town", 0),
    ("La Clusaz", 45.9040, 6.4230, "town", 0), ("Villard-de-Lans", 45.0711, 5.5531, "town", 0), ("La Mure", 44.9030, 5.7880, "town", 0), ("Le Châtelard", 45.6870, 6.1370, "town", 0), ("Saint-Pierre-de-Chartreuse", 45.3430, 5.8160, "town", 0),
    ("Challes-les-Eaux", 45.5610, 5.9760, "field", 0), ("Annecy-Meythet", 45.9290, 6.1068, "field", 0), ("Le Versoud", 45.2170, 5.8500, "field", 0),
    ("Albertville (aérodrome)", 45.6275, 6.3297, "field", 0), ("Sallanches Mont-Blanc", 45.9530, 6.6390, "field", 0),
]
places = []
for name, la, lo, kind, alt in PLACES:
    i, j = (lo - WEST) / (EAST - WEST) * nx, (NORTH - la) / (NORTH - SOUTH) * ny
    i0, j0 = int(i), int(j)
    if kind == "peak":
        # sommet = maximum local du relief, à moins de 1,5 km (coordonnées vérifiées sur Wikipédia), dont l'altitude est compatible avec la cote
        # (la maille de 150 m rabote les pointes de 30 à 250 m) ; parmi les candidats, le plus proche
        r = int(1500 // DX)
        ja, ia = max(0, j0 - r), max(0, i0 - r)
        win = Zf[ja:j0 + r + 1, ia:i0 + r + 1]
        best = None
        for jm, im in zip(*np.nonzero((win > alt - 260) & (win < alt + 40))):
            jg, ig = ja + jm, ia + im
            if Zf[jg, ig] < Zf[max(0, jg - 3):jg + 4, max(0, ig - 3):ig + 4].max():
                continue
            dist = np.hypot(ig - i, jg - j) * DX
            if best is None or dist < best[0]:
                best = (dist, jg, ig)
        if best is None:
            print(f"{name:26s} attendu {alt:4d} m | introuvable, lieu retiré")
            continue
        dist, j0, i0 = best
        print(f"{name:26s} attendu {alt:4d} m | grille {Zf[j0, i0]:4.0f} m | décalage {dist:5.0f} m")
        la, lo = latc[j0], lonc[i0]
    places.append(dict(name=name, lat=round(float(la), 5), lon=round(float(lo), 5), kind=kind, alt=int(round(float(Zf[j0, i0])))))

meta = dict(nx=nx, ny=ny, dx=DX, lat0=LAT0, lon0=LON0, west=WEST, east=float(LON0 + (x0 + nx * DX) / KX),
            south=float(LAT0 + (y1 - ny * DX) / KY), north=NORTH, places=places)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for f in sorted(os.listdir(OUT)):
    print(f"  {f:14s} {os.path.getsize(os.path.join(OUT, f)) / 1024:8.0f} ko")
names = dict(horsdonnees=0, lac=1, foret=2, vallee=3, alpage=4, rocher=5, glacier=6)
print("nature du sol (%) :", {k: round(100 * float((cover == v).mean()), 1) for k, v in names.items()})
