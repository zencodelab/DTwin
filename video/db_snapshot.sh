#!/bin/bash
# The audit-trail rows and Level 3 temperatures the video shows -> db.json.
# Run from the repo root with .env loaded, after capture.ts. AT is the moment
# the map screenshot was taken (UTC); the callouts quote readings at or before it.
set -euo pipefail
AT="${1:?usage: db_snapshot.sh '2026-09-24 00:33:45+00'}"
q() { docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" dtwin-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"; }
{
  echo '{"commands":'
  q "select coalesce(json_agg(r order by r.zone),'[]') from (
       select z.name zone, c.setpoint_temp_c setpoint, c.previous_temp_c previous, c.state,
              to_char(c.requested_at at time zone 'UTC','HH24:MI:SS') requested,
              to_char(c.applied_at at time zone 'UTC','HH24:MI:SS') applied,
              round(extract(epoch from c.applied_at - c.requested_at))::int applied_after_s,
              to_char(c.effective_until at time zone 'UTC','HH24:MI') until_utc,
              u.email requested_by, c.reason
         from control_commands c join zones z on z.id = c.zone_id left join users u on u.id = c.requested_by
        where c.reason like 'copilot (operator-approved)%' and c.requested_at > timestamptz '$AT' - interval '1 hour') r"
  echo ',"level3":'
  q "select json_agg(r order by r.zone) from (
       select z.name zone, p.setpoint_temp_c design, round(t.value::numeric, 2) temp,
              to_char(t.time at time zone 'UTC','HH24:MI:SS') at_utc
         from zones z join floors f on f.id = z.floor_id
         left join thermal_profiles p on p.id = z.thermal_profile_id
         join sensors s on s.zone_id = z.id and s.metric = 'temperature_c'
         join lateral (select value, time from telemetry where sensor_id = s.id and quality = 0
                        and time <= timestamptz '$AT' order by time desc limit 1) t on true
        where f.name = 'Level 3') r"
  echo '}'
} > "$(dirname "$0")/db.json"
echo "wrote video/db.json"
