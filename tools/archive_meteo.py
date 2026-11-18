"""Stocke sur le site les journées sèches passées (modèle par défaut), pour un affichage immédiat.
  python -I site/tools/archive_meteo.py [--budget N]

Garde : juin à septembre de l'année en cours et de la précédente, plus les 92 derniers jours.
Une journée n'est stockée que si elle est sèche (pluie moyenne sur la zone, de 9 h à 19 h, inférieure à 1 mm).
Heures stockées : 7 h à 21 h (heure de Paris). Format : entiers 16 bits petit-boutiste, [altitudes][variable][point][heure],
valeur = entier x échelle, -32768 = absent. Index : data/meteo/index.json.
Les journées pluvieuses sont simplement chargées en direct depuis Open-Meteo par le site.

L'API gratuite d'Open-Meteo compte une requête de 49 points x 59 variables x 14 jours pour environ 290 appels
(10 000 par jour et 600 par minute au plus) : --budget limite le nombre de requêtes par passage, espacées de 35 s ;
le reste est rattrapé au passage suivant.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
OUT = os.path.join(SITE, "data", "meteo")
MODEL, NG, H0, H1 = "best_match", 7, 7, 21
RECENT = 55
ESSENTIAL = ["temperature_2m", "shortwave_radiation", "direct_normal_irradiance", "cloud_cover", "precipitation", "temperature_700hPa"]
# mêmes variables que js/weather.js (les altitudes des niveaux sont recalculées par le site)
LEVELS = [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550, 500]
LEVELS_HW = [1000, 950, 900, 850, 800, 750, 700, 600, 500]
SURFACE = ["temperature_2m", "dew_point_2m", "surface_pressure", "direct_normal_irradiance", "diffuse_radiation", "shortwave_radiation",
           "sensible_heat_flux", "soil_moisture_0_to_1cm", "snow_depth", "cloud_cover", "cloud_cover_low", "cape",
           "precipitation", "wind_speed_10m", "wind_direction_10m"]
VARS = SURFACE + [f"temperature_{p}hPa" for p in LEVELS] + [f"{k}_{p}hPa" for p in LEVELS_HW for k in ("dew_point", "wind_speed", "wind_direction")]


def scale(name):
    if name.startswith(("temperature", "dew_point")):
        return 0.01
    if name.startswith("wind_speed"):
        return 0.01
    if name.startswith(("wind_direction", "surface_pressure", "direct_normal", "diffuse", "shortwave", "sensible")):
        return 0.1
        return 0.1
    if name.startswith("soil"):
        return 0.0001
    if name.startswith("snow"):
        return 0.001
    if name.startswith(("cloud", "precipitation")):
        return 0.01
    return 1.0                                       # géopotentiel, couche limite, CAPE


def points():
    meta = json.load(open(os.path.join(SITE, "data", "meta.json"), encoding="utf-8"))
    pts = []
    for gy in range(NG):
        for gx in range(NG):
            fx, fy = (gx + 0.5) / NG, (gy + 0.5) / NG
            pts.append((meta["north"] - fy * (meta["north"] - meta["south"]), meta["west"] + fx * (meta["east"] - meta["west"])))
    return pts


def paris_offset(day):
    """Décalage de Paris à midi (heure d'été : du dernier dimanche de mars au dernier dimanche d'octobre)."""
    def last_sunday(m):
        d = dt.date(day.year, m + 1, 1) - dt.timedelta(days=1)
        return d - dt.timedelta(days=(d.weekday() + 1) % 7)
    return 7200 if last_sunday(3) <= day < last_sunday(10) else 3600


def wanted(today):
    days = set()
    for y in (today.year - 1, today.year):
        d = dt.date(y, 6, 1)
        while d <= dt.date(y, 9, 30):
            if d < today - dt.timedelta(days=1):
                days.add(d)
            d += dt.timedelta(days=1)
    for k in range(2, 93):
        days.add(today - dt.timedelta(days=k))
    return days


def fetch(pts, start, end, host):
    q = urllib.parse.urlencode({
        "latitude": ",".join(f"{la:.4f}" for la, lo in pts), "longitude": ",".join(f"{lo:.4f}" for la, lo in pts),
        "elevation": ",".join("nan" for _ in pts), "hourly": ",".join(VARS), "models": MODEL, "timezone": "Europe/Paris",
        "wind_speed_unit": "ms", "start_date": start.isoformat(), "end_date": end.isoformat()})
    for k in range(4):
        try:
            req = urllib.request.Request(f"https://{host}/v1/forecast?" + q, headers={"User-Agent": "pompes-alpes-archive"})
            data = json.load(urllib.request.urlopen(req, timeout=180))
            return data if isinstance(data, list) else [data]
        except Exception as e:                       # noqa: BLE001
            msg = getattr(e, "read", lambda: b"")()[:200]
            print("  échec", start, end, e, msg, file=sys.stderr)
            if b"daily" in msg.lower():
                raise SystemExit("quota quotidien Open-Meteo atteint : reprise au prochain passage")
            time.sleep(65 if b"minute" in msg.lower() else 20 * (k + 1))
    raise SystemExit("Open-Meteo injoignable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=24, help="nombre maximal de requêtes de 14 jours")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    ipath = os.path.join(OUT, "index.json")
    index = json.load(open(ipath)) if os.path.exists(ipath) else {}
    stored = {d: o for d, o in index.get("days", [])}
    checked = set(index.get("wet", []))              # journées pluvieuses déjà vues (non stockées)
    today = dt.date.today()
    want = wanted(today)
    # ménage : journées sorties de la fenêtre
    for d in list(stored):
        if dt.date.fromisoformat(d) not in want:
            f = os.path.join(OUT, d[:4], d + ".bin")
            if os.path.exists(f):
                os.remove(f)
            del stored[d]
    checked = {d for d in checked if dt.date.fromisoformat(d) in want}
    todo = sorted(d for d in want if d.isoformat() not in stored and d.isoformat() not in checked)
    pts = points()
    # regroupe les jours manquants en blocs consécutifs de 14 jours au plus
    blocks, cur = [], []
    edge = today - dt.timedelta(days=RECENT)
    for d in todo:
        if cur and ((d - cur[-1]).days != 1 or len(cur) == 14 or (cur[-1] < edge) != (d < edge)):
            blocks.append(cur); cur = []
        cur.append(d)
    if cur:
        blocks.append(cur)
    print(f"{len(stored)} journées stockées, {len(todo)} à examiner en {len(blocks)} requêtes (budget {args.budget})")
    sc = np.array([scale(v) for v in VARS])
    # l'API de prévision garde les variables de surface ~60 jours (les niveaux de pression plus longtemps) :
    # au-delà de RECENT jours, l'API d'archives
    recent = today - dt.timedelta(days=RECENT)
    blocks.sort(key=lambda b: b[0] < recent)          # d'abord les journées récentes
    try:
        grab(blocks[:args.budget], pts, sc, stored, checked, recent)
    finally:
        index = {"model": MODEL, "ng": NG, "h0": H0, "h1": H1, "vars": VARS, "scale": [float(s) for s in sc],
                 "days": sorted([d, o] for d, o in stored.items()), "wet": sorted(checked),
                 "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="minutes")}
        json.dump(index, open(ipath, "w"), separators=(",", ":"))
        print(f"{len(stored)} journées stockées, {len(checked)} pluvieuses écartées")


def grab(blocks, pts, sc, stored, checked, recent):
    for b in blocks:
        data = fetch(pts, b[0], b[-1], "api.open-meteo.com" if b[0] >= recent else "historical-forecast-api.open-meteo.com")
        times = data[0]["hourly"]["time"]
        elev = np.array([d["elevation"] for d in data])
        for day in b:
            iso = day.isoformat()
            idx = [times.index(f"{iso}T{h:02d}:00") for h in range(H0, H1 + 1)]
            # journée incomplète (variables de surface absentes) : ni stockée ni écartée, reprise plus tard
            if any(all((data[k]["hourly"].get(v) or [None] * len(times))[i] is None for k in range(len(pts)) for i in idx) for v in ESSENTIAL):
                print(f"  {iso} incomplet, repris plus tard", flush=True)
                continue
            rain = np.nanmean([[data[k]["hourly"]["precipitation"][i] or 0 for i in idx[2:13]] for k in range(len(pts))])
            if rain * 11 >= 1.0:
                checked.add(iso)
                continue
            arr = np.full((len(VARS), len(pts), len(idx)), -32768, np.int32)
            for vi, v in enumerate(VARS):
                for k in range(len(pts)):
                    col = data[k]["hourly"].get(v)
                    if col is None:
                        continue
                    vals = np.array([np.nan if col[i] is None else col[i] for i in idx], float)
                    ok = np.isfinite(vals)
                    arr[vi, k, ok] = np.clip(np.round(vals[ok] / sc[vi]), -32767, 32767)
            os.makedirs(os.path.join(OUT, iso[:4]), exist_ok=True)
            with open(os.path.join(OUT, iso[:4], iso + ".bin"), "wb") as f:
                np.clip(np.round(elev), -32767, 32767).astype("<i2").tofile(f)
                arr.astype("<i2").tofile(f)
            stored[iso] = paris_offset(day)
        print(f"  {b[0]} -> {b[-1]} : {sum(1 for d in b if d.isoformat() in stored)} sèches sur {len(b)}", flush=True)
        time.sleep(35)                               # limite de 600 appels par minute


if __name__ == "__main__":
    main()
