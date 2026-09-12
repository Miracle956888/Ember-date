#!/usr/bin/env bash
#
# vps.sh - turn a fresh Ubuntu/Debian VPS into a public Ember host.
#
#   sudo SITE_ADDRESS=ember.example.com ./deploy/vps.sh
#   SITE_ADDRESS=ember.example.com ./deploy/vps.sh --dry-run   # print, change nothing
#
# What it does, in order: installs Docker if absent, puts the repo in
# /opt/ember, writes a .env with real random secrets (never overwriting one that
# already exists), brings up the app + MySQL + uploads volume on loopback only,
# then fronts it with Caddy so TLS and the http->https redirect happen at the
# proxy. Re-running it is safe: every step checks before it acts.
#
# It does NOT buy you a server, point your DNS, or seed demo accounts. Those are
# the three things only you can do - see DEPLOY.md.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ember}"
REPO_URL="${REPO_URL:-https://github.com/Miracle956888/Ember-date.git}"
BRANCH="${BRANCH:-main}"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

run() {
  if [[ $DRY -eq 1 ]]; then
    printf '    \033[90m+ %s\033[0m\n' "$*"
  else
    bash -c "$*"
  fi
}

# cap() runs a command that already exists and is idempotent; in dry mode it only
# echoes, so a machine without docker still completes a full --dry-run.
cap() { run "$*"; }

