-- Tenant isolation in the database. The API connects as streamiq_app, which owns no
-- table, so every policy below applies to it (table owners and superusers bypass RLS).
-- The tenant comes from app.tenant_id, set per transaction (api/internal/db).
-- A later migration that adds a table grants streamiq_app on it itself.

-- Roles are per cluster: another database on the same Postgres may have made it.
DO $$ BEGIN
  CREATE ROLE streamiq_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO streamiq_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.tenants, public.users, public.memberships, public.gateways,
  public.enrollment_tokens, public.invites, public.tunnels, public.gateway_health
  TO streamiq_app;

-- NULL when unset, so a query without a tenant matches no row. nullif: after a
-- transaction that set it, the setting reads '' on that connection, not NULL.
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

-- Lookups that run before the tenant is known: SECURITY DEFINER runs them as the owner,
-- past RLS, so each returns only what its argument entitles the caller to.
-- A user's households, oldest first (the household a request without one acts in).
CREATE FUNCTION public.memberships_of(uid uuid) RETURNS TABLE (tenant_id uuid, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT m."TenantId", t."Name", m."Role" FROM public.memberships m
        JOIN public.tenants t ON t."Id" = m."TenantId"
        WHERE m."UserId" = uid ORDER BY m."CreatedAt", m."TenantId" $$;

REVOKE ALL ON FUNCTION public.memberships_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.memberships_of(uuid) TO streamiq_app;
