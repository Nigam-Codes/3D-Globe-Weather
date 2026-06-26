// 3D Globe Weather — app logic
// Globe rendering: Globe.gl (Three.js wrapper). Weather data: Open-Meteo (no key required).
import * as THREE from 'three';
import { CURRENT_PATHS, expandToSegments } from './currents.js';
import { buildSolarSystem } from './solarSystem.js';
import { COUNTRIES, CITIES, tierForAltitude } from './places.js';
import { buildConstellations } from './constellations.js';

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

// ---------- pins + dashboard (persisted locally so they survive reloads) ----------

const PIN_KEY = 'weatherGlobePins';
const DASH_KEY = 'weatherGlobeDashboard';

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
let pins = loadJSON(PIN_KEY);
let dashboardItems = loadJSON(DASH_KEY);
function savePins() { localStorage.setItem(PIN_KEY, JSON.stringify(pins)); }
function saveDashboard() { localStorage.setItem(DASH_KEY, JSON.stringify(dashboardItems)); }
function sameCoord(a, b) { return Math.abs(a.lat - b.lat) < 0.001 && Math.abs(a.lng - b.lng) < 0.001; }

// ---------- zoom-based level of detail ----------

let currentTier = 1;
function visibleCities() {
  return CITIES.filter(c => c.tier <= currentTier);
}

// ---------- small color helpers (no external deps) ----------

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToCss([r, g, b], a = 1) {
  return `rgba(${r},${g},${b},${a})`;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function scaleFromStops(stops) {
  // stops: [[0, '#rrggbb'], [0.5, '#rrggbb'], [1, '#rrggbb'], ...]
  const parsed = stops.map(([t, hex]) => [t, hexToRgb(hex)]);
  return function (t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < parsed.length - 1; i++) {
      const [t0, c0] = parsed[i];
      const [t1, c1] = parsed[i + 1];
      if (t >= t0 && t <= t1) {
        const local = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return rgbToCss(lerpColor(c0, c1, local), 0.75);
      }
    }
    return rgbToCss(parsed[parsed.length - 1][1], 0.75);
  };
}
function normalize(value, min, max) {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

const TEMP_SCALE = scaleFromStops([
  [0, '#1a3a8f'], [0.35, '#2fa3ff'], [0.55, '#ffd966'], [0.75, '#ff8a4c'], [1, '#ff3b3b'],
]);
const PRECIP_SCALE = scaleFromStops([
  [0, '#0a1a33'], [0.3, '#1c4f8f'], [0.6, '#2f8fd8'], [1, '#7bd8ff'],
]);
const TEMP_DOMAIN = [-30, 45];
const PRECIP_DOMAIN = [0, 12];
const WIND_DOMAIN = [0, 60];

// ---------- weather grid cache ----------

const gridCache = { points: null, fetchedAt: 0 };
const GRID_TTL_MS = 10 * 60 * 1000;

function buildGrid() {
  const points = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lng = -180; lng < 180; lng += 15) {
      points.push({ lat, lng });
    }
  }
  return points;
}

async function fetchGridWeather() {
  const now = Date.now();
  if (gridCache.points && now - gridCache.fetchedAt < GRID_TTL_MS) {
    return gridCache.points;
  }
  const grid = buildGrid();
  const chunkSize = 90;
  const chunks = [];
  for (let i = 0; i < grid.length; i += chunkSize) chunks.push(grid.slice(i, i + chunkSize));

  const results = await Promise.all(chunks.map(async (chunk) => {
    const lats = chunk.map(p => p.lat).join(',');
    const lngs = chunk.map(p => p.lng).join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
      `&current=temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,cloud_cover`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Grid fetch failed');
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];
    return list.map((d, i) => ({
      lat: chunk[i].lat,
      lng: chunk[i].lng,
      temp: d.current?.temperature_2m,
      precip: d.current?.precipitation ?? 0,
      windSpeed: d.current?.wind_speed_10m ?? 0,
      windDir: d.current?.wind_direction_10m ?? 0,
      cloudCover: d.current?.cloud_cover ?? 0,
    }));
  }));

  const points = results.flat().filter(p => typeof p.temp === 'number');
  gridCache.points = points;
  gridCache.fetchedAt = now;
  return points;
}

// ---------- great-circle helper (for wind arrow orientation) ----------

