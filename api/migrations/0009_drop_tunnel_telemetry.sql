-- Tunnels and box health are recorded on each gateway now; nothing in the API reads or
-- writes these any more. Relay usage stays, in relay_usage, from Cloudflare only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- The drops are the point: their data has no reader. The previous deployment, still
-- serving until the switch, may fail a heartbeat write or a gateways read for those seconds.
-- squawk-ignore ban-drop-table
DROP TABLE public.tunnels;
-- squawk-ignore ban-drop-table
DROP TABLE public.gateway_health;
-- squawk-ignore ban-drop-column
ALTER TABLE public.gateways DROP COLUMN telemetry;
