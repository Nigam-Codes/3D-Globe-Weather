// Air quality — Open-Meteo Air Quality API (same provider/keyless/CORS as the weather
// feed). Grid fetch powers the US-AQI heatmap field; point fetch powers the detail panel.

const AQ_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GRID_TTL_MS = 15 * 60 * 1000;
let gridCache = { points: null, at: 0 };

// US AQI category bands (EPA), used for both color and the text label in the detail panel.
export const AQI_BANDS = [
  { max: 50,  name: 'Good',            color: '#2ecc71' },
  { max: 100, name: 'Moderate',        color: '#f1c40f' },
  { max: 150, name: 'Unhealthy (SG)',  color: '#e67e22' },
  { max: 200, name: 'Unhealthy',       color: '#e74c3c' },
  { max: 300, name: 'Very Unhealthy',  color: '#9b59b6' },
  { max: 9999, name: 'Hazardous',      color: '#7e0023' },
];
export function aqiBand(aqi) {
  return AQI_BANDS.find(b => aqi <= b.max) || AQI_BANDS[AQI_BANDS.length - 1];
}

export async function fetchAQGrid(grid) {
  const now = Date.now();
  if (gridCache.points && now - gridCache.at < GRID_TTL_MS) return gridCache.points;

  const chunkSize = 90;
  const chunks = [];
  for (let i = 0; i < grid.length; i += chunkSize) chunks.push(grid.slice(i, i + chunkSize));

  const results = await Promise.all(chunks.map(async (chunk) => {
    const lats = chunk.map(p => p.lat).join(',');
    const lngs = chunk.map(p => p.lng).join(',');
    const url = `${AQ_BASE}?latitude=${lats}&longitude=${lngs}&current=us_aqi`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('AQ grid fetch failed');
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];
    return list.map((d, i) => ({ lat: chunk[i].lat, lng: chunk[i].lng, aqi: d.current?.us_aqi }));
  }));

  const points = results.flat().filter(p => typeof p.aqi === 'number');
  gridCache = { points, at: now };
  return points;
}

export async function fetchAQPoint(lat, lng) {
  try {
    const url = `${AQ_BASE}?latitude=${lat}&longitude=${lng}&current=us_aqi,pm2_5,pm10,ozone`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = await res.json();
    return d.current || null;
  } catch {
    return null;
  }
}
