// Stylized constellation line-art for the starfield background.
// These are illustrative patterns for a handful of well-known constellations
// (Big Dipper / Ursa Major, Orion, Cassiopeia, Southern Cross, Scorpius) —
// decorative placement to make the background sky feel alive, not a precise
// star-catalog rendering.

import * as THREE from 'three';

const SKY_RADIUS = 600;

function sphericalToVec3(lonDeg, latDeg, r) {
  const lon = THREE.MathUtils.degToRad(lonDeg);
  const lat = THREE.MathUtils.degToRad(latDeg);
  return new THREE.Vector3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.sin(lat),
    r * Math.cos(lat) * Math.sin(lon)
  );
}

function makeLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 220; canvas.height = 56;
  const ctx = canvas.getContext('2d');
  ctx.font = '22px -apple-system, sans-serif';
  ctx.fillStyle = 'rgba(180,200,230,0.6)';
  ctx.textAlign = 'center';
  ctx.fillText(text, 110, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(34, 8.5, 1);
  return sprite;
}

const PATTERNS = [
  {
    name: 'Ursa Major',
    stars: [[170,60],[178,63],[186,62],[194,58],[200,52],[206,48],[212,44]],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[3,0]],
  },
  {
    name: 'Orion',
    stars: [[50,8],[44,7],[47,2],[48,1],[49,0],[49,-6],[45,-7]],
    lines: [[0,3],[1,2],[2,3],[3,4],[4,5],[2,6]],
  },
  {
    name: 'Cassiopeia',
    stars: [[320,55],[326,62],[332,57],[338,63],[344,58]],
    lines: [[0,1],[1,2],[2,3],[3,4]],
  },
  {
    name: 'Crux',
    stars: [[184,-57],[186,-63],[190,-59],[188,-60]],
    lines: [[0,1],[2,3]],
  },
  {
    name: 'Scorpius',
    stars: [[250,-22],[254,-26],[258,-30],[262,-34],[266,-37],[270,-38],[268,-34]],
    lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[4,6]],
  },
];

export function buildConstellations(scene) {
  const group = new THREE.Group();
  group.name = 'constellations';

  const lineMat = new THREE.LineBasicMaterial({ color: 0x6f8fc9, transparent: true, opacity: 0.35 });
  const starMat = new THREE.PointsMaterial({ color: 0xcfe0ff, size: 2.4, transparent: true, opacity: 0.85, sizeAttenuation: false });

  PATTERNS.forEach(pattern => {
    const points = pattern.stars.map(([lon, lat]) => sphericalToVec3(lon, lat, SKY_RADIUS));

    // connecting lines
    pattern.lines.forEach(([a, b]) => {
      const geo = new THREE.BufferGeometry().setFromPoints([points[a], points[b]]);
      group.add(new THREE.Line(geo, lineMat));
    });

    // star points themselves, slightly brighter than the background starfield
    const starGeo = new THREE.BufferGeometry().setFromPoints(points);
    group.add(new THREE.Points(starGeo, starMat));

    // label near the first star of the pattern
    const label = makeLabel(pattern.name);
    label.position.copy(points[0]).multiplyScalar(1.02);
    group.add(label);
  });

  scene.add(group);
  return group;
}
