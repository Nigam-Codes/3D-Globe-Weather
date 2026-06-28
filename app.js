// Weather Globe Terminal — app logic
// Globe rendering: Globe.gl (Three.js wrapper). All data keyless + CORS-friendly:
//   Open-Meteo (weather, air quality, geocoding) · NOAA SWPC (aurora) ·
//   USGS (earthquakes) · astronomy-engine (sun/planets/moon, computed locally).
import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { CURRENT_PATHS, expandToSegments } from './currents.js';
import { buildSolarSystem } from './solarSystem.js';
import { COUNTRIES, CITIES, tierForAltitude } from './places.js';
import { buildConstellations } from './constellations.js';
import { fetchAurora } from './aurora.js';
import { fetchQuakes } from './quakes.js';
import { fetchAQGrid, fetchAQPoint, aqiBand } from './airquality.js';

const WMO_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Light snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm w/ hail',
};

// ---------- persisted pins + dashboard ----------

const PIN_KEY = 'weatherGlobePins';
const DASH_KEY = 'weatherGlobeDashboard';
function loadJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; } }
let pins = loadJSON(PIN_KEY);
let dashboardItems = loadJSON(DASH_KEY);
function savePins() { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); }
function saveDashboard() { localStorage.setItem(DASH_KEY, JSON.stringify(dashboardItems)); }
function sameCoord(a, b) { return Math.abs(a.lat - b.lat) < 0.001 && Math.abs(a.lng - b.lng) < 0.001; }

// ---------- zoom-based level of detail ----------

let currentTier = 1;
// City dots disclose with zoom, mirroring the labels: none at world view (tier 1)
// for a clean planet, then major→minor cities as you zoom in. Pins, the selected
// location, and quakes are added separately in renderPoints and always show.
function visibleCities() {
  if (currentTier <= 1) return [];
  return CITIES.filter(c => c.tier <= currentTier - 1);
}

// ---------- color + math helpers ----------

function hexToRgb(hex) { const v = parseInt(hex.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
function rgbToCss([r, g, b], a = 1) { return `rgba(${r},${g},${b},${a})`; }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }
function scaleFromStops(stops, alpha = 0.75) {
  const parsed = stops.map(([t, hex]) => [t, hexToRgb(hex)]);
  return function (t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < parsed.length - 1; i++) {
      const [t0, c0] = parsed[i];
      const [t1, c1] = parsed[i + 1];
      if (t >= t0 && t <= t1) {
        const local = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return rgbToCss(lerpColor(c0, c1, local), alpha);
      }
    }
    return rgbToCss(parsed[parsed.length - 1][1], alpha);
  };
}
function normalize(value, min, max) { return Math.max(0, Math.min(1, (value - min) / (max - min))); }

const TEMP_SCALE = scaleFromStops([[0, '#1a3a8f'], [0.35, '#2fa3ff'], [0.55, '#ffd966'], [0.75, '#ff8a4c'], [1, '#ff3b3b']]);
const PRECIP_SCALE = scaleFromStops([[0, '#0a1a33'], [0.3, '#1c4f8f'], [0.6, '#2f8fd8'], [1, '#7bd8ff']]);
const PRESSURE_SCALE = scaleFromStops([[0, '#b042ff'], [0.45, '#4ca3ff'], [0.5, '#16223c'], [0.55, '#ffd966'], [1, '#ff8a4c']]);
const AQI_SCALE = scaleFromStops([[0, '#2ecc71'], [0.25, '#f1c40f'], [0.5, '#e67e22'], [0.75, '#e74c3c'], [1, '#9b59b6']], 0.78);
const QUAKE_COLOR = scaleFromStops([[0, '#ffd34d'], [0.5, '#ff8a3c'], [1, '#ff3b3b']], 1);

// field → { scale, domain, weightKey } config for the single scalar heatmap
const FIELD_CONFIG = {
  temp:     { scale: TEMP_SCALE,     domain: [-30, 45],   key: 'temp' },
  precip:   { scale: PRECIP_SCALE,   domain: [0, 12],     key: 'precip' },
  pressure: { scale: PRESSURE_SCALE, domain: [980, 1040], key: 'pressure' },
  aqi:      { scale: AQI_SCALE,      domain: [0, 200],    key: 'aqi' },
};
const WIND_DOMAIN = [0, 60];

// ---------- weather grid cache ----------

const gridCache = { points: null, fetchedAt: 0 };
const GRID_TTL_MS = 10 * 60 * 1000;

function buildGrid() {
  const points = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lng = -180; lng < 180; lng += 15) points.push({ lat, lng });
  }
  return points;
}

// ---------- resilient fetch with 429 (rate-limit) backoff ----------
// Open-Meteo rate-limits per IP; on a 429 we surface a "RATE-LIMITED" status,
// wait with exponential backoff, and retry so the app recovers on its own.
const delay = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchJSON(url, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt >= retries) throw e;
      await delay(Math.min(20000, 1500 * 2 ** attempt) + Math.random() * 800);
      continue;
    }
    if (res.status === 429) {
      setApiState('limited');
      if (attempt >= retries) throw new Error('rate-limited');
      await delay(Math.min(25000, 2000 * 2 ** attempt) + Math.random() * 1000);
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
}

let gridInflight = null;
async function fetchGridWeather() {
  const now = Date.now();
  if (gridCache.points && now - gridCache.fetchedAt < GRID_TTL_MS) return gridCache.points;
  // share one in-flight request between concurrent callers (e.g. a hash-activated
  // field layer + the monitor tiles both warming up on load) so we never fire the
  // chunked grid fetch twice and trip a transient rate limit
  if (gridInflight) return gridInflight;

  gridInflight = (async () => {
    const grid = buildGrid();
    const chunkSize = 90;
    const chunks = [];
    for (let i = 0; i < grid.length; i += chunkSize) chunks.push(grid.slice(i, i + chunkSize));

    const results = await Promise.all(chunks.map(async (chunk) => {
      const lats = chunk.map(p => p.lat).join(',');
      const lngs = chunk.map(p => p.lng).join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
        `&current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover,surface_pressure`;
      const data = await fetchJSON(url);
      const list = Array.isArray(data) ? data : [data];
      return list.map((d, i) => ({
        lat: chunk[i].lat, lng: chunk[i].lng,
        temp: d.current?.temperature_2m,
        precip: d.current?.precipitation ?? 0,
        windSpeed: d.current?.wind_speed_10m ?? 0,
        windDir: d.current?.wind_direction_10m ?? 0,
        cloudCover: d.current?.cloud_cover ?? 0,
        pressure: d.current?.surface_pressure ?? 1013,
      }));
    }));

    const points = results.flat().filter(p => typeof p.temp === 'number');
    gridCache.points = points;
    gridCache.fetchedAt = Date.now();
    markUpdated();
    setTicker('gridCount', points.length);
    return points;
  })();

  try { return await gridInflight; }
  finally { gridInflight = null; }
}