function destinationPoint(lat, lng, bearingDeg, distanceKm) {
  const R = 6371;
  const δ = distanceKm / R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180, λ1 = lng * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );
  return { lat: φ2 * 180 / Math.PI, lng: ((λ2 * 180 / Math.PI) + 540) % 360 - 180 };
}

// ---------- globe setup ----------

const world = Globe()
  .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .showAtmosphere(true)
  .atmosphereColor('#5fd0ff')
  .atmosphereAltitude(0.18)
  .onGlobeClick(({ lat, lng }) => selectLocation(lat, lng, null))
  (document.getElementById('globeViz'));

world.width(window.innerWidth).height(window.innerHeight);
window.addEventListener('resize', () => world.width(window.innerWidth).height(window.innerHeight));

world.controls().autoRotate = true;
world.controls().autoRotateSpeed = 0.4;
world.controls().enableDamping = true;
world.pointOfView({ lat: 15, lng: 10, altitude: 2.4 }, 0);

let userInteracted = false;
['pointerdown', 'wheel'].forEach(evt => {
  document.getElementById('globeViz').addEventListener(evt, () => {
    if (!userInteracted) { userInteracted = true; world.controls().autoRotate = false; }
  });
});

// gentle "breathing" atmosphere glow — purely cosmetic, keeps the globe feeling alive even when idle
(function breatheAtmosphere() {
  const t = performance.now() / 1000;
  world.atmosphereAltitude(0.18 + Math.sin(t * 0.5) * 0.02);
  requestAnimationFrame(breatheAtmosphere);
})();

// zoom-driven level of detail: re-render cities/labels only when the altitude crosses a tier boundary
function updateTierFromAltitude() {
  const alt = world.pointOfView().altitude;
  const tier = tierForAltitude(alt);
  if (tier !== currentTier) {
    currentTier = tier;
    renderPoints();
    refreshLabels();
  }
}
world.controls().addEventListener('change', updateTierFromAltitude);
setInterval(updateTierFromAltitude, 800); // fallback for programmatic fly-tos that skip 'change' ticks

// ---------- background solar system (Sun + planets, real positions today) + constellations ----------

buildSolarSystem(world.scene());
buildConstellations(world.scene());
const legendNote = document.getElementById('legendNote');
if (legendNote) {
  legendNote.textContent = 'Sun & planets: real positions for today, via astronomy-engine · Ocean currents: documented current systems (not live telemetry) · Clouds: stylized, driven by live cloud-cover data · Country/city labels & constellations: curated reference sets, illustrative placement';
}

// ---------- stylized cloud layer (real cloud-cover %, drawn as a drifting canvas texture) ----------

const CLOUD_CANVAS_SIZE = 1024;
const cloudCanvas = document.createElement('canvas');
cloudCanvas.width = CLOUD_CANVAS_SIZE;
cloudCanvas.height = CLOUD_CANVAS_SIZE / 2;
const cloudCtx = cloudCanvas.getContext('2d');
const cloudTexture = new THREE.CanvasTexture(cloudCanvas);
cloudTexture.wrapS = THREE.RepeatWrapping;

const cloudGeo = new THREE.SphereGeometry(world.getGlobeRadius() * 1.012, 75, 75);
const cloudMat = new THREE.MeshBasicMaterial({
  map: cloudTexture, transparent: true, opacity: 0.85, depthWrite: false,
});
const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
cloudMesh.visible = false;
world.scene().add(cloudMesh);

