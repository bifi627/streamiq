-- The gateway's relay setting, mirrored from its heartbeat: true = direct connections
-- only, the broker mints no TURN credential for a tunnel to it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.gateways ADD COLUMN relay_off boolean NOT NULL DEFAULT false;
