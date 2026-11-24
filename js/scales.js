// Échelles de couleur partagées entre la carte (fil principal) et le calcul (Web Worker).
export function ramp(stops) {
  return v => {
    if (v <= stops[0][0]) return stops[0][1];
    for (let k = 1; k < stops.length; k++) {
      if (v <= stops[k][0]) {
        const t = (v - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]), a = stops[k - 1][1], b = stops[k][1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return stops[stops.length - 1][1];
  };
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const SCALES = {
  climb: { cap: "Vario moyen en spirale (intégrateur 30 s, inclinaison adaptée), m/s", ticks: [1, 2, 3, 4, 5, 6],
    col: ramp([[0.2, hex("#fff7c2")], [1, hex("#fde047")], [2, hex("#fb923c")], [3, hex("#ef4444")], [4, hex("#c026d3")], [5, hex("#7c3aed")], [6, hex("#3730a3")]]) },
  ceil: { cap: "Plafond utilisable (m, altitude)", ticks: [1200, 1800, 2400, 3000, 3600, 4200],
    col: ramp([[1200, hex("#3b82f6")], [1800, hex("#22d3ee")], [2400, hex("#4ade80")], [3000, hex("#facc15")], [3600, hex("#f97316")], [4200, hex("#dc2626")]]) },
  heat: { cap: "Chaleur rendue à l'air par le sol (W/m²)", ticks: [50, 150, 250, 350, 450],
    col: ramp([[50, hex("#5a2412")], [150, hex("#a8401a")], [250, hex("#d95926")], [350, hex("#f0a070")], [450, hex("#fbe3cf")]]) },
  wave: { cap: "Onde de relief : où la chercher (λ/2 et 3λ/2 sous le vent des crêtes), indice", ticks: [0.1, 0.25, 0.5, 0.75, 1],
    col: ramp([[0.05, hex("#1e3a8a")], [0.3, hex("#3b82f6")], [0.6, hex("#93c5fd")], [1, hex("#ffffff")]]) },
  ridge: { cap: "Vol de pente (vent + soleil sur la pente) : Vz en ligne droite le long du relief, m/s", ticks: [0.5, 1, 1.5, 2, 3],
    col: ramp([[0.1, hex("#d1fae5")], [0.6, hex("#34d399")], [1.2, hex("#0ea5e9")], [2, hex("#6366f1")], [3, hex("#a21caf")]]) },
  conv: { cap: "Alimentation : chaleur collectée par les brises et le vent (indice)", ticks: [0.25, 0.5, 0.75, 1, 1.25, 1.5],
    col: ramp([[0.15, hex("#0c4a36")], [0.6, hex("#199e70")], [1.1, hex("#a9ecd2")], [1.5, hex("#ffffff")]]) },
};

export const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
