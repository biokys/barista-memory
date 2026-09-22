# syntax=docker/dockerfile:1
# One image runs the archive daemon and the web UI together (src/main.ts).
# Node 22 is required for the built-in node:sqlite. Every dependency is pure
# JavaScript, so node_modules is architecture-independent: it is installed
# once on the build platform and copied into the arm64 image, rather than
# running npm under QEMU, which crashed with an illegal instruction on the
# 0.2.0 build.

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine
ARG GIT_COMMIT=""
WORKDIR /app
ENV BARISTA_COMMIT=$GIT_COMMIT \
    NODE_ENV=production \
    NODE_OPTIONS=--no-warnings \
    GAGGIMATE_DB=/data/archive.db \
    GAGGIMATE_WEB_PORT=8080 \
    GAGGIMATE_WEB_HOST=0.0.0.0
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY web ./web
# Receipt fonts (Inter, OFL) for the SVG rasteriser.
COPY assets ./assets
# Runs as root on purpose: Home Assistant mounts /data as root with
# options.json readable only by root, and add-ons run as root by convention.
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/version >/dev/null || exit 1
CMD ["node", "dist/main.js"]
