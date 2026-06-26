// Background solar system: Sun + inner/outer planets placed at their real
// current ecliptic positions (computed client-side with astronomy-engine —
// a proper ephemeris library, no network call, no API key). Positions are
// accurate for "right now"; since planets move only fractions of a degree
// per day, this is effectively live each time the app loads.

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';

const BODY_INFO = [
  { name: 'Mercury', body: 'Mercury', color: 0xb9b3a8, size: 2.1 },
  { name: 'Venus',   body: 'Venus',   color: 0xe8c989, size: 2.9 },
  { name: 'Mars',    body: 'Mars',    color: 0xe07a5f, size: 2.3 },
  { name: 'Jupiter', body: 'Jupiter', color: 0xd8b894, size: 6.4 },
  { name: 'Saturn',  body: 'Saturn',  color: 0xe3d5a8, size: 5.4 },
];

const BG_RADIUS = 640;

function eclipticToVec3(elonDeg, elatDeg, r) {
  const lon = THREE.MathUtils.degToRad(elonDeg);
  const lat = THREE.MathUtils.degToRad(elatDeg);
  return new THREE.Vector3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.sin(lat),
    r * Math.cos(lat) * Math.sin(lon)
  );
}

function makeLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '28px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(232,237,245,0.85)';
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(28, 7, 1);
  return sprite;
}

export function buildSolarSystem(scene, date = new Date()) {
  const group = new THREE.Group();
  group.name = 'solarSystemBackground';
  const pulseTargets = [];

  try {
    const time = Astronomy.MakeTime(date);

    const sunEcl = Astronomy.SunPosition(time);
    const sunPos = eclipticToVec3(sunEcl.elon, sunEcl.elat, BG_RADIUS);

    const sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd86b })
    );
    sunMesh.position.copy(sunPos);

    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      color: 0xffd86b, transparent: true, opacity: 0.4, depthTest: false,
    }));
    sunGlow.scale.set(46, 46, 1);
    sunGlow.position.copy(sunPos);

    const sunLabel = makeLabelSprite('Sun');
    sunLabel.position.copy(sunPos).add(new THREE.Vector3(0, 14, 0));

    group.add(sunMesh, sunGlow, sunLabel);
    pulseTargets.push(sunGlow);

    BODY_INFO.forEach(info => {
      const vec = Astronomy.GeoVector(Astronomy.Body[info.body], time, true);
      const ecl = Astronomy.Ecliptic(vec);
      const pos = eclipticToVec3(ecl.elon, ecl.elat, BG_RADIUS * 0.9);

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(info.size, 16, 16),
        new THREE.MeshBasicMaterial({ color: info.color })
      );
      mesh.position.copy(pos);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        color: info.color, transparent: true, opacity: 0.22, depthTest: false,
      }));
      glow.scale.set(info.size * 4.5, info.size * 4.5, 1);
      glow.position.copy(pos);

      const label = makeLabelSprite(info.name);
      label.position.copy(pos).add(new THREE.Vector3(0, info.size + 5, 0));

      group.add(mesh, glow, label);
    });
  } catch (err) {
    console.warn('Solar system background unavailable:', err);
  }

  scene.add(group);

  // Gentle twinkle/pulse animation, independent of globe.gl's own render loop.
  function tick() {
    const t = performance.now() / 1000;
    pulseTargets.forEach(spr => {
      spr.material.opacity = 0.32 + Math.sin(t * 1.4) * 0.08;
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return group;
}
