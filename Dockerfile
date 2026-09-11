# syntax=docker/dockerfile:1
#
# Multi-stage build. Stage 1 installs every dependency and compiles the
# Tailwind stylesheet; stage 2 ships only production deps plus the built
# assets, so the runtime image carries no build tooling.

# ----------------------------------------------------------------- builder
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Dependencies first, so a source-only change reuses the install layer.
COPY package.json package-lock.json* ./
RUN npm ci

# Build the CSS from the same sources the app serves.
COPY tailwind.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build:css

# ----------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production

# ffmpeg powers video poster frames; the app degrades gracefully without it,
# but posters are part of the intended experience.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code.
COPY server ./server
COPY db ./db
COPY public ./public
# The stylesheet built in stage 1 replaces whatever was copied above.
COPY --from=builder /app/public/css/app.css ./public/css/app.css

# Uploads are written at runtime; the volume in docker-compose mounts over it.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/server.js"]
