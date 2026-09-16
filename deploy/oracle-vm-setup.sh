#!/usr/bin/env bash
# Provisions apps/api + apps/worker on a plain Ubuntu VM (written for Oracle
# Cloud's "Always Free" Ampere A1 instance, but works on any Ubuntu 22.04+
# host with a public IP). Idempotent — safe to re-run after a `git pull` to
# redeploy. Does NOT touch anything outside /opt/ai-concierge and this
# system's package manager / Docker / pm2 install.
#
# What this script cannot do for you (must be done first, outside the VM):
#   - Create the Oracle Cloud account and the VM instance itself.
#   - Add an Ingress Rule for port 4000 in the VM's Virtual Cloud Network
#     Security List (Oracle Cloud Console -> Networking -> Virtual Cloud
#     Networks -> your VCN -> Security Lists -> Add Ingress Rules ->
#     source 0.0.0.0/0, destination port 4000, TCP). Without this, the OS
#     firewall rule this script adds is not enough — Oracle blocks inbound
#     traffic at the network level by default, separately from the OS.
#
# Usage (as a user with sudo, after SSH'ing into the VM):
#   git clone <this repo's URL> /opt/ai-concierge   # first time only
#   cd /opt/ai-concierge
#   cp deploy/.env.production.example .env.production
#   nano .env.production   # fill in the REPLACE_WITH_* values
#   sudo bash deploy/oracle-vm-setup.sh

set -euo pipefail

REPO_DIR="/opt/ai-concierge"
NODE_MAJOR="22"

if [ ! -f "$REPO_DIR/.env.production" ]; then
  echo "ERROR: $REPO_DIR/.env.production not found."
  echo "Copy deploy/.env.production.example to .env.production and fill in real values first."
  exit 1
fi

# Sourced once, early — every step below (migrations, tenant seed, pm2) needs
# DATABASE_URL and/or DEFAULT_TENANT_ID, so all of them just inherit this.
set -a
# shellcheck disable=SC1091
source "$REPO_DIR/.env.production"
set +a

echo "==> Installing base packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" != "$NODE_MAJOR" ]; then
  echo "==> Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

echo "==> Enabling corepack (pnpm)"
corepack enable

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2"
  npm install -g pm2
fi

echo "==> Starting Postgres + Redis (docker-compose.yml)"
cd "$REPO_DIR"
docker compose up -d postgres redis

echo "==> Waiting for Postgres to be healthy"
POSTGRES_CID="$(docker compose ps -q postgres)"
for _ in $(seq 1 30); do
  status="$(docker inspect --format='{{.State.Health.Status}}' "$POSTGRES_CID" 2>/dev/null || true)"
  [ "$status" = "healthy" ] && break
  sleep 2
done
if [ "$status" != "healthy" ]; then
  echo "WARNING: Postgres did not report healthy after 60s (last status: ${status:-unknown})."
  echo "Continuing anyway — check 'docker compose logs postgres' if migrations fail below."
fi

echo "==> Installing dependencies + building apps/api and apps/worker"
pnpm install --frozen-lockfile
pnpm --filter @ai-concierge/api... --filter @ai-concierge/worker... run build

echo "==> Running database migrations"
pnpm --filter @ai-concierge/db run migrate:deploy

echo "==> Seeding the default tenant (idempotent — no-op if it already exists)"
# packages/testing's seedTestTenants does the same insert for tests; there is
# no production seed script in the repo, so a fresh migrated DB has zero
# Tenant rows and DEFAULT_TENANT_ID would match nothing without this.
echo "INSERT INTO tenants (id, name) VALUES ('${DEFAULT_TENANT_ID}', 'Default Tenant') ON CONFLICT (id) DO NOTHING;" \
  | pnpm --filter @ai-concierge/db exec prisma db execute --stdin --schema=./prisma/schema.prisma

echo "==> Opening port 4000 in the OS firewall (ufw), if active"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 4000/tcp
fi

echo "==> Starting apps/api + apps/worker under pm2"
pm2 start "$REPO_DIR/deploy/ecosystem.config.js"
pm2 save

echo ""
echo "==> Done. Run the following once to make pm2 survive a VM reboot"
echo "    (copy-paste the exact command pm2 prints, it's user/OS-specific):"
pm2 startup || true
echo ""
echo "==> Check it's alive: curl http://localhost:4000/health"
echo "==> From outside: http://<vm-public-ip>:4000/health (after the VCN ingress rule above is added)"