// Densify the coarse 15° grid into a smooth ~5° field by bilinearly interpolating
// each cell from its four surrounding measured locations — makes the temperature
// (and pressure/precip) overlay read as a true heatmap of nearby temperatures
// rather than coarse blobs. Pure client-side maths, no extra API calls.
const _densifyCache = { key: '', step: 0, fetchedAt: 0, byField: {} };
function densifyField(points, field, step = 5) {
  if (_densifyCache.fetchedAt === gridCache.fetchedAt && _densifyCache.byField[field]) {
    return _densifyCache.byField[field];
  }
  const at = {}; // "lat_lng" -> value
  points.forEach(p => { at[`${p.lat}_${p.lng}`] = p[field]; });
  const val = (la, lo) => {
    if (lo >= 180) lo -= 360; if (lo < -180) lo += 360;
    return at[`${la}_${lo}`];
  };
  const out = [];
  for (let lat = -75; lat <= 75; lat += step) {
    for (let lng = -180; lng < 180; lng += step) {
      const la0 = Math.floor(lat / 15) * 15, la1 = Math.min(75, la0 + 15);
      const lo0 = Math.floor(lng / 15) * 15, lo1 = lo0 + 15;
      const q00 = val(la0, lo0), q01 = val(la0, lo1), q10 = val(la1, lo0), q11 = val(la1, lo1);
      const corners = [q00, q01, q10, q11].filter(v => typeof v === 'number');
      if (!corners.length) continue;
      const ft = (lat - la0) / 15, fg = ((lng - lo0) + 360) % 360 / 15;
      // bilinear with graceful fallback to the mean of any present corners
      let v;
      if (corners.length === 4) {
        v = q00 * (1 - ft) * (1 - fg) + q01 * (1 - ft) * fg + q10 * ft * (1 - fg) + q11 * ft * fg;
      } else {
        v = corners.reduce((a, b) => a + b, 0) / corners.length;
      }
      out.push({ lat, lng, [field]: v });
    }
  }
  if (_densifyCache.fetchedAt !== gridCache.fetchedAt) { _densifyCache.fetchedAt = gridCache.fetchedAt; _densifyCache.byField = {}; }
  _densifyCache.byField[field] = out;
  return out;
}

let aqGridCache = { points: null, fetchedAt: 0 };
async function fetchAQGridCached() {
  const now = Date.now();
  if (aqGridCache.points && now - aqGridCache.fetchedAt < GRID_TTL_MS) return aqGridCache.points;
  const points = await fetchAQGrid(buildGrid());
  aqGridCache = { points, fetchedAt: now };
  return points;
}

