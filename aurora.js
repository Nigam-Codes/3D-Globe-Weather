// Live aurora nowcast — NOAA SWPC OVATION model (public JSON, CORS-enabled, no key).
// The feed is a global 1°×1° grid of [longitude, latitude, probability%] for visible
// aurora "right now". We downsample it for rendering and derive a rough hemispheric
// power figure so the Global Monitor tile has a real headline number.

const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const TTL_MS = 5 * 60 * 1000;
let cache = { data: null, at: 0 };

export async function fetchAurora() {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  const res = await fetch(OVATION_URL);
  if (!res.ok) throw new Error('Aurora fetch failed');
  const j = await res.json();

  const points = [];
  let peak = 0, northPeak = 0, southPeak = 0, activeCells = 0;
  for (const [lng0, lat, prob] of j.coordinates) {
    if (prob > 0) {
      activeCells++;
      if (prob > peak) peak = prob;
      if (lat >= 0) { if (prob > northPeak) northPeak = prob; }
      else { if (prob > southPeak) southPeak = prob; }
    }
    // downsample to a ~2° grid and drop negligible probabilities to keep the
    // render light (the raw feed is ~65k points)
    if (prob >= 4 && lat % 2 === 0 && lng0 % 2 === 0) {
      const lng = lng0 > 180 ? lng0 - 360 : lng0;
      points.push({ lat, lng, prob });
    }
  }

  // Headline numbers are taken straight from the feed (probability of visible
  // aurora, 0–100%) — no unit conversion or fudge factor.
  const data = {
    points,
    peak,                 // global peak visible-aurora probability %
    northPeak, southPeak, // per-hemisphere peak %
    activeCells,          // 1° cells with any aurora signal
    obsTime: j['Observation Time'],
    forecastTime: j['Forecast Time'],
  };
  cache = { data, at: now };
  return data;
}
