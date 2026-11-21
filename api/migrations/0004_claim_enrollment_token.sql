-- Enrollment's claim before its tenant is known: spends the token whose hash is hash if
-- it is unused and unexpired, and returns its household (none when it isn't). The row
-- lock makes it single-use under a race: a second claim waits for the first's
-- transaction and then sees the token used. Rolled back with the caller's transaction.
CREATE FUNCTION public.claim_enrollment_token(hash text) RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ UPDATE public.enrollment_tokens SET "UsedAt" = now()
        WHERE "TokenHash" = hash AND "UsedAt" IS NULL AND "ExpiresAt" > now()
        RETURNING "TenantId" $$;

REVOKE ALL ON FUNCTION public.claim_enrollment_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_enrollment_token(text) TO streamiq_app;
