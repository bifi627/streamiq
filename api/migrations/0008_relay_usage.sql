-- Relay usage per gateway and month (#784), from Cloudflare's TURN analytics. Each
-- credential is minted with the gateway's relay_tag as its customIdentifier: random, so
-- the analytics name neither the gateway nor its household. The volatile default gives
-- every existing gateway its own tag.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- gateways is small (one row per box): the rewrite and the index take moments.
-- squawk-ignore adding-field-with-default,disallowed-unique-constraint
ALTER TABLE public.gateways ADD COLUMN relay_tag text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;

-- No foreign key to gateways: a removed gateway's usage stays.
CREATE TABLE public.relay_usage (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  gateway_id uuid NOT NULL,
  month date NOT NULL,
  bytes bigint NOT NULL,
  PRIMARY KEY (tenant_id, gateway_id, month)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.relay_usage TO streamiq_app;
ALTER TABLE public.relay_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.relay_usage TO streamiq_app
  USING (tenant_id = public.app_tenant()) WITH CHECK (tenant_id = public.app_tenant());

-- The usage job's lookup, outside any tenant: the gateway a tag belongs to. A revoked
-- gateway still matches: its last relayed bytes count.
CREATE FUNCTION public.gateway_by_relay_tag(tag text) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT g.id, g.tenant_id FROM public.gateways g WHERE g.relay_tag = tag $$;

REVOKE ALL ON FUNCTION public.gateway_by_relay_tag(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gateway_by_relay_tag(text) TO streamiq_app;
