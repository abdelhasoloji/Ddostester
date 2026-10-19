#!/usr/bin/env bash
# Repair the deploy privileges on VPS 1. Run ONCE, as root, on the production host.
#
# Why this exists: the Deploy workflow runs as the unprivileged service user. A
# promotion performed earlier as root left the release directory owned by root, so
# every automated deploy died on `mktemp ... Permission denied`. Separately,
# deploy/update.sh needs five privileged commands while the original provisioning
# granted only `systemctl restart`, so even a writable directory could not be
# promoted. Both are fixed here, idempotently, and nothing else is touched.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: run this on VPS 1 as root.' >&2
  exit 1
fi

SERVICE="${SERVICE:-ddostester}"
USER_NAME="${RUNNER_USER:-shieldtest}"
SUDOERS=/etc/sudoers.d/ddostester-deploy
DROPIN_DIR="/etc/systemd/system/${SERVICE}.service.d"

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6 || true)"
if [ -z "$HOME_DIR" ] || [ ! -d "$HOME_DIR" ]; then
  echo "ERROR: user '$USER_NAME' has no home directory; set RUNNER_USER=<user>." >&2
  exit 1
fi

RELEASES="$HOME_DIR/ddostester-releases"
if [ -d "$RELEASES" ]; then
  chown -R "$USER_NAME:$USER_NAME" "$RELEASES"
  echo "ownership: $RELEASES -> $USER_NAME:$USER_NAME"
else
  echo "ownership: $RELEASES absent; the deploy creates it as $USER_NAME"
fi
mkdir -p "$RELEASES"
chown "$USER_NAME:$USER_NAME" "$RELEASES"

# Exactly the commands deploy/update.sh invokes, with the destination pinned. No
# general `install`, no shell: a compromised deploy user cannot write outside its own
# drop-in.
cat > "$SUDOERS" <<RULES
${USER_NAME} ALL=(root) NOPASSWD: /usr/bin/mkdir -p ${DROPIN_DIR}, /usr/bin/install -m 644 /tmp/* ${DROPIN_DIR}/40-verified-release.conf, /usr/bin/unlink ${DROPIN_DIR}/40-verified-release.conf, /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart ${SERVICE}
RULES
chmod 440 "$SUDOERS"

if ! visudo -cf "$SUDOERS" >/dev/null; then
  echo 'ERROR: sudoers validation failed; nothing was changed.' >&2
  rm -f "$SUDOERS"
  exit 1
fi
echo "sudoers: $SUDOERS installed and validated"

echo '--- what the deploy user may now run ---'
sudo -u "$USER_NAME" sudo -n -l || true
echo '--- done: re-run the Deploy workflow; no further manual step is needed ---'
