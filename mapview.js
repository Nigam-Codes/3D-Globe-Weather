// 2D map view — Leaflet + CARTO dark basemap + RainViewer live precipitation radar.
// All keyless: CARTO/OSM tiles (attributed), RainViewer public API (CORS *).
// Leaflet is loaded as a classic script (global L) from index.html.

const RV_INDEX = 'https://api.rainviewer.com/public/weather-maps.json';

export function createMapView(containerId, { onPick } = {}) {
  const map = L.map(containerId, {
    center: [22, 12],
    zoom: 3,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: false,
    worldCopyJump: true,
    attributionControl: true,
  });
  map.attributionControl.setPrefix(false);

  // dark futuristic basemap (CARTO dark_all, keyless with attribution)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · radar <a href="https://www.rainviewer.com/">RainViewer</a>',
    subdomains: 'abcd',
    maxZoom: 20,
  }).addTo(map);

  // selection marker (neon pulse ring, styled in CSS)
  let marker = null;
  function setMarker(lat, lng) {
    if (marker) marker.remove();
    marker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'map-pin', html: '<i></i>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(map);
  }

  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    setMarker(lat, lng);
    onPick?.(lat, lng);
  });

  // ---------- RainViewer animated radar ----------

  const radar = {
    frames: [],          // [{ time, path }]
    layers: new Map(),   // path -> L.tileLayer (created lazily, kept for reuse)
    idx: 0,
    on: true,
    playing: true,
    timer: null,
    host: '',
    generated: 0,
    opacity: 0.7,
  };

  function frameLayer(frame) {
    let layer = radar.layers.get(frame.path);
    if (!layer) {
      layer = L.tileLayer(`${radar.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0,
        maxNativeZoom: 12,
      });
      radar.layers.set(frame.path, layer);
    }
    return layer;
  }

  function showFrame(i) {
    if (!radar.frames.length) return;
    radar.idx = (i + radar.frames.length) % radar.frames.length;
    radar.frames.forEach((f, j) => {
      const layer = frameLayer(f);
      if (!map.hasLayer(layer)) layer.addTo(map);
      layer.setOpacity(radar.on && j === radar.idx ? radar.opacity : 0);
    });
    const f = radar.frames[radar.idx];
    const d = new Date(f.time * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const isForecast = f.time > radar.generated;
    radarTimeEl && (radarTimeEl.textContent = `${hh}:${mm} UTC${isForecast ? ' · FCST' : ''}`);
    radarBarEl && (radarBarEl.style.width = `${((radar.idx + 1) / radar.frames.length) * 100}%`);
  }

  function play() {
    stop();
    radar.timer = setInterval(() => showFrame(radar.idx + 1), 650);
    radar.playing = true;
    radarPlayEl && (radarPlayEl.textContent = '⏸');
  }
  function stop() {
    if (radar.timer) clearInterval(radar.timer);
    radar.timer = null;
    radar.playing = false;
    radarPlayEl && (radarPlayEl.textContent = '▶');
  }

  async function loadRadar() {
    try {
      const res = await fetch(RV_INDEX);
      if (!res.ok) throw new Error('radar index ' + res.status);
      const j = await res.json();
      radar.host = j.host;
      radar.generated = j.generated;
      radar.frames = [...(j.radar?.past ?? []), ...(j.radar?.nowcast ?? [])];
      if (radar.frames.length) {
        showFrame(radar.frames.length - (j.radar?.nowcast?.length ?? 0) - 1); // start at latest observed
        if (radar.playing) play();
      }
    } catch {
      radarTimeEl && (radarTimeEl.textContent = 'radar unavailable');
    }
  }

  // refresh the frame index every 5 min so the loop tracks live data
  setInterval(loadRadar, 5 * 60 * 1000);
  loadRadar();

  // ---------- radar UI wiring (elements owned by index.html) ----------

  const radarTimeEl = document.getElementById('radarTime');
  const radarPlayEl = document.getElementById('radarPlay');
  const radarBarEl = document.getElementById('radarBar');
  const radarToggleEl = document.getElementById('radarToggle');

  radarPlayEl?.addEventListener('click', () => (radar.playing ? stop() : play()));
  document.getElementById('radarPrev')?.addEventListener('click', () => { stop(); showFrame(radar.idx - 1); });
  document.getElementById('radarNext')?.addEventListener('click', () => { stop(); showFrame(radar.idx + 1); });
  radarToggleEl?.addEventListener('click', () => {
    radar.on = !radar.on;
    radarToggleEl.classList.toggle('on', radar.on);
    showFrame(radar.idx);
  });
  radarToggleEl?.classList.add('on');

  return {
    map,
    flyTo(lat, lng, zoom = 7) {
      // flyTo's zoom animation can produce NaN when the container has zero size
      // (e.g. mid-resize); never let a fly animation break the selection flow
      try { map.flyTo([lat, lng], zoom, { duration: 1.2 }); }
      catch { try { map.setView([lat, lng], zoom, { animate: false }); } catch { /* zero-size container */ } }
      setMarker(lat, lng);
    },
    invalidate() { map.invalidateSize(); },
  };
}
