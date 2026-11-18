"""
Nature du sol réelle : ESA WorldCover 2021 v200 (10 m, CC BY 4.0) ramenée à la grille de 150 m du site.

Chaque maille compte ses pixels de 10 m par classe WorldCover, regroupés en types du modèle, et prend le type dominant
(comme les modèles météo). Un lac exige au moins la moitié d'eau. Prairies sous 900 m : fond de vallée (prés humides,
cultures) ; au-dessus : alpage. Nouveau type 7 : zones bâties (sol sec, sombre, qui stocke la chaleur).

Types : 0 hors données, 1 lac, 2 forêt, 3 fond de vallée et cultures, 4 alpage et landes, 5 rocher et éboulis, 6 glacier, 7 bâti.
Écrit data/cover.u8 (l'ancienne nature déduite du relief est gardée dans ../data/cover_relief.u8).
"""
import glob, json, os, shutil, struct, zlib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..")
WC = os.path.join(SITE, "..", "data", "worldcover")
meta = json.load(open(os.path.join(SITE, "data", "meta.json"), encoding="utf-8"))
nx, ny, W, E, S, N = meta["nx"], meta["ny"], meta["west"], meta["east"], meta["south"], meta["north"]
dlon, dlat = (E - W) / nx, (N - S) / ny
elev = np.fromfile(os.path.join(SITE, "data", "elev.i16"), "<i2").reshape(ny, nx)
old = np.fromfile(os.path.join(SITE, "data", "cover.u8"), np.uint8).reshape(ny, nx)

# classes WorldCover -> indice 0..9 (255 : ignoré)
LUT = np.full(256, 255, np.uint8)
for k, c in enumerate([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]): LUT[c] = k
NAMES = ["arbres", "arbustes", "prairies", "cultures", "bâti", "sol nu", "neige/glace", "eau", "zones humides", "mousses"]
counts = np.zeros((ny * nx, 10), np.uint32)

def ifd0(f):
    hdr = f.read(8); bo = "<" if hdr[:2] == b"II" else ">"
    off = struct.unpack(bo + "I", hdr[4:8])[0]; f.seek(off)
    n = struct.unpack(bo + "H", f.read(2))[0]; tags = {}
    for _ in range(n):
        e = f.read(12); tag, typ, cnt = struct.unpack(bo + "HHI", e[:8]); tags[tag] = (typ, cnt, e[8:])
    def vals(tag):
        typ, cnt, raw = tags[tag]
        size = {3: 2, 4: 4, 12: 8, 16: 8}[typ]; fmt = {3: "H", 4: "I", 12: "d", 16: "Q"}[typ]
        if size * cnt <= 4: return struct.unpack(bo + fmt * cnt, raw[:size * cnt])
        pos = struct.unpack(bo + "I", raw)[0]; cur = f.tell(); f.seek(pos); d = f.read(size * cnt); f.seek(cur)
        return struct.unpack(bo + fmt * cnt, d)
    assert vals(259)[0] == 8, "compression inattendue"
    return {"w": vals(256)[0], "h": vals(257)[0], "tw": vals(322)[0], "th": vals(323)[0], "off": vals(324), "cnt": vals(325),
            "scale": vals(33550), "tie": vals(33922)}

for path in sorted(glob.glob(os.path.join(WC, "*_Map.tif"))):
    with open(path, "rb") as f:
        I = ifd0(f)
        px, lon0, lat0 = I["scale"][0], I["tie"][3], I["tie"][4]
        across = -(-I["w"] // I["tw"])
        c0 = max(0, int((W - lon0) / px) // I["tw"]); c1 = min(across - 1, int((E - lon0) / px) // I["tw"])
        r0 = max(0, int((lat0 - N) / px) // I["th"]); r1 = min(-(-I["h"] // I["th"]) - 1, int((lat0 - S) / px) // I["th"])
        if c1 < c0 or r1 < r0: continue
        done = 0
        for tr in range(r0, r1 + 1):
            for tc in range(c0, c1 + 1):
                k = tr * across + tc
                f.seek(I["off"][k]); a = np.frombuffer(zlib.decompress(f.read(I["cnt"][k])), np.uint8).reshape(I["th"], I["tw"])
                lons = lon0 + (tc * I["tw"] + np.arange(I["tw"]) + 0.5) * px
                lats = lat0 - (tr * I["th"] + np.arange(I["th"]) + 0.5) * px
                ci = np.floor((lons - W) / dlon).astype(np.int64); cj = np.floor((N - lats) / dlat).astype(np.int64)
                okc, okr = (ci >= 0) & (ci < nx), (cj >= 0) & (cj < ny)
                if not okc.any() or not okr.any(): continue
                cls = LUT[a[np.ix_(okr, okc)]]
                cell = (cj[okr][:, None] * nx + ci[okc][None, :])
                m = cls != 255
                idx = cell[m] * 10 + cls[m]
                lo, hi = idx.min(), idx.max()
                counts.reshape(-1)[lo:hi + 1] += np.bincount(idx - lo, minlength=hi - lo + 1).astype(np.uint32)
                done += 1
        print(os.path.basename(path), done, "blocs de 1024 px", flush=True)

tot = counts.sum(1)
print("mailles couvertes :", round(100 * float((tot > 0).mean()), 1), "%")
# regroupement en types du modèle
g = np.zeros((ny * nx, 8), np.uint32)
low = (elev.reshape(-1) < 900)
g[:, 2] = counts[:, 0]                                                   # forêt
g[:, 3] = counts[:, 3] + counts[:, 8] + np.where(low, counts[:, 2] + counts[:, 1], 0)    # cultures, zones humides, prés bas
g[:, 4] = np.where(low, 0, counts[:, 2] + counts[:, 1])                  # alpages, landes
g[:, 5] = counts[:, 5] + counts[:, 9]                                     # rocher, éboulis, mousses
g[:, 6] = counts[:, 6]                                                   # glacier
g[:, 7] = counts[:, 4]                                                   # bâti
g[:, 1] = counts[:, 7]                                                   # eau
cover = g[:, 2:].argmax(1).astype(np.uint8) + 2
cover[counts[:, 7] * 2 >= np.maximum(tot, 1)] = 1                        # lac : au moins la moitié d'eau
cover[tot == 0] = old.reshape(-1)[tot == 0]
cover[old.reshape(-1) == 0] = 0
cover = cover.reshape(ny, nx)

names = {1: "lac", 2: "forêt", 3: "fond de vallée", 4: "alpage", 5: "rocher", 6: "glacier", 7: "bâti"}
print("avant (relief) :", {v: round(100 * float((old == k).mean()), 1) for k, v in names.items()})
print("après (WorldCover) :", {v: round(100 * float((cover == k).mean()), 1) for k, v in names.items()})
print("classes WorldCover (%) :", {NAMES[k]: round(100 * float(counts[:, k].sum() / max(1, tot.sum())), 1) for k in range(10)})
backup = os.path.join(SITE, "..", "data", "cover_relief.u8")
if not os.path.exists(backup): shutil.copy(os.path.join(SITE, "data", "cover.u8"), backup)
cover.tofile(os.path.join(SITE, "data", "cover.u8"))
print("écrit data/cover.u8")
