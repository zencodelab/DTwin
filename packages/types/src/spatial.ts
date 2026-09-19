import { z } from 'zod';
import {
  BuildingId, FloorId, ZoneId, EquipmentId, SensorId,
  ThermalProfileId, OccupancyScheduleId,
} from './ids.ts';
import {
  ZoneType, EquipmentType, EquipmentStatus, MetricType,
  ServiceRole, MaintenanceType, DayType,
} from './enums.ts';
import { PolygonZ, Vec3, LatLng } from './geometry.ts';

/**
 * Building -> Floor -> Zone -> Equipment -> Sensor.
 *
 * Timestamps use z.coerce.date() so both a pg Date and an ISO string from an
 * HTTP payload parse to the same Date. Nullable columns are `.nullable()`
 * rather than `.optional()`: the database returns null explicitly, and
 * collapsing that to undefined loses the distinction between "no value" and
 * "field not selected".
 */

export const Building = z.object({
  id: BuildingId,
  name: z.string().min(1),
  address: z.string().nullable(),
  timezone: z.string(),
  /** WGS84 — the only geographic coordinate in the model. */
  location: LatLng.nullable(),
  grossFloorAreaM2: z.number().positive().nullable(),
  yearBuilt: z.number().int().nullable(),
  /** Grid emission factor used to convert kWh to carbon. */
  gridCarbonKgPerKwh: z.number().nonnegative(),
  gltfAssetPath: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Building = z.infer<typeof Building>;

export const Floor = z.object({
  id: FloorId,
  buildingId: BuildingId,
  /** Signed: basements negative, ground 0. */
  level: z.number().int(),
  name: z.string().min(1),
  elevationM: z.number(),
  floorHeightM: z.number().positive().nullable(),
  floorAreaM2: z.number().positive().nullable(),
  footprint: PolygonZ.nullable(),
  /** Node name in the GLTF scene graph, for selection and camera framing. */
  gltfNodeId: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Floor = z.infer<typeof Floor>;

export const Zone = z.object({
  id: ZoneId,
  floorId: FloorId,
  name: z.string().min(1),
  zoneType: ZoneType,
  areaM2: z.number().positive().nullable(),
  volumeM3: z.number().positive().nullable(),
  designOccupancy: z.number().int().nonnegative().nullable(),
  exteriorWallAreaM2: z.number().nonnegative().nullable(),
  boundary: PolygonZ.nullable(),
  gltfNodeId: z.string().nullable(),
  thermalProfileId: ThermalProfileId.nullable(),
  occupancyScheduleId: OccupancyScheduleId.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Zone = z.infer<typeof Zone>;

export const Equipment = z.object({
  id: EquipmentId,
  buildingId: BuildingId,
  /** Physical location. Null for plant that has no single floor/zone home. */
  floorId: FloorId.nullable(),
  zoneId: ZoneId.nullable(),
  /** Serving tree: chiller -> AHU -> VAV. Drives fault-impact propagation. */
  parentEquipmentId: EquipmentId.nullable(),
  tag: z.string().min(1),
  equipmentType: EquipmentType,
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  installDate: z.coerce.date().nullable(),
  ratedPowerKw: z.number().nonnegative().nullable(),
  ratedAirflowCmh: z.number().nonnegative().nullable(),
  status: EquipmentStatus,
  position: Vec3.nullable(),
  gltfNodeId: z.string().nullable(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Equipment = z.infer<typeof Equipment>;

/**
 * What an asset SERVES, as opposed to where it sits. One AHU serves many zones;
 * a VAV serves one. loadFraction splits a zone between units so energy is not
 * double-counted.
 */
export const EquipmentZoneService = z.object({
  equipmentId: EquipmentId,
  zoneId: ZoneId,
  role: ServiceRole,
  loadFraction: z.number().gt(0).max(1),
});
export type EquipmentZoneService = z.infer<typeof EquipmentZoneService>;

export const Sensor = z.object({
  id: SensorId,
  /** Device-side identity: BACnet object id, Modbus tag, gateway topic. */
  externalId: z.string().min(1),
  name: z.string().min(1),
  metric: MetricType,
  unit: z.string(),
  equipmentId: EquipmentId.nullable(),
  zoneId: ZoneId.nullable(),
  minPlausible: z.number().nullable(),
  maxPlausible: z.number().nullable(),
  /** Counter rather than gauge — never average these. */
  isCumulative: z.boolean(),
  sampleIntervalS: z.number().int().positive(),
  isActive: z.boolean(),
  lastSeenAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Sensor = z.infer<typeof Sensor>;

export const MaintenanceLog = z.object({
  id: z.string().uuid(),
  equipmentId: EquipmentId,
  performedAt: z.coerce.date(),
  logType: MaintenanceType,
  technician: z.string().nullable(),
  notes: z.string().nullable(),
  /** String, not number — NUMERIC money must not round-trip through a float. */
  cost: z.string().nullable(),
  downtimeMinutes: z.number().int().nonnegative().nullable(),
  nextDueAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type MaintenanceLog = z.infer<typeof MaintenanceLog>;

export const ThermalProfile = z.object({
  id: ThermalProfileId,
  name: z.string().min(1),
  description: z.string().nullable(),
  uValueWallW_m2k: z.number().positive(),
  uValueWindowW_m2k: z.number().positive(),
  uValueRoofW_m2k: z.number().positive().nullable(),
  windowToWallRatio: z.number().min(0).max(1),
  /** Solar heat gain coefficient — the dominant term in a cooling climate. */
  shgc: z.number().min(0).max(1),
  infiltrationAch: z.number().nonnegative(),
  thermalMassKjPerK: z.number().positive(),
  lightingPowerDensityW_m2: z.number().nonnegative(),
  equipmentPowerDensityW_m2: z.number().nonnegative(),
  occupancyHeatGainWPerson: z.number().nonnegative(),
  setpointTempC: z.number(),
  deadbandK: z.number().nonnegative(),
  ventilationLSPerson: z.number().nonnegative(),
  hvacCop: z.number().positive(),
});
export type ThermalProfile = z.infer<typeof ThermalProfile>;

/** 24 hourly occupancy fractions, index 0 = 00:00 local. */
export const HourlyFractions = z.array(z.number().min(0).max(1)).length(24);
export type HourlyFractions = z.infer<typeof HourlyFractions>;

export const OccupancySchedule = z.object({
  id: OccupancyScheduleId,
  name: z.string().min(1),
  description: z.string().nullable(),
  days: z.record(DayType, HourlyFractions),
});
export type OccupancySchedule = z.infer<typeof OccupancySchedule>;

/**
 * The shape the 3D view actually consumes: one building, fully hydrated, so the
 * scene can be built and every node made pickable in a single request. At 4
 * floors / 24 zones / 40 assets this is a few hundred KB — worth one round trip
 * rather than a waterfall of per-floor fetches.
 */
export const SpatialTree = z.object({
  building: Building,
  floors: z.array(Floor.extend({ zones: z.array(Zone) })),
  equipment: z.array(Equipment),
  sensors: z.array(Sensor),
  services: z.array(EquipmentZoneService),
});
export type SpatialTree = z.infer<typeof SpatialTree>;