// ---------- great-circle helpers ----------

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function declutter(items, minKm) {
  const kept = [];
  for (const item of items) {
    if (kept.every(k => haversineKm(k.lat, k.lng, item.lat, item.lng) > minKm)) kept.push(item);
  }
  return kept;
}
function destinationPoint(lat, lng, bearingDeg, distanceKm) {
  const R = 6371;
  const δ = distanceKm / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI) + 540) % 360 - 180 };
}
function nearestCityName(lat, lng) {
  let best = null, bestD = Infinity;
  for (const c of CITIES) {
    if (c.tier > 2) continue;
    const d = haversineKm(lat, lng, c.lat, c.lng);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best && bestD < 1200 ? best.name : fmtCoord(lat, lng);
}
function fmtCoord(lat, lng) {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;
}

// ---------- moon phase (astronomy-engine, computed locally) ----------

function moonPhase(date = new Date()) {
  try {
    const angle = Astronomy.MoonPhase(date); // 0=new, 90=1st quarter, 180=full, 270=last quarter
    const names = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
    const emoji = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    const idx = Math.round(angle / 45) % 8;
    return `${emoji[idx]} ${names[idx]}`;
  } catch { return '—'; }
}

// ---------- tiny canvas charts ----------

function drawLineChart(canvas, values, colorHex) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 4;
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter(v => typeof v === 'number');
  if (vals.length < 2) return;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = i => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = v => h - pad - ((v - min) / span) * (h - pad * 2);
  // area fill
  ctx.beginPath();
  values.forEach((v, i) => { if (typeof v === 'number') ctx[i === 0 ? 'moveTo' : 'lineTo'](x(i), y(v)); });
  ctx.lineTo(x(values.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  const [r, g, b] = hexToRgb(colorHex);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.32)`); grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath();
  values.forEach((v, i) => { if (typeof v === 'number') ctx[i === 0 ? 'moveTo' : 'lineTo'](x(i), y(v)); });
  ctx.strokeStyle = colorHex; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
}

function drawBarChart(canvas, values, colorHex) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 3;
  ctx.clearRect(0, 0, w, h);
  const vals = values.filter(v => typeof v === 'number');
  if (!vals.length) return;
  const max = Math.max(...vals, 0.1);
  const bw = (w - pad * 2) / values.length;
  const [r, g, b] = hexToRgb(colorHex);
  values.forEach((v, i) => {
    if (typeof v !== 'number') return;
    const bh = (v / max) * (h - pad * 2);
    ctx.fillStyle = v > 0 ? `rgba(${r},${g},${b},0.85)` : 'rgba(255,255,255,0.06)';
    ctx.fillRect(pad + i * bw + 0.5, h - pad - bh, Math.max(1, bw - 1), Math.max(v > 0 ? 1.5 : 0.5, bh));
  });
}

// ---------- globe setup ----------

const world = Globe()
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .showAtmosphere(true).atmosphereColor('#5fd0ff').atmosphereAltitude(0.18)
  .onGlobeClick(({ lat, lng }) => selectLocation(lat, lng, null))
  (document.getElementById('globeViz'));

world.width(window.innerWidth).height(window.innerHeight);
window.addEventListener('resize', () => world.width(window.innerWidth).height(window.innerHeight));

world.controls().autoRotate = true;
world.controls().autoRotateSpeed = 0.4;
world.controls().enableDamping = true;
world.pointOfView({ lat: 15, lng: 10, altitude: 2.4 }, 0);

const MIN_ALTITUDE = 0.28;
world.controls().minDistance = world.getGlobeRadius() * (1 + MIN_ALTITUDE);

(function sharpenGlobeTexture() {
  const mat = world.globeMaterial();
  if (mat && mat.map) {
    mat.map.anisotropy = world.renderer().capabilities.getMaxAnisotropy();
    mat.map.minFilter = THREE.LinearMipmapLinearFilter;
    mat.map.needsUpdate = true;
    return;
  }
  setTimeout(sharpenGlobeTexture, 200);
})();

let userInteracted = false;
['pointerdown', 'wheel'].forEach(evt => {
  document.getElementById('globeViz').addEventListener(evt, () => {
    if (!userInteracted) { userInteracted = true; world.controls().autoRotate = false; }
  });
});

(function breatheAtmosphere() {
  const t = performance.now() / 1000;
  world.atmosphereAltitude(0.18 + Math.sin(t * 0.5) * 0.02);
  requestAnimationFrame(breatheAtmosphere);
})();

function updateTierFromAltitude() {
  const tier = tierForAltitude(world.pointOfView().altitude);
  if (tier !== currentTier) { currentTier = tier; renderPoints(); refreshLabels(); }
}
world.controls().addEventListener('change', updateTierFromAltitude);
setInterval(updateTierFromAltitude, 800);

// ---------- background solar system + constellations ----------

buildSolarSystem(world.scene());
buildConstellations(world.scene());

// ---------- stylized cloud layer (real cloud-cover %) ----------

const CLOUD_CANVAS_SIZE = 1024;
const cloudCanvas = document.createElement('canvas');
cloudCanvas.width = CLOUD_CANVAS_SIZE; cloudCanvas.height = CLOUD_CANVAS_SIZE / 2;
const cloudCtx = cloudCanvas.getContext('2d');
const cloudTexture = new THREE.CanvasTexture(cloudCanvas);
cloudTexture.wrapS = THREE.RepeatWrapping;
const cloudMesh = new THREE.Mesh(
  new THREE.SphereGeometry(world.getGlobeRadius() * 1.012, 75, 75),
  new THREE.MeshBasicMaterial({ map: cloudTexture, transparent: true, opacity: 0.85, depthWrite: false })
);
cloudMesh.visible = false;
world.scene().add(cloudMesh);

function drawClouds(points, t = 0) {
  const ctx = cloudCtx;
  ctx.clearRect(0, 0, cloudCanvas.width, cloudCanvas.height);
  points.forEach(p => {
    const cover = p.cloudCover ?? 0;
    if (cover < 8) return;
    const jx = Math.sin(t * 0.6 + p.lat * 0.4 + p.lng * 0.1) * 4;
    const jy = Math.cos(t * 0.5 + p.lng * 0.4) * 2.5;
    const x = ((p.lng + 180) / 360) * cloudCanvas.width + jx;
    const y = ((90 - p.lat) / 180) * cloudCanvas.height + jy;
    const breathe = 0.82 + Math.sin(t * 0.9 + p.lat + p.lng) * 0.18;
    const r = (18 + (cover / 100) * 46) * breathe;
    const alpha = Math.min(0.75, 0.12 + (cover / 100) * 0.55) * breathe;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`); grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (x < r) { ctx.save(); ctx.translate(cloudCanvas.width, 0); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    else if (x > cloudCanvas.width - r) { ctx.save(); ctx.translate(-cloudCanvas.width, 0); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  });
  cloudTexture.needsUpdate = true;
}

let cloudAnimT = 0, lastCloudDraw = 0;
function animateClouds(now) {
  if (cloudMesh.visible && gridCache.points && now - lastCloudDraw > 80) {
    lastCloudDraw = now; cloudAnimT += 0.08; drawClouds(gridCache.points, cloudAnimT);
  }
  requestAnimationFrame(animateClouds);
}
requestAnimationFrame(animateClouds);

// ---------- aurora layer (NOAA OVATION, glowing polar ovals) ----------

const AUR_W = 1024, AUR_H = 512;
const auroraCanvas = document.createElement('canvas');
auroraCanvas.width = AUR_W; auroraCanvas.height = AUR_H;
const auroraCtx = auroraCanvas.getContext('2d');
const auroraTexture = new THREE.CanvasTexture(auroraCanvas);
auroraTexture.wrapS = THREE.RepeatWrapping;
const auroraMesh = new THREE.Mesh(
  new THREE.SphereGeometry(world.getGlobeRadius() * 1.022, 80, 80),
  new THREE.MeshBasicMaterial({ map: auroraTexture, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending })
);
auroraMesh.visible = false;
world.scene().add(auroraMesh);
let auroraData = null;

function drawAurora(t = 0) {
  const ctx = auroraCtx;
  ctx.clearRect(0, 0, AUR_W, AUR_H);
  if (!auroraData) return;
  auroraData.points.forEach(p => {
    const shimmer = 0.78 + Math.sin(t * 1.6 + p.lng * 0.15 + p.lat * 0.2) * 0.22;
    const x = ((p.lng + 180) / 360) * AUR_W;
    const y = ((90 - p.lat) / 180) * AUR_H;
    const intensity = p.prob / 100;
    const r = (5 + intensity * 22) * shimmer;
    const a = Math.min(0.9, 0.1 + intensity * 0.85) * shimmer;
    // green core → teal → magenta tail for stronger activity (real aurora color progression)
    const col = intensity > 0.6 ? [180, 120, 255] : intensity > 0.3 ? [80, 247, 200] : [70, 230, 150];
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
    grad.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  });
  auroraTexture.needsUpdate = true;
}

let auroraAnimT = 0, lastAuroraDraw = 0;
function animateAurora(now) {
  if (auroraMesh.visible && auroraData && now - lastAuroraDraw > 90) {
    lastAuroraDraw = now; auroraAnimT += 0.08; drawAurora(auroraAnimT);
  }
  requestAnimationFrame(animateAurora);
}
requestAnimationFrame(animateAurora);

// ---------- ocean current arcs ----------

const CURRENT_ARCS = expandToSegments(CURRENT_PATHS);

