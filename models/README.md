# `models/`

Empty, and correctly so.

The 3D view builds the scene from the PostGIS geometry the database already
holds — see [decision 27](../docs/decisions.md#27-the-3d-view-renders-the-database-not-a-model-file).
A GLB in the render path would be a second source of truth and the first thing
to go stale after a fit-out: move a partition in the BIM export and the twin
still colours the old room.

So this directory is not where the building comes from. It is where a **real**
BIM export would go if one were ever loaded *alongside* the database model, to
be reconciled with it by `gltf_node_id` rather than to replace it. Nothing
reads it today.

`005_seed.sql` used to populate `gltf_node_id` with invented names — `Zone_2_3`,
`VAV_2_3` — pointing at a file that has never existed. Migration 012 clears
them: NULL means "not mapped yet", which is true, and is what an unmapped row
will look like when an export does arrive.
