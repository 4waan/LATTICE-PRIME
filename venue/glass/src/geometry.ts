import {
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
  TubeGeometry,
  Vector2,
  Vector3,
} from "three";

function stadiumProfile(binormal: number, normal: number, corner: number, steps = 3): Vector2[] {
  const hb = binormal / 2;
  const hn = normal / 2;
  const r = Math.min(corner, hb * 0.95, hn * 0.95);
  const pts: Vector2[] = [];
  const corners = [
    { x: hb - r, y: hn - r, a0: 0, a1: Math.PI / 2 },
    { x: -hb + r, y: hn - r, a0: Math.PI / 2, a1: Math.PI },
    { x: -hb + r, y: -hn + r, a0: Math.PI, a1: (3 * Math.PI) / 2 },
    { x: hb - r, y: -hn + r, a0: (3 * Math.PI) / 2, a1: 2 * Math.PI },
  ];
  for (const c of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = c.a0 + ((c.a1 - c.a0) * i) / steps;
      pts.push(new Vector2(c.x + r * Math.cos(a), c.y + r * Math.sin(a)));
    }
  }
  return pts;
}

function sweepProfile(
  curve: CatmullRomCurve3,
  profile: Vector2[],
  segments: number,
  twistFn?: (t: number) => number,
): BufferGeometry {
  const pts = curve.getSpacedPoints(segments);
  const tangents: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    tangents.push(curve.getTangentAt(i / segments).normalize());
  }

  const normals: Vector3[] = [];
  const binormals: Vector3[] = [];
  const t0 = tangents[0];
  let n = new Vector3(0, 1, 0);
  if (Math.abs(t0.dot(n)) > 0.86) n.set(1, 0, 0);
  n.crossVectors(n, t0).cross(t0).normalize();
  if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
  normals.push(n.clone());
  binormals.push(new Vector3().crossVectors(t0, n).normalize());

  for (let i = 1; i <= segments; i++) {
    const tPrev = tangents[i - 1];
    const t = tangents[i];
    const axis = new Vector3().crossVectors(tPrev, t);
    const axisLen = axis.length();
    n = normals[i - 1].clone();
    if (axisLen > 1e-6) {
      axis.divideScalar(axisLen);
      const angle = Math.acos(Math.min(1, Math.max(-1, tPrev.dot(t))));
      n.applyAxisAngle(axis, angle);
    }
    n.addScaledVector(t, -n.dot(t)).normalize();
    normals.push(n);
    binormals.push(new Vector3().crossVectors(t, n).normalize());
  }

  const np = profile.length;
  const positions: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const twist = twistFn ? twistFn(t) : 0;
    const c = Math.cos(twist);
    const s = Math.sin(twist);
    const N = normals[i];
    const B = binormals[i];
    const nTw = new Vector3().addScaledVector(N, c).addScaledVector(B, s);
    const bTw = new Vector3().addScaledVector(N, -s).addScaledVector(B, c);
    const p = pts[i];
    for (const q of profile) {
      positions.push(
        p.x + nTw.x * q.y + bTw.x * q.x,
        p.y + nTw.y * q.y + bTw.y * q.x,
        p.z + nTw.z * q.y + bTw.z * q.x,
      );
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < np; j++) {
      const jn = (j + 1) % np;
      const a = i * np + j;
      const b = i * np + jn;
      const c = (i + 1) * np + j;
      const d = (i + 1) * np + jn;
      indices.push(a, c, b, b, c, d);
    }
  }

  const cap = (slice: number, reverse: boolean) => {
    const base = slice * np;
    const cx = [0, 0, 0];
    for (let j = 0; j < np; j++) {
      cx[0] += positions[(base + j) * 3];
      cx[1] += positions[(base + j) * 3 + 1];
      cx[2] += positions[(base + j) * 3 + 2];
    }
    cx[0] /= np;
    cx[1] /= np;
    cx[2] /= np;
    const ci = positions.length / 3;
    positions.push(cx[0], cx[1], cx[2]);
    for (let j = 0; j < np; j++) {
      const jn = (j + 1) % np;
      if (reverse) indices.push(ci, base + jn, base + j);
      else indices.push(ci, base + j, base + jn);
    }
  };
  cap(0, true);
  cap(segments, false);

  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

