#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f package.json || ! -f package-lock.json ]]; then
  echo "Run this script from an Ember-date checkout (package.json and package-lock.json are required)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 20 )); then
  echo "Ember-date requires Node.js 20 or newer; found $(node --version)." >&2
  exit 1
fi

# Tailwind is a dev dependency. Install it for the build, create the ignored
# stylesheet, then remove dev-only packages from the Passenger runtime.
npm ci --include=dev
npm run build:css
npm prune --omit=dev

# Passenger watches this path for restart requests. The operator should touch
# the file only after database migrations and configuration checks are complete.
mkdir -p "$ROOT_DIR/tmp"

echo "cPanel build prepared. Run db:ping, take/verify backups, apply reviewed migrations, then restart Passenger."
