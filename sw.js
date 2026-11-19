// Fonctionnement hors réseau (au terrain, en montagne) : le site, le relief et la dernière météo récupérée restent
// disponibles. Site et météo : réseau d'abord, copie en cache sinon. Archives météo, relief, bibliothèques : cache d'abord.
// Le relief est demandé avec « ?v=version » (lue dans meta.json, toujours par le réseau) : une nouvelle version
// est téléchargée puis remplace l'ancienne dans le cache.
const CACHE = "pompes-v2";
const SHELL = ["./", "index.html", "theorie.html", "style.css", "manifest.webmanifest", "icon-192.png",
  "js/app.js", "js/worker.js", "js/helper.js", "js/model.js", "js/weather.js", "js/sun.js", "js/scales.js", "js/pump3d.js", "js/igc.js",
  "data/meta.json",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheFirst = async req => {
  const hit = await caches.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === "opaque") {
    const c = await caches.open(CACHE), u = new URL(req.url);
    if (u.search) for (const k of await c.keys(req, { ignoreSearch: true })) if (k.url !== req.url) await c.delete(k);
    await c.put(req, r.clone());
  }
  return r;
};
const networkFirst = async req => {
  try {
    // revalidation auprès du serveur (le cache HTTP de GitHub Pages garderait sinon l'ancienne page 10 min)
    const r = await fetch(req.mode === "navigate" ? new Request(req.url, { cache: "no-cache" }) : req, req.mode === "navigate" ? undefined : { cache: "no-cache" });
    if (r.ok) (await caches.open(CACHE)).put(req, r.clone());
    return r;
  } catch (e) {
    const hit = await caches.match(req, { ignoreSearch: req.url.includes("/index.html") || req.mode === "navigate" });
    if (hit) return hit;
    throw e;
  }
};

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET") return;
  // balises en direct et carte en tuiles : jamais en cache (données périmées, règles des serveurs de tuiles)
  if (u.hostname.includes("pioupiou") || u.hostname.includes("tile.openstreetmap") || u.hostname.includes("opentopomap")) return;
  if (u.hostname.endsWith("open-meteo.com")) { e.respondWith(networkFirst(req)); return; }
  if (u.hostname === "unpkg.com" || /\/data\/(meteo\/\d{4}\/|elev|cover|svf|relief)/.test(u.pathname)) { e.respondWith(cacheFirst(req)); return; }
  if (u.origin === self.location.origin) e.respondWith(networkFirst(req));
});