export function makeSeamRibbon(): BufferGeometry {
  // One continuous ribbon: bottom bar, right 180°, middle behind, left 180°,
  // top bar. Width lives in the letter plane; thickness is toward the camera.
  const pts: Vector3[] = [];
  const n = 18;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    let x: number;
    let y: number;
    if (u < 0.22) {
      const t = u / 0.22;
      x = -0.64 + 1.28 * t;
      y = -1.08 - 0.06 * Math.sin(Math.PI * t);
    } else if (u < 0.38) {
      const t = (u - 0.22) / 0.16;
      const a = -Math.PI / 2 + Math.PI * t;
      x = 0.64 + 0.52 * Math.cos(a);
      y = -0.56 + 0.52 * Math.sin(a);
    } else if (u < 0.62) {
      const t = (u - 0.38) / 0.24;
      x = 0.64 - 1.28 * t;
      y = -0.04 + 0.08 * t;
    } else if (u < 0.78) {
      const t = (u - 0.62) / 0.16;
      const a = -Math.PI / 2 - Math.PI * t;
      x = -0.64 + 0.52 * Math.cos(a);
      y = 0.56 + 0.52 * Math.sin(a);
    } else {
      const t = (u - 0.78) / 0.22;
      x = -0.64 + 1.28 * t;
      y = 1.08 + 0.06 * Math.sin(Math.PI * t);
    }
    const z = 0.11 * Math.cos(2 * Math.PI * u);
    pts.push(new Vector3(x, y, z));
  }
  const curve = new CatmullRomCurve3(pts, false, "catmullrom", 0.18);
  const profile = stadiumProfile(0.10, 0.42, 0.045, 4);
  const twist = (t: number) => 0.12 * Math.sin(Math.PI * t);
  return sweepProfile(curve, profile, 96, twist);
}

export const SEAM_NATIVE_HEIGHT = 2.72;

function roundedRect(cx: number, cy: number, w: number, h: number, r: number): Shape {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const s = new Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function makeCuboid(): BufferGeometry {
  const face = roundedRect(0, 0, 1.15, 0.34, 0.07);
  const geo = new ExtrudeGeometry(face, {
    depth: 0.72,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.024,
    bevelSegments: 2,
    curveSegments: 5,
  });
  geo.translate(0, 0, -0.36);
  geo.computeVertexNormals();
  return geo;
}

export function seamXAt(y: number, radius: number): number {
  const t = (y / radius + 1) / 2;
  return 0.18 * radius * Math.sin(2 * Math.PI * t);
}

export function makeHiddenPathDisc(): BufferGeometry {
  const geo = new CylinderGeometry(1, 1, 0.14, 48, 1, false);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

export function makeHiddenPathSeam(): BufferGeometry {
  const pts: Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const y = 1 - 2 * t;
    pts.push(new Vector3(seamXAt(y, 1), y, 0.02));
  }
  const curve = new CatmullRomCurve3(pts, false, "catmullrom", 0.2);
  return new TubeGeometry(curve, 32, 0.028, 6, false);
}

export function hiddenPathPoint(t: number, radius = 1): Vector3 {
  const y = radius * (1 - 2 * t);
  return new Vector3(seamXAt(y, radius), y, 0.04);
}

export function makeMarketBar(): BufferGeometry {
  const s = roundedRect(0, 0.5, 0.32, 1, 0.05);
  const geo = new ExtrudeGeometry(s, {
    depth: 0.22,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.016,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.translate(0, 0, -0.11);
  geo.computeVertexNormals();
  return geo;
}

export function makeProofDisc(): BufferGeometry {
  const geo = new CylinderGeometry(1, 1, 0.16, 48, 1, false);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}
