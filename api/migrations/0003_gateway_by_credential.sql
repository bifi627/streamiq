-- The gateway socket's lookup before its tenant is known: the gateway whose credential
-- hashes to hash, and its household. A revoked gateway (hash NULL) never matches.
CREATE FUNCTION public.gateway_by_credential(hash text) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT g."Id", g."TenantId" FROM public.gateways g WHERE g."CredentialHash" = hash $$;

REVOKE ALL ON FUNCTION public.gateway_by_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gateway_by_credential(text) TO streamiq_app;
