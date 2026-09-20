import { withTenant } from '@dtwin/db';
import type { MetricType, Topic } from '@dtwin/types';
import { topicId, topicScope } from '@dtwin/types';
import { activeTenants } from './tenants.ts';

/**
 * Device registry: `external_id` -> sensor, with spatial context resolved.
 *
 * A BACnet gateway knows its own object ids and nothing about our UUIDs.
 * Requiring it to learn them would mean a provisioning round trip before it
 * could report anything, so ingest resolves the mapping itself against an
 * in-memory cache — one query at boot rather than one per reading.
 *
 * The cache also carries zone/floor/building, because fan-out needs to know
 * which topics a reading belongs to and doing that join per reading would put a
 * database round trip on the hot path.
 *
 * Since 007 it carries `tenantId` too, and doubles as this service's
 * topic-ownership map. A WebSocket topic is a bare UUID, so knowing one must
 * not grant access to it — `ownerOf` answers which tenant a topic belongs to so
 * `subscribe` can refuse the rest. That lookup has to be synchronous and free:
 * it runs on every subscribe, and a database round trip there would make topic
 * authorisation the slowest thing the socket does.
 */
export interface RegisteredSensor {
  id: string;
  externalId: string;
  /** Human-readable point name, used in alert messages. */
  name: string;
  metric: MetricType;
  unit: string;
  minPlausible: number | null;
  maxPlausible: number | null;
  isCumulative: boolean;
  sampleIntervalS: number;
  equipmentId: string | null;
  zoneId: string | null;
  floorId: string | null;
  buildingId: string | null;
  tenantId: string;
}

/**
 * Resolving spatial context is not a single join: a point hangs off a zone OR
 * off equipment, and equipment may sit on a floor with no zone (plant) or have
 * no floor at all (a main meter serving the building). Each level falls back to
 * the next thing that can supply it.
 */
const REGISTRY_SQL = `
  WITH base AS (
    SELECT s.id, s.external_id, s.name, s.metric, s.unit, s.tenant_id,
           s.min_plausible, s.max_plausible, s.is_cumulative,
           s.sample_interval_s, s.equipment_id,
           COALESCE(s.zone_id, e.zone_id) AS zone_id,
           e.floor_id    AS eq_floor_id,
           e.building_id AS eq_building_id
      FROM sensors s
      LEFT JOIN equipment e ON e.id = s.equipment_id
     WHERE s.is_active
  )
  SELECT b.id, b.external_id AS "externalId", b.name, b.metric, b.unit,
         b.tenant_id AS "tenantId",
         b.min_plausible AS "minPlausible", b.max_plausible AS "maxPlausible",
         b.is_cumulative AS "isCumulative",
         b.sample_interval_s AS "sampleIntervalS",
         b.equipment_id AS "equipmentId",
         b.zone_id AS "zoneId",
         COALESCE(z.floor_id, b.eq_floor_id) AS "floorId",
         COALESCE(zf.building_id, ef.building_id, b.eq_building_id) AS "buildingId"
    FROM base b
    LEFT JOIN zones  z  ON z.id  = b.zone_id
    LEFT JOIN floors zf ON zf.id = z.floor_id
    LEFT JOIN floors ef ON ef.id = b.eq_floor_id
`;

export class SensorRegistry {
  /**
   * Keyed by TENANT AND external id, not external id alone.
   *
   * `sensors.external_id` was globally unique until 007 and is now unique only
   * within a tenant — two operators will both run a point called
   * `BAC:AHU-01:KW`. A single flat map would have one of them silently
   * shadowing the other, which is a data-crossing bug that looks like a
   * misconfigured gateway.
   */
  #byExternalId = new Map<string, RegisteredSensor>();
  #byId = new Map<string, RegisteredSensor>();
  /** Which tenant owns a building/floor/zone/sensor id — the topic guard. */
  #ownerById = new Map<string, string>();
  /**
   * Unknown external ids are remembered so a misconfigured gateway spamming an
   * id we do not have cannot trigger a database refresh per reading.
   */
  #unknown = new Map<string, number>();
  #refreshing: Promise<void> | null = null;

  static readonly UNKNOWN_RETRY_MS = 30_000;

