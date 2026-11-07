# Prebuilt Firebase Auth emulator. Baking a pinned firebase-tools at BUILD time
# (not an `npx` pull at container start) makes boot deterministic: the slow,
# network-variable npm fetch happens in the build step, outside Testcontainers'
# wait-for-"All emulators ready" window, so a busy network can't flake the suite.
# Auth emulator is Node-based — no Java/JRE needed. Pinned like every image in
# this repo (never `latest`); bump deliberately.
FROM node:24-alpine
RUN npm install -g firebase-tools@15.34.1
WORKDIR /app
COPY firebase.json .
