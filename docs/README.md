# DTwin documentation

DTwin connects a building's rooms and equipment to live measurements, alerts,
and thermal scenarios. This documentation describes the implementation inspected
on **18 September 2026** and separates current behavior from proposed work.

| Reader / question | Start here |
|---|---|
| Leadership: what have we built, and what should we fund next? | [CTO assessment](cto-assessment.md) |
| Engineering: how does the system work? | [Architecture](architecture.md) |
| Developers and operators: how do I run and diagnose it? | [Operations and development](operations.md) |
| Integrators: how do devices and clients connect? | [API and event reference](api.md) |
| Data engineers: what does each table represent? | [Schema reference](schema.md) |
| Maintainers: why were these design choices made? | [Design decisions](decisions.md) |
| Anyone touching tenancy, auth or data isolation | [Multi-tenancy design](multi-tenancy.md) |

Service guides: [ingest](../apps/ingest/README.md),
[simulation](../apps/sim/README.md), [dashboard](../apps/web/README.md).
The [root README](../README.md) is the entry point for setup;
[AGENTS.md](../AGENTS.md) contains implementation rules.

## How to keep these docs useful

Update the capability matrix when behavior changes; update the API reference
with routes and contracts; update operations when configuration or deployment
changes. Record significant trade-offs in `decisions.md`. Link to code and
schemas rather than copying their complete definitions.

The assessment is a dated engineering judgment, not a release certificate.
Its verification record identifies exactly which checks were run. Historical
test counts in older material are not evidence that today's checkout passed.
