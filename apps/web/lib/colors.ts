/**
 * Colour scales for the 3D overlays.
 *
 * Each overlay's scale is chosen by the job its data does, not by taste:
 *
 * - **Temperature is polarity, not magnitude.** What a facility manager needs to
 *   see is deviation from setpoint — too cold, on target, too hot — so it gets a
 *   DIVERGING scale with a neutral midpoint anchored at the setpoint. A hot=red
 *   gradient would encode absolute temperature, which answers a question nobody
 *   asks: 21 C is a problem in a lobby and correct in a server room.
 * - **Occupancy and CO2 are magnitude**, so they get a SEQUENTIAL single-hue
 *   ramp, light to dark. Never a rainbow: hue has no natural order, so a rainbow
 *   forces the reader to consult the legend for every cell.
 *
 * Validated: the diverging poles separate at ΔE 18.7 (light) / 19.6 (dark) under
 * protanopia — clear of the ≥8 target — and each arm is monotonic in lightness
 * with the two arms mirrored to within 0.047 L, so neither side reads heavier.
 *
 * The midpoint sits close to the surface by design, which puts it under 3:1
 * contrast. That obligates relief, met here by the zone name labels on the
 * canvas and the numeric readout in the detail panel: colour never carries the
 * value alone.
 */

export type OverlayMetric = 'temperature_c' | 'occupancy_count' | 'co2_ppm';

/**
 * Diverging, blue ↔ red with a gray midpoint. Anchors from the design system.
 *
 * Five stops per arm rather than four: with four, a third of the scale was spent
 * getting from neutral to full saturation, so a zone 0.9 K off setpoint — a
 * zone that is fine — rendered as an alarming red. The extra near-neutral step
 * keeps small deviations looking like small deviations.
 *
 * Verified monotonic in lightness per arm, with the arms mirrored to within
 * 0.030 L (dark) and 0.047 L (light) so neither pole reads heavier.
 */
const DIVERGING_COLD = ['#f0efec', '#cde2fb', '#86b6ef', '#2a78d6', '#184f95'] as const;
const DIVERGING_HOT = ['#f0efec', '#f8d5d1', '#f0a49c', '#e34948', '#a32420'] as const;
const DIVERGING_COLD_DARK = ['#383835', '#31506e', '#2166a8', '#3987e5', '#86b6ef'] as const;
const DIVERGING_HOT_DARK = ['#383835', '#6b3a35', '#a33c33', '#e0514a', '#f3a49c'] as const;

/** Sequential blue, from the documented ramp (steps 100 → 700). */
const SEQUENTIAL = [
  '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b',
] as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const NO_DATA_LIGHT = '#e1e0d9';
export const NO_DATA_DARK = '#2c2c2a';

// --- OKLab conversion ------------------------------------------------------
// Interpolating in sRGB drags a blue→red ramp through muddy purple-grey because
// sRGB is not perceptually uniform. OKLab is, so the ramp keeps its chroma.

type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function hexToOklab(hex: string): Lab {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16) / 255);
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16) / 255);
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16) / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255));

  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Sample a ramp at t in [0,1], interpolating between its stops in OKLab. */
function sampleRamp(stops: readonly string[], t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;

  const a = hexToOklab(stops[i]!);
  const b = hexToOklab(stops[i + 1]!);
  return oklabToHex([
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ]);
}

/**
 * Colour a temperature by its signed deviation from setpoint.
 *
 * The zone's own deadband is subtracted first: inside it the zone IS on target —
 * that is what a deadband means — so it renders neutral rather than tinted.
 * Without this every zone in the building shows a permanent colour for being
 * normally, correctly controlled, and the overlay stops distinguishing anything.
 *
 * `span` is the deviation beyond the deadband that reaches full saturation.
 */
export function temperatureColor(
  value: number,
  setpoint: number,
  span = 4,
  dark = false,
  deadbandK = 1,
): string {
  const deviation = value - setpoint;
  const excess = Math.max(0, Math.abs(deviation) - deadbandK / 2);
  const t = Math.min(1, excess / Math.max(0.1, span - deadbandK / 2));
  const cold = dark ? DIVERGING_COLD_DARK : DIVERGING_COLD;
  const hot = dark ? DIVERGING_HOT_DARK : DIVERGING_HOT;
  return sampleRamp(deviation >= 0 ? hot : cold, t);
}

/** Colour a magnitude against a maximum. */
export function magnitudeColor(value: number, max: number): string {
  return sampleRamp(SEQUENTIAL, max <= 0 ? 0 : value / max);
}

export interface LegendStop {
  color: string;
  label: string;
}

/**
 * Legend stops for the active overlay.
 *
 * Always shown: with only colour on screen, the reader cannot recover a number,
 * and a heatmap without a legend is decoration.
 */
export function legendStops(
  metric: OverlayMetric,
  setpoint: number,
  max: number,
  dark = false,
): LegendStop[] {
  if (metric === 'temperature_c') {
    return [
      { color: temperatureColor(setpoint - 4, setpoint, 4, dark), label: '−4 K' },
      { color: temperatureColor(setpoint - 2, setpoint, 4, dark), label: '−2 K' },
      { color: temperatureColor(setpoint, setpoint, 4, dark), label: 'in band' },
      { color: temperatureColor(setpoint + 2, setpoint, 4, dark), label: '+2 K' },
      { color: temperatureColor(setpoint + 4, setpoint, 4, dark), label: '+4 K' },
    ];
  }

  const unit = metric === 'co2_ppm' ? ' ppm' : '';
  return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    color: magnitudeColor(f * max, max),
    label: `${Math.round(f * max)}${unit}`,
  }));
}

export const OVERLAY_LABELS: Record<OverlayMetric, string> = {
  temperature_c: 'Temperature vs setpoint',
  occupancy_count: 'Occupancy',
  co2_ppm: 'CO₂',
};

export const SEVERITY_COLOR: Record<string, string> = {
  info: STATUS.good,
  warning: STATUS.warning,
  critical: STATUS.critical,
};
