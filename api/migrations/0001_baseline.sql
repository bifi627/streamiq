-- Today's schema as EF Core migrated it (pg_dump --schema-only --no-owner --no-privileges of
-- postgres:18 after the last EF migration, 20261121103147_GatewayHealthVersion), with
-- EF's history rows so the .NET API sees nothing to migrate on a database Go created.
-- On a database EF already migrated this file is recorded, not run (migrations.go).

CREATE TABLE public."__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL,
    "ProductVersion" character varying(32) NOT NULL
);

CREATE TABLE public.enrollment_tokens (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "TokenHash" text NOT NULL,
    "ExpiresAt" timestamp with time zone NOT NULL,
    "UsedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.gateway_health (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "GatewayId" uuid NOT NULL,
    "At" timestamp with time zone NOT NULL,
    "Level" text NOT NULL,
    "JellyfinReachable" boolean,
    "JellyfinVersion" text,
    "Os" text,
    "Arch" text,
    "Transcoding" text,
    "Offline" text,
    "Tunnels" integer,
    "Transcodes" integer,
    "Cpu" double precision,
    "Memory" double precision,
    "GatewayVersion" text
);

CREATE TABLE public.gateways (
    "Id" uuid CONSTRAINT "devices_Id_not_null" NOT NULL,
    "TenantId" uuid CONSTRAINT "devices_TenantId_not_null" NOT NULL,
    "Name" text,
    "DtlsFingerprint" text,
    "CredentialHash" text,
    "LastSeenAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() CONSTRAINT "devices_CreatedAt_not_null" NOT NULL,
    "LanUrl" text,
    "Version" text,
    "Update" text,
    "Protocol" integer,
    "Telemetry" text
);

CREATE TABLE public.invites (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "TokenHash" text NOT NULL,
    "CreatedBy" uuid,
    "ExpiresAt" timestamp with time zone NOT NULL,
    "UsedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.memberships (
    "TenantId" uuid NOT NULL,
    "UserId" uuid NOT NULL,
    "Role" text NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_memberships_Role" CHECK (("Role" = ANY (ARRAY['admin'::text, 'member'::text])))
);

CREATE TABLE public.tenants (
    "Id" uuid NOT NULL,
    "Name" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tunnels (
    "Id" uuid CONSTRAINT "connection_sessions_Id_not_null" NOT NULL,
    "TenantId" uuid CONSTRAINT "connection_sessions_TenantId_not_null" NOT NULL,
    "GatewayId" uuid CONSTRAINT "connection_sessions_GatewayId_not_null" NOT NULL,
    "Relay" boolean CONSTRAINT "connection_sessions_Relay_not_null" NOT NULL,
    "Ipv6" boolean CONSTRAINT "connection_sessions_Ipv6_not_null" NOT NULL,
    "LocalCandidateType" text,
    "RemoteCandidateType" text,
    "Protocol" text,
    "BytesReceived" bigint,
    "BytesSent" bigint,
    "CreatedAt" timestamp with time zone DEFAULT now() CONSTRAINT "connection_sessions_CreatedAt_not_null" NOT NULL,
    "EndedAt" timestamp with time zone,
    "Failure" text,
    "ThroughputKbps" integer,
    "UserId" uuid,
    "ActiveMs" bigint,
    "Use" text
);

CREATE TABLE public.users (
    "Id" uuid NOT NULL,
    "FirebaseUid" text NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public."__EFMigrationsHistory"
    ADD CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId");

ALTER TABLE ONLY public.enrollment_tokens
    ADD CONSTRAINT "PK_enrollment_tokens" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "PK_gateway_health" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.gateways
    ADD CONSTRAINT "PK_gateways" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "PK_invites" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "PK_memberships" PRIMARY KEY ("TenantId", "UserId");

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT "PK_tenants" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "PK_tunnels" PRIMARY KEY ("Id");

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_users" PRIMARY KEY ("Id");

CREATE INDEX "IX_enrollment_tokens_TenantId" ON public.enrollment_tokens USING btree ("TenantId");

CREATE UNIQUE INDEX "IX_enrollment_tokens_TokenHash" ON public.enrollment_tokens USING btree ("TokenHash");

CREATE INDEX "IX_gateway_health_GatewayId_At" ON public.gateway_health USING btree ("GatewayId", "At");

CREATE INDEX "IX_gateway_health_TenantId" ON public.gateway_health USING btree ("TenantId");

CREATE UNIQUE INDEX "IX_gateways_CredentialHash" ON public.gateways USING btree ("CredentialHash");

CREATE INDEX "IX_gateways_TenantId" ON public.gateways USING btree ("TenantId");

CREATE INDEX "IX_invites_CreatedBy" ON public.invites USING btree ("CreatedBy");

CREATE INDEX "IX_invites_TenantId" ON public.invites USING btree ("TenantId");

CREATE UNIQUE INDEX "IX_invites_TokenHash" ON public.invites USING btree ("TokenHash");

CREATE INDEX "IX_memberships_UserId" ON public.memberships USING btree ("UserId");

CREATE INDEX "IX_tunnels_GatewayId" ON public.tunnels USING btree ("GatewayId");

CREATE INDEX "IX_tunnels_TenantId" ON public.tunnels USING btree ("TenantId");

CREATE INDEX "IX_tunnels_UserId" ON public.tunnels USING btree ("UserId");

CREATE UNIQUE INDEX "IX_users_FirebaseUid" ON public.users USING btree ("FirebaseUid");

ALTER TABLE ONLY public.enrollment_tokens
    ADD CONSTRAINT "FK_enrollment_tokens_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "FK_gateway_health_gateways_GatewayId" FOREIGN KEY ("GatewayId") REFERENCES public.gateways("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "FK_gateway_health_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.gateways
    ADD CONSTRAINT "FK_gateways_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "FK_invites_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "FK_invites_users_CreatedBy" FOREIGN KEY ("CreatedBy") REFERENCES public.users("Id") ON DELETE SET NULL;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "FK_memberships_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "FK_memberships_users_UserId" FOREIGN KEY ("UserId") REFERENCES public.users("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_gateways_GatewayId" FOREIGN KEY ("GatewayId") REFERENCES public.gateways("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_users_UserId" FOREIGN KEY ("UserId") REFERENCES public.users("Id") ON DELETE SET NULL;

INSERT INTO public."__EFMigrationsHistory" VALUES ('20260712170533_InitialCreate', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261101162225_AgentEnrollment', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261102152428_RenameDeviceToGateway', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261102203124_ConnectionSessions', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261102220035_ConnectionFailure', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261104214801_GatewayVersion', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261108110740_DropUserEmail', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261110140434_GatewayStatus', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261111075049_MinimalHeartbeat', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261112141801_ConnectionThroughput', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261112212906_GatewayProtocol', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261113112732_Memberships', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261113141355_Invites', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261116145428_Tunnels', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261116154932_TunnelUser', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261120173828_TunnelUse', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261121091833_GatewayHealth', '10.0.14');
INSERT INTO public."__EFMigrationsHistory" VALUES ('20261121103147_GatewayHealthVersion', '10.0.14');

