-- EF's quoted PascalCase names to snake_case: every column, and every constraint and
-- index EF or Postgres named after one, to the name Postgres would give it. Renames only.
-- Policies, indexes and constraints follow a column rename by themselves; the SQL
-- function bodies below don't, so each is replaced (owner and grants stay).

DROP TABLE IF EXISTS public."__EFMigrationsHistory";

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT a.attrelid::regclass AS tbl, a.attname FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'i')
             AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~ '[A-Z]' LOOP
    EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO %I', r.tbl, r.attname,
                   lower(regexp_replace(r.attname, '([a-z0-9])([A-Z])', '\1_\2', 'g')));
  END LOOP;

  -- A primary key's index is renamed with it.
  FOR r IN SELECT con.conrelid::regclass AS tbl, c.relname, con.conname,
                  c.relname || coalesce('_' || (SELECT string_agg(a.attname, '_' ORDER BY k.ord)
                    FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum), '')
                  AS stem, con.contype
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
           WHERE con.connamespace = 'public'::regnamespace AND con.conname ~ '[A-Z]' LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname,
                   CASE r.contype WHEN 'p' THEN r.relname || '_pkey'
                                  WHEN 'f' THEN r.stem || '_fkey'
                                  WHEN 'c' THEN r.stem || '_check'
                                  WHEN 'n' THEN r.stem || '_not_null'
                                  WHEN 'u' THEN r.stem || '_key' END);
  END LOOP;

  FOR r IN SELECT i.indexrelid::regclass AS idx,
                  t.relname || '_' || (SELECT string_agg(a.attname, '_' ORDER BY k.ord)
                    FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) || '_idx' AS name
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
           WHERE c.relnamespace = 'public'::regnamespace AND c.relname ~ '[A-Z]' LOOP
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idx, r.name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.memberships_of(uid uuid) RETURNS TABLE (tenant_id uuid, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT m.tenant_id, t.name, m.role FROM public.memberships m
        JOIN public.tenants t ON t.id = m.tenant_id
        WHERE m.user_id = uid ORDER BY m.created_at, m.tenant_id $$;

CREATE OR REPLACE FUNCTION public.gateway_by_credential(hash text) RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT g.id, g.tenant_id FROM public.gateways g WHERE g.credential_hash = hash $$;

CREATE OR REPLACE FUNCTION public.claim_enrollment_token(hash text) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ UPDATE public.enrollment_tokens e SET used_at = now()
        WHERE e.token_hash = hash AND e.used_at IS NULL AND e.expires_at > now()
        RETURNING e.tenant_id $$;

CREATE OR REPLACE FUNCTION public.create_household(uid uuid) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ WITH t AS (INSERT INTO public.tenants (id) VALUES (uuidv7()) RETURNING id)
        INSERT INTO public.memberships (tenant_id, user_id, role) SELECT t.id, uid, 'admin' FROM t
        RETURNING memberships.tenant_id $$;

CREATE OR REPLACE FUNCTION public.invite_by_hash(hash text)
  RETURNS TABLE (tenant_id uuid, usable boolean, name text, inviter_uid text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT i.tenant_id, i.used_at IS NULL AND i.expires_at > now(), t.name, u.firebase_uid
        FROM public.invites i JOIN public.tenants t ON t.id = i.tenant_id
        LEFT JOIN public.users u ON u.id = i.created_by
        WHERE i.token_hash = hash $$;

CREATE OR REPLACE FUNCTION public.claim_invite(hash text) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ UPDATE public.invites i SET used_at = now()
        WHERE i.token_hash = hash AND i.used_at IS NULL AND i.expires_at > now()
        RETURNING i.tenant_id $$;

-- The parameter is now also a column name: use_column reads bare names as columns, and
-- sign_in.firebase_uid names the parameter.
CREATE OR REPLACE FUNCTION public.sign_in(firebase_uid text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
#variable_conflict use_column
DECLARE user_id uuid;
BEGIN
  SELECT u.id INTO user_id FROM public.users u WHERE u.firebase_uid = sign_in.firebase_uid;
  IF user_id IS NULL THEN
    INSERT INTO public.users (id, firebase_uid) VALUES (uuidv7(), sign_in.firebase_uid)
      ON CONFLICT (firebase_uid) DO NOTHING;
    SELECT u.id INTO user_id FROM public.users u WHERE u.firebase_uid = sign_in.firebase_uid;
  END IF;
  RETURN user_id;
END $$;
