# Scoped access to VPS 1

Two keys replace the need for root on the host. Each is bound to a forced command
(`/root/.ssh/authorized_keys`, `restrict,command=...`), so the key cannot do anything the
wrapper does not allow.

## Deploy-only key

`~/.ssh/ddostester_deploy` (ed25519, no passphrase: it is an automation key, keep it 0600).

```bash
ssh -i ~/.ssh/ddostester_deploy root@31.31.74.228 status   # running build
ssh -i ~/.ssh/ddostester_deploy root@31.31.74.228 deploy   # promote origin/main
```

`deploy` runs `deploy/update.sh` from the production checkout as the service user; it builds a
release, restarts the unit and waits for health. Any other command is refused with
`allowed: status | deploy`, which was verified with a destructive command against `/`.

## Read-only database key

`~/.ssh/ddostester_sql`.

```bash
ssh -i ~/.ssh/ddostester_sql root@31.31.74.228 "select count(*) from campaigns"
```

The wrapper connects as `ddostester_ro` with `default_transaction_read_only=on` and a 15 s
statement timeout, so a write fails at the database:

```
ERROR:  cannot execute DELETE in a read-only transaction
```

The role has `SELECT` on existing and future tables in `public` and nothing else. The password
lives in `/etc/ddostester-ro.pw` (0600), read by the wrapper only.

## What stays root

Host-level changes — systemd units, Caddy, PostgreSQL roles, firewall — still need the
administrative key. The point of the two above is that ordinary work no longer does: reading
the database and shipping a build are the two operations that used to require root.

## Verification

| Check                            | Result                                             |
| -------------------------------- | -------------------------------------------------- |
| deploy key, `status`             | `/health` JSON with build and commit               |
| deploy key, `rm -rf /`           | `allowed: status                                   | deploy` |
| SQL key, `select count(*)`       | `345`                                              |
| SQL key, `delete from campaigns` | `cannot execute DELETE in a read-only transaction` |
