-- =============================================================================
-- 011_latent_load.sql — record the moisture half of the cooling load
--
-- The simulation modelled sensible heat only. In a Gulf coastal climate that
-- is not a rounding error: outdoor air at 35 C and 70% RH carries about 25 g of
-- water per kg of dry air against about 9 g indoors, and drying every kilogram
-- brought in for ventilation costs energy that never shows up as a temperature.
-- A sensible-only balance does not approximate that term — it has no term for
-- it, so the model understated HVAC energy with no way to see by how much.
--
-- `latent_load_kwh` is the electrical energy attributable to dehumidification,
-- already divided by COP like the rest of `hvac_load_kwh`, and it is a SUBSET
-- of that column rather than an addition to it. Reported separately because
-- "why is this building expensive?" has a different answer in Abu Dhabi than
-- in Munich, and a single HVAC number cannot give it.
--
-- Nullable, unlike its neighbours: rows written by runs before this migration
-- have no latent component to report, and a default of 0 would claim they
-- measured it and found none.
-- =============================================================================

ALTER TABLE simulation_results
  ADD COLUMN latent_load_kwh DOUBLE PRECISION
    CHECK (latent_load_kwh >= 0);

COMMENT ON COLUMN simulation_results.latent_load_kwh IS
  'Electrical energy for dehumidification, a subset of hvac_load_kwh. NULL for '
  'runs made before the latent model existed. See docs/decisions.md 48.';
