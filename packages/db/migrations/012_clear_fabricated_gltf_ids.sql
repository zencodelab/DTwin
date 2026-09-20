-- =============================================================================
-- 012_clear_fabricated_gltf_ids.sql — stop claiming a model that does not exist
--
-- The columns stay. Decision §27 keeps `gltf_node_id` on every row deliberately:
-- the 3D view renders the stored PostGIS geometry rather than a GLB, precisely
-- so what is on screen cannot disagree with the data, and the node id is the
-- key by which a real BIM export would later be RECONCILED with this model
-- rather than replacing it. Dropping them would overturn a recorded decision
-- because the column happens to be unused today, which is the wrong reason.
--
-- What is wrong is the VALUES. `005_seed.sql` fills them with invented names —
-- `Zone_2_3`, `VAV_2_3`, `corniche-tower.glb` — and `models/` is empty. A row
-- reading `gltf_node_id = 'Zone_2_3'` says "this maps to node Zone_2_3 in a
-- model"; that is false, and it is the kind of false that survives into a demo
-- because it looks like configuration rather than fiction.
--
-- NULL says "not mapped yet", which is true, and is what an unmapped row will
-- look like when a real export arrives. Seed data should be representative,
-- not decorative.
-- =============================================================================

UPDATE buildings  SET gltf_asset_path = NULL WHERE gltf_asset_path IS NOT NULL;
UPDATE floors     SET gltf_node_id    = NULL WHERE gltf_node_id    IS NOT NULL;
UPDATE zones      SET gltf_node_id    = NULL WHERE gltf_node_id    IS NOT NULL;
UPDATE equipment  SET gltf_node_id    = NULL WHERE gltf_node_id    IS NOT NULL;
