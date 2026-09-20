"""Moist-air properties.

Exists because the model was sensible-heat only, and in a Gulf coastal climate
that is not a rounding error: outdoor air at 35 °C and 70% RH carries about
25 g of water per kg of dry air, against about 9 g in the conditioned space.
Every kilogram of that air brought in for ventilation has to be dried before it
is delivered, and the energy to do it does not raise or lower the zone
temperature at all — so a sensible-only balance does not merely approximate the
answer, it has no term for the question.

ASHRAE Fundamentals, chapter 1. The formulations are the standard ones; what
matters here is that the saturation-pressure correlation is valid over the
range a building actually sees, and Hyland-Wexler is (-100 to +200 °C).

Not a psychrometrics library: this is three functions, and pulling in CoolProp
or psychrolib for them would be a dependency per equation.
"""

from __future__ import annotations

import numpy as np

# Standard sea-level pressure. The building is on the Abu Dhabi corniche, so
# altitude correction would be a fraction of a percent; a site at 1,500 m would
# need this to come from the building row instead.
STANDARD_PRESSURE_PA = 101_325.0

# Ratio of the molecular masses of water and dry air.
MOLAR_MASS_RATIO = 0.621945

# Latent heat of vaporisation of water near room temperature, J/kg. It varies
# by about 1% across the range a coil sees, which is well inside the error of
# everything else here.
LATENT_HEAT_J_KG = 2.45e6


def saturation_pressure_pa(dry_bulb_c: np.ndarray) -> np.ndarray:
    """Saturation vapour pressure over liquid water, Hyland-Wexler.

    Valid 0-200 °C, which covers every condition this model runs in. The
    sub-zero branch over ice is deliberately not implemented: a building in Abu
    Dhabi does not reach it, and an unused branch is an untested branch.
    """
    t = np.asarray(dry_bulb_c, dtype=float) + 273.15
    ln_p = (
        -5.8002206e3 / t
        + 1.3914993
        - 4.8640239e-2 * t
        + 4.1764768e-5 * t**2
        - 1.4452093e-8 * t**3
        + 6.5459673 * np.log(t)
    )
    return np.exp(ln_p)


def humidity_ratio(
    dry_bulb_c: np.ndarray,
    rh_pct: np.ndarray,
    pressure_pa: float = STANDARD_PRESSURE_PA,
) -> np.ndarray:
    """Mass of water per mass of dry air, kg/kg.

    The quantity a latent load is actually about. Relative humidity on its own
    cannot answer it: 70% RH at 35 °C and 70% RH at 20 °C differ by more than a
    factor of two in the water they carry, which is the whole reason a humid
    hot climate is expensive and a humid mild one is not.
    """
    rh = np.clip(np.asarray(rh_pct, dtype=float), 0.0, 100.0) / 100.0
    p_w = rh * saturation_pressure_pa(dry_bulb_c)
    # Guard the asymptote: p_w approaches the total pressure only in conditions
    # this model will not see, but the division would go to infinity there.
    p_w = np.minimum(p_w, pressure_pa * 0.999)
    return MOLAR_MASS_RATIO * p_w / (pressure_pa - p_w)


def latent_power_w(
    mass_flow_kg_s: np.ndarray,
    humidity_out: np.ndarray,
    humidity_in: float | np.ndarray,
) -> np.ndarray:
    """Power needed to dry an outdoor air stream to the indoor condition.

    Clamped at zero: when outdoor air is drier than indoor — a winter night, or
    any desert away from the coast — it dehumidifies the space for free. The
    model does not humidify, because this building has no humidifier, and
    crediting a negative load would be claiming equipment that is not there.
    """
    delta_w = np.maximum(np.asarray(humidity_out, dtype=float) - humidity_in, 0.0)
    return mass_flow_kg_s * delta_w * LATENT_HEAT_J_KG
