import { CAVEAT_IDS, type CaveatId } from './evidence.ts';

/**
 * The caveat catalogue: fixed text, rendered by code.
 *
 * A caveat is the part of an answer most likely to be softened by a model
 * that is trying to be helpful — "roughly", "should be fine", a limitation
 * summarised into nothing. So the model never writes one. Tools attach codes
 * to the evidence they return, the verifier refuses an answer that cites
 * that evidence without the same codes, and this table turns codes into the
 * words the operator reads. Changing what a caveat SAYS is a change here and
 * nowhere else.
 *
 * Every sentence below states a limit of THIS data or THIS simulator, found
 * by reading the rows (see the ADR 64 data realities): identical floors,
 * independent main and sub-meters, synthetic weather, a uniform setpoint
 * shift, unmet hours against the scenario's own band. None is boilerplate.
 *
 * `Record<CaveatId, string>` makes a code without text a compile error.
 */
export const CAVEAT_TEXT: Readonly<Record<CaveatId, string>> = Object.freeze({
  SIM_ANALYTICALLY_VERIFIED:
    "Model estimate: the simulator is analytically verified, not validated or calibrated against this building's meters. Treat differences as directional.",
  SIM_SYNTHETIC_WEATHER:
    'Weather is a synthetic clear-sky design day at the stated temperatures. No forecast or measured weather is stored, and its humidity is near-record, so cooling energy is likely overstated.',
  SIM_UNIFORM_DELTA:
    "Each scenario shifts every simulated zone's setpoint by the same amount for the whole period; a time-windowed pre-cool cannot be simulated yet.",
  SIM_UNMET_OWN_BAND:
    "Unmet hours are zone-hours outside the scenario's own shifted band, a test of the plant, not of comfort; comfort is reported against the designed band.",
  SIM_CONSTANT_COP_NO_SETBACK:
    'The model uses a constant plant efficiency and runs HVAC around the clock, so it can show peak shifting but never credits pre-cooling with efficiency.',
  SIM_PEAK_INTERVAL_MEAN:
    'Peak demand is an hourly mean over the simulated zones, not a 15-minute demand-charge peak.',
  SIM_PLANT_RESIZED_PER_RUN:
    "The simulator sizes plant from each scenario's own setpoint, which overstates a setpoint-raise saving.",
  SIM_SUBSET:
    'Only the named zones were simulated; totals cover those zones only.',
  PARTIAL_COVERAGE:
    'Some 5-minute periods had no good data; totals cover measured periods only and are not extrapolated.',
  FLAGGED_EXCLUDED:
    'Out-of-range samples are excluded from statistics and counted separately.',
  PLANT_NOT_ALLOCATED:
    'Chillers, pumps, cooling tower and EV charging are metered for the whole building and are not split by floor.',
  FLOORS_WITHIN_2PCT:
    'Measured per-floor energy differs by less than 2% between floors; no floor stands out in this data.',
  METER_SUSPECT_BUCKETS:
    'Some meter periods are flagged suspect (a counter reset, or implied demand above five times the median); the total without them is given beside the raw total, or is absent when no period is clean.',
  MAIN_VS_SUBMETERS_UNRECONCILED:
    'The main meter and the sub-meters do not reconcile in this data; any difference is unattributed, not plug load.',
  NO_STATUS_HISTORY:
    'Equipment status is current only; there is no history of status changes.',
  NO_WEATHER_STORED:
    'No measured or forecast outdoor weather is stored for this period, so behaviour cannot be attributed to weather.',
  NO_SCHEDULED_START:
    'Overrides take effect when approved and cannot be scheduled; ask again when the window opens.',
});

/**
 * The caveat every simulated figure must carry, whatever the tool attached.
 * Named separately because the verifier requires it on its own authority: a
 * simulate tool that forgot to attach it must not make a model estimate read
 * like a measurement.
 */
export const SIMULATED_FIGURE_CAVEAT: CaveatId = 'SIM_ANALYTICALLY_VERIFIED';

/**
 * The caveat a CHECK-mode controller finding always carries, attached by code
 * (specialist.ts) and required in the answer by the verify node. Check mode
 * is how the planner handles "pre-cool tomorrow" and "could we…": it never
 * proposes, because an override starts when it is approved and cannot be
 * scheduled (§62) — so the answer must say to ask again when the window
 * opens, whatever the model chose to write.
 */
export const CHECK_MODE_CAVEAT: CaveatId = 'NO_SCHEDULED_START';

/**
 * Caveat codes as the lines the operator reads: de-duplicated, in catalogue
 * order (so the SIM_ lines stay together however the model listed them), and
 * never text the model wrote.
 */
export function caveatLines(ids: Iterable<CaveatId>): string[] {
  const wanted = new Set(ids);
  return CAVEAT_IDS.filter((id) => wanted.has(id)).map((id) => CAVEAT_TEXT[id]);
}
