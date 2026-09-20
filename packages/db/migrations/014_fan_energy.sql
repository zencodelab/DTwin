-- =============================================================================
-- 014_fan_energy.sql — report the air-side share of HVAC energy
--
-- HVAC was thermal load divided by COP, with no term for moving the air. The
-- supply fan runs whenever the coil does, and the asset register says what it
-- costs: the seeded AHUs are rated 15 kW at 18,000 m3/h, which is 3.0 W per
-- litre per second.
--
-- Like `latent_load_kwh`, this is a SUBSET of `hvac_load_kwh` rather than an
-- addition to it, and it is reported separately for the same reason: a single
-- HVAC number cannot answer "what would a better fan buy us?" — which is one
-- of the few questions a facilities manager can act on this month rather than
-- at the next plant replacement.
--
-- Nullable, so rows from runs before the air-side model are not claimed to
-- have measured a fan and found nothing.
-- =============================================================================

ALTER TABLE simulation_results
  ADD COLUMN fan_load_kwh DOUBLE PRECISION CHECK (fan_load_kwh >= 0);

COMMENT ON COLUMN simulation_results.fan_load_kwh IS
  'Supply-fan electricity, a subset of hvac_load_kwh. NULL for runs made '
  'before the air-side model existed. See docs/decisions.md 50.';
