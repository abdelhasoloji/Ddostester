# Staging — trustena.lu

An isolated instance for client demonstrations and for exercising plans without touching
production data.

## What runs

| Piece       | Where                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Service     | `ddostester-staging.service`, `127.0.0.1:8081`, user `shieldtest`                        |
| Checkout    | `/home/shieldtest/ddostester-staging`, updated by `deploy/staging-update.sh`             |
| Database    | `ddostester_staging` on the same PostgreSQL, role `ddostester_staging`                   |
| Environment | `/etc/ddostester-staging.env` (0600)                                                     |
| Login       | `staging-admin@trustena.lu`; the password is in `/root/.ddostester-staging-login` (0600) |

Staging is loopback-only. Nothing is exposed until the reverse proxy block below is enabled,
which needs the DNS record first.

## DNS to add (OVH)

```
drs-staging.trustena.lu.  A  31.31.74.228
```

`trustena.lu` and its wildcard currently point at `51.178.16.135`, which is not this host; a
specific A record for the subdomain overrides the wildcard.

Verify from a workstation:

```
dig +short drs-staging.trustena.lu A    # must print 31.31.74.228
```

## Reverse proxy, once DNS resolves

Append to `/etc/caddy/Caddyfile` and reload:

```
drs-staging.trustena.lu {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		-Server
	}
	reverse_proxy 127.0.0.1:8081
}
```

```
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Caddy obtains a Let's Encrypt certificate for the hostname on first request. Do not add the
block before the DNS record exists: ACME will fail and retry.

## Why app auth rather than the production mTLS gate

Production requires a client certificate on every connection, which is right for the
operational estate and wrong for a client demonstration. Staging keeps the application's own
login and password policy on top of TLS, and is reachable from the internet. That is the
trade-off: a staging host with real credentials must be treated as an internet-facing service.

## Updating

```bash
sudo deploy/staging-update.sh
```

It fetches main, installs, builds, applies the account migration and restarts, then waits for
`/health`. The production workflow never touches staging, and staging never touches the
production database.
