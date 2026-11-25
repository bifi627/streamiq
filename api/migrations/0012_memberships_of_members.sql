-- memberships_of also counts each household's members for /api/me. Its return
-- type changes, so it is dropped and made again. The count crosses tenants only for
-- households uid is already in.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- One transaction, so no caller sees it missing; the previous deployment's query names
-- its columns and still runs against the new one.
-- squawk-ignore ban-drop-function
DROP FUNCTION public.memberships_of(uuid);
CREATE FUNCTION public.memberships_of(uid uuid) RETURNS TABLE (tenant_id uuid, name text, role text, members int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT m.tenant_id, t.name, m.role,
               (SELECT count(*)::int FROM public.memberships o WHERE o.tenant_id = m.tenant_id)
        FROM public.memberships m
        JOIN public.tenants t ON t.id = m.tenant_id
        WHERE m.user_id = uid ORDER BY m.created_at, m.tenant_id $$;
REVOKE ALL ON FUNCTION public.memberships_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.memberships_of(uuid) TO streamiq_app;
