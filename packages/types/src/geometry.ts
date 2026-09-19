import { z } from 'zod';

/**
 * Geometry in the LOCAL SITE CRS: metres, origin at the building datum corner,
 * +X east, +Y north, +Z up. These coordinates are directly usable as Three.js
 * world coordinates — that is the whole reason the schema keeps floor plans out
 * of WGS84.
 *
 * `LatLng` is the one exception: buildings.location is real WGS84, used for
 * weather lookup and map placement, and never for anything geometric.
 */

export const Vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3 = z.infer<typeof Vec3>;

export const LatLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLng>;

/** Axis-aligned bounds in local metres — used for camera framing and picking. */
export const BBox = z.object({
  min: Vec3,
  max: Vec3,
});
export type BBox = z.infer<typeof BBox>;

/**
 * A closed ring in local metres. GeoJSON-style [x, y, z] positions, first and
 * last coordinate equal. Z is the floor elevation, so a zone boundary is a flat
 * polygon sitting at its floor's height.
 */
export const Ring = z.array(z.tuple([z.number(), z.number(), z.number()])).min(4);
export type Ring = z.infer<typeof Ring>;

export const PolygonZ = z.object({
  type: z.literal('Polygon'),
  /** First ring is the exterior; any further rings are holes (atria, cores). */
  coordinates: z.array(Ring).min(1),
});
export type PolygonZ = z.infer<typeof PolygonZ>;

export function bboxOf(polygon: PolygonZ): BBox {
  const positions = polygon.coordinates.flat();
  const xs = positions.map((p) => p[0]);
  const ys = positions.map((p) => p[1]);
  const zs = positions.map((p) => p[2]);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
  };
}

export function centroidOf(polygon: PolygonZ): Vec3 {
  const ring = polygon.coordinates[0]!;
  // Drop the repeated closing coordinate so it is not double-weighted.
  const pts = ring.slice(0, -1);
  const n = pts.length || 1;
  return {
    x: pts.reduce((s, p) => s + p[0], 0) / n,
    y: pts.reduce((s, p) => s + p[1], 0) / n,
    z: pts.reduce((s, p) => s + p[2], 0) / n,
  };
}
