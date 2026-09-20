"""Unit tests for deriving facade orientation from stored geometry.

Pure geometry, so no database and no simulation: a wrong sign here would show
up end to end only as a building whose afternoon peak is in the morning, which
is a slow and ambiguous way to find a swapped normal.
"""
from __future__ import annotations

import pytest

from app import facade

# A 40 x 30 m building outline, matching the seeded footprint: +X east,
# +Y north, origin at the south-west corner.
OUTLINE = [[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0], [0, 0, 0]]


def ring(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 0]]


class TestSurfaceAzimuth:
    def test_cardinal_directions_match_duffies_convention(self) -> None:
        # South is 0, west positive, east negative, north at the wrap.
        assert facade.surface_azimuth_deg(0.0, -1.0) == pytest.approx(0.0)    # faces south
        assert facade.surface_azimuth_deg(-1.0, 0.0) == pytest.approx(90.0)   # faces west
        assert facade.surface_azimuth_deg(1.0, 0.0) == pytest.approx(-90.0)   # faces east
        assert abs(facade.surface_azimuth_deg(0.0, 1.0)) == pytest.approx(180.0)

    def test_result_is_always_in_range(self) -> None:
        import math
        for deg in range(0, 360, 7):
            r = math.radians(deg)
            got = facade.surface_azimuth_deg(math.sin(r), math.cos(r))
            assert -180.0 < got <= 180.0


class TestExteriorFacades:
    def test_a_south_west_corner_zone_has_exactly_two_facades(self) -> None:
        got = facade.exterior_facades(ring(0, 0, 13, 15), OUTLINE)
        azimuths = sorted(round(a) for a, _ in got)
        # South-facing (0) and west-facing (+90). The north and east edges of
        # this zone are interior party walls.
        assert azimuths == [0, 90]

    def test_facade_lengths_are_the_wall_lengths(self) -> None:
        got = dict((round(a), round(length)) for a, length in
                   facade.exterior_facades(ring(0, 0, 13, 15), OUTLINE))
        assert got[0] == 13    # the 13 m south wall
        assert got[90] == 15   # the 15 m west wall

    def test_a_north_edge_zone_faces_north(self) -> None:
        got = facade.exterior_facades(ring(13, 15, 27, 30), OUTLINE)
        assert [round(abs(a)) for a, _ in got] == [180]

    def test_an_east_edge_zone_faces_east(self) -> None:
        got = facade.exterior_facades(ring(27, 0, 40, 15), OUTLINE)
        assert sorted(round(a) for a, _ in got) == [-90, 0]

    def test_a_core_zone_has_no_exterior_wall(self) -> None:
        # Entirely inside the outline: no facade, and therefore no solar gain
        # through one. Returning a default orientation would invent a window.
        assert facade.exterior_facades(ring(15, 10, 25, 20), OUTLINE) == []

    def test_a_zone_spanning_the_whole_footprint_has_four_facades(self) -> None:
        got = facade.exterior_facades(ring(0, 0, 40, 30), OUTLINE)
        assert sorted(round(a) for a, _ in got) == [-90, 0, 90, 180]

    def test_a_wall_just_inside_the_outline_still_counts(self) -> None:
        # A CAD import will not share vertices exactly with the outline.
        got = facade.exterior_facades(ring(0.1, 0.1, 13, 15), OUTLINE)
        assert sorted(round(a) for a, _ in got) == [0, 90]

    def test_a_wall_well_inside_the_outline_does_not(self) -> None:
        got = facade.exterior_facades(ring(2, 2, 13, 15), OUTLINE)
        assert got == []

    def test_an_unclosed_ring_is_handled(self) -> None:
        # GeoJSON closes its rings; a hand-built list may not.
        open_ring = [[0, 0, 0], [13, 0, 0], [13, 15, 0], [0, 15, 0]]
        assert len(facade.exterior_facades(open_ring, OUTLINE)) == 2

    def test_degenerate_input_returns_nothing_rather_than_raising(self) -> None:
        assert facade.exterior_facades([], OUTLINE) == []
        assert facade.exterior_facades(ring(0, 0, 13, 15), []) == []
