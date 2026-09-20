-- =============================================================================
-- 009_api_key_rotation.sql — make an API key name reusable after revocation
--
-- 007 gave api_keys a table-level UNIQUE (tenant_id, name). That reads as "one
-- key per name", but what it enforces is "one key per name, forever" — a
-- revoked key keeps its name, so rotating `dev-gateway` fails on the unique
-- constraint and the operator has to invent `dev-gateway-2`. Names stop
-- describing the key's purpose about two rotations in.
--
-- The intent was always liveness-scoped: `api_keys_prefix_idx` right below it
-- is already partial on `revoked_at IS NULL`. This makes the name constraint
-- agree with it. Rotation becomes revoke-then-create, the audit row keeps its
-- name, and only one key by that name can authenticate at a time.
--
-- Nothing infers ON CONFLICT against the dropped constraint — createApiKey is a
-- plain INSERT — so no query changes with it.
-- =============================================================================

ALTER TABLE api_keys DROP CONSTRAINT api_keys_tenant_id_name_key;

CREATE UNIQUE INDEX api_keys_tenant_name_live_uidx
  ON api_keys (tenant_id, name)
  WHERE revoked_at IS NULL;
