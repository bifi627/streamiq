# syntax=docker/dockerfile:1
# streamiq gateway image (item 4). Multi-arch via buildx: TARGETOS/TARGETARCH come
# from --platform; the Go cross-compile runs on the build host, no QEMU.
# Base tags float at patch level on purpose — they pick up security updates.
FROM --platform=$BUILDPLATFORM golang:1.27 AS build
ARG TARGETOS TARGETARCH VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /gateway ./cmd/gateway \
 && mkdir /state

# distroless/static: CA certs for the HTTPS API, no shell, runs as nonroot.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /gateway /gateway
# Owned by nonroot so a fresh named volume mounted here inherits writable perms.
COPY --from=build --chown=65532:65532 /state /state
ENV STREAMIQ_STATE_DIR=/state STREAMIQ_ICE_PORT=8098
EXPOSE 8097 8098/udp
ENTRYPOINT ["/gateway"]
