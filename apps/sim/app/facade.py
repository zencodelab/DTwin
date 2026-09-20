"""Which way a zone's exterior walls face, derived from the stored geometry.

`solar.py` averages surface irradiance over the four cardinal orientations,
and says why: zone orientation "is not in the schema". Its own note adds that
recording it per zone "is the fix, and it belongs in the model, not here."

It is in the model. It has always been in the model. `zones.boundary` and
`floors.footprint` are PostGIS polygons in a local metre CRS whose axes are
declared — +X east, +Y north (decision §1) — so a zone's facades are a
property of geometry already stored, not a new fact to record about it.

That is why this derives rather than adds a column. A stored
`facade_azimuth_deg` would be a second source of truth about where a wall
points, free to drift from the polygon that actually says so, which is the
failure decision §27 exists to avoid for the building as a whole.

The averaged version is not a small error for a single-aspect zone. A west
office takes its peak gain late in the afternoon, when the outdoor temperature
is also at its highest and the plant is least able to help; an east office takes
the same energy in the morning, when it is cheap. Averaging over four aspects
puts both peaks at the same middling hour and removes the difference entirely.
"""

from __future__ import annotations

import math

# How close an edge midpoint must lie to the floor outline to count as
# exterior. Generous on purpose: seeded footprints and zone boundaries share
# vertices exactly, but a CAD import will not, and a wall a centimetre inside
# the outline is still a wall on the outside of the building.
EXTERIOR_TOLERANCE_M = 0.25

Point = tuple[float, float]


def _segment_distance(p: Point, a: Point, b: Point) -> float:
    """Shortest distance from a point to the segment a-b."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _distance_to_ring(p: Point, ring: list[Point]) -> float:
    return min(
        (_segment_distance(p, ring[i], ring[i + 1]) for i in range(len(ring) - 1)),
        default=float("inf"),
    )


def _to_2d(ring: list[list[float]]) -> list[Point]:
    """Drop Z and close the ring if the source did not."""
    pts: list[Point] = [(float(c[0]), float(c[1])) for c in ring]
    if len(pts) > 1 and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def surface_azimuth_deg(nx: float, ny: float) -> float:
    """Convert a local outward normal to Duffie's surface azimuth.

    The CRS is +X east, +Y north, so the compass bearing of the normal is
    `atan2(east, north)`. Duffie measures a surface azimuth from SOUTH and
    counts west positive, which is what `solar.irradiance_on_surface` expects —
    so south is 0, west is +90, east is -90, north is ±180.
    """
    compass = math.degrees(math.atan2(nx, ny))
    gamma = compass - 180.0
    # Normalise to (-180, 180]; the sign convention only matters because
    # cos_incidence takes the difference against the sun's own azimuth.
    while gamma <= -180.0:
        gamma += 360.0
    while gamma > 180.0:
        gamma -= 360.0
    return gamma


def exterior_facades(
    zone_ring: list[list[float]],
    footprint_ring: list[list[float]],
    tolerance_m: float = EXTERIOR_TOLERANCE_M,
) -> list[tuple[float, float]]:
    """`(surface_azimuth_deg, wall_length_m)` for each exterior edge of a zone.

    An edge counts as exterior when its midpoint lies on the floor outline. The
    outward normal is whichever of the edge's two perpendiculars points away
    from the zone's own centroid — which is well defined for the convex,
    axis-aligned zones this building has, and is the reason a pathological
    concave zone would want a proper point-in-polygon test instead.

    A core zone returns an empty list, correctly: it has no wall to the outside
    and therefore no solar gain through one.
    """
    zone = _to_2d(zone_ring)
    outline = _to_2d(footprint_ring)
    if len(zone) < 4 or len(outline) < 4:
        return []

    # Centroid of the distinct vertices, used only to choose a normal's sign.
    distinct = zone[:-1]
    cx = sum(p[0] for p in distinct) / len(distinct)
    cy = sum(p[1] for p in distinct) / len(distinct)

    out: list[tuple[float, float]] = []
    for i in range(len(zone) - 1):
        (ax, ay), (bx, by) = zone[i], zone[i + 1]
        length = math.hypot(bx - ax, by - ay)
        if length == 0.0:
            continue

        mid = ((ax + bx) / 2.0, (ay + by) / 2.0)
        if _distance_to_ring(mid, outline) > tolerance_m:
            continue

        # Both perpendiculars to the edge; keep the one facing away from the
        # zone interior.
        dx, dy = (bx - ax) / length, (by - ay) / length
        nx, ny = dy, -dx
        if (mid[0] + nx - cx) ** 2 + (mid[1] + ny - cy) ** 2 < (
            (mid[0] - nx - cx) ** 2 + (mid[1] - ny - cy) ** 2
        ):
            nx, ny = -nx, -ny

        out.append((surface_azimuth_deg(nx, ny), length))

    return out
