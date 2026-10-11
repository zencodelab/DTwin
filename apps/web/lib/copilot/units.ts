import type { UnitId } from './evidence.ts';

/**
 * Units, read off the name.
 *
 * The workspace rule is that units are part of every name — `_c`, `_kw`,
 * `_kwh` — and that there is no conversion layer. This module turns that
 * convention into a mechanism: the unit of any number the copilot cites is
 * the suffix of the key it was cited from, so a model that writes "kW" over a
 * `total_kwh` is caught by string comparison, not by judgement.
 *
 * A key with no suffix from this table is UNCITABLE: it can be shown on an
 * evidence card, but it cannot back a unit-bearing number in an answer. That
 * is deliberate for identifiers and levels (`level`, `run_id`), and it is a
 * bug to fix in the tool, never in the verifier, for a quantity that simply
 * lacks its suffix.
 */

/**
 * Longest match first. Order matters wherever one suffix ends another:
 * `_k_per_h` and `_zone_h` both end in `_h`, and must win over it.
 */
export const UNIT_SUFFIXES: ReadonlyArray<{ suffix: string; unit: UnitId }> = Object.freeze([
  { suffix: '_k_per_h', unit: 'k_per_h' },
  { suffix: '_zone_h', unit: 'zone_h' },
  { suffix: '_kwh', unit: 'kwh' },
  { suffix: '_kw', unit: 'kw' },
  { suffix: '_ppm', unit: 'ppm' },
  { suffix: '_cmh', unit: 'cmh' },
  { suffix: '_pct', unit: 'pct' },
  { suffix: '_m2', unit: 'm2' },
  { suffix: '_m3', unit: 'm3' },
  { suffix: '_min', unit: 'min' },
  { suffix: '_count', unit: 'count' },
  { suffix: '_kg', unit: 'kg' },
  { suffix: '_c', unit: 'c' },
  { suffix: '_k', unit: 'k' },
  { suffix: '_h', unit: 'h' },
  { suffix: '_s', unit: 's' },
]);

/**
 * How each unit is written for the operator. `count` is bare — "18 people"
 * reads better than "18 count" — and `%` hugs its number, as the rest of the
 * dashboard writes it; every other symbol takes a space ("23.9 °C").
 */
export const UNIT_SYMBOL: Readonly<Record<UnitId, string>> = Object.freeze({
  k_per_h: 'K/h',
  zone_h: 'zone-hours',
  kwh: 'kWh',
  kw: 'kW',
  ppm: 'ppm',
  cmh: 'm³/h',
  pct: '%',
  m2: 'm²',
  m3: 'm³',
  min: 'min',
  count: '',
  kg: 'kg',
  c: '°C',
  k: 'K',
  h: 'h',
  s: 's',
});

/**
 * The unit a key names, or null when it names none.
 *
 * A compound "per" unit that is NOT in the table is refused rather than read
 * by its tail: `implied_m3_per_h` ends in `_h` but is a flow, not a duration,
 * and `grid_carbon_kg_per_kwh` ends in `_kwh` but is an intensity. Reading
 * either by its last token would verify a number against the wrong unit —
 * the one failure this module exists to prevent.
 */
export function unitOfKey(key: string): UnitId | null {
  for (const { suffix, unit } of UNIT_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stem = key.slice(0, -suffix.length);
      if (stem.endsWith('_per') || stem === 'per') return null;
      return unit;
    }
  }
  return null;
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(decimals: number, grouping: boolean): Intl.NumberFormat {
  const key = `${decimals}:${grouping}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: grouping,
    });
    // Bounded by construction: decimals is 0–3 and grouping is a boolean,
    // so this map never holds more than eight formatters.
    formatters.set(key, f);
  }
  return f;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 3) {
    throw new RangeError(`decimals must be an integer from 0 to 3, got ${decimals}`);
  }
}

/**
 * A number as the operator reads it: fixed decimals, thousands grouped.
 *
 * Negative zero is shown as zero. "-0.0 K" invites the question of which way
 * it moved, and the honest answer is that it did not, at this precision.
 */
export function formatNumber(value: number, decimals: number, grouping = true): string {
  assertDecimals(decimals);
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const s = formatter(decimals, grouping).format(value);
  return /^-[0.,]+$/.test(s) ? s.slice(1) : s;
}

/**
 * The value the operator actually sees, as a number. The verifier compares
 * THIS against the evidence, so the check and the display cannot disagree
 * about rounding: both go through the same formatter.
 */
export function displayedValue(value: number, decimals: number): number {
  return Number(formatNumber(value, decimals, false));
}

/** "23.97 °C", "95%", "2,862 m³/h", "18.2". */
export function formatQuantity(value: number, decimals: number, unit: UnitId): string {
  const n = formatNumber(value, decimals);
  const symbol = UNIT_SYMBOL[unit];
  if (symbol === '') return n;
  if (unit === 'pct') return `${n}${symbol}`;
  return `${n} ${symbol}`;
}

/**
 * Decimals for a number the operator did NOT ask a model about — an evidence
 * card's headline, formatted straight from the record. Enough to be useful,
 * never more than the data's own resolution suggests.
 */
export function defaultDecimals(unit: UnitId, value: number): number {
  switch (unit) {
    case 'c': case 'k': case 'k_per_h': case 'kw': case 'm3': case 'h': case 'zone_h':
      return 1;
    case 'count':
      return Number.isInteger(value) ? 0 : 1;
    default:
      return 0;
  }
}
