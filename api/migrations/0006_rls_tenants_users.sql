-- Row-level security on tenants and users, the two tables 0002 left open to streamiq_app.
-- A household is created only by create_household and nothing in the API deletes one;
-- a user is written only by sign_in. Both functions are SECURITY DEFINER.

REVOKE INSERT, DELETE ON public.tenants FROM streamiq_app;
REVOKE INSERT, UPDATE, DELETE ON public.users FROM streamiq_app;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.tenants TO streamiq_app
  USING ("Id" = public.app_tenant()) WITH CHECK ("Id" = public.app_tenant());

-- The members of the transaction's tenant: the subquery reads memberships under its own policy.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON public.users FOR SELECT TO streamiq_app
  USING ("Id" IN (SELECT m."UserId" FROM public.memberships m));

-- The users row of a Firebase UID, added on its first sign-in. plpgsql: each statement
-- takes a new snapshot, so the last SELECT sees a row a concurrent first sign-in committed
-- while the INSERT waited on it.
CREATE FUNCTION public.sign_in(firebase_uid text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
  AS $$
DECLARE user_id uuid;
BEGIN
  SELECT u."Id" INTO user_id FROM public.users u WHERE u."FirebaseUid" = firebase_uid;
  IF user_id IS NULL THEN
    INSERT INTO public.users ("Id", "FirebaseUid") VALUES (uuidv7(), firebase_uid)
      ON CONFLICT ("FirebaseUid") DO NOTHING;
    SELECT u."Id" INTO user_id FROM public.users u WHERE u."FirebaseUid" = firebase_uid;
  END IF;
  RETURN user_id;
END $$;

REVOKE ALL ON FUNCTION public.sign_in(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sign_in(text) TO streamiq_app;
