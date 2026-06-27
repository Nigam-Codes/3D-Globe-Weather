// Living Globe — a fully animated Earth in raw Three.js.
// Day/night terminator shader, drifting cloud shell, fresnel atmosphere, and a
// CPU wind-particle field advected by the real Open-Meteo wind grid.
import * as THREE from 'three';
import { OrbitControls } from 'https://unpkg.com/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import * as Astronomy from 'astronomy-engine';

const IMG = 'https://unpkg.com/three-globe/example/img';
const CLOUD_URL = 'https://raw.githubusercontent.com/turban/webgl-earth/master/images/fair_clouds_4k.png';
const EARTH_R = 100;

// ---------- renderer / scene / camera ----------

const host = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 60, 320);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = EARTH_R * 1.3;
controls.maxDistance = EARTH_R * 4;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.25;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- starfield background ----------

const texLoader = new THREE.TextureLoader();
texLoader.crossOrigin = 'anonymous';
scene.background = texLoader.load(`${IMG}/night-sky.png`);

// ---------- earth: day/night terminator shader ----------

const dayTex = texLoader.load(`${IMG}/earth-blue-marble.jpg`);
const nightTex = texLoader.load(`${IMG}/earth-night.jpg`);
const waterTex = texLoader.load(`${IMG}/earth-water.png`);
[dayTex, nightTex, waterTex].forEach(t => { t.colorSpace = THREE.SRGBColorSpace; });

// world-space sun direction: drives the terminator independent of texture
// orientation, so the lit day side reliably faces the camera on load
const sunDir = new THREE.Vector3(0, 0.4, 1).normalize();
const earthUniforms = {
  uDay: { value: dayTex },
  uNight: { value: nightTex },
  uWater: { value: waterTex },
  uSunDir: { value: sunDir },
  uDayNight: { value: 1.0 }, // 1 = terminator on, 0 = full daylight
};

const earthMat = new THREE.ShaderMaterial({
  uniforms: earthUniforms,
  vertexShader: /* glsl */`
    varying vec2 vUv; varying vec3 vWN;
    void main(){
      vUv = uv;
      vWN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv; varying vec3 vWN;
    uniform sampler2D uDay, uNight, uWater;
    uniform vec3 uSunDir;
    uniform float uDayNight;
    void main(){
      vec3 dayCol = texture2D(uDay, vUv).rgb;
      vec3 nightCol = texture2D(uNight, vUv).rgb;
      float water = texture2D(uWater, vUv).r;

      float d = dot(normalize(vWN), normalize(uSunDir));
      float day = smoothstep(-0.12, 0.25, d);
      day = mix(1.0, day, uDayNight);

      // vivid day side + warm glowing city lights on the night side
      vec3 dayC = dayCol * 1.04;
      vec3 nightC = nightCol * vec3(1.25, 1.0, 0.65) * 1.4;
      vec3 col = mix(nightC, dayC, day);
      // faint ambient so unlit oceans aren't pure black
      col += dayCol * 0.03;
      // sub-solar ocean glint
      col += day * water * pow(max(d, 0.0), 14.0) * vec3(1.0, 0.96, 0.82) * 0.5;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 96), earthMat);
scene.add(earth);

// ---------- cloud shell ----------

const cloudUniforms = {
  uClouds: { value: null },
  uSunDir: earthUniforms.uSunDir,
  uDayNight: earthUniforms.uDayNight,
  uShift: { value: 0.0 },
};
const cloudMat = new THREE.ShaderMaterial({
  uniforms: cloudUniforms,
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */`
    varying vec2 vUv; varying vec3 vWN;
    void main(){
      vUv = uv;
      vWN = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv; varying vec3 vWN;
    uniform sampler2D uClouds;
    uniform vec3 uSunDir;
    uniform float uDayNight, uShift;
    void main(){
      float a = texture2D(uClouds, vec2(vUv.x + uShift, vUv.y)).r;
      // keep only well-defined cloud masses so the blue-marble surface shows through
      a = smoothstep(0.35, 0.85, a);
      if(a < 0.03) discard;
      float d = dot(normalize(vWN), normalize(uSunDir));
      float day = smoothstep(-0.12, 0.25, d);
      day = mix(1.0, day, uDayNight);
      float bright = mix(0.35, 1.0, day);
      gl_FragColor = vec4(vec3(bright), a * mix(0.22, 0.5, day));
    }
  `,
});
const clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.012, 80, 80), cloudMat);
clouds.visible = false;
scene.add(clouds);
texLoader.load(CLOUD_URL, (t) => { t.wrapS = THREE.RepeatWrapping; cloudUniforms.uClouds.value = t; clouds.visible = layers.clouds; });

// ---------- atmosphere (fresnel rim glow) ----------

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * 1.18, 64, 64),
  new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color('#5fd0ff') } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vW;
      void main(){
        vN = normalize(normalMatrix * normal);
        vec4 wp = modelMatrix * vec4(position,1.0); vW = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float; varying vec3 vN; varying vec3 vW; uniform vec3 uColor;
      void main(){
        vec3 viewDir = normalize(cameraPosition - vW);
        float f = pow(1.0 - abs(dot(vN, viewDir)), 3.2);
        gl_FragColor = vec4(uColor, f * 0.9);
      }
    `,
  })
);
scene.add(atmosphere);

