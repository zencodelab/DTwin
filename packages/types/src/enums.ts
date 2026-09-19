import { z } from 'zod';

/**
 * Enumerations, mirroring the PostgreSQL types in 001_spatial.sql,
 * 003_alerting.sql and 004_simulation.sql. Keep them in sync — a value added on
 * one side and not the other fails at the parse boundary, which is the intended
 * place to find out, but only if someone is looking.
 *
 * These are `as const` arrays plus Zod enums, not TypeScript `enum`. TS `enum`
 * emits runtime code and is rejected under --erasableSyntaxOnly, which Node's
 * native type stripping requires.
 */

export const ZONE_TYPES = [
  'office', 'meeting', 'corridor', 'server_room', 'lobby',
  'plant_room', 'retail', 'restroom', 'stairwell', 'parking',
] as const;
export const ZoneType = z.enum(ZONE_TYPES);
export type ZoneType = z.infer<typeof ZoneType>;

export const EQUIPMENT_TYPES = [
  'ahu', 'vav', 'fcu', 'chiller', 'boiler', 'pump', 'cooling_tower',
  'electric_meter', 'water_meter', 'btu_meter',
  'lighting_circuit', 'ev_charger',
] as const;
export const EquipmentType = z.enum(EQUIPMENT_TYPES);
export type EquipmentType = z.infer<typeof EquipmentType>;

export const EQUIPMENT_STATUSES = [
  'operational', 'degraded', 'fault', 'offline', 'maintenance',
] as const;
export const EquipmentStatus = z.enum(EQUIPMENT_STATUSES);
export type EquipmentStatus = z.infer<typeof EquipmentStatus>;

export const METRIC_TYPES = [
  'temperature_c', 'humidity_pct', 'co2_ppm',
  'power_kw', 'energy_kwh',
  'occupancy_count', 'pressure_pa', 'airflow_cmh',
  'valve_position_pct', 'damper_position_pct', 'setpoint_temp_c',
  'water_m3', 'illuminance_lux',
] as const;
export const MetricType = z.enum(METRIC_TYPES);
export type MetricType = z.infer<typeof MetricType>;

/**
 * Canonical display unit per metric. The metric name already carries the unit,
 * so this exists for axis labels and tooltips rather than for conversion —
 * there is no conversion layer by design. Data is stored in these units or it
 * is wrong.
 */
export const METRIC_UNITS: Readonly<Record<MetricType, string>> = {
  temperature_c: '°C',
  humidity_pct: '%',
  co2_ppm: 'ppm',
  power_kw: 'kW',
  energy_kwh: 'kWh',
  occupancy_count: 'persons',
  pressure_pa: 'Pa',
  airflow_cmh: 'm³/h',
  valve_position_pct: '%',
  damper_position_pct: '%',
  setpoint_temp_c: '°C',
  water_m3: 'm³',
  illuminance_lux: 'lx',
} as const;

/**
 * Metrics reported as a monotonically increasing counter rather than an
 * instantaneous value. Averaging these is meaningless; consumption over a
 * window is a reset-aware delta. See the counter_agg note in 002_timeseries.sql.
 */
export const CUMULATIVE_METRICS: ReadonlySet<MetricType> = new Set<MetricType>([
  'energy_kwh',
  'water_m3',
]);

export const SERVICE_ROLES = ['primary', 'secondary', 'backup', 'metered_by'] as const;
export const ServiceRole = z.enum(SERVICE_ROLES);
export type ServiceRole = z.infer<typeof ServiceRole>;

export const MAINTENANCE_TYPES = [
  'preventive', 'corrective', 'inspection', 'calibration', 'replacement',
] as const;
export const MaintenanceType = z.enum(MAINTENANCE_TYPES);
export type MaintenanceType = z.infer<typeof MaintenanceType>;

export const DAY_TYPES = ['weekday', 'saturday', 'sunday', 'holiday'] as const;
export const DayType = z.enum(DAY_TYPES);
export type DayType = z.infer<typeof DayType>;

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const AlertSeverity = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const ALERT_STATES = ['open', 'acknowledged', 'resolved'] as const;
export const AlertState = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof AlertState>;

export const ALERT_CONDITIONS = [
  'threshold_above', 'threshold_below', 'rate_of_change',
  'deviation_from_setpoint', 'flatline', 'no_data', 'out_of_range',
] as const;
export const AlertCondition = z.enum(ALERT_CONDITIONS);
export type AlertCondition = z.infer<typeof AlertCondition>;

export const SIMULATION_STATUSES = [
  'queued', 'running', 'completed', 'failed', 'cancelled',
] as const;
export const SimulationStatus = z.enum(SIMULATION_STATUSES);
export type SimulationStatus = z.infer<typeof SimulationStatus>;
