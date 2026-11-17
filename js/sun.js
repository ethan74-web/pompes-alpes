// Position du soleil (formules approchées de l'Almanach astronomique, précision ~0,01°).
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

/** utcMs : instant UTC en millisecondes. Retourne la hauteur et l'azimut (0 = nord, 90 = est) en degrés. */
export function sunPosition(utcMs, latDeg, lonDeg) {
  const d = utcMs / 86400000 + 2440587.5 - 2451545.0;
  const g = rad(357.529 + 0.98560028 * d);
  const q = 280.459 + 0.98564736 * d;
  const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 18.697374558 + 24.06570982441908 * d;
  const ha = rad(gmst * 15 + lonDeg) - ra;
  const lat = rad(latDeg);
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { el: deg(el), az: (deg(az) + 360) % 360 };
}
