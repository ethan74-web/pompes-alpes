"""Icônes de l'application installable : spirale de thermique orange sur fond sombre, relief stylisé."""
import math, os
from PIL import Image, ImageDraw

def icon(size, path, pad=0.0):
    s = 4 * size                                      # suréchantillonnage puis réduction (bords lisses)
    im = Image.new("RGB", (s, s), (15, 18, 20))
    d = ImageDraw.Draw(im)
    m = int(s * pad)
    # relief
    d.polygon([(m, s * 0.78), (s * 0.30, s * 0.50), (s * 0.45, s * 0.62), (s * 0.66, s * 0.36), (s - m, s * 0.70), (s - m, s - m), (m, s - m)], fill=(58, 53, 43))
    # spirale du thermique
    cx, cy, pts = s * 0.62, s * 0.36, []
    for k in range(400):
        t = k / 400 * 5.5 * math.pi
        r = s * (0.03 + 0.11 * k / 400)
        pts.append((cx + r * math.cos(t), cy - s * 0.18 * k / 400 + r * 0.35 * math.sin(t)))
    d.line(pts, fill=(249, 115, 22), width=max(4, s // 28), joint="curve")
    im.resize((size, size), Image.LANCZOS).save(path)

here = os.path.join(os.path.dirname(__file__), "..")
icon(192, os.path.join(here, "icon-192.png"))
icon(512, os.path.join(here, "icon-512.png"))
icon(512, os.path.join(here, "icon-maskable.png"), pad=0.1)
print("ok")
