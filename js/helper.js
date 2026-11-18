// Calcul d'une heure dans un fil d'exécution annexe (plusieurs heures en parallèle sur les processeurs multicœurs).
import { computeHour, loadTerrain, setPolar } from "./model.js";

let T = null, W = null;
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type === "init") { T = await loadTerrain(m.base); self.postMessage({ type: "ready" }); }
    else if (m.type === "weather") W = m.W;
    else if (m.type === "polar") setPolar(m.a, m.b, m.vm);
    else if (m.type === "hour") {
      const F = computeHour(T, W, m.idx);
      const fl = F.flow;
      const tr = [F.H.buffer, F.Hloc.buffer, F.top.buffer, F.ceil.buffer, F.cu.buffer, F.climb.buffer, F.conv.buffer, F.Q.buffer, F.zl.buffer, F.fw.buffer,
        F.ua.buffer, F.va.buffer, fl.down.buffer, fl.fu.buffer, fl.fv.buffer, fl.acc.buffer, fl.src.buffer];
      self.postMessage({ type: "hour", job: m.job, F }, tr);
    }
  } catch (err) { self.postMessage({ type: "error", job: m.job, message: String(err && err.message || err) }); }
};
