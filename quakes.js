// Live earthquakes — USGS GeoJSON feed (public, CORS-enabled, no key).
// "2.5_day" = all magnitude-2.5+ quakes in the past 24h, the standard significant-
// events feed. Returned sorted strongest-first so the monitor tile can headline the
// largest event.

const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const TTL_MS = 5 * 60 * 1000;
let cache = { data: null, at: 0 };

export async function fetchQuakes() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  const res = await fetch(USGS_URL);
  if (!res.ok) throw new Error('Quake fetch failed');
  const j = await res.json();

  const list = (j.features || [])
    .map(f => ({
      lng: f.geometry?.coordinates?.[0],
      lat: f.geometry?.coordinates?.[1],
      depth: f.geometry?.coordinates?.[2],
      mag: f.properties?.mag,
      place: f.properties?.place || 'Unknown location',
      time: f.properties?.time,
      url: f.properties?.url,
      tsunami: f.properties?.tsunami,
    }))
    .filter(q => typeof q.mag === 'number' && typeof q.lat === 'number')
    .sort((a, b) => b.mag - a.mag);

  cache = { data: list, at: now };
  return list;
}
