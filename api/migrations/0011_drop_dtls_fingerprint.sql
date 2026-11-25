-- Browsers pin the gateway's identity key now, learned at pairing; the DTLS
-- certificate is new per tunnel. Nothing read this column.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- The previous deployment, still serving until the switch, may fail an enrollment for
-- those seconds (it writes the column); the gateway retries with a new token.
-- squawk-ignore ban-drop-column
ALTER TABLE public.gateways DROP COLUMN dtls_fingerprint;
