# syntax=docker/dockerfile:1
# Spike #720: the Go API image, for the size and cold-start comparison with the .NET one.
# Build context = repo root (the module replaces streamiq/gateway with ../gateway).
# No SPA in it, to compare like with like: the measurement builds the .NET image without one too.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY gateway/go.mod gateway/go.sum gateway/
COPY backend-go/go.mod backend-go/go.sum backend-go/
RUN cd backend-go && go mod download
COPY gateway/proto gateway/proto
COPY backend-go backend-go
RUN cd backend-go && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /api ./cmd/api

# distroless static: CA certificates (Firebase's public keys, Cloudflare) and a nonroot user, no shell.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /api /api
ENTRYPOINT ["/api"]