function drawClouds(points) {
  const ctx = cloudCtx;
  ctx.clearRect(0, 0, cloudCanvas.width, cloudCanvas.height);
  // soft drifting blobs, sized/opacity-scaled by real cloud-cover % per grid point
  points.forEach(p => {
    const cover = p.cloudCover ?? 0;
    if (cover < 8) return;
    const x = ((p.lng + 180) / 360) * cloudCanvas.width;
    const y = ((90 - p.lat) / 180) * cloudCanvas.height;
    const r = 18 + (cover / 100) * 46;
    const alpha = Math.min(0.75, 0.12 + (cover / 100) * 0.55);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // wrap horizontally so blobs near the seam look continuous
    if (x < r) {
      ctx.save(); ctx.translate(cloudCanvas.width, 0);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    } else if (x > cloudCanvas.width - r) {
      ctx.save(); ctx.translate(-cloudCanvas.width, 0);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  });
  cloudTexture.needsUpdate = true;
}

// slow independent drift, separate from the globe's own rotation — keeps clouds animated even when paused
(function driftClouds() {
  cloudMesh.rotation.y += 0.00025;
  requestAnimationFrame(driftClouds);
})();

// ---------- real ocean current arcs (static dataset, see currents.js) ----------

const CURRENT_ARCS = expandToSegments(CURRENT_PATHS);

// city + pin + selection markers (rendered as WebGL points, not DOM elements)
let activePoint = null; // { lat, lng, name } for the currently selected location
let activePinId = null; // set when the selected point is an existing saved pin

function renderPoints() {
  const points = [...visibleCities()];
  pins.forEach(p => points.push({ ...p, isPin: true }));
  if (activePoint) points.push({ ...activePoint, selected: true });
  world
    .pointsData(points)
    .pointLat('lat')
    .pointLng('lng')
    .pointAltitude(0.005)
    .pointRadius(d => d.selected ? 0.5 : d.isPin ? 0.45 : 0.3)
    .pointColor(d => d.selected ? '#ffffff' : d.isPin ? '#ff5ca8' : '#5fd0ff')
    .pointLabel(d => d.name || '')
    .pointsMerge(false)
    .onPointClick(d => selectLocation(d.lat, d.lng, d.name || null, d.isPin ? d.id : null));
  renderRings();
}

// animated pulsing "ping" rings under the selected location + every saved pin (mockup-style emphasis)
function renderRings() {
  const ringTargets = [];
  if (activePoint) ringTargets.push({ lat: activePoint.lat, lng: activePoint.lng, color: 'rgba(255,255,255,0.7)' });
  pins.forEach(p => ringTargets.push({ lat: p.lat, lng: p.lng, color: 'rgba(255,92,168,0.65)' }));
  world
    .ringsData(ringTargets)
    .ringLat('lat')
    .ringLng('lng')
    .ringColor(d => d.color)
    .ringMaxRadius(2.4)
    .ringPropagationSpeed(2.2)
    .ringRepeatPeriod(1500);
}

// country + city text labels — countries always show when the layer is on; city text only
// appears once zoomed in past world view, so detail "loads in" as the user zooms (city dots
// themselves are always tier-filtered in renderPoints, independent of this label toggle)
function refreshLabels() {
  if (!layerState.labels) { world.labelsData([]); return; }
  const cityLabels = currentTier >= 2 ? visibleCities().map(c => ({ ...c, kind: 'city' })) : [];
  const countryLabels = COUNTRIES.map(c => ({ ...c, kind: 'country' }));
  world
    .labelsData([...countryLabels, ...cityLabels])
    .labelLat('lat')
    .labelLng('lng')
    .labelText('name')
    .labelSize(d => d.kind === 'country' ? 1.15 : 0.55)
    .labelColor(d => d.kind === 'country' ? 'rgba(255,207,92,0.85)' : 'rgba(232,237,245,0.85)')
    .labelDotRadius(d => d.kind === 'country' ? 0 : 0.25)
    .labelAltitude(0.006)
    .labelResolution(2)
    .labelIncludeDot(d => d.kind !== 'country');
}
renderPoints();

// ---------- detail panel ----------

const detail = document.getElementById('detail');
const loadingBadge = document.getElementById('loadingBadge');

function setLoading(on) {
  loadingBadge.classList.toggle('show', on);
}

function fmtCoord(lat, lng) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${latDir}, ${Math.abs(lng).toFixed(1)}°${lngDir}`;
}

async function selectLocation(lat, lng, name, pinId = null) {
  // fly to the point
  world.pointOfView({ lat, lng, altitude: 1.6 }, 1200);

  activePoint = { lat, lng, name };
  activePinId = pinId;
  renderPoints();
  updateDetailActionButtons();

  document.getElementById('dName').textContent = name || fmtCoord(lat, lng);
  document.getElementById('dSub').textContent = 'Local conditions · loading…';
  detail.classList.add('open');
  setLoading(true);

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m` +
      `&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m` +
      `&forecast_days=3&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Weather fetch failed');
    const data = await res.json();
    renderDetail(name, lat, lng, data);
  } catch (err) {
    document.getElementById('dSub').textContent = 'Could not load weather data';
  } finally {
    setLoading(false);
  }
}

// holds the currently selected location's forecast, so the slider can scrub without re-fetching
let activeForecast = null;

function renderDetail(name, lat, lng, data) {
  const c = data.current || {};
  document.getElementById('dName').textContent = name || fmtCoord(lat, lng);
  document.getElementById('dSub').textContent = 'Local conditions · updated just now';

  const hourly = data.hourly;
  const nowIdx = hourly && Array.isArray(hourly.time) ? Math.max(0, hourly.time.indexOf(c.time)) : 0;
  activeForecast = { current: c, hourly, nowIdx, name, lat, lng };

  const timeSlider = document.getElementById('timeSlider');
  timeSlider.value = 0;
  renderForecastAt(0);
}

function renderForecastAt(stepIdx) {
  if (!activeForecast) return;
  const { current: c, hourly, nowIdx } = activeForecast;
  const hOffset = stepIdx * 6; // each slider step = 6h
  const idx = nowIdx + hOffset;

  const temp = stepIdx === 0 ? c.temperature_2m : hourly?.temperature_2m?.[idx];
  const wind = stepIdx === 0 ? c.wind_speed_10m : hourly?.wind_speed_10m?.[idx];
  const humidity = stepIdx === 0 ? c.relative_humidity_2m : hourly?.relative_humidity_2m?.[idx];
  const precip = stepIdx === 0 ? c.precipitation : hourly?.precipitation?.[idx];
  const code = stepIdx === 0 ? c.weather_code : hourly?.weather_code?.[idx];

  document.getElementById('dTemp').textContent = typeof temp === 'number' ? `${Math.round(temp)}°C` : '—';
  document.getElementById('dCond').textContent = WMO_CODES[code] ?? '—';
  document.getElementById('dWind').textContent = typeof wind === 'number' ? `${Math.round(wind)} km/h` : '—';
  document.getElementById('dHumidity').textContent = typeof humidity === 'number' ? `${Math.round(humidity)}%` : '—';
  document.getElementById('dPrecip').textContent = typeof precip === 'number' ? `${precip.toFixed(1)} mm` : '—';

  document.getElementById('tWhen').textContent = hOffset === 0 ? 'Now' : `+${hOffset}h`;
  if (hOffset > 0 && typeof temp === 'number' && typeof c.temperature_2m === 'number') {
    const delta = temp - c.temperature_2m;
    document.getElementById('tDelta').textContent = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}° vs now`;
  } else {
    document.getElementById('tDelta').textContent = '';
  }
}

