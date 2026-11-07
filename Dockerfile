# syntax=docker/dockerfile:1
# streamiq image for Railway: control plane (API + WebRTC signaling) + the built SPA,
# served same-origin from wwwroot (no CORS in prod).
# Railway service Root Directory = repo root (build context needs backend/ + frontend/).
# Base tags float at patch level on purpose — they pick up security updates.

FROM node:24-alpine AS web
WORKDIR /web
# Public-by-design Firebase web config, baked into the bundle at build time.
# Railway passes same-named service variables as build args.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci
COPY frontend/ ./
# Fail the build, not sign-in: firebase.ts would silently bake in demo-* fallbacks.
RUN : "${VITE_FIREBASE_API_KEY:?build arg not set}" "${VITE_FIREBASE_AUTH_DOMAIN:?build arg not set}" "${VITE_FIREBASE_PROJECT_ID:?build arg not set}"
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
# Restore against just the API project (the test project isn't in the image).
# Separate COPY so this layer caches until the csproj itself changes.
COPY backend/src/StreamIq.Api/StreamIq.Api.csproj src/StreamIq.Api/
RUN dotnet restore src/StreamIq.Api/StreamIq.Api.csproj
COPY backend/src/ src/
RUN dotnet publish src/StreamIq.Api/StreamIq.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
COPY --from=web /web/dist ./wwwroot
# Railway injects $PORT; Program.cs binds 0.0.0.0:$PORT when it is present.
# Railway terminates TLS at its proxy: honor X-Forwarded-Proto/-For so
# Request.Scheme is https (the gateway install command embeds it).
# ponytail: trusts the headers from any peer (only Railway's proxy can reach us).
# Nothing keys on the client IP from X-Forwarded-For (client-writable): the
# signaling rate limit reads Railway's X-Real-IP instead.
ENV ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
ENV STREAMIQ_CLIENT_IP_HEADER=X-Real-IP
ENTRYPOINT ["dotnet", "StreamIq.Api.dll"]
