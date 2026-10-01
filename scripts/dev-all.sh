#!/usr/bin/env bash
# Run the backend (node --watch) and the Vite dev server together; Ctrl-C stops both.
# Open http://localhost:5173 (Vite proxies /api to the backend).
set -euo pipefail
cd "$(dirname "$0")/.."

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Prefix each line so the two logs stay readable when interleaved.
pnpm -s dev:server 2>&1 | sed -u 's/^/[server] /' &
pids+=($!)
pnpm -s dev:client 2>&1 | sed -u 's/^/[client] /' &
pids+=($!)

wait -n
