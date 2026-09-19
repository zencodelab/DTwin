import * as THREE from 'three';
import type { PolygonZ, Vec3 } from '@dtwin/types';

/**
 * Turning the twin's stored geometry into meshes.
 *
 * The 3D view renders the DATABASE, not a model file. Zone volumes are extruded
 * from the PostGIS polygons the schema already holds, in the local metre CRS —
 * so what is on screen cannot drift from what the data says. A separate GLB
 * would be a second source of truth, and the first thing to go stale after a
 * fit-out. `gltf_node_id` stays on every row for the day a real BIM export is
 * loaded alongside this; then the two are reconciled by node id.
 *
 * COORDINATES: the local CRS is +X east, +Y north, +Z up. three.js is Y-up, so
 * the whole scene sits in a group rotated −90° about X, which maps
 * (x, y, z) → (x, z, −y). Geometry is therefore built in raw database
 * coordinates and never transformed by hand — the one rotation is the only
 * place the two conventions meet.
 */
export const SCENE_ROTATION: [number, number, number] = [-Math.PI / 2, 0, 0];

/** Extrude a stored polygon into a solid of the given height. */
export function extrudeZone(boundary: PolygonZ, height: number): THREE.ExtrudeGeometry {
  const ring = boundary.coordinates[0]!;
  const shape = new THREE.Shape();

  // The stored ring repeats its first coordinate to close itself; three.js
  // closes shapes implicitly, so feeding it the duplicate leaves a degenerate
  // final segment that shows up as a shading seam.
  ring.slice(0, -1).forEach(([x, y], i) => {
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });

  // Interior rings are holes — atria, service cores.
  for (const hole of boundary.coordinates.slice(1)) {
    const path = new THREE.Path();
    hole.slice(0, -1).forEach(([x, y], i) => {
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    shape.holes.push(path);
  }

  return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
}

export function polygonCentroid(boundary: PolygonZ): Vec3 {
  const ring = boundary.coordinates[0]!.slice(0, -1);
  const n = ring.length || 1;
  return {
    x: ring.reduce((s, p) => s + p[0], 0) / n,
    y: ring.reduce((s, p) => s + p[1], 0) / n,
    z: ring.reduce((s, p) => s + p[2], 0) / n,
  };
}

export interface Bounds {
  center: Vec3;
  size: Vec3;
  radius: number;
}

/** Bounds over every floor footprint, for framing the camera. */
export function buildingBounds(footprints: (PolygonZ | null)[]): Bounds {
  const points = footprints
    .filter((f): f is PolygonZ => f !== null)
    .flatMap((f) => f.coordinates.flat());

  if (points.length === 0) {
    return { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 }, radius: 1 };
  }

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const zs = points.map((p) => p[2]);

  const min = { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) };
  const max = { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) };
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };

  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    size,
    radius: Math.max(size.x, size.y, size.z) || 1,
  };
}
