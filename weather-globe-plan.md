# 3D Globe Weather App — Plan

## Tech approach

**Globe rendering:** Globe.gl (a Three.js wrapper purpose-built for data-on-a-sphere visualization). It gives rotation, zoom/pan, and clickable regions out of the box, and supports heatmap, point, and arc overlays directly — a good fit for temperature/wind/precipitation layers without hand-rolling Three.js geometry. Runs entirely client-side (plain HTML/JS), so no backend is required for rendering.

*Alternative:* CesiumJS, if photorealistic terrain/3D buildings become a priority later. Heavier and overkill for a weather-layer app, but worth knowing as an upgrade path.

**Weather data:** Open-Meteo. Free, no API key, no commercial-use cost for personal projects, covers current conditions, hourly/daily forecast, and gridded variables (temperature, precipitation, wind speed/direction) globally. Rate limits (10k calls/day, 600/min) are far beyond what an interactive single-user app needs.

**Stack:**
- Frontend: HTML/JS, Globe.gl + Three.js, vanilla JS or a light framework
- Data layer: fetch calls to Open-Meteo, with a thin local cache (in-memory + localStorage-free — session memory only, since the app is a static client)
- No backend needed for v1; a small Node proxy can be added later if API keys or server-side caching become necessary

## Key features

- Rotating, zoomable 3D globe (drag to rotate, scroll/pinch to zoom)
- Toggleable overlay layers: temperature (color heatmap), precipitation (intensity overlay), wind (animated direction/speed arrows or particle flow)
- Click/zoom into a region → fly-to animation + detail panel with local current conditions and short forecast
- Radial menu for layer toggling and navigation (mockup below)
- Smooth transitions between global and regional views

## Data architecture

1. **Globe shell** renders a low-res base layer (country/coastline outlines) on load — no weather calls yet.
2. **Viewport-driven fetch**: as the user zooms/pans, the app requests Open-Meteo data for a grid of points covering the visible region (resolution scales with zoom level — coarse grid at world view, finer grid at regional/city view).
3. **Layer cache**: responses are cached in memory by grid cell + variable, keyed with a short TTL (current conditions refresh ~10–15 min; forecast data cached longer).
4. **Overlay render**: cached points are mapped to Globe.gl's heatmap/points/arcs layers depending on the active toggle (temperature = heatmap, precipitation = heatmap/intensity, wind = directional arrows or particles).
5. **Region click**: selecting a point or area triggers a single high-detail Open-Meteo call (full current + hourly forecast) for that coordinate, shown in a side panel.

## Added features (round 2)

**Time slider on city select:** searching or clicking a city opens the detail panel with a slider covering the next 48h (e.g. now / +6h / +12h ... /+48h, pulled from Open-Meteo's hourly forecast). Dragging it updates temp/condition/wind in place — no extra fetch per step, since the full 48h hourly block is fetched once when the city is selected.

**Cloud accumulation animation:** default approach is a stylized drifting cloud layer whose density/opacity is driven by Open-Meteo's cloud-cover (%) field per grid cell — free, lightweight, no imagery licensing. If you want literal satellite-look clouds instead of stylized drift, NASA GIBS provides free near-real-time global cloud imagery tiles (no key) that could be mapped onto the globe as a texture later — flagging as a v2 upgrade since it adds tile-loading complexity.

**Ocean current animation:** real current vector data exists (NOAA OSCAR / Copernicus Marine) but requires registration and heavier processing — likely overkill for a weather app. Default plan is a stylized, animated flow-line effect over ocean regions (visually "cool," not tied to literal current measurements). Flagging this as a judgment call — let me know if you'd rather it be data-accurate even at the cost of added complexity.

**Background planets with live positions:** implemented as a small "orrery" widget (sun-centered mini solar system, orbit rings, planets as dots) rather than scattering planets across the main starfield, so it stays legible. For real implementation, planetary positions are computed client-side via an ephemeris library (e.g. `astronomy-engine`, free/MIT, no network call) using today's date — fully accurate, no API needed. In the mockup the orbit motion is illustrative/decorative.

## Open questions for you

- Should cloud cover be purely stylized (Open-Meteo % data) or eventually satellite-textured (NASA GIBS)?
- Should ocean currents be decorative animation only, or do you want them tied to real current data (heavier lift)?
- Any preference on visual style (realistic satellite-textured globe vs. stylized/minimal, as in the mockup)?
