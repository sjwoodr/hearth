# Development image: runs `pnpm dev:fullstack` against the source bind-mounted at /app,
# so node --watch and Vite reload on edits made on the host. See docker-compose.yml.
FROM node:22-bookworm-slim

# Build tools for better-sqlite3, which compiles from source when no prebuilt binary fits.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.18.0

# The image's `node` user is uid 1000, the same as the usual host user, so files the
# app writes into the mount (data/hearth.db, dist/) stay owned by you on the host.
# node_modules is a named volume (better-sqlite3 is native, so the container builds its
# own); creating it here gives the volume node's ownership on first use.
WORKDIR /app
RUN mkdir -p /app/node_modules && chown -R node:node /app
USER node

# Keep pnpm's store inside the node_modules volume: one volume, and hard links work.
ENV npm_config_store_dir=/app/node_modules/.pnpm-store

# Install on every start so lockfile changes land; a no-op when nothing changed.
# CI=true lets pnpm rebuild node_modules without a TTY prompt if it needs to.
CMD ["sh", "-c", "CI=true pnpm install --frozen-lockfile && exec pnpm dev:fullstack"]
