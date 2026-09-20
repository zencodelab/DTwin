"""Supply-fan power at part load, and where its heat goes.

The air side was one line: fan power = specific fan power x airflow, with
airflow proportional to the cooling load. Three things were wrong with it, and
they pull in different directions, which is why the total looked plausible.

1. POWER WAS LINEAR IN FLOW. Specific fan power comes from the asset register
   at its DESIGN point (15 kW at 18,000 m3/h). Multiplying it by a part-load
   airflow says a fan moving half the air draws half the power. A
   variable-speed fan does not: the affinity laws put shaft power near the
   cube of flow, and a real system with a duct static-pressure setpoint lands
   between the square and the cube. At half flow that is ~30% of design power,
   not 50%.

   And the register says this building IS variable volume: 24 VAV terminals
   hang off its 4 AHUs, each with an airflow and a damper-position point.
   Modelling constant-volume fans contradicts the equipment list (decisions.md
   §14 — the simulator must agree with the register).

2. THE FAN ONLY RAN WHILE THE COIL DID. But the zone balance has charged for
   ventilation air whenever people are present since the first version of this
   engine. Something moves that air. A fan that is off during occupied hours in
   the deadband, while outdoor air arrives anyway, is air moved for free.

3. FAN HEAT WENT NOWHERE. The motor and the fan sit in the airstream, so every
   watt they draw ends up as heat in the supply air, and the coil has to take
   it out again. It is a load the system puts on itself: at the design point
   here it is 3 W per l/s against ~13 W per l/s of cooling carried, so about a
   fifth on top.

(1) lowers fan energy; (2) and (3) raise HVAC energy. The register gives the
design point and nothing about turn-down, so the curve is from the literature:
ASHRAE 90.1 Appendix G's part-load equation for a variable-speed fan with
static-pressure reset, which is what a baseline building is required to be
modelled with. That is a disclosed assumption, not a measurement.
"""
from __future__ import annotations

import numpy as np

# P/P_design as a cubic in flow fraction — ASHRAE 90.1 Table G3.1.3.15, Method 2.
# Sums to 0.9991 at full flow, which is the published curve and not a typo.
_C0, _C1, _C2, _C3 = 0.0013, 0.1470, 0.9506, -0.0998

# A VAV box does not close. Below this fraction of design flow the terminal
# holds its minimum so the space still gets its ventilation air, and the fan
# sees that as its floor. 30% is the common design minimum for an office VAV.
MIN_FLOW_FRACTION = 0.30

# Share of the fan's electrical input that ends up as heat in the supply air.
# 1.0 is a motor mounted in the airstream, which is how a packaged AHU is
# built: shaft work becomes pressure and then friction heat in the ducts, and
# the motor's own losses are shed into the same air. A motor outside the
# airstream would put its ~10% losses into the plant room instead.
HEAT_TO_AIRSTREAM_FRACTION = 1.0


def part_load_power_fraction(flow_fraction: np.ndarray) -> np.ndarray:
    """Fan power as a fraction of design power, for a flow fraction in [0, 1]."""
    f = np.clip(flow_fraction, 0.0, 1.0)
    return _C0 + _C1 * f + _C2 * f**2 + _C3 * f**3


def flow_fraction(
    sensible_load_w: np.ndarray, capacity_w: np.ndarray, running: np.ndarray
) -> np.ndarray:
    """Fraction of design airflow the fan is moving.

    Airflow follows the SENSIBLE load, because that is what a temperature rise
    across the coil carries; latent load rides on the same air. While the fan is
    running it never drops below the VAV minimum; while it is not, it is zero —
    not the minimum, or an empty building would ventilate itself all night.
    """
    with np.errstate(divide="ignore", invalid="ignore"):
        load_fraction = np.where(capacity_w > 0.0, sensible_load_w / capacity_w, 0.0)
    return np.where(running, np.clip(load_fraction, MIN_FLOW_FRACTION, 1.0), 0.0)


def fan_power_w(flow_frac: np.ndarray, design_power_w: np.ndarray) -> np.ndarray:
    """Electrical power drawn by the fan. Zero when the fan is off."""
    return np.where(flow_frac > 0.0, design_power_w * part_load_power_fraction(flow_frac), 0.0)
