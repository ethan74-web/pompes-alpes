"""Télécharge les tuiles ESA WorldCover 2021 v200 (10 m, CC BY 4.0) qui couvrent la zone, dans data/worldcover."""
import os, sys, urllib.request
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "data", "worldcover")
os.makedirs(OUT, exist_ok=True)
for t in ["N42E003", "N42E006", "N45E003", "N45E006"]:
    name = f"ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
    path = os.path.join(OUT, name)
    if os.path.exists(path) and os.path.getsize(path) > 1e6:
        print("déjà là", name); continue
    url = f"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/{name}"
    urllib.request.urlretrieve(url, path + ".part")
    os.replace(path + ".part", path)
    print("ok", name, round(os.path.getsize(path) / 1e6), "Mo", flush=True)