// ---------- wind particle flow (ported from the animated build) ----------
// thousands of points advected across the surface by the live wind grid, colored
// by speed — replaces the old cone glyphs for the "Wind flow" overlay
const WIND_N = 7000;
const wLat = new Float32Array(WIND_N), wLng = new Float32Array(WIND_N), wLife = new Float32Array(WIND_N);
const wPos = new Float32Array(WIND_N * 3), wCol = new Float32Array(WIND_N * 3);
function seedWind(i) { wLat[i] = Math.random() * 180 - 90; wLng[i] = Math.random() * 360 - 180; wLife[i] = 20 + Math.random() * 80; }
for (let i = 0; i < WIND_N; i++) seedWind(i);

const wGeo = new THREE.BufferGeometry();
wGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
wGeo.setAttribute('color', new THREE.BufferAttribute(wCol, 3));
const windPointsObj = new THREE.Points(wGeo, new THREE.PointsMaterial({
  size: 0.9, vertexColors: true, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
windPointsObj.visible = false;
world.scene().add(windPointsObj);
const WIND_COOL = new THREE.Color('#2de0c9'), WIND_HOT = new THREE.Color('#ffffff');

// lookup of (u,v) wind components on the 15° grid, rebuilt when the grid refreshes
let windLookup = null, windLookupAt = -1;
function getWindLookup() {
  if (!gridCache.points) return null;
  if (windLookup && windLookupAt === gridCache.fetchedAt) return windLookup;
  const m = {};
  gridCache.points.forEach(p => {
    const toRad = (p.windDir + 180) * Math.PI / 180; // direction wind blows TOWARD
    m[`${p.lat}_${p.lng}`] = { u: p.windSpeed * Math.sin(toRad), v: p.windSpeed * Math.cos(toRad), speed: p.windSpeed };
  });
  windLookup = m; windLookupAt = gridCache.fetchedAt;
  return m;
}
function sampleWind(lat, lng) {
  if (!windLookup) return { u: 0, v: 0, speed: 0 };
  let rl = Math.max(-75, Math.min(75, Math.round(lat / 15) * 15));
  let rg = Math.round(lng / 15) * 15; if (rg >= 180) rg -= 360; if (rg < -180) rg += 360;
  return windLookup[`${rl}_${rg}`] || { u: 0, v: 0, speed: 0 };
}

let _windT = performance.now();
function animateWind(now) {
  const dt = Math.min(0.05, (now - _windT) / 1000); _windT = now;
  if (windPointsObj.visible && getWindLookup()) {
    const k = 3.0; // advection strength
    for (let i = 0; i < WIND_N; i++) {
      const w = sampleWind(wLat[i], wLng[i]);
      wLng[i] += (w.u * k * dt) / Math.max(0.2, Math.cos(wLat[i] * Math.PI / 180));
      wLat[i] += w.v * k * dt;
      wLife[i] -= dt * 12;
      if (wLat[i] > 85 || wLat[i] < -85 || wLife[i] <= 0) seedWind(i);
      if (wLng[i] > 180) wLng[i] -= 360; if (wLng[i] < -180) wLng[i] += 360;
      const c = world.getCoords(wLat[i], wLng[i], 0.015);
      wPos[i * 3] = c.x; wPos[i * 3 + 1] = c.y; wPos[i * 3 + 2] = c.z;
      const t = Math.min(1, w.speed / 45);
      wCol[i * 3] = WIND_COOL.r + (WIND_HOT.r - WIND_COOL.r) * t;
      wCol[i * 3 + 1] = WIND_COOL.g + (WIND_HOT.g - WIND_COOL.g) * t;
      wCol[i * 3 + 2] = WIND_COOL.b + (WIND_HOT.b - WIND_COOL.b) * t;
    }
    wGeo.attributes.position.needsUpdate = true;
    wGeo.attributes.color.needsUpdate = true;
  }
  requestAnimationFrame(animateWind);
}
requestAnimationFrame(animateWind);

// ---------- layer state ----------

const FIELDS = ['temp', 'precip', 'pressure', 'aqi'];
const OVERLAYS = ['wind', 'clouds', 'aurora', 'quakes', 'currents', 'peaks', 'labels'];
const layerState = {};
[...FIELDS, ...OVERLAYS].forEach(k => layerState[k] = false);

let quakeData = [];
let cloudPeaks = [];

// ---------- points (cities + pins + quakes + cloud peaks + selection) ----------

let activePoint = null;
let activePinId = null;

function computeCloudPeaks() {
  if (!gridCache.points) return [];
  return [...gridCache.points]
    .filter(p => p.cloudCover >= 75)
    .sort((a, b) => b.cloudCover - a.cloudCover)
    .slice(0, 24)
    .map(p => ({ lat: p.lat, lng: p.lng, cloudCover: Math.round(p.cloudCover), type: 'peak' }));
}

function renderPoints() {
  const points = [];
  visibleCities().forEach(c => points.push({ ...c, type: 'city' }));
  pins.forEach(p => points.push({ ...p, type: 'pin' }));
  if (layerState.peaks) cloudPeaks.forEach(p => points.push(p));
  if (layerState.quakes) quakeData.forEach(q => points.push({ ...q, type: 'quake' }));
  if (activePoint) points.push({ ...activePoint, type: 'active' });

  world
    .pointsData(points)
    .pointLat('lat').pointLng('lng')
    .pointAltitude(d => d.type === 'quake' ? 0.012 : 0.005)
    .pointRadius(d => {
      if (d.type === 'active') return 0.5;
      if (d.type === 'pin') return 0.45;
      if (d.type === 'quake') return 0.2 + normalize(d.mag, 2.5, 7.5) * 0.7;
      if (d.type === 'peak') return 0.4;
      return 0.3;
    })
    .pointColor(d => {
      if (d.type === 'active') return '#ffffff';
      if (d.type === 'pin') return '#ff5ca8';
      if (d.type === 'quake') return QUAKE_COLOR(normalize(d.mag, 2.5, 7));
      if (d.type === 'peak') return 'rgba(220,233,247,0.9)';
      return '#5fd0ff';
    })
    .pointLabel(d => {
      if (d.type === 'quake') return `M${d.mag.toFixed(1)} · ${d.place}`;
      if (d.type === 'peak') return `☁ ${d.cloudCover}% cloud`;
      return d.name || '';
    })
    .pointsMerge(false)
    .onPointClick(d => {
      if (d.type === 'quake') { showQuake(d); return; }
      selectLocation(d.lat, d.lng, d.name || null, d.type === 'pin' ? d.id : null);
    });
  renderRings();
}

function renderRings() {
  const ringTargets = [];
  if (activePoint) ringTargets.push({ lat: activePoint.lat, lng: activePoint.lng, color: 'rgba(255,255,255,0.7)' });
  pins.forEach(p => ringTargets.push({ lat: p.lat, lng: p.lng, color: 'rgba(255,92,168,0.65)' }));
  // pulse the strongest few quakes for emphasis when the layer is on
  if (layerState.quakes) {
    quakeData.filter(q => q.mag >= 4.5).slice(0, 8).forEach(q =>
      ringTargets.push({ lat: q.lat, lng: q.lng, color: 'rgba(255,122,69,0.6)' }));
  }
  world
    .ringsData(ringTargets)
    .ringLat('lat').ringLng('lng').ringColor(d => d.color)
    .ringMaxRadius(2.4).ringPropagationSpeed(2.2).ringRepeatPeriod(1500);
}

// Progressive label disclosure as the user zooms in:
//   far (tier 1)      → nothing (keeps the world view clean)
//   tier 2            → countries
//   tier 3            → + major cities
//   tier 4 (closest)  → + smaller cities / towns
// (True street-level labels would need an external street/vector-tile dataset,
//  which doesn't fit the keyless static design — towns are the finest level here.)
function refreshLabels() {
  if (!layerState.labels || currentTier < 2) { world.labelsData([]); return; }

  const out = [];
  out.push(...declutter(COUNTRIES.map(c => ({ ...c, kind: 'country' })), 140));
  if (currentTier >= 3) {
    const major = CITIES.filter(c => c.tier <= 2).map(c => ({ ...c, kind: 'city' }));
    out.push(...declutter(major, currentTier >= 4 ? 80 : 220));
  }
  if (currentTier >= 4) {
    const towns = CITIES.filter(c => c.tier === 3).map(c => ({ ...c, kind: 'town' }));
    out.push(...declutter(towns, 45));
  }

  world
    .labelsData(out)
    .labelLat('lat').labelLng('lng').labelText('name')
    .labelSize(d => d.kind === 'country' ? 1.1 : d.kind === 'city' ? 0.5 : 0.38)
    .labelColor(d => d.kind === 'country' ? 'rgba(255,207,92,0.9)'
      : d.kind === 'city' ? 'rgba(232,237,245,0.92)' : 'rgba(184,200,228,0.85)')
    .labelDotRadius(d => d.kind === 'country' ? 0 : d.kind === 'city' ? 0.22 : 0.16)
    .labelAltitude(0.007).labelResolution(3).labelIncludeDot(d => d.kind !== 'country');
}
renderPoints();

// ---------- detail panel ----------

const detail = document.getElementById('detail');
const loadingBadge = document.getElementById('loadingBadge');
function setLoading(on) { loadingBadge.classList.toggle('show', on); }

async function selectLocation(lat, lng, name, pinId = null) {
  world.pointOfView({ lat, lng, altitude: 1.6 }, 1200);
  activePoint = { lat, lng, name };
  activePinId = pinId;
  renderPoints();
  updateDetailActionButtons();

  document.getElementById('dName').textContent = name || fmtCoord(lat, lng);
  document.getElementById('dSub').textContent = 'Local conditions · loading…';
  document.getElementById('dMoon').textContent = moonPhase();
  detail.classList.add('open');
  document.getElementById('quakePop').classList.remove('open');
  setLoading(true);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,` +
      `wind_speed_10m,wind_direction_10m,surface_pressure,visibility,uv_index` +
      `&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m,surface_pressure,visibility,uv_index` +
      `&daily=sunrise,sunset&forecast_days=3&timezone=auto`;
    const [wRes, aq] = await Promise.all([fetch(url), fetchAQPoint(lat, lng)]);
    if (!wRes.ok) throw new Error('Weather fetch failed');
    const data = await wRes.json();
    renderDetail(name, lat, lng, data, aq);
    setApi(true);
  } catch (err) {
    document.getElementById('dSub').textContent = 'Could not load weather data';
    setApi(false);
  } finally {
    setLoading(false);
  }
}

let activeForecast = null;

function renderDetail(name, lat, lng, data, aq) {
  const c = data.current || {};
  document.getElementById('dName').textContent = name || fmtCoord(lat, lng);
  document.getElementById('dSub').textContent = 'Local conditions · updated just now';

  const hourly = data.hourly;
  const nowIdx = hourly && Array.isArray(hourly.time) ? Math.max(0, hourly.time.indexOf(c.time)) : 0;
  activeForecast = { current: c, hourly, nowIdx };

  // feels-like, astro, AQI, moon — "now" values that don't scrub with the slider
  document.getElementById('dFeels').textContent =
    typeof c.apparent_temperature === 'number' ? `feels ${Math.round(c.apparent_temperature)}°` : '';
  const daily = data.daily;
  document.getElementById('dSunrise').textContent = daily?.sunrise?.[0]?.slice(11, 16) ?? '—';
  document.getElementById('dSunset').textContent = daily?.sunset?.[0]?.slice(11, 16) ?? '—';
  if (aq && typeof aq.us_aqi === 'number') {
    const band = aqiBand(aq.us_aqi);
    const el = document.getElementById('dAQI');
    el.textContent = `${aq.us_aqi} ${band.name}`;
    el.style.color = band.color;
  } else {
    document.getElementById('dAQI').textContent = '—';
  }

  // 48h sparkline charts
  if (hourly) {
    const slice = (arr) => (arr || []).slice(nowIdx, nowIdx + 48);
    const temps = slice(hourly.temperature_2m);
    const precs = slice(hourly.precipitation);
    drawLineChart(document.getElementById('chartTemp'), temps, '#ff8a4c');
    drawBarChart(document.getElementById('chartPrecip'), precs, '#4ca3ff');
    const tv = temps.filter(v => typeof v === 'number');
    if (tv.length) document.getElementById('chTempRange').textContent = `${Math.round(Math.min(...tv))}° – ${Math.round(Math.max(...tv))}°`;
    const pv = precs.filter(v => typeof v === 'number');
    if (pv.length) document.getElementById('chPrecipRange').textContent = `Σ ${pv.reduce((a, b) => a + b, 0).toFixed(1)} mm`;
  }

  document.getElementById('timeSlider').value = 0;
  renderForecastAt(0);
}

function renderForecastAt(stepIdx) {
  if (!activeForecast) return;
  const { current: c, hourly, nowIdx } = activeForecast;
  const hOffset = stepIdx * 6;
  const idx = nowIdx + hOffset;
  const at = (key, cur) => stepIdx === 0 ? cur : hourly?.[key]?.[idx];

  const temp = at('temperature_2m', c.temperature_2m);
  const wind = at('wind_speed_10m', c.wind_speed_10m);
  const humidity = at('relative_humidity_2m', c.relative_humidity_2m);
  const precip = at('precipitation', c.precipitation);
  const code = at('weather_code', c.weather_code);
  const pressure = at('surface_pressure', c.surface_pressure);
  const vis = at('visibility', c.visibility);
  const uv = at('uv_index', c.uv_index);

  document.getElementById('dTemp').textContent = typeof temp === 'number' ? `${Math.round(temp)}°C` : '—';
  document.getElementById('dCond').textContent = WMO_CODES[code] ?? '—';
  document.getElementById('dWind').textContent = typeof wind === 'number' ? `${Math.round(wind)} km/h` : '—';
  document.getElementById('dHumidity').textContent = typeof humidity === 'number' ? `${Math.round(humidity)}%` : '—';
  document.getElementById('dPrecip').textContent = typeof precip === 'number' ? `${precip.toFixed(1)} mm` : '—';
  document.getElementById('dPressure').textContent = typeof pressure === 'number' ? `${Math.round(pressure)} hPa` : '—';
  document.getElementById('dVis').textContent = typeof vis === 'number' ? `${(vis / 1000).toFixed(0)} km` : '—';
  document.getElementById('dUV').textContent = typeof uv === 'number' ? uv.toFixed(1) : '—';

  document.getElementById('tWhen').textContent = hOffset === 0 ? 'Now' : `+${hOffset}h`;
  if (hOffset > 0 && typeof temp === 'number' && typeof c.temperature_2m === 'number') {
    const delta = temp - c.temperature_2m;
    document.getElementById('tDelta').textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}° vs now`;
  } else {
    document.getElementById('tDelta').textContent = '';
  }
}

document.getElementById('timeSlider').addEventListener('input', (e) => renderForecastAt(Number(e.target.value)));
document.getElementById('detailClose').addEventListener('click', () => detail.classList.remove('open'));

// ---------- quake popover ----------

const quakePop = document.getElementById('quakePop');
function showQuake(q) {
  detail.classList.remove('open');
  world.pointOfView({ lat: q.lat, lng: q.lng, altitude: 1.4 }, 1000);
  document.getElementById('qpMag').textContent = `M ${q.mag.toFixed(1)}`;
  document.getElementById('qpPlace').textContent = q.place;
  const when = q.time ? new Date(q.time).toUTCString().replace('GMT', 'UTC') : '—';
  document.getElementById('qpMeta').innerHTML =
    `Depth ${q.depth != null ? q.depth.toFixed(0) + ' km' : '—'} · ${fmtCoord(q.lat, q.lng)}<br>${when}` +
    (q.tsunami ? '<br><b style="color:#ff7a45">⚠ Tsunami evaluation issued</b>' : '');
  quakePop.classList.add('open');
}
document.getElementById('quakeClose').addEventListener('click', () => quakePop.classList.remove('open'));

// ---------- pins + dashboard actions ----------

const pinActionBtn = document.getElementById('pinAction');
const dashActionBtn = document.getElementById('dashAction');
function updateDetailActionButtons() {
  if (activePinId) { pinActionBtn.textContent = '🗑 Remove pin'; pinActionBtn.classList.add('active'); }
  else { pinActionBtn.textContent = '📌 Drop pin'; pinActionBtn.classList.remove('active'); }
  const inDash = activePoint && dashboardItems.some(d => sameCoord(d, activePoint));
  dashActionBtn.textContent = inDash ? '★ Saved' : '★ Save';
  dashActionBtn.classList.toggle('active', inDash);
}
pinActionBtn.addEventListener('click', () => {
  if (!activePoint) return;
  if (activePinId) { pins = pins.filter(p => p.id !== activePinId); savePins(); activePinId = null; }
  else {
    const fallback = activePoint.name || fmtCoord(activePoint.lat, activePoint.lng);
    const label = window.prompt('Name this pin:', fallback) || fallback;
    const pin = { id: 'pin_' + Date.now(), name: label, lat: activePoint.lat, lng: activePoint.lng };
    pins.push(pin); savePins(); activePinId = pin.id;
  }
  renderPoints(); updateDetailActionButtons(); renderDashboardPanelIfOpen();
});
dashActionBtn.addEventListener('click', () => {
  if (!activePoint) return;
  const idx = dashboardItems.findIndex(d => sameCoord(d, activePoint));
  if (idx >= 0) dashboardItems.splice(idx, 1);
  else dashboardItems.push({ name: activePoint.name || fmtCoord(activePoint.lat, activePoint.lng), lat: activePoint.lat, lng: activePoint.lng });
  saveDashboard(); updateDetailActionButtons(); renderDashboardPanelIfOpen(true);
});

// ---------- dashboard panel ----------

const dashboardPanel = document.getElementById('dashboard');
const dashboardList = document.getElementById('dashboardList');
const dashboardToggle = document.getElementById('dashboardToggle');
const dashboardClose = document.getElementById('dashboardClose');
let dashboardRefreshTimer = null;

dashboardToggle.addEventListener('click', () => {
  const open = dashboardPanel.classList.toggle('open');
  if (open) {
    renderDashboardPanel();
    if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = setInterval(renderDashboardPanel, 10 * 60 * 1000);
  } else if (dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
});
dashboardClose.addEventListener('click', () => {
  dashboardPanel.classList.remove('open');
  if (dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
});
function renderDashboardPanelIfOpen(force) { if (force || dashboardPanel.classList.contains('open')) renderDashboardPanel(); }

async function renderDashboardPanel() {
  const entries = [
    ...dashboardItems.map(d => ({ ...d, isPin: false })),
    ...pins.map(p => ({ ...p, isPin: true })),
  ];
  if (!entries.length) {
    dashboardList.innerHTML = '<div class="dash-empty">Nothing saved yet — select a place and tap "Save to dashboard", or drop a pin.</div>';
    return;
  }
  dashboardList.innerHTML = entries.map((e, i) =>
    `<div class="dash-card" data-idx="${i}">
       <div class="dremove" data-idx="${i}">✕</div>
       <div class="dn">${e.name}${e.isPin ? '<span class="pin-tag">PIN</span>' : ''}</div>
       <div class="dm"><span>loading…</span><span>${fmtCoord(e.lat, e.lng)}</span></div>
     </div>`).join('');
  dashboardList.querySelectorAll('.dremove').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const entry = entries[Number(btn.dataset.idx)];
      if (entry.isPin) { pins = pins.filter(p => p.id !== entry.id); savePins(); renderPoints(); }
      else { dashboardItems = dashboardItems.filter(d => !sameCoord(d, entry)); saveDashboard(); }
      updateDetailActionButtons(); renderDashboardPanel();
    });
  });
  dashboardList.querySelectorAll('.dash-card').forEach(card => {
    card.addEventListener('click', () => {
      const entry = entries[Number(card.dataset.idx)];
      selectLocation(entry.lat, entry.lng, entry.name, entry.isPin ? entry.id : null);
    });
  });
  try {
    const lats = entries.map(e => e.lat).join(',');
    const lngs = entries.map(e => e.lng).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=temperature_2m,weather_code`;
    const res = await fetch(url);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];
    dashboardList.querySelectorAll('.dash-card').forEach((card, i) => {
      const c = list[i]?.current;
      const span = card.querySelector('.dm span');
      span.textContent = c && typeof c.temperature_2m === 'number'
        ? `${Math.round(c.temperature_2m)}°C · ${WMO_CODES[c.weather_code] ?? ''}` : '—';
    });
  } catch { dashboardList.querySelectorAll('.dm span').forEach(s => { s.textContent = '—'; }); }
}

// ---------- zoom controls ----------

document.getElementById('zoomIn').addEventListener('click', () => {
  const p = world.pointOfView();
  world.pointOfView({ lat: p.lat, lng: p.lng, altitude: Math.max(MIN_ALTITUDE, p.altitude * 0.65) }, 500);
});
document.getElementById('zoomOut').addEventListener('click', () => {
  const p = world.pointOfView();
  world.pointOfView({ lat: p.lat, lng: p.lng, altitude: Math.min(3.2, p.altitude / 0.65) }, 500);
});
document.getElementById('zoomHome').addEventListener('click', () => world.pointOfView({ lat: 15, lng: 10, altitude: 2.4 }, 900));

// ---------- search ----------

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.classList.remove('open'); searchResults.innerHTML = ''; return; }
  searchDebounce = setTimeout(() => runSearch(q), 300);
});
async function runSearch(q) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) { searchResults.innerHTML = '<div class="empty">No matches</div>'; searchResults.classList.add('open'); return; }
    searchResults.innerHTML = '';
    items.forEach(r => {
      const div = document.createElement('div');
      div.className = 'item';
      const meta = [r.admin1, r.country].filter(Boolean).join(', ');
      div.innerHTML = `<div class="name">${r.name}</div><div class="meta">${meta}</div>`;
      div.addEventListener('click', () => {
        searchResults.classList.remove('open');
        searchInput.value = r.name;
        selectLocation(r.latitude, r.longitude, r.name);
      });
      searchResults.appendChild(div);
    });
    searchResults.classList.add('open');
  } catch { searchResults.innerHTML = '<div class="empty">Search failed</div>'; searchResults.classList.add('open'); }
}
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) searchResults.classList.remove('open'); });

// ---------- layer controls (chips + rail tiles share data-layer) ----------

const hintText = document.getElementById('hintText');
const layerControls = {};
document.querySelectorAll('[data-layer]').forEach(el => {
  const key = el.dataset.layer;
  (layerControls[key] = layerControls[key] || []).push(el);
  el.addEventListener('click', (e) => { e.stopPropagation(); toggleLayer(key); });
});

function syncControls() {
  Object.entries(layerControls).forEach(([key, els]) => els.forEach(el => el.classList.toggle('on', !!layerState[key])));
  const on = [...FIELDS, ...OVERLAYS].filter(k => layerState[k]);
  hintText.textContent = on.length ? on.join(' · ') : 'none';
}

async function toggleLayer(key) {
  if (!(key in layerState)) return;
  if (FIELDS.includes(key)) {
    const turningOn = !layerState[key];
    FIELDS.forEach(f => layerState[f] = false); // fields are mutually exclusive
    layerState[key] = turningOn;
  } else {
    layerState[key] = !layerState[key];
  }
  syncControls();
  await applyLayers();
}

document.getElementById('pillClear').addEventListener('click', (e) => {
  e.stopPropagation();
  [...FIELDS, ...OVERLAYS].forEach(k => layerState[k] = false);
  syncControls();
  applyLayers();
});

function applyCurrentArcs() {
  if (!layerState.currents) { world.arcsData([]); return; }
  world
    .arcsData(CURRENT_ARCS)
    .arcStartLat('lat1').arcStartLng('lng1').arcEndLat('lat2').arcEndLng('lng2')
    .arcColor(d => d.color)
    .arcStroke(d => 0.4 + Math.min(1.2, d.speed * 0.5))
    .arcAltitude(0.012).arcDashLength(0.4).arcDashGap(0.25)
    .arcDashAnimateTime(d => Math.max(900, 7000 - d.speed * 3200))
    .arcLabel(d => `🌊 ${d.name} · ${d.speed.toFixed(1)} m/s`)
    .arcsTransitionDuration(400)
    .onArcClick(d => {
      const mid = { lat: (d.lat1 + d.lat2) / 2, lng: (d.lng1 + d.lng2) / 2 };
      document.getElementById('qpMag').textContent = `${d.speed.toFixed(1)} m/s`;
      document.getElementById('qpPlace').textContent = d.name;
      document.getElementById('qpMeta').innerHTML =
        `Surface ocean current · documented mean speed<br>${fmtCoord(mid.lat, mid.lng)}`;
      quakePop.querySelector('.qp-mag').style.color = 'var(--current)';
      quakePop.style.borderColor = 'var(--current)';
      quakePop.classList.add('open');
    });
}

async function applyLayers() {
  applyCurrentArcs();
  refreshLabels();
  renderPoints(); // picks up quakes / cloud-peaks toggles

  const field = FIELDS.find(k => layerState[k]);
  const needsWeatherGrid = (field && field !== 'aqi') || layerState.wind || layerState.clouds || layerState.peaks;

  // ensure data is present for whatever is active
  if (needsWeatherGrid && !gridCache.points) {
    setLoading(true);
    try { await fetchGridWeather(); setApi(true); } catch { setApi(false); }
    setLoading(false);
  }
  if (layerState.peaks) { cloudPeaks = computeCloudPeaks(); renderPoints(); }

  // scalar field heatmap (one at a time)
  if (field) {
    const cfg = FIELD_CONFIG[field];
    let pts;
    if (field === 'aqi') {
      setLoading(true);
      try { pts = await fetchAQGridCached(); setApi(true); } catch { setApi(false); pts = []; }
      setLoading(false);
    } else {
      // densify the coarse grid so the field reads as a smooth heatmap of the
      // interpolated temperatures/values of surrounding locations
      pts = gridCache.points ? densifyField(gridCache.points, cfg.key, 5) : [];
    }
    world
      .heatmapsData([pts])
      .heatmapPointLat('lat').heatmapPointLng('lng')
      .heatmapPointWeight(d => normalize(d[cfg.key], cfg.domain[0], cfg.domain[1]) + 0.01)
      .heatmapBandwidth(field === 'aqi' ? 2.6 : 1.6)
      .heatmapColorFn(t => cfg.scale(t))
      .heatmapTopAltitude(0.02);
  } else {
    world.heatmapsData([]);
  }

  // aurora
  if (layerState.aurora) {
    if (!auroraData) { try { auroraData = await fetchAurora(); updateAuroraTile(); } catch { setApi(false); } }
    if (auroraData) { drawAurora(auroraAnimT); auroraMesh.visible = true; }
  } else {
    auroraMesh.visible = false;
  }

  // wind particle flow — the heavy lifting is in animateWind(); here we just
  // warm the grid lookup and show/hide the particle cloud
  if (layerState.wind) { getWindLookup(); windPointsObj.visible = true; }
  else { windPointsObj.visible = false; }

  // clouds
  if (layerState.clouds && gridCache.points) { drawClouds(gridCache.points); cloudMesh.visible = true; }
  else cloudMesh.visible = false;
}


// ---------- global monitor tiles ----------

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

async function updateQuakeTile() {
  try {
    quakeData = await fetchQuakes();
    setText('qkCount', quakeData.length);
    const strongest = quakeData[0];
    setText('qkMax', strongest ? `strongest M${strongest.mag.toFixed(1)} · ${strongest.place}` : 'strongest —');
    const alerts = quakeData.filter(q => q.mag >= 5).length;
    setText('alertCount', alerts);
    setTicker('tkQuakes', quakeData.length);
    // spark of the strongest two-dozen magnitudes
    drawBarChart(document.getElementById('qkSpark'), quakeData.slice(0, 24).map(q => q.mag), '#ff7a45');
    if (layerState.quakes) renderPoints();
    markUpdated(); setApi(true);
  } catch { setApi(false); }
}

function updateAuroraTile() {
  if (!auroraData) return;
  setText('auGW', auroraData.peak);
  setText('auHemi', `N peak ${auroraData.northPeak}% · S peak ${auroraData.southPeak}%`);
}
async function loadAurora() {
  try { auroraData = await fetchAurora(); updateAuroraTile(); markUpdated(); setApi(true); }
  catch { setApi(false); }
}

function updateGridTiles() {
  if (!gridCache.points) return;
  const pts = gridCache.points;
  const cloudAvg = Math.round(pts.reduce((a, p) => a + (p.cloudCover || 0), 0) / pts.length);
  setText('clAvg', cloudAvg);
  const bar = document.getElementById('clBar'); if (bar) bar.style.width = cloudAvg + '%';
  let peak = pts[0];
  pts.forEach(p => { if (p.windSpeed > (peak?.windSpeed ?? 0)) peak = p; });
  if (peak) { setText('wdPeak', Math.round(peak.windSpeed)); setText('wdWhere', `near ${nearestCityName(peak.lat, peak.lng)}`); }
}

// alert chip → jump to strongest quake + enable the layer
document.getElementById('alertChip').addEventListener('click', () => {
  if (!quakeData.length) return;
  if (!layerState.quakes) toggleLayer('quakes');
  showQuake(quakeData[0]);
});

// ---------- top clock + bottom ticker ----------

function tickClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  setText('utcClock', `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`);
  setText('utcDate', now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' UTC');
}
setInterval(tickClock, 1000); tickClock();

function setTicker(id, v) { setText(id, v); }
function markUpdated() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  setText('lastUpdated', `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`);
}
// API status: 'ok' | 'limited' (rate-limited, auto-retrying) | 'degraded'
function setApiState(state) {
  const el = document.getElementById('apiStatus');
  if (!el) return;
  if (state === 'ok') { el.textContent = 'OPERATIONAL'; el.className = 'ok'; el.style.color = ''; }
  else if (state === 'limited') { el.textContent = 'RATE-LIMITED · RETRYING'; el.className = ''; el.style.color = '#ffcf5c'; }
  else { el.textContent = 'DEGRADED'; el.className = ''; el.style.color = '#ff7a45'; }
}
function setApi(ok) { setApiState(ok ? 'ok' : 'degraded'); }

// FPS meter
let frames = 0, lastFpsT = performance.now();
(function fpsLoop(now) {
  frames++;
  if (now - lastFpsT >= 1000) {
    setText('fpsVal', Math.round((frames * 1000) / (now - lastFpsT)));
    frames = 0; lastFpsT = now;
  }
  requestAnimationFrame(fpsLoop);
})(performance.now());

// ---------- shareable deep links: #layers=temp,aurora,quakes ----------
// lets a terminal view be bookmarked/shared with its overlays pre-activated
(function applyHashLayers() {
  const m = location.hash.match(/layers=([a-z,]+)/i);
  if (!m) return;
  m[1].split(',').filter(k => k in layerState).forEach(k => { if (!layerState[k]) toggleLayer(k); });
})();

// ---------- init: warm up the live monitor in the background ----------

function gridLayersActive() {
  return layerState.temp || layerState.precip || layerState.pressure ||
         layerState.wind || layerState.clouds || layerState.peaks;
}

// keep trying the weather grid until it loads (survives a rate-limited start),
// then refresh tiles and re-render any grid-dependent layer that's already on
function warmGrid() {
  fetchGridWeather()
    .then(() => {
      updateGridTiles();
      setApi(true);
      if (gridLayersActive()) applyLayers();
    })
    .catch(() => setTimeout(warmGrid, 15000)); // rate-limited / offline → retry shortly
}

(async function initMonitor() {
  warmGrid();
  updateQuakeTile();
  loadAurora();
  // periodic refresh (also self-heals if a refresh gets rate-limited)
  setInterval(() => { gridCache.fetchedAt = 0; warmGrid(); }, GRID_TTL_MS);
  setInterval(updateQuakeTile, 5 * 60 * 1000);
  setInterval(() => { auroraData = null; loadAurora(); }, 5 * 60 * 1000);
})();
