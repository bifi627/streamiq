-- Tenant isolation in the database. The API connects as streamiq_app, which owns no
-- table, so every policy below applies to it (owners and superusers bypass RLS).
-- The tenant comes from app.tenant_id, set per transaction (set_config(..., true)).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'streamiq_app') THEN
    CREATE ROLE streamiq_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO streamiq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.tenants, public.users, public.memberships, public.gateways,
  public.enrollment_tokens, public.invites, public.tunnels, public.gateway_health
  TO streamiq_app;

-- NULL when unset: no row matches, so a query without a tenant fails closed. nullif:
-- after a transaction that set it, the setting reads '' on that connection, not NULL.
CREATE FUNCTION public.app_tenant() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'gateways', 'enrollment_tokens', 'invites', 'tunnels', 'gateway_health'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON public.%I TO streamiq_app USING ("TenantId" = public.app_tenant()) WITH CHECK ("TenantId" = public.app_tenant())', t);
  END LOOP;
END $$;

-- The lookups that establish the tenant, so they run before one is known (today:
-- scripts/tenant-filter-allowlist.txt). SECURITY DEFINER = as the owner, past RLS;
-- each returns only what its secret or its user id entitles the caller to.
CREATE FUNCTION public.gateway_by_credential(hash text) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT "Id", "TenantId" FROM public.gateways WHERE "CredentialHash" = hash $$;

CREATE FUNCTION public.memberships_of(uid uuid) RETURNS TABLE (tenant_id uuid, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT m."TenantId", t."Name", m."Role" FROM public.memberships m
        JOIN public.tenants t ON t."Id" = m."TenantId"
        WHERE m."UserId" = uid ORDER BY m."CreatedAt", m."TenantId" $$;

REVOKE ALL ON FUNCTION public.gateway_by_credential(text), public.memberships_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gateway_by_credential(text), public.memberships_of(uuid) TO streamiq_app;
