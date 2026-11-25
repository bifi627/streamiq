# syntax=docker/dockerfile:1
# streamiq image for Railway: the Go API (control plane + WebRTC signaling) + the built
# SPA, served same-origin from /web (no CORS in prod).
# Railway service Root Directory = repo root (build context needs api/ + protocol/ + frontend/).
# Base tags float at patch level on purpose — they pick up security updates.

FROM node:26-alpine AS web
WORKDIR /web
# Public-by-design Firebase web config, baked into the bundle at build time.
# Railway passes same-named service variables as build args.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci
COPY frontend/ ./
# crypto.test.ts (type-checked by tsc -b) imports the shared pairing vectors from ../gateway.
COPY gateway/internal/pairing/testdata/vectors.json /gateway/internal/pairing/testdata/vectors.json
# Fail the build, not sign-in: firebase.ts would silently bake in demo-* fallbacks.
RUN : "${VITE_FIREBASE_API_KEY:?build arg not set}" "${VITE_FIREBASE_AUTH_DOMAIN:?build arg not set}" "${VITE_FIREBASE_PROJECT_ID:?build arg not set}"
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY protocol/ protocol/
COPY api/ api/
RUN CGO_ENABLED=0 go build -trimpath -ldflags=-s -o /api ./api/cmd/api

# Static, with CA certificates (Postgres TLS, Firebase's keys) and a nonroot user.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /api /api
COPY --from=web /web/dist /web
ENV STREAMIQ_WEB_DIR=/web
# Railway injects $PORT and terminates TLS at its proxy: the install command takes its
# https from X-Forwarded-Proto. X-Forwarded-For is client-writable: the per-IP budget
# reads Railway's X-Real-IP instead.
ENV STREAMIQ_CLIENT_IP_HEADER=X-Real-IP
ENTRYPOINT ["/api"]
