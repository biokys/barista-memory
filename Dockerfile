# syntax=docker/dockerfile:1
# One image runs the archive daemon and the web UI together (src/main.ts).
# Node 22 is required for the built-in node:sqlite; there are no native
# modules, so the same Dockerfile builds for amd64 and arm64 (Raspberry Pi).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ARG GIT_COMMIT=""
WORKDIR /app
ENV BARISTA_COMMIT=$GIT_COMMIT \
    NODE_ENV=production \
    NODE_OPTIONS=--no-warnings \
    GAGGIMATE_DB=/data/archive.db \
    GAGGIMATE_WEB_PORT=8080 \
    GAGGIMATE_WEB_HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/version >/dev/null || exit 1
CMD ["node", "dist/main.js"]
