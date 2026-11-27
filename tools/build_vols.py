"""
Traces de la base de recalage pour le rejeu du site (data/vols/) : un fichier binaire compact par vol et un index.
    python -I tools/build_vols.py
Format d'un vol (little-endian) : Int32 [n, t0 (s UTC), lat0·1e5, lon0·1e5, alt0 (m)] puis, pour chaque point suivant,
Int16 [dt (s), dlat·1e5, dlon·1e5, dalt (m)]. Points espacés d'au moins 3 s. Le fichier IGC d'origine (en-têtes,
nom du pilote, signature) n'est pas publié : seulement la position et l'altitude.
"""
import json, os, struct, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IGC = os.path.join(ROOT, "calib", "igc")
OUT = os.path.join(ROOT, "data", "vols")
STEP = 3

PILOTES = {
    "a": "Auteur du site", "b": "Enno Adema", "c": "Fabrice Pouillard", "d": "Jean-Dominique Berti",
    "e": "Lionel Graire", "f": "Jean-Jacques Bodenmann", "g": "Denis Hyvert", "h": "Eric Schaffter",
}


def read_igc(path):
    fx = []
    for raw in open(path, encoding="latin-1"):
        l = raw.strip()
        if not l.startswith("B") or len(l) < 35:
            continue
        try:
            t = int(l[1:3]) * 3600 + int(l[3:5]) * 60 + int(l[5:7])
            lat = int(l[7:9]) + int(l[9:14]) / 60000
            lon = int(l[15:18]) + int(l[18:23]) / 60000
            pa, ga = int(l[25:30]), int(l[30:35])
        except ValueError:
            continue
        if l[14] == "S": lat = -lat
        if l[23] == "W": lon = -lon
        if not (lat or lon): continue
        fx.append([t, lat, lon, ga if ga > 0 else pa])
    for k in range(1, len(fx)):                       # passage de minuit UTC
        if fx[k][0] < fx[k - 1][0] - 43200:
            for m in range(k, len(fx)): fx[m][0] += 86400
    out = []
    for f in fx:
        if not out or f[0] >= out[-1][0] + STEP: out.append(f)
    return out


def encode(fx):
    q = [(t, round(la * 1e5), round(lo * 1e5), round(a)) for t, la, lo, a in fx]
    b = bytearray(struct.pack("<5i", len(q), *q[0]))
    for p, c in zip(q, q[1:]):
        d = [c[k] - p[k] for k in range(4)]
        if any(abs(x) > 32767 for x in d): raise ValueError("saut trop grand")
        b += struct.pack("<4h", *d)
    return bytes(b)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(OUT, exist_ok=True)
    cat = json.load(open(os.path.join(IGC, "catalogue.json"), encoding="utf-8"))
    oth = json.load(open(os.path.join(IGC, "vols-autres.json"), encoding="utf-8"))
    vols, seen = [], set()
    for v in cat + oth:
        p = os.path.join(IGC, v["fichier"])
        if v["id"] in seen or not os.path.exists(p): continue
        fx = read_igc(p)
        if len(fx) < 60: continue
        try: data = encode(fx)
        except ValueError as e: print(v["fichier"], e); continue
        seen.add(v["id"])
        open(os.path.join(OUT, f"{v['id']}.bin"), "wb").write(data)
        vols.append({"id": v["id"], "date": v["date"], "p": v["pilote"], "planeur": v.get("planeur", ""),
                     "km": v.get("km"), "min": v.get("min") or round((fx[-1][0] - fx[0][0]) / 60),
                     "terrain": v.get("aerodrome") or "Challes-les-Eaux"})
    vols.sort(key=lambda v: (v["p"], v["date"]), reverse=False)
    pil = [{"p": k, "nom": n, "n": sum(v["p"] == k for v in vols)} for k, n in PILOTES.items()]
    json.dump({"pilotes": [x for x in pil if x["n"]], "vols": vols}, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    tot = sum(os.path.getsize(os.path.join(OUT, f"{v['id']}.bin")) for v in vols)
    print(f"{len(vols)} vols, {tot / 1e6:.1f} Mo")


if __name__ == "__main__":
    main()
