-- What households and invites do before the tenant is known (api/internal/household,
-- api/internal/invites). SECURITY DEFINER, like memberships_of: each returns only what
-- its argument entitles the caller to.

-- A new household with uid as its admin, in one statement: the membership is written
-- before any tenant could be set for it.
CREATE FUNCTION public.create_household(uid uuid) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ WITH t AS (INSERT INTO public.tenants ("Id") VALUES (uuidv7()) RETURNING "Id")
        INSERT INTO public.memberships ("TenantId", "UserId", "Role") SELECT "Id", uid, 'admin' FROM t
        RETURNING "TenantId" $$;

-- The invite whose token hashes to hash, for its preview: its household, whether it can
-- still be accepted, the household's name and the inviter's Firebase UID (for
-- "<inviter>'s household"). No row: unknown or revoked.
CREATE FUNCTION public.invite_by_hash(hash text)
  RETURNS TABLE (tenant_id uuid, usable boolean, name text, inviter_uid text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT i."TenantId", i."UsedAt" IS NULL AND i."ExpiresAt" > now(), t."Name", u."FirebaseUid"
        FROM public.invites i JOIN public.tenants t ON t."Id" = i."TenantId"
        LEFT JOIN public.users u ON u."Id" = i."CreatedBy"
        WHERE i."TokenHash" = hash $$;

-- Accept's claim, like claim_enrollment_token: spends the invite if it is unused and
-- unexpired and returns its household. The row lock makes it single-use under a race.
CREATE FUNCTION public.claim_invite(hash text) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ UPDATE public.invites SET "UsedAt" = now()
        WHERE "TokenHash" = hash AND "UsedAt" IS NULL AND "ExpiresAt" > now()
        RETURNING "TenantId" $$;

REVOKE ALL ON FUNCTION public.create_household(uuid), public.invite_by_hash(text), public.claim_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_household(uuid), public.invite_by_hash(text), public.claim_invite(text)
  TO streamiq_app;
