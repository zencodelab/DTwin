import type { SpatialTree } from '@dtwin/types';
import type { Db } from '../client.ts';

/**
 * Hydrate one building's whole spatial tree in a single round trip.
 *
 * Five separate queries rather than one giant join: joining floors x zones x
 * equipment x sensors multiplies rows combinatorially (24 zones x 40 assets x
 * 190 points) and then needs de-duplicating in JS. Five small result sets
 * assembled client-side is both less data over the wire and less code.
 *
 * Geometry is converted to GeoJSON in Postgres via ST_AsGeoJSON. The local-CRS
 * coordinates come through unchanged, which is exactly what the Three.js scene
 * wants — no reprojection anywhere in the path.
 *
 * `db` is a tenant-scoped handle from `withTenant`. None of the queries below
 * carry a tenant predicate of their own and none should: the RLS policies add
 * it, and duplicating it here would create two places to get it wrong. The
 * consequence to internalise is that `buildingId` is NOT trusted — a building
 * belonging to another tenant simply returns null, the same as one that does
 * not exist, which is also the right thing to tell the caller.
 */
/**
 * The most of each collection one tree may carry.
 *
 * The tree had no ceiling at all, and everything in it is handed to a browser
 * in one piece: serialised into the page's flight payload, held in memory, and
 * — for zones — turned into one extruded mesh each. So the limits are set by
 * what that consumer can do with the answer, not by what Postgres can return.
 * They are an order of magnitude above a large tower and well below the point
 * where the dashboard stops being usable.
 */
export const SPATIAL_LIMITS = {
  floors: 300,
  zones: 5_000,
  equipment: 20_000,
  sensors: 50_000,
  services: 60_000,
} as const;

export type SpatialLimits = Record<keyof typeof SPATIAL_LIMITS, number>;

/**
 * A building too large to load whole.
 *
 * Thrown rather than answered with a truncated tree, and the difference
 * matters more here than it did for sensor history. A capped time series still
 * means something — it is the most recent window. A capped spatial tree is a
 * building with rooms missing, rendered with full confidence: zones that are
 * not drawn cannot be clicked, cannot show an alert, and look exactly like
 * zones that do not exist. There is no honest subset of a floor plan, so the
 * caller is told the truth instead.
 *
 * Reaching this is the signal to load the tree per floor, which the schema
 * already supports and nothing has needed yet.
 */
export class SpatialTreeTooLargeError extends Error {
  constructor(
    readonly collection: keyof typeof SPATIAL_LIMITS,
    readonly limit: number,
  ) {
    super(
      `building has more than ${limit} ${collection}; the spatial tree is ` +
        'loaded whole and cannot be truncated without drawing a building with ' +
        'parts missing. Load it per floor instead.',
    );
    this.name = 'SpatialTreeTooLargeError';
  }
}

/**
 * `limits` exists so the ceiling can be exercised without seeding five
 * thousand zones. Production callers leave it alone.
 */