  static key(tenantId: string, externalId: string): string {
    return `${tenantId}:${externalId}`;
  }

  async refresh(): Promise<void> {
    // Collapse concurrent refreshes; a burst of cache misses should cause one
    // query, not one per miss.
    if (this.#refreshing) return this.#refreshing;

    this.#refreshing = (async () => {
      const byExternalId = new Map<string, RegisteredSensor>();
      const byId = new Map<string, RegisteredSensor>();
      const ownerById = new Map<string, string>();

      // One scoped pass per tenant. The registry spans tenants; every query
      // that builds it does not.
      for (const tenant of await activeTenants()) {
        const { rows } = await withTenant({ tenantId: tenant.id }, (db) =>
          db.query<RegisteredSensor>(REGISTRY_SQL).then((r) => r));

        for (const r of rows) {
          byExternalId.set(SensorRegistry.key(r.tenantId, r.externalId), r);
          byId.set(r.id, r);
          // Every id a topic can name maps to its owner.
          ownerById.set(r.id, r.tenantId);
          if (r.zoneId) ownerById.set(r.zoneId, r.tenantId);
          if (r.floorId) ownerById.set(r.floorId, r.tenantId);
          if (r.buildingId) ownerById.set(r.buildingId, r.tenantId);
        }

        // Buildings and floors with no sensors still own topics a dashboard
        // will subscribe to. Without this, an empty floor's topic resolves to
        // no owner and the subscribe is refused — which looks to an operator
        // exactly like a floor that has gone quiet.
        const { rows: spatial } = await withTenant({ tenantId: tenant.id }, (db) =>
          db.query<{ id: string }>(
            `SELECT id FROM buildings
             UNION ALL SELECT id FROM floors
             UNION ALL SELECT id FROM zones`));
        for (const row of spatial) ownerById.set(row.id, tenant.id);
      }

      // Swap atomically so a lookup never sees a half-built map.
      this.#byExternalId = byExternalId;
      this.#byId = byId;
      this.#ownerById = ownerById;
      this.#unknown.clear();
    })();

    try {
      await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }

  /**
   * Which tenant owns this topic, or undefined if nothing here knows.
   *
   * Undefined must be treated as "refuse", never as "allow": an id this map has
   * not heard of is either not ours or not yet loaded, and neither is a reason
   * to stream data to a subscriber.
   *
   * `sim:` topics need no special case: they are keyed by building id (§45),
   * so they resolve through this same map. This paragraph used to claim they
   * were "authorised separately, against the run's own tenant" — that code was
   * never written, and while it said so every sim topic was silently refused.
   */
  ownerOf(topic: Topic): string | undefined {
    return this.#ownerById.get(topicId(topic));
  }

  /** True when `tenantId` may subscribe to `topic`. */
  maySubscribe(tenantId: string, topic: Topic): boolean {
    if (topicScope(topic) === 'alerts') {
      // `alerts:<tenantId>` — its own id is the authorisation.
      return topicId(topic) === tenantId;
    }
    return this.ownerOf(topic) === tenantId;
  }

  get size(): number {
    return this.#byId.size;
  }

  all(): RegisteredSensor[] {
    return [...this.#byId.values()];
  }

  byId(id: string): RegisteredSensor | undefined {
    return this.#byId.get(id);
  }

  /**
   * Synchronous lookup — the hot path must not await. A miss is reported so the
   * caller can schedule a refresh out of band, and a recently-missed id is
   * reported as unknown without re-querying.
   */
  lookup(tenantId: string, externalId: string): RegisteredSensor | undefined {
    return this.#byExternalId.get(SensorRegistry.key(tenantId, externalId));
  }

  /** Every sensor belonging to one tenant. */
  forTenant(tenantId: string): RegisteredSensor[] {
    return [...this.#byId.values()].filter((s) => s.tenantId === tenantId);
  }

  /** True when this id is worth a refresh rather than a known-bad id. */
  shouldRetryUnknown(tenantId: string, externalId: string, now = Date.now()): boolean {
    const key = SensorRegistry.key(tenantId, externalId);
    const last = this.#unknown.get(key);
    if (last !== undefined && now - last < SensorRegistry.UNKNOWN_RETRY_MS) return false;
    this.#unknown.set(key, now);
    return true;
  }
}
