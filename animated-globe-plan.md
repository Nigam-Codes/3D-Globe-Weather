# Plan — "Living Globe": a fully animated version

A second version where the globe is **continuously, physically animated** rather than a
static textured sphere with overlay toggles. Everything breathes, flows, and advances in
real time. This is a parallel build (keep the current terminal version intact) so the two
can be compared.

> Status: planning only. The current terminal version (Open-Meteo + NOAA + USGS, Globe.gl)
> is committed and working. This document is the roadmap for the animated variant.

---

## 1. Vision

Turn the globe from "a map you query" into "a planet you watch." Target feel: a live,
cinematic Earth where wind streams flow across the surface, clouds drift and build, the
day/night terminator sweeps in real time, ocean currents move as particle ribbons, and
the whole scene has subtle atmospheric motion. Data still real; presentation fully kinetic.

Two style directions to pick between (decide before Phase 2):
- **A. Photoreal kinetic** — keep the realistic earth textures, add shader-driven motion
  (terminator, specular oceans, flowing particle layers). Lower art cost, high "wow".
- **B. Stylized/low-poly kinetic** — the toon-diorama direction discussed earlier
  (biome colors, raised relief, 3D trees, puffy clouds) but animated. Higher art cost,
  very distinctive. (See prior conversation on low-poly toon globe.)

Recommendation: start with **A** (reuses existing data plumbing) and keep **B** as a skin.

---

## 2. Why this needs a different engine than Globe.gl

Globe.gl is great for *data-on-a-sphere overlays* but it abstracts away the Three.js
render loop and material pipeline we need for custom shaders and GPU particle systems.
The animated version should drop to **raw Three.js** (we already import three as an ES
module via the import map) for full control of:
- custom `ShaderMaterial` on the globe (day/night blend, terminator, animated normals)
- GPGPU / instanced particle systems for wind + currents
- a single owned `requestAnimationFrame` loop driving all animation uniforms

Keep the data modules as-is — `aurora.js`, `quakes.js`, `airquality.js`, `currents.js`,
`places.js`, plus the Open-Meteo grid fetch. They are renderer-agnostic and port directly.

---

## 3. Animated features (in priority order)

1. **Real-time day/night terminator** — sun position from `astronomy-engine` (already a
   dependency) fed into a globe `ShaderMaterial` that blends a day texture and a
   night-lights texture along the true solar terminator, advancing each frame. City
   lights glow only on the dark side.
2. **Flowing wind field** — GPU particle system seeded across the globe, advected by the
   Open-Meteo wind grid (speed + direction), bilinearly interpolated. Particles fade,
   respawn, and trail — the classic "earth wind map" look, on a sphere. ~50–200k particles
   via instancing / a position-feedback shader.
3. **Drifting + building clouds** — replace the static canvas blob layer with a scrolling
   noise-modulated cloud shell whose density is driven by the real cloud-cover grid; clouds
   thicken where coverage is high and thin out elsewhere, with slow parallax drift.
4. **Animated ocean currents** — render `currents.js` paths as flowing particle ribbons
   (speed-scaled) instead of dashed arcs; continuous motion along each documented current.
5. **Pulsing aurora** — port the OVATION oval to an additive shader shell with animated
   curtain/shimmer noise instead of redrawn canvas blobs.
6. **Live seismic ripples** — each USGS quake emits an expanding shockwave ring on arrival;
   magnitude drives size/speed/color.
7. **Atmospheric motion** — animated rim/scatter shader (Fresnel glow that shifts with the
   sun direction), subtle cloud shadows on the surface, gentle camera auto-orbit.
8. **Time-lapse / forecast scrubber** — a global timeline that animates the whole planet
   forward through the 48h forecast: wind, clouds, and temperature field all interpolate
   between hourly frames. The current per-location slider becomes a planet-wide playhead.

---

## 4. Architecture

```
main.js            owns the Three.js scene, camera, controls, single rAF loop
globeMaterial.js   day/night ShaderMaterial (sun uniform, 3 textures)
windField.js       GPU particle advection from the wind grid
cloudShell.js      noise + cloud-cover driven cloud shader
currentRibbons.js  particle ribbons along currents.js paths
auroraShell.js     additive aurora shader (OVATION uniform texture)
quakeRipples.js    transient shockwave rings
data/*             REUSED unchanged: aurora.js, quakes.js, airquality.js,
                   currents.js, places.js, + grid fetch (extract from app.js)
ui/*               REUSED: terminal chrome (topbar, rail, ticker, detail panel)
```

Data → texture bridge: pack the 15° weather grid into small `DataTexture`s
(wind u/v, temperature, cloud cover) updated every 10 min; shaders sample these. This is
the key trick that lets GPU animation read real data cheaply.

Single animation clock: one `THREE.Clock`; every shader gets a `uTime` uniform; the rAF
loop updates `uTime`, the sun direction, and particle state, then renders once.

---

## 5. Performance plan

- Budget for 60fps on integrated GPUs: cap particles, use additive points (no per-particle
  geometry), `powerPreference:'high-performance'`, and a quality auto-step that drops
  particle count if FPS (already metered in the ticker) falls below ~40.
- Wind advection on GPU (ping-pong FBOs) rather than CPU; fall back to a smaller CPU
  particle count if WebGL2/float textures are unavailable.
- Throttle data refresh (grid 10 min, aurora/quakes 5 min) — animation is decoupled from
  fetch cadence and just interpolates between snapshots.
- Reuse the existing in-flight fetch dedup so concurrent layers don't double-request.

---

## 6. Phased roadmap

- **Phase 0** — scaffold `index-animated.html` + `main.js` raw-Three scene with the
  existing globe textures, orbit controls, and the single rAF loop. Port the terminal UI.
- **Phase 1** — day/night terminator shader (feature 1). Biggest visual payoff, lowest risk.
- **Phase 2** — wind particle field (feature 2). The signature effect; prototype CPU first
  (~10k particles) then move to GPU.
- **Phase 3** — animated clouds + current ribbons + aurora shell (features 3–5).
- **Phase 4** — quake ripples + atmospheric motion (features 6–7).
- **Phase 5** — planet-wide forecast time-lapse (feature 8).
- **Phase 6** — optional stylized/low-poly skin (style B).

Each phase is independently shippable; stop at any point with a coherent result.

---

## 7. Open decisions (resolve before coding)

1. Style direction A (photoreal kinetic) vs B (stylized) for v1 — recommend A.
2. Keep Globe.gl for the current version and build the animated one fresh in raw Three.js
   (recommended), vs. trying to bolt shaders onto Globe.gl (fights the abstraction).
3. Day/night textures: source a 2k–4k daytime "blue marble" + the existing night-lights
   map (the current build only ships the night map).
4. Acceptable minimum hardware / FPS floor (drives the particle budget).

---

## 8. What ports over unchanged

- All data fetchers (`aurora.js`, `quakes.js`, `airquality.js`, `currents.js`, `places.js`)
- The weather-grid fetch + caching + in-flight dedup logic (extract from `app.js`)
- The entire terminal chrome (top bar, monitor rail, ticker, detail panel, charts, search,
  pins/dashboard, deep-link `#layers=` hashing)
- Color scales, WMO codes, moon-phase, geo helpers

So roughly half the existing code is reusable; the new work is the render layer.