document.getElementById('timeSlider').addEventListener('input', (e) => {
  renderForecastAt(Number(e.target.value));
});

document.getElementById('detailClose').addEventListener('click', () => detail.classList.remove('open'));

// ---------- pins + dashboard actions ----------

const pinActionBtn = document.getElementById('pinAction');
const dashActionBtn = document.getElementById('dashAction');

function updateDetailActionButtons() {
  if (activePinId) {
    pinActionBtn.textContent = '🗑 Remove pin';
    pinActionBtn.classList.add('active');
  } else {
    pinActionBtn.textContent = '📌 Drop pin';
    pinActionBtn.classList.remove('active');
  }
  const inDash = activePoint && dashboardItems.some(d => sameCoord(d, activePoint));
  dashActionBtn.textContent = inDash ? '★ Saved to dashboard' : '★ Save to dashboard';
  dashActionBtn.classList.toggle('active', inDash);
}

pinActionBtn.addEventListener('click', () => {
  if (!activePoint) return;
  if (activePinId) {
    pins = pins.filter(p => p.id !== activePinId);
    savePins();
    activePinId = null;
  } else {
    const fallback = activePoint.name || fmtCoord(activePoint.lat, activePoint.lng);
    const label = window.prompt('Name this pin:', fallback) || fallback;
    const pin = { id: 'pin_' + Date.now(), name: label, lat: activePoint.lat, lng: activePoint.lng };
    pins.push(pin);
    savePins();
    activePinId = pin.id;
  }
  renderPoints();
  updateDetailActionButtons();
  renderDashboardPanelIfOpen();
});

dashActionBtn.addEventListener('click', () => {
  if (!activePoint) return;
  const idx = dashboardItems.findIndex(d => sameCoord(d, activePoint));
  if (idx >= 0) {
    dashboardItems.splice(idx, 1);
  } else {
    dashboardItems.push({ name: activePoint.name || fmtCoord(activePoint.lat, activePoint.lng), lat: activePoint.lat, lng: activePoint.lng });
  }
  saveDashboard();
  updateDetailActionButtons();
  renderDashboardPanelIfOpen(true);
});

