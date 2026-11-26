-- An admin deletes household t: the app role can't DELETE tenants (0006), so this is the
-- one way. NULL when uid isn't t's admin (nothing deleted), else the ids of t's gateways
-- (their sockets get closed). Every tenant-owned row cascades from the tenant row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE FUNCTION public.delete_household(t uuid, uid uuid) RETURNS uuid[]
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
DECLARE
  gws uuid[];
BEGIN
  -- The row lock members' role changes and enrollment's FK check also take: the role
  -- read after it (a new snapshot per statement) is current, and no gateway joins late.
  PERFORM FROM public.tenants WHERE id = t FOR UPDATE;
  IF NOT EXISTS (SELECT FROM public.memberships WHERE tenant_id = t AND user_id = uid AND role = 'admin') THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(array_agg(id), '{}') INTO gws FROM public.gateways WHERE tenant_id = t;
  DELETE FROM public.tenants WHERE id = t;
  RETURN gws;
END $$;
REVOKE ALL ON FUNCTION public.delete_household(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_household(uuid, uuid) TO streamiq_app;
