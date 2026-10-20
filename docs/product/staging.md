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

| Record                   | Points to                   |
| ------------------------ | --------------------------- |
| `drs.trustena.lu.` A     | `31.31.74.228` — production |
| `testdrs.trustena.lu.` A | `31.31.74.228` — staging    |

`trustena.lu` and its wildcard currently point at `51.178.16.135`, which is not this host; a
specific A record for each subdomain overrides the wildcard.

Verify from a workstation:

```
dig +short drs.trustena.lu A        # must print 31.31.74.228
dig +short testdrs.trustena.lu A    # must print 31.31.74.228
```

## Published

`https://testdrs.trustena.lu` is live (staging, build 505): Let's Encrypt certificate, the
sign-in screen, and `/health` at 200. The update script builds **both** workspaces — a
backend-only build serves `/health` and returns 404 on `/`, which looks down to a client.

`drs.trustena.lu` waits on its A record.

## Publishing the domains

Once both records resolve:

```bash
sudo deploy/enable-domains.sh
```

It refuses to touch Caddy while a name points elsewhere, backs up the Caddyfile, appends one
site block per name (`drs.trustena.lu` → `127.0.0.1:8080`, `testdrs.trustena.lu` →
`127.0.0.1:8081`), validates the configuration, reloads Caddy and waits for `/health` on both
hostnames. `--check` reports DNS and certificate status without changing anything.

## Why app auth rather than the production mTLS gate

The operational `:443` block still requires a client certificate, and that is right for the
estate. A client cannot be asked for a certificate issued by this CA, so both product domains
(`drs.trustena.lu`, `testdrs.trustena.lu`) use the application's own login and password policy
over a Let's Encrypt certificate. The IP-based mTLS vhost is untouched: existing operational
access keeps working exactly as before.

That is the trade-off: two internet-facing names with real credentials must be treated as
internet-facing services — strong passwords, no shared accounts, monitoring included.

## Updating

```bash
sudo deploy/staging-update.sh
```

It fetches main, installs, builds, applies the account migration and restarts, then waits for
`/health`. The production workflow never touches staging, and staging never touches the
production database.

## The certificate trap this hit

The internal vhost was written as `:443`, a catch-all without a hostname. Caddy answers a
catch-all for any name and TLS selects the certificate by SNI, so `testdrs.trustena.lu` was
served the **internal** certificate (`CN=31.31.74.228`) even though the Let's Encrypt
certificate had been obtained successfully.

Scoping the internal vhost to `https://31.31.74.228` fixes both sides:

| Connection                           | Certificate                                        |
| ------------------------------------ | -------------------------------------------------- |
| no SNI, as a client connecting by IP | `CN=31.31.74.228` (internal) — unchanged behaviour |
| SNI `testdrs.trustena.lu`            | `CN=testdrs.trustena.lu` (Let's Encrypt)           |

`deploy/enable-domains.sh` performs that scoping itself, idempotently. The health check pins
the address with `--resolve`, because the host resolver keeps the previous wildcard until its
TTL expires and would otherwise report a false failure.
