--
-- PostgreSQL database dump
--


-- Dumped from database version 18.7 (Debian 18.7-1.pgdg13+2)
-- Dumped by pg_dump version 18.7 (Debian 18.7-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __EFMigrationsHistory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."__EFMigrationsHistory" (
    "MigrationId" character varying(150) NOT NULL,
    "ProductVersion" character varying(32) NOT NULL
);


--
-- Name: enrollment_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_tokens (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "TokenHash" text NOT NULL,
    "ExpiresAt" timestamp with time zone NOT NULL,
    "UsedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gateway_health; Type: TABLE; Schema: public; Owner: -
--

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
    "Memory" double precision
);


--
-- Name: gateways; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "TokenHash" text NOT NULL,
    "CreatedBy" uuid,
    "ExpiresAt" timestamp with time zone NOT NULL,
    "UsedAt" timestamp with time zone,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    "TenantId" uuid NOT NULL,
    "UserId" uuid NOT NULL,
    "Role" text NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "CK_memberships_Role" CHECK (("Role" = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    "Id" uuid NOT NULL,
    "Name" text,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tunnels; Type: TABLE; Schema: public; Owner: -
--

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


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    "Id" uuid NOT NULL,
    "FirebaseUid" text NOT NULL,
    "CreatedAt" timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: __EFMigrationsHistory PK___EFMigrationsHistory; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."__EFMigrationsHistory"
    ADD CONSTRAINT "PK___EFMigrationsHistory" PRIMARY KEY ("MigrationId");


--
-- Name: enrollment_tokens PK_enrollment_tokens; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_tokens
    ADD CONSTRAINT "PK_enrollment_tokens" PRIMARY KEY ("Id");


--
-- Name: gateway_health PK_gateway_health; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "PK_gateway_health" PRIMARY KEY ("Id");


--
-- Name: gateways PK_gateways; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateways
    ADD CONSTRAINT "PK_gateways" PRIMARY KEY ("Id");


--
-- Name: invites PK_invites; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "PK_invites" PRIMARY KEY ("Id");


--
-- Name: memberships PK_memberships; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "PK_memberships" PRIMARY KEY ("TenantId", "UserId");


--
-- Name: tenants PK_tenants; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT "PK_tenants" PRIMARY KEY ("Id");


--
-- Name: tunnels PK_tunnels; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "PK_tunnels" PRIMARY KEY ("Id");


--
-- Name: users PK_users; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_users" PRIMARY KEY ("Id");


--
-- Name: IX_enrollment_tokens_TenantId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_enrollment_tokens_TenantId" ON public.enrollment_tokens USING btree ("TenantId");


--
-- Name: IX_enrollment_tokens_TokenHash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IX_enrollment_tokens_TokenHash" ON public.enrollment_tokens USING btree ("TokenHash");


--
-- Name: IX_gateway_health_GatewayId_At; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_gateway_health_GatewayId_At" ON public.gateway_health USING btree ("GatewayId", "At");


--
-- Name: IX_gateway_health_TenantId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_gateway_health_TenantId" ON public.gateway_health USING btree ("TenantId");


--
-- Name: IX_gateways_CredentialHash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IX_gateways_CredentialHash" ON public.gateways USING btree ("CredentialHash");


--
-- Name: IX_gateways_TenantId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_gateways_TenantId" ON public.gateways USING btree ("TenantId");


--
-- Name: IX_invites_CreatedBy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_invites_CreatedBy" ON public.invites USING btree ("CreatedBy");


--
-- Name: IX_invites_TenantId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_invites_TenantId" ON public.invites USING btree ("TenantId");


--
-- Name: IX_invites_TokenHash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IX_invites_TokenHash" ON public.invites USING btree ("TokenHash");


--
-- Name: IX_memberships_UserId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_memberships_UserId" ON public.memberships USING btree ("UserId");


--
-- Name: IX_tunnels_GatewayId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_tunnels_GatewayId" ON public.tunnels USING btree ("GatewayId");


--
-- Name: IX_tunnels_TenantId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_tunnels_TenantId" ON public.tunnels USING btree ("TenantId");


--
-- Name: IX_tunnels_UserId; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IX_tunnels_UserId" ON public.tunnels USING btree ("UserId");


--
-- Name: IX_users_FirebaseUid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IX_users_FirebaseUid" ON public.users USING btree ("FirebaseUid");


--
-- Name: enrollment_tokens FK_enrollment_tokens_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_tokens
    ADD CONSTRAINT "FK_enrollment_tokens_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: gateway_health FK_gateway_health_gateways_GatewayId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "FK_gateway_health_gateways_GatewayId" FOREIGN KEY ("GatewayId") REFERENCES public.gateways("Id") ON DELETE CASCADE;


--
-- Name: gateway_health FK_gateway_health_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_health
    ADD CONSTRAINT "FK_gateway_health_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: gateways FK_gateways_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateways
    ADD CONSTRAINT "FK_gateways_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: invites FK_invites_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "FK_invites_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: invites FK_invites_users_CreatedBy; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT "FK_invites_users_CreatedBy" FOREIGN KEY ("CreatedBy") REFERENCES public.users("Id") ON DELETE SET NULL;


--
-- Name: memberships FK_memberships_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "FK_memberships_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: memberships FK_memberships_users_UserId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT "FK_memberships_users_UserId" FOREIGN KEY ("UserId") REFERENCES public.users("Id") ON DELETE CASCADE;


--
-- Name: tunnels FK_tunnels_gateways_GatewayId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_gateways_GatewayId" FOREIGN KEY ("GatewayId") REFERENCES public.gateways("Id") ON DELETE CASCADE;


--
-- Name: tunnels FK_tunnels_tenants_TenantId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_tenants_TenantId" FOREIGN KEY ("TenantId") REFERENCES public.tenants("Id") ON DELETE CASCADE;


--
-- Name: tunnels FK_tunnels_users_UserId; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tunnels
    ADD CONSTRAINT "FK_tunnels_users_UserId" FOREIGN KEY ("UserId") REFERENCES public.users("Id") ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


