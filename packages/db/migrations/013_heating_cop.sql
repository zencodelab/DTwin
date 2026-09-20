-- =============================================================================
-- 013_heating_cop.sql — stop using one COP for both directions
--
-- `thermal_profiles.hvac_cop` was applied to heating and cooling alike, which
-- is only right for a machine that has one. A reversible heat pump is usually
-- BETTER at heating than cooling (it collects ambient heat as well as moving
-- it); an electric resistance heater is exactly 1.0 and nothing else. Using the
-- cooling figure for both understates resistance heating by a factor of three
-- and overstates a heat pump slightly.
--
-- It barely moves the number for THIS building — a Gulf tower heats almost
-- never — which is the reason to fix it now rather than later: the error is
-- currently invisible, and it would stop being invisible the first time this
-- model is pointed at a building that has a winter.
--
-- Nullable, and the engine falls back to hvac_cop when it is unset. A profile
-- that has not been told its heating efficiency should keep behaving the way
-- it did rather than silently acquiring a default.
-- =============================================================================

ALTER TABLE thermal_profiles
  ADD COLUMN heating_cop DOUBLE PRECISION CHECK (heating_cop > 0);

COMMENT ON COLUMN thermal_profiles.heating_cop IS
  'Coefficient of performance for heating. NULL means "same as hvac_cop". '
  'Use 1.0 for electric resistance. See docs/decisions.md 50.';

-- The seeded building is served by chillers with electric reheat at the VAV
-- terminals, so its heating is resistance: COP 1.0, not the 2.6-3.2 the
-- cooling side gets.
UPDATE thermal_profiles SET heating_cop = 1.0 WHERE heating_cop IS NULL;