// ---------- wind particle field (advected by the real Open-Meteo grid) ----------

const N = 7000;
const pLat = new Float32Array(N), pLng = new Float32Array(N), pLife = new Float32Array(N);
const positions = new Float32Array(N * 3);
const colors = new Float32Array(N * 3);
function seed(i) {
  pLat[i] = (Math.random() * 180) - 90;
  pLng[i] = (Math.random() * 360) - 180;
  pLife[i] = 30 + Math.random() * 90;
}
for (let i = 0; i < N; i++) seed(i);

function latLngToXYZ(lat, lng, r, out, o) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  out[o] = -r * Math.sin(phi) * Math.cos(theta);
  out[o + 1] = r * Math.cos(phi);
  out[o + 2] = r * Math.sin(phi) * Math.sin(theta);
}

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const windPoints = new THREE.Points(pGeo, new THREE.PointsMaterial({
  size: 1.4, vertexColors: true, transparent: true, opacity: 0.9,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
}));
scene.add(windPoints);

// wind grid: { "lat_lng": {u, v, speed} } on a 15° lattice (matches the terminal build)
let windGrid = null;
const COOL = new THREE.Color('#2de0c9'), HOT = new THREE.Color('#ffffff');

async function loadWindGrid() {
  const pts = [];
  for (let lat = -75; lat <= 75; lat += 15) for (let lng = -180; lng < 180; lng += 15) pts.push({ lat, lng });
  const chunk = 100, chunks = [];
  for (let i = 0; i < pts.length; i += chunk) chunks.push(pts.slice(i, i + chunk));
  try {
    const all = await Promise.all(chunks.map(async (c) => {
      const la = c.map(p => p.lat).join(','), lo = c.map(p => p.lng).join(',');
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=wind_speed_10m,wind_direction_10m`;
      const r = await fetch(url); if (!r.ok) throw new Error('wind grid');
      const d = await r.json(); const list = Array.isArray(d) ? d : [d];
      return list.map((x, i) => ({ lat: c[i].lat, lng: c[i].lng, sp: x.current?.wind_speed_10m ?? 0, dir: x.current?.wind_direction_10m ?? 0 }));
    }));
    const map = {};
    all.flat().forEach(g => {
      const toRad = (g.dir + 180) * Math.PI / 180; // direction wind blows TOWARD
      map[`${g.lat}_${g.lng}`] = { u: g.sp * Math.sin(toRad), v: g.sp * Math.cos(toRad), speed: g.sp };
    });
    windGrid = map;
    document.getElementById('grid').textContent = `${all.flat().length} pts`;
  } catch {
    document.getElementById('grid').textContent = 'unavailable';
  }
}

function sampleWind(lat, lng) {
  if (!windGrid) return { u: 0, v: 0, speed: 0 };
  const rl = Math.max(-75, Math.min(75, Math.round(lat / 15) * 15));
  let rg = Math.round(lng / 15) * 15; if (rg >= 180) rg -= 360; if (rg < -180) rg += 360;
  return windGrid[`${rl}_${rg}`] || { u: 0, v: 0, speed: 0 };
}

function updateWind(dt) {
  const k = 0.06; // advection strength
  for (let i = 0; i < N; i++) {
    const w = sampleWind(pLat[i], pLng[i]);
    pLng[i] += (w.u * k) / Math.max(0.2, Math.cos(pLat[i] * Math.PI / 180));
    pLat[i] += w.v * k;
    pLife[i] -= dt * 12;
    if (pLat[i] > 88 || pLat[i] < -88 || pLife[i] <= 0) seed(i);
    if (pLng[i] > 180) pLng[i] -= 360; if (pLng[i] < -180) pLng[i] += 360;
    latLngToXYZ(pLat[i], pLng[i], EARTH_R * 1.02, positions, i * 3);
    const t = Math.min(1, w.speed / 45);
    const c = COOL.clone().lerp(HOT, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------- sun: real seasonal declination (tilt), animated longitude sweep ----------

function solarDeclination(date = new Date()) {
  try {
    const t = Astronomy.MakeTime(date);
    const eq = Astronomy.Equator(Astronomy.Body.Sun, t, new Astronomy.Observer(0, 0, 0), true, true);
    return eq.dec * Math.PI / 180;
  } catch {
    const doy = Math.floor((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 0))) / 864e5);
    return 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (doy - 81) / 365);
  }
}
const DECL = solarDeclination();
let sunAngle = 0; // 0 → day side faces the camera (+Z)
function updateSun() {
  sunDir.set(
    Math.cos(DECL) * Math.sin(sunAngle),
    Math.sin(DECL),
    Math.cos(DECL) * Math.cos(sunAngle)
  ).normalize();
}
updateSun();

// ---------- layer toggles ----------

const layers = { clouds: true, wind: true, atmos: true, daynight: true };
document.querySelectorAll('.tog').forEach(btn => {
  btn.addEventListener('click', () => {
    const fx = btn.dataset.fx;
    layers[fx] = !layers[fx];
    btn.classList.toggle('on', layers[fx]);
    if (fx === 'clouds') clouds.visible = layers.clouds && !!cloudUniforms.uClouds.value;
    if (fx === 'wind') windPoints.visible = layers.wind;
    if (fx === 'atmos') atmosphere.visible = layers.atmos;
    if (fx === 'daynight') earthUniforms.uDayNight.value = layers.daynight ? 1.0 : 0.0;
  });
});
let timeSpeed = 0.4;
document.getElementById('speed').addEventListener('input', e => { timeSpeed = e.target.value / 100; });

// ---------- main animation loop ----------

const clock = new THREE.Clock();
let frames = 0, fpsT = performance.now();
const subEl = document.getElementById('subsolar');
const loadingEl = document.getElementById('loading');

function animate() {
  const dt = Math.min(0.05, clock.getDelta());

  // advance the day/night terminator (sped-up day cycle for a living feel)
  sunAngle -= dt * timeSpeed * 0.5;
  if (sunAngle < -Math.PI) sunAngle += 2 * Math.PI;
  updateSun();

  // drift clouds slowly relative to the surface
  cloudUniforms.uShift.value += dt * 0.004;

  if (layers.wind && windGrid) updateWind(dt);

  controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - fpsT >= 500) {
    document.getElementById('fps').textContent = Math.round((frames * 1000) / (now - fpsT));
    frames = 0; fpsT = now;
    const tiltDeg = (DECL * 180 / Math.PI).toFixed(0);
    let phase = (sunAngle * 180 / Math.PI) % 360; if (phase < 0) phase += 360;
    subEl.textContent = `tilt ${tiltDeg}° · ${phase.toFixed(0)}°`;
  }
  requestAnimationFrame(animate);
}

document.getElementById('pcount').textContent = N.toLocaleString();
loadWindGrid();
// give textures a moment, then reveal
setTimeout(() => loadingEl.classList.add('hide'), 1200);
animate();
