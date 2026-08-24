# ---- Stage 1: build frontend + backend ------------------------------------
# `node:22-slim` (glibc) is used because better-sqlite3 ships glibc prebuilds;
# alpine/musl would force a node-gyp compile at build time.
FROM node:22-slim AS build
WORKDIR /app

# Install workspace dependencies first for layer caching.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install

# Build the frontend into web/dist.
COPY web ./web
RUN npm run build --workspace @h-tosho/web

# Build the backend into server/dist.
COPY server ./server
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server/dist/index.js"]