# ---- Stage 1: build frontend + backend ------------------------------------
# `node:22-slim` (glibc) is used because better-sqlite3 ships glibc prebuilds;
# alpine/musl would force a node-gyp compile at build time.
# The current 22.x image must satisfy package.json's Node >=22.22 requirement.
FROM node:22-slim AS build
WORKDIR /app

# Install workspace dependencies first for layer caching.
# npm 12 (upgraded from the node:22-bundled 10.x) gates dependency install
# scripts by default; the "allowScripts" policy in package.json explicitly
# denies them, so better-sqlite3 v13 uses the N-API prebuilds shipped in its
# tarball instead of compiling from source. This stage needs no python or
# build tools. `npm ci` installs strictly from the lockfile.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install -g npm@12 && npm ci

# Copy shared source before building the frontend, which imports its contracts.
COPY server ./server
# Build the frontend into web/dist.
COPY web ./web
RUN npm run build --workspace @h-tosho/web

# Build the backend into server/dist.
RUN npm run build --workspace @h-tosho/server

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HTOSHO_DATA_DIR=/data

# curl is used by the NHentai tag-autocomplete provider (Cloudflare lets curl
# through where Node's fetch gets challenged). ca-certificates provides the
# system trust store curl verifies against (node:slim ships none at its path).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# npm workspaces hoist all runtime dependencies to the root node_modules.
COPY package.json ./
COPY server/package.json ./server/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server/dist/index.js"]