export async function getSpatialTree(
  db: Db,
  buildingId: string,
  limits: SpatialLimits = SPATIAL_LIMITS,
): Promise<SpatialTree | null> {
  // One past the limit, so "exactly at it" and "over it" are distinguishable.
  const over = (collection: keyof SpatialLimits) => limits[collection] + 1;
  const enforce = (collection: keyof SpatialLimits, rowCount: number | null) => {
    if ((rowCount ?? 0) > limits[collection]) {
      throw new SpatialTreeTooLargeError(collection, limits[collection]);
    }
  };

  const building = await db.query(
    `SELECT id, name, address, timezone,
            CASE WHEN location IS NULL THEN NULL
                 ELSE json_build_object('lat', ST_Y(location::geometry),
                                        'lng', ST_X(location::geometry)) END AS location,
            gross_floor_area_m2  AS "grossFloorAreaM2",
            year_built           AS "yearBuilt",
            grid_carbon_kg_per_kwh AS "gridCarbonKgPerKwh",
            gltf_asset_path      AS "gltfAssetPath",
            metadata,
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM buildings WHERE id = $1`,
    [buildingId],
  );
  if (building.rowCount === 0) return null;

  const [floors, zones, equipment, sensors, services] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id, building_id AS "buildingId", level, name,
              elevation_m AS "elevationM", floor_height_m AS "floorHeightM",
              floor_area_m2 AS "floorAreaM2",
              ST_AsGeoJSON(footprint)::json AS footprint,
              gltf_node_id AS "gltfNodeId",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM floors WHERE building_id = $1 ORDER BY level LIMIT $2`,
      [buildingId, over('floors')],
    ),
    db.query<{ id: string; floorId: string }>(
      `SELECT z.id, z.floor_id AS "floorId", z.name, z.zone_type AS "zoneType",
              z.area_m2 AS "areaM2", z.volume_m3 AS "volumeM3",
              z.design_occupancy AS "designOccupancy",
              z.exterior_wall_area_m2 AS "exteriorWallAreaM2",
              ST_AsGeoJSON(z.boundary)::json AS boundary,
              z.gltf_node_id AS "gltfNodeId",
              z.thermal_profile_id AS "thermalProfileId",
              z.occupancy_schedule_id AS "occupancyScheduleId",
              z.created_at AS "createdAt", z.updated_at AS "updatedAt"
         FROM zones z JOIN floors f ON f.id = z.floor_id
        WHERE f.building_id = $1 ORDER BY f.level, z.name LIMIT $2`,
      [buildingId, over('zones')],
    ),
    db.query(
      `SELECT id, building_id AS "buildingId", floor_id AS "floorId", zone_id AS "zoneId",
              parent_equipment_id AS "parentEquipmentId", tag,
              equipment_type AS "equipmentType", manufacturer, model,
              serial_number AS "serialNumber", install_date AS "installDate",
              rated_power_kw AS "ratedPowerKw", rated_airflow_cmh AS "ratedAirflowCmh",
              status,
              CASE WHEN position IS NULL THEN NULL
                   ELSE json_build_object('x', ST_X(position), 'y', ST_Y(position),
                                          'z', ST_Z(position)) END AS position,
              gltf_node_id AS "gltfNodeId", metadata,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM equipment WHERE building_id = $1 ORDER BY tag LIMIT $2`,
      [buildingId, over('equipment')],
    ),
    db.query(
      `SELECT s.id, s.external_id AS "externalId", s.name, s.metric, s.unit,
              s.equipment_id AS "equipmentId", s.zone_id AS "zoneId",
              s.min_plausible AS "minPlausible", s.max_plausible AS "maxPlausible",
              s.is_cumulative AS "isCumulative",
              s.sample_interval_s AS "sampleIntervalS",
              s.is_active AS "isActive", s.last_seen_at AS "lastSeenAt",
              s.created_at AS "createdAt", s.updated_at AS "updatedAt"
         FROM sensors s
         LEFT JOIN equipment e ON e.id = s.equipment_id
         LEFT JOIN zones z     ON z.id = s.zone_id
         LEFT JOIN floors f    ON f.id = z.floor_id
        WHERE e.building_id = $1 OR f.building_id = $1
        ORDER BY s.external_id LIMIT $2`,
      [buildingId, over('sensors')],
    ),
    db.query(
      `SELECT es.equipment_id AS "equipmentId", es.zone_id AS "zoneId",
              es.role, es.load_fraction AS "loadFraction"
         FROM equipment_zone_service es
         JOIN equipment e ON e.id = es.equipment_id
        WHERE e.building_id = $1 LIMIT $2`,
      [buildingId, over('services')],
    ),
  ]);

  enforce('floors', floors.rowCount);
  enforce('zones', zones.rowCount);
  enforce('equipment', equipment.rowCount);
  enforce('sensors', sensors.rowCount);
  enforce('services', services.rowCount);

  const zonesByFloor = new Map<string, unknown[]>();
  // Assembled here rather than by a five-way join: joining floors x zones x
  // equipment x sensors multiplies rows combinatorially. See the header.
  for (const z of zones.rows) {
    const list = zonesByFloor.get(z.floorId) ?? [];
    list.push(z);
    zonesByFloor.set(z.floorId, list);
  }

  return {
    building: building.rows[0],
    floors: floors.rows.map((f) => ({ ...f, zones: zonesByFloor.get(f.id) ?? [] })),
    equipment: equipment.rows,
    sensors: sensors.rows,
    services: services.rows,
  } as SpatialTree;
}

/**
 * Which zone contains a point picked in the 3D view.
 *
 * ST_Contains against the 2D projection, with elevation matched separately —
 * zone boundaries are flat polygons at their floor's Z, so a 3D containment
 * test against a ray hit slightly above the floor plane would never match.
 */
export async function findZoneAtPoint(
  db: Db,
  buildingId: string,
  x: number,
  y: number,
  z: number,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT zo.id, zo.name
       FROM zones zo
       JOIN floors f ON f.id = zo.floor_id
      WHERE f.building_id = $1
        AND ST_Contains(ST_Force2D(zo.boundary), ST_SetSRID(ST_MakePoint($2, $3), 0))
        AND $4 BETWEEN f.elevation_m - 0.5
                   AND f.elevation_m + COALESCE(f.floor_height_m, 4) + 0.5
      LIMIT 1`,
    [buildingId, x, y, z],
  );
  return rows[0] ?? null;
}