# ------------------------------------------------------------------ preflight
say "Preflight"
[[ -n "${SITE_ADDRESS:-}" ]] || die "SITE_ADDRESS is required, e.g. SITE_ADDRESS=ember.example.com ./deploy/vps.sh (use http://IP for a TLS-less trial)"
# Accept a bare domain or a full URL. Caddy takes either; APP_ORIGIN must have the
# scheme, because an origin without one is a different origin as far as CORS is
# concerned and every API call from the browser would be rejected.
APP_ORIGIN="$SITE_ADDRESS"
[[ "$APP_ORIGIN" != http://* && "$APP_ORIGIN" != https://* ]] && APP_ORIGIN="https://$APP_ORIGIN"
note "public address: $SITE_ADDRESS"
note "APP_ORIGIN will be: $APP_ORIGIN"

if [[ $DRY -eq 0 && $(id -u) -ne 0 ]]; then
  die "run me as root: sudo SITE_ADDRESS=$SITE_ADDRESS ./deploy/vps.sh"
fi

# Docker Compose v2 is a subcommand, v1 is a separate binary.
compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    echo ""
  fi
}

if [[ $DRY -eq 0 ]] && ! docker info >/dev/null 2>&1; then
  say "Installing Docker"
  command -v curl >/dev/null 2>&1 || run "apt-get update -qq && apt-get install -y curl ca-certificates"
  run "curl -fsSL https://get.docker.com | sh"
  run "systemctl enable --now docker"
else
  say "Docker present - skipping install"
fi

# ------------------------------------------------------------------ repo
say "Repository at $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  note "already cloned - fetching and resetting to origin/$BRANCH"
  run "git -C $APP_DIR fetch --depth 1 origin $BRANCH"
  # A deploy must not silently run whatever was left in the working tree.
  run "git -C $APP_DIR reset --hard origin/$BRANCH"
else
  run "mkdir -p $APP_DIR"
  run "git clone --depth 1 --branch $BRANCH $REPO_URL $APP_DIR"
fi

# ------------------------------------------------------------------ .env
say "Environment file"
ENV_FILE="$APP_DIR/.env"
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [[ $DRY -eq 1 ]]; then
  printf '    \033[90m+ would create %s from .env.example if absent (existing file is never overwritten)\033[0m\n' "$ENV_FILE"
  printf '    \033[90m+ would set APP_ORIGIN=%s, NODE_ENV=production, TRUST_PROXY=1, FORCE_HTTPS=1\033[0m\n' "$APP_ORIGIN"
else
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    note "created $ENV_FILE from .env.example"
  else
    note "kept the existing $ENV_FILE (nothing overwritten)"
  fi

  set_key() { # set_key KEY VALUE  - replaces, appends, or leaves alone if identical
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
      sed -i -E "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    else
      printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
    fi
  }

  # Only fill secrets that are still empty, so re-running never rotates them.
  # Rotating JWT secrets silently invalidates every logged-in session.
  for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET DB_PASSWORD; do
    if ! grep -qE "^${key}=..+" "$ENV_FILE"; then
      set_key "$key" "$(gen_secret)"
      note "generated a fresh ${key}"
    else
      note "${key} already set - left alone"
    fi
  done

  set_key APP_ORIGIN "$APP_ORIGIN"
  set_key NODE_ENV production
  set_key TRUST_PROXY 1
  set_key FORCE_HTTPS 1
  set_key UPLOAD_DIR /opt/ember/uploads
  note "APP_ORIGIN=$APP_ORIGIN, NODE_ENV=production, TRUST_PROXY=1, FORCE_HTTPS=1"
  chmod 600 "$ENV_FILE"
fi

# ------------------------------------------------------------------ app
say "Application containers"
C="$(compose_cmd)"
if [[ -z "$C" ]]; then
  [[ $DRY -eq 1 ]] && C="docker compose" || die "no 'docker compose' found - install Docker first"
fi
# MYSQL_ROOT_PASSWORD/DB_* are read from .env by compose itself (env_file is the
# containing directory), and the app runs its own migrations on boot.
run "cd $APP_DIR && ${C} up -d --build"
note "app on 127.0.0.1:3000 and MySQL on 127.0.0.1:3307 - neither is internet-facing"

if [[ $DRY -eq 0 ]]; then
  say "Health check"
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      note "/api/health answered after ${i}s"
      break
    fi
    [[ $i -eq 30 ]] && { (cd "$APP_DIR" && ${C} logs --tail 40 app) || true; die "app never became healthy"; }
    sleep 1
  done
fi

# ------------------------------------------------------------------ proxy
say "Caddy (TLS)"
if command -v caddy >/dev/null 2>&1; then
  note "caddy already installed"
else
  run "apt-get update -qq && apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https"
  run "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
  run "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list"
  run "apt-get update -qq && apt-get install -y -qq caddy"
fi
run "install -m 644 $APP_DIR/deploy/Caddyfile /etc/caddy/Caddyfile"
run "systemctl enable caddy"
# SITE_ADDRESS is what the Caddyfile's {$SITE_ADDRESS:localhost} reads. The
# caddy package's unit loads /etc/default/caddy, so the value survives a reboot -
# a drop-in via systemctl set-property would also work, but is harder to inspect.
if [[ $DRY -eq 0 ]]; then
  printf 'SITE_ADDRESS=%s\n' "$SITE_ADDRESS" > /etc/default/caddy
  note "wrote /etc/default/caddy (SITE_ADDRESS=$SITE_ADDRESS)"
else
  printf '    \033[90m+ would write /etc/default/caddy with SITE_ADDRESS=%s\033[0m\n' "$SITE_ADDRESS"
fi
run "systemctl restart caddy"
note "Caddy requests the certificate on first request; check: journalctl -u caddy -n 20"

# ------------------------------------------------------------------ firewall
say "Firewall"
if command -v ufw >/dev/null 2>&1; then
  run "ufw allow 80/tcp"
  run "ufw allow 443/tcp"
  run "ufw status numbered"
else
  note "no ufw - open 80/443 in your provider's security group instead"
fi

# ------------------------------------------------------------------ done
say "Done"
cat <<EOF
    site        $SITE_ADDRESS
    repo        $APP_DIR
    compose       cd $APP_DIR && ${C} ps
    logs          cd $APP_DIR && ${C} logs -f app
    deploy again  cd $APP_DIR && git pull && ${C} up -d --build

    Next, in this order:
      1. npm run deploy:check        # from $APP_DIR - catches the rest, offline style
      2. cd $APP_DIR && ${C} exec app node db/migrate.js   # idempotent, also runs at boot
      3. ONLY IF YOU WANT DEMO DATA:
         cd $APP_DIR && ${C} exec -e SEED_DEMO=1 -e DEMO_PASSWORD=change-me app node db/seed.js
         (it deletes existing users - never run it once real people have signed up)
EOF
