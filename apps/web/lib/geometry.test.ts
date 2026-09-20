import { describe, expect, it } from 'vitest';
import type { PolygonZ } from '@dtwin/types';
import { buildingBounds, extrudeZone, polygonCentroid } from './geometry.ts';

/**
 * The 3D view is the one part of this system with no automated coverage — the
 * web smoke suite says so explicitly and leaves the canvas to be "verified by
 * hand". These are the parts of it that are arithmetic rather than rendering,
 * and arithmetic can be checked.
 *
 * Both functions have a specific trap. extrudeZone must drop the ring's
 * repeated closing coordinate, because three.js closes shapes implicitly and
 * the duplicate leaves a degenerate segment that renders as a shading seam.
 * buildingBounds must survive a building whose floors have no footprint at all,
 * because its result divides the camera framing.
 */
function square(size: number, z = 0): PolygonZ {
  return {
    type: 'Polygon',
    coordinates: [[
      [0, 0, z], [size, 0, z], [size, size, z], [0, size, z], [0, 0, z],
    ]],
  } as PolygonZ;
}

describe('extrudeZone', () => {
  it('drops the repeated closing coordinate', () => {
    // Four distinct corners, not five. A fifth would coincide with the first.
    const geometry = extrudeZone(square(10), 3);
    const pos = geometry.getAttribute('position');
    const footprint = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      footprint.add(`${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)}`);
    }
    expect(footprint.size).toBe(4);
  });

  it('extrudes to the requested depth', () => {
    const geometry = extrudeZone(square(10), 3.25);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.z - box.min.z).toBeCloseTo(3.25, 6);
    expect(box.max.x - box.min.x).toBeCloseTo(10, 6);
  });

  it('carries interior rings through as holes', () => {
    const withCore: PolygonZ = {
      type: 'Polygon',
      coordinates: [
        square(20).coordinates[0]!,
        [[8, 8, 0], [12, 8, 0], [12, 12, 0], [8, 12, 0], [8, 8, 0]],
      ],
    } as PolygonZ;
    // A 20x20 slab with a 4x4 core removed has less geometry than a solid one.
    const solid = extrudeZone(square(20), 3).getAttribute('position').count;
    const holed = extrudeZone(withCore, 3).getAttribute('position').count;
    expect(holed).toBeGreaterThan(0);
    expect(holed).not.toBe(solid);
  });
});

describe('polygonCentroid', () => {
  it('finds the centre of a square, ignoring the repeated corner', () => {
    // Averaging all five stored coordinates would bias towards [0,0].
    expect(polygonCentroid(square(10, 4))).toEqual({ x: 5, y: 5, z: 4 });
  });
});

describe('buildingBounds', () => {
  it('spans every floor footprint', () => {
    const bounds = buildingBounds([square(40, 0), square(40, 4), square(40, 8)]);
    expect(bounds.center).toEqual({ x: 20, y: 20, z: 4 });
    expect(bounds.size).toEqual({ x: 40, y: 40, z: 8 });
    expect(bounds.radius).toBe(40);
  });

  it('ignores floors with no stored footprint', () => {
    expect(buildingBounds([null, square(40, 0), null])).toEqual(
      buildingBounds([square(40, 0)]),
    );
  });

  it('returns a usable unit box when there is no geometry at all', () => {
    // The camera divides by this. A zero radius would frame nothing, or NaN.
    const bounds = buildingBounds([]);
    expect(bounds.radius).toBe(1);
    expect(bounds.size).toEqual({ x: 1, y: 1, z: 1 });
    expect(buildingBounds([null, null]).radius).toBe(1);
  });

  it('never returns a zero radius for a flat single floor', () => {
    // One floor at one elevation has zero extent in z; the radius must still
    // come from the largest non-zero dimension.
    expect(buildingBounds([square(40, 0)]).radius).toBe(40);
  });

  it('handles a floor plan far more detailed than a real one', () => {
    // Math.min/max are applied with spread, which has a ceiling: measured on
    // this Node, ~100k arguments is fine and 200k throws RangeError. A real
    // floor footprint is tens of vertices, and 50k is already absurd, so this
    // records the working range rather than claiming there is no limit. If
    // footprints ever come from a CAD import instead of the seed, replace the
    // spread with a fold before trusting it.
    const ring = Array.from({ length: 50_000 }, (_, i) => [i % 100, i % 70, 0] as [number, number, number]);
    ring.push(ring[0]!);
    const big = { type: 'Polygon', coordinates: [ring] } as PolygonZ;
    expect(() => buildingBounds([big])).not.toThrow();
  });
});
