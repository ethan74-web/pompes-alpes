"""Enregistre la réponse Open-Meteo d'une journée (mêmes points et variables que le site) pour le banc de recalage.
  python -I site/tools/save_day.py 2026-07-08 [modèle]  ->  site/calib/w-2026-07-08-best_match.json
"""
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import archive_meteo as A  # noqa: E402

day, model = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "best_match")
pts = A.points()
q = urllib.parse.urlencode({
    "latitude": ",".join(f"{la:.4f}" for la, lo in pts), "longitude": ",".join(f"{lo:.4f}" for la, lo in pts),
    "elevation": ",".join("nan" for _ in pts), "hourly": ",".join(A.VARS), "models": model, "timezone": "Europe/Paris",
    "wind_speed_unit": "ms", "start_date": day, "end_date": day})
data = json.load(urllib.request.urlopen("https://historical-forecast-api.open-meteo.com/v1/forecast?" + q, timeout=180))
out = os.path.join(A.SITE, "calib", f"w-{day}-{model}.json")
json.dump(data, open(out, "w"), separators=(",", ":"))
print(out, os.path.getsize(out) // 1024, "ko")
