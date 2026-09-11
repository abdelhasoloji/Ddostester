#!/usr/bin/env bash
# WEDOS ShieldTest — rotate control-plane runtime secrets (VPS 1, run as root).
#
# Rotates, behind a health gate with automatic rollback:
#   • DB_PASSWORD     — the Postgres role password AND the DATABASE_URL DSN.
#   • AUTH_JWT_SECRET — signing key for console sessions (rotating it logs
#                       every operator out; they simply sign in again).
# Optionally (--bench):
#   • BENCH_RUNNER_TOKEN — the app↔lab-runner shared bearer. The new value is
#                       written to a root-only file for you to carry to the
#                       lab-runner host; the two MUST match, so update the
#                       runner in the same maintenance window (see below).
#
# It NEVER prints a secret to stdout. New values are generated on-box with
# `openssl rand` and go straight into /etc/ddostester.env (chmod 600). The old
# env file is backed up first; if the service fails its health check after the
# restart, the DB password and env file are both rolled back automatically.
#
# Usage (as root on VPS 1):
#   bash deploy/rotate-secrets.sh              # rotate DB_PASSWORD + AUTH_JWT_SECRET
#   bash deploy/rotate-secrets.sh --bench      # also rotate BENCH_RUNNER_TOKEN
#
# Companion manual steps (different host / service — not automatable from here):
#   • BENCH_RUNNER_TOKEN on the lab-runner host: edit the systemd unit
#       /etc/systemd/system/shieldtest-lab-runner.service
#     replace the `Environment=BENCH_RUNNER_TOKEN=...` line with the value from
#     /root/shieldtest-bench-token.new, then:
#       systemctl daemon-reload && systemctl restart shieldtest-lab-runner
#     Do this within minutes of the --bench rotation or Class-C bench calls 401.
#   • Grafana admin password (VPS 2): as root on the monitoring host,
#       grafana-cli admin reset-admin-password "$(openssl rand -base64 24)"
#     then store the printed value in your password manager (do not paste it
#     into a chat/transcript).
set -euo pipefail

SERVICE="ddostester"
ENVFILE="/etc/${SERVICE}.env"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
ROTATE_BENCH=0
[ "${1:-}" = "--bench" ] && ROTATE_BENCH=1

die() { echo "!! $*" >&2; exit 1; }

# --- Preconditions -----------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$ENVFILE" ] || die "$ENVFILE not found — is this the control-plane host?"
command -v openssl >/dev/null || die "openssl not found"
command -v psql >/dev/null || die "psql not found"
grep -qE '^DATABASE_URL=' "$ENVFILE" || die "no DATABASE_URL in $ENVFILE — nothing to rotate for DB"

# --- Parse the current DSN (needed to target the role and to roll back) ------
OLD_DSN="$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2-)"
_rest="${OLD_DSN#*://}"                 # user:pass@host:port/db?params
_creds="${_rest%%@*}"                   # user:pass
_after="${_rest#*@}"                    # host:port/db?params
DB_USER="${_creds%%:*}"
OLD_DB_PASS="${_creds#*:}"
_hostportdb="${_after%%\?*}"            # host:port/db
_hostport="${_hostportdb%%/*}"          # host:port
DB_HOST="${_hostport%%:*}"
DB_PORT="${_hostport##*:}"; [ "$DB_PORT" = "$DB_HOST" ] && DB_PORT=5432
DB_NAME="${_hostportdb#*/}"
# Fail closed: if we cannot recover the current password we cannot roll the DB
# back on a failed restart, so refuse rather than risk a locked-out service.
[ -n "$DB_USER" ] && [ -n "$OLD_DB_PASS" ] && [ -n "$DB_NAME" ] \
  || die "could not parse DATABASE_URL for safe rollback — aborting (no changes made)"

echo "==> Rotating secrets for role '${DB_USER}' on ${DB_HOST}:${DB_PORT}/${DB_NAME}"

# --- Generate new values (hex → URL-safe inside the DSN, no encoding needed) --
NEW_DB_PASS="$(openssl rand -hex 24)"
NEW_JWT="$(openssl rand -base64 48 | tr -d '\n')"
NEW_DSN="postgresql://${DB_USER}:${NEW_DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
[ "$_hostportdb" != "${_after}" ] && NEW_DSN="${NEW_DSN}?${_after#*\?}"  # keep ?params

if [ "$ROTATE_BENCH" -eq 1 ]; then NEW_BENCH="$(openssl rand -hex 32)"; fi

# --- Back up the env file (kept; contains the OLD secrets) -------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${ENVFILE}.bak.${STAMP}"
cp -a "$ENVFILE" "$BACKUP"
chmod 600 "$BACKUP"
echo "==> Backed up current env to ${BACKUP}"

restart_service() { systemctl restart "$SERVICE"; sleep 2; }
healthy() { curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; }

rollback() {
  echo "!! Health check failed — rolling back" >&2
  sudo -u postgres psql -qc "ALTER USER \"${DB_USER}\" WITH PASSWORD '${OLD_DB_PASS}';" >/dev/null 2>&1 || true
  cp -a "$BACKUP" "$ENVFILE"; chmod 600 "$ENVFILE"
  restart_service
  if healthy; then echo "== Rolled back to previous secrets; service healthy again." >&2
  else echo "!! Rollback restart did not pass health — investigate manually (backup at ${BACKUP})." >&2; fi
  exit 1
}

# --- Apply: DB role first, then the env file (temp → atomic install) ---------
echo "==> ALTER USER (Postgres role password)"
sudo -u postgres psql -qc "ALTER USER \"${DB_USER}\" WITH PASSWORD '${NEW_DB_PASS}';" >/dev/null \
  || die "ALTER USER failed — no env change made, DB password unchanged"

echo "==> Rewriting ${ENVFILE}"
TMP="$(mktemp)"; chmod 600 "$TMP"
# Drop the keys we rotate, keep everything else (AUTH_USERS, LAB_TARGETS, …).
DROP='^(DATABASE_URL|AUTH_JWT_SECRET'
[ "$ROTATE_BENCH" -eq 1 ] && DROP="${DROP}|BENCH_RUNNER_TOKEN"
DROP="${DROP})="
grep -vE "$DROP" "$ENVFILE" > "$TMP" || true
{
  printf 'DATABASE_URL=%s\n' "$NEW_DSN"
  printf 'AUTH_JWT_SECRET=%s\n' "$NEW_JWT"
  [ "$ROTATE_BENCH" -eq 1 ] && printf 'BENCH_RUNNER_TOKEN=%s\n' "$NEW_BENCH"
} >> "$TMP"
install -m 600 "$TMP" "$ENVFILE"; rm -f "$TMP"

echo "==> Restarting ${SERVICE} and checking health"
restart_service
healthy || rollback

echo "✅ Rotation complete; ${SERVICE} healthy."
if [ "$ROTATE_BENCH" -eq 1 ]; then
  TOKENFILE="/root/shieldtest-bench-token.new"
  ( umask 077; printf '%s\n' "$NEW_BENCH" > "$TOKENFILE" )
  echo "   BENCH_RUNNER_TOKEN rotated. New value written to ${TOKENFILE} (chmod 600)."
  echo "   → Update the lab-runner unit NOW (see the header of this script), then:"
  echo "       shred -u ${TOKENFILE}"
fi
echo "   Old secrets remain in ${BACKUP} — delete it once you've confirmed everything works:"
echo "       shred -u ${BACKUP}"