// ---------- dashboard panel ----------

const dashboardPanel = document.getElementById('dashboard');
const dashboardList = document.getElementById('dashboardList');
const dashboardToggle = document.getElementById('dashboardToggle');
const dashboardClose = document.getElementById('dashboardClose');
let dashboardRefreshTimer = null;

dashboardToggle.addEventListener('click', () => {
  dashboardPanel.classList.add('open');
  renderDashboardPanel();
  if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = setInterval(renderDashboardPanel, 10 * 60 * 1000);
});
dashboardClose.addEventListener('click', () => {
  dashboardPanel.classList.remove('open');
  if (dashboardRefreshTimer) { clearInterval(dashboardRefreshTimer); dashboardRefreshTimer = null; }
});

function renderDashboardPanelIfOpen(force) {
  if (force || dashboardPanel.classList.contains('open')) renderDashboardPanel();
}

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
     </div>`
  ).join('');

  dashboardList.querySelectorAll('.dremove').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const entry = entries[Number(btn.dataset.idx)];
      if (entry.isPin) {
        pins = pins.filter(p => p.id !== entry.id);
        savePins();
        renderPoints();
      } else {
        dashboardItems = dashboardItems.filter(d => !sameCoord(d, entry));
        saveDashboard();
      }
      updateDetailActionButtons();
      renderDashboardPanel();
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
      if (c && typeof c.temperature_2m === 'number') {
        span.textContent = `${Math.round(c.temperature_2m)}°C · ${WMO_CODES[c.weather_code] ?? ''}`;
      } else {
        span.textContent = '—';
      }
    });
  } catch (err) {
    dashboardList.querySelectorAll('.dm span').forEach(span => { span.textContent = '—'; });
  }
}

// ---------- map-style zoom controls ----------

document.getElementById('zoomIn').addEventListener('click', () => {
  const pov = world.pointOfView();
  world.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: Math.max(0.25, pov.altitude * 0.65) }, 500);
});
document.getElementById('zoomOut').addEventListener('click', () => {
  const pov = world.pointOfView();
  world.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: Math.min(3.2, pov.altitude / 0.65) }, 500);
});
document.getElementById('zoomHome').addEventListener('click', () => {
  world.pointOfView({ lat: 15, lng: 10, altitude: 2.4 }, 900);
});

// ---------- search ----------

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.classList.remove('open');
    searchResults.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 300);
});

async function runSearch(q) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) {
      searchResults.innerHTML = '<div class="empty">No matches</div>';
      searchResults.classList.add('open');
      return;
    }
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
  } catch (err) {
    searchResults.innerHTML = '<div class="empty">Search failed</div>';
    searchResults.classList.add('open');
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) searchResults.classList.remove('open');
});

// ---------- radial menu + layers ----------

const radialRoot = document.getElementById('radialRoot');
document.getElementById('fab').addEventListener('click', (e) => {
  e.stopPropagation();
  radialRoot.classList.toggle('open');
});
document.querySelector('.stage').addEventListener('click', (e) => {
  if (!radialRoot.contains(e.target)) radialRoot.classList.remove('open');
});

const layerState = { temp: false, precip: false, wind: false, clouds: false, currents: false, labels: false };
const pills = {
  temp: document.getElementById('pillTemp'),
  precip: document.getElementById('pillPrecip'),
  wind: document.getElementById('pillWind'),
  clouds: document.getElementById('pillClouds'),
  currents: document.getElementById('pillCurrents'),
  labels: document.getElementById('pillLabels'),
};
const spokes = {
  temp: document.getElementById('spokeTemp'),
  precip: document.getElementById('spokePrecip'),
  wind: document.getElementById('spokeWind'),
  clouds: document.getElementById('spokeClouds'),
  currents: document.getElementById('spokeCurrents'),
  labels: document.getElementById('spokeLabels'),
};
const hintText = document.getElementById('hintText');

function updateHint() {
  const on = Object.keys(layerState).filter(k => layerState[k]);
  hintText.textContent = on.length ? on.join(' + ') + ' active' : 'none active';
}

document.querySelectorAll('.spoke').forEach(spoke => {
  spoke.addEventListener('click', async (e) => {
    e.stopPropagation();
    const key = spoke.dataset.layer;
    if (key === 'reset') {
      Object.keys(layerState).forEach(k => layerState[k] = false);
      Object.values(pills).forEach(p => p.classList.remove('on'));
      Object.values(spokes).forEach(s => s.classList.remove('active'));
      applyLayers();
      updateHint();
      return;
    }
    layerState[key] = !layerState[key];
    pills[key].classList.toggle('on', layerState[key]);
    spokes[key].classList.toggle('active', layerState[key]);
    updateHint();
    await applyLayers();
  });
});

function applyCurrentArcs() {
  if (!layerState.currents) {
    world.arcsData([]);
    return;
  }
  world
    .arcsData(CURRENT_ARCS)
    .arcStartLat('lat1').arcStartLng('lng1')
    .arcEndLat('lat2').arcEndLng('lng2')
    .arcColor(d => d.color)
    .arcStroke(d => 0.4 + Math.min(1.2, d.speed * 0.5))
    .arcAltitude(0.012)
    .arcDashLength(0.4)
    .arcDashGap(0.25)
    .arcDashAnimateTime(d => Math.max(900, 7000 - d.speed * 3200))
    .arcsTransitionDuration(400);
}

async function applyLayers() {
  applyCurrentArcs();
  refreshLabels();

  const anyHeat = layerState.temp || layerState.precip;
  const needsGrid = anyHeat || layerState.wind || layerState.clouds;

  if (!needsGrid) {
    world.heatmapsData([]);
    world.customLayerData([]);
    cloudMesh.visible = false;
    return;
  }

  setLoading(true);
  let points;
  try {
    points = await fetchGridWeather();
  } catch (err) {
    setLoading(false);
    return;
  }
  setLoading(false);

  // temp/precip heatmap (only one can render at a time; temp takes priority if both toggled)
  if (anyHeat) {
    const useTemp = layerState.temp;
    const weightKey = useTemp ? 'temp' : 'precip';
    const domain = useTemp ? TEMP_DOMAIN : PRECIP_DOMAIN;
    const scale = useTemp ? TEMP_SCALE : PRECIP_SCALE;
    world
      .heatmapsData([points])
      .heatmapPointLat('lat')
      .heatmapPointLng('lng')
      .heatmapPointWeight(d => normalize(d[weightKey], domain[0], domain[1]) + 0.01)
      .heatmapBandwidth(2.4)
      .heatmapColorFn(t => scale(t))
      .heatmapTopAltitude(0.02);
  } else {
    world.heatmapsData([]);
  }

  // wind arrows (oriented cones, pulsing via animateWindCones below)
  if (layerState.wind) {
    const windPoints = points.filter(p => p.windSpeed > 1);
    world
      .customLayerData(windPoints)
      .customThreeObjectUpdate((obj, d) => {
        const alt = 0.03;
        const p0 = world.getCoords(d.lat, d.lng, alt);
        const dest = destinationPoint(d.lat, d.lng, (d.windDir + 180) % 360, 300);
        const p1 = world.getCoords(dest.lat, dest.lng, alt);
        obj.position.set(p0.x, p0.y, p0.z);
        obj.lookAt(p1.x, p1.y, p1.z);
        const pulse = 1 + Math.sin(performance.now() / 450 + d.lat + d.lng) * 0.12;
        const base = obj.userData.baseScale || 1;
        obj.scale.set(base * pulse, base * pulse, base * pulse);
      })
      .customThreeObject(d => {
        const scale = Math.max(0.6, Math.min(2.6, d.windSpeed / 12));
        const color = lerpColor(hexToRgb('#1f8f6b'), hexToRgb('#7bffb0'), normalize(d.windSpeed, WIND_DOMAIN[0], WIND_DOMAIN[1]));
        const geometry = new THREE.ConeGeometry(0.35, 1.6, 8);
        geometry.rotateX(-Math.PI / 2);
        const material = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255),
          transparent: true,
          opacity: 0.85,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.baseScale = scale;
        mesh.scale.set(scale, scale, scale);
        return mesh;
      });
  } else {
    world.customLayerData([]);
  }

  // clouds: stylized canvas texture sphere, density driven by real cloud-cover %
  if (layerState.clouds) {
    drawClouds(points);
    cloudMesh.visible = true;
  } else {
    cloudMesh.visible = false;
  }
}

// continuously re-render wind cones so the pulse animation in customThreeObjectUpdate keeps ticking
(function animateWindCones() {
  if (layerState.wind) world.customLayerData(world.customLayerData());
  requestAnimationFrame(animateWindCones);
})();
