import type { AggregateBucket, AggregateResolution, LatestReading, Reading } from '@dtwin/types';
import type { Db } from '../client.ts';

/**
 * The tenant-scoped BARRIER VIEWS, not the aggregates themselves.
 *
 * `telemetry_1h` and friends are continuous aggregates, which are views, and a
 * view cannot carry a row-level security policy — so the application is not
 * granted access to them at all. `telemetry_1h_t` filters on
 * `current_tenant_id()` and is what `dtwin_app` may read. Naming the bare
 * aggregate here produces `permission denied for view telemetry_1h`, which is
 * the intended way to find out. See docs/decisions.md §43.
 */
const VIEW_FOR: Record<AggregateResolution, string> = {
  '5m': 'telemetry_5m_t',
  '1h': 'telemetry_1h_t',
  '1d': 'telemetry_1d_t',
};

/**
 * Insert a batch of readings.
 *
 * One multi-row INSERT with unnest rather than a loop of parameterised inserts:
 * a 5,000-row batch becomes one statement and one round trip instead of 5,000.
 * ON CONFLICT collapses re-deliveries against the (sensor_id, time) unique
 * index — gateways retry, and a retried batch must not double-count a meter.
 *
 * TENANT IS DERIVED, NOT SUPPLIED. `telemetry` is compressed, and TimescaleDB
 * refuses row-level security on a compressed hypertable, so there is no policy
 * to catch a wrong `tenant_id` here. Instead the statement joins `sensors`,
 * which IS under RLS, and takes the tenant from the sensor row. A reading
 * naming another tenant's sensor does not join and is dropped.
 *
 * That also means the caller cannot write into a tenant it cannot already read,
 * even if it wanted to — which is a stronger guarantee than a `WITH CHECK`
 * would have given, because it does not depend on the caller passing the right
 * value in the first place. See docs/decisions.md §44.
 *
 * The count returned is rows actually written, so a caller comparing it against
 * the batch length sees both duplicates and unattributable readings.
 */
export async function insertReadings(db: Db, readings: Reading[]): Promise<number> {
  if (readings.length === 0) return 0;

  const { rowCount } = await db.query(
    `INSERT INTO telemetry (time, tenant_id, sensor_id, value, quality)
     SELECT to_timestamp(t.ts / 1000.0), s.tenant_id, t.sensor_id, t.value, t.quality
       FROM unnest($1::bigint[], $2::uuid[], $3::double precision[], $4::smallint[])
              AS t(ts, sensor_id, value, quality)
       JOIN sensors s ON s.id = t.sensor_id
     ON CONFLICT (sensor_id, time) DO NOTHING`,
    [
      readings.map((r) => r.ts),
      readings.map((r) => r.sensorId),
      readings.map((r) => r.value),
      readings.map((r) => r.quality),
    ],
  );
  return rowCount ?? 0;
}

/**
 * Latest reading per sensor for a zone.
 *
 * DISTINCT ON is the right tool here: Postgres walks the (sensor_id, time DESC)
 * index and stops at the first row per sensor. A window function or a
 * correlated subquery would scan far more.
 *
 * Staleness is computed in SQL against each sensor's own expected interval
 * rather than a global constant — a 5-minute-old reading is healthy for a meter
 * polled every 15 minutes and a fault for a 60-second zone temperature.
 *
 * Reads `telemetry_t` rather than `telemetry`: the application role has INSERT
 * on the hypertable but no general SELECT, so this is the only way in.
 */
export async function getLatestReadingsForZone(
  db: Db,
  zoneId: string,
): Promise<LatestReading[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (t.sensor_id)
            t.sensor_id AS "sensorId", s.metric, s.unit,
            t.value, t.quality, t.time AS ts,
            (now() - t.time) > (s.sample_interval_s * 3 * INTERVAL '1 second') AS "isStale"
       FROM telemetry_t t
       JOIN sensors s ON s.id = t.sensor_id
      WHERE s.zone_id = $1
        AND s.is_active
        -- Bound the scan to recent chunks; without this DISTINCT ON would
        -- happily walk two years of history for a decommissioned point.
        AND t.time > now() - INTERVAL '24 hours'
      ORDER BY t.sensor_id, t.time DESC`,
    [zoneId],
  );
  return rows as LatestReading[];
}

/**
 * History for one sensor at a given resolution.
 *
 * Reads the continuous aggregates, never raw telemetry. With real-time
 * aggregation enabled the view also covers the not-yet-materialised tail, so
 * the most recent bucket is live rather than up to a refresh interval stale.
 *
 * `delta` is only meaningful for cumulative points and is null otherwise: it
 * comes from counter_agg, which is reset-aware, so a meter rollover produces a
 * correct interval rather than a negative spike or a fictional megawatt.
 */
export async function getSensorHistory(
  db: Db,
  sensorId: string,
  resolution: AggregateResolution,
  from: Date,
  to: Date,
): Promise<AggregateBucket[]> {
  const view = VIEW_FOR[resolution];
  // counter_agg only exists on the hourly and daily views.
  const deltaExpr = resolution === '5m' ? 'NULL::double precision' : 'delta(counter)';

  const { rows } = await db.query(
    `SELECT bucket, sensor_id AS "sensorId",
            avg_value AS "avgValue", min_value AS "minValue",
            max_value AS "maxValue", last_value AS "lastValue",
            sample_count AS "sampleCount", bad_quality_count AS "badQualityCount",
            CASE WHEN s.is_cumulative THEN ${deltaExpr} END AS "deltaValue"
       FROM ${view} a
       JOIN sensors s ON s.id = a.sensor_id
      WHERE a.sensor_id = $1 AND a.bucket >= $2 AND a.bucket < $3
      ORDER BY bucket`,
    [sensorId, from, to],
  );
  return rows as AggregateBucket[];
}

/**
 * Per-zone mean of one metric over a window — the heatmap overlay's data source.
 *
 * Returns one number per zone so the 3D layer can map value to colour directly.
 * Averaging the zone's sensors for that metric handles zones with more than one
 * point; sample_count is weighted so a sensor that dropped out mid-window does
 * not distort the mean.
 */
export async function getZoneHeatmap(
  db: Db,
  buildingId: string,
  metric: string,
  from: Date,
  to: Date,
): Promise<Array<{ zoneId: string; zoneName: string; value: number | null }>> {
  const { rows } = await db.query(
    `SELECT z.id AS "zoneId", z.name AS "zoneName",
            CASE WHEN sum(a.sample_count) > 0
                 THEN sum(a.avg_value * a.sample_count) / sum(a.sample_count)
            END AS value
       FROM zones z
       JOIN floors f  ON f.id = z.floor_id
       LEFT JOIN sensors s ON s.zone_id = z.id AND s.metric = $2::metric_type AND s.is_active
       LEFT JOIN telemetry_1h_t a ON a.sensor_id = s.id AND a.bucket >= $3 AND a.bucket < $4
      WHERE f.building_id = $1
      GROUP BY z.id, z.name
      ORDER BY z.name`,
    [buildingId, metric, from, to],
  );
  return rows as Array<{ zoneId: string; zoneName: string; value: number | null }>;
}
