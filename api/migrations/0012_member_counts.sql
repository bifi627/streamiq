-- How many members each of uid's households has, for /api/me only (memberships_of runs
-- on every request). It crosses tenants only for households uid is already in.
CREATE FUNCTION public.member_counts(uid uuid) RETURNS TABLE (tenant_id uuid, members int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT o.tenant_id, count(*)::int FROM public.memberships o
        WHERE o.tenant_id IN (SELECT m.tenant_id FROM public.memberships m WHERE m.user_id = uid)
        GROUP BY o.tenant_id $$;
REVOKE ALL ON FUNCTION public.member_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.member_counts(uuid) TO streamiq_app;
