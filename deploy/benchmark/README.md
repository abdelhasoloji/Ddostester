# Bare-origin benchmark (VPS3)

The deliberately-**unprotected** HTTP origin the control plane's scenarios run
against to produce a baseline — the "before" a protected WEDOS edge is measured
against. This directory is **infrastructure-as-code for the target**, not attack
code: the control plane still implements no attack vector (see the repo's
`AGENTS.md` boundary), and every endpoint here is a bounded victim app.

## What it exposes

The origin is configured so recon classifies it with the posture flags the
playbooks gate on (`TargetRequirement`), so the matching scenarios apply **and
actually land**:

| Flag      | How it is exposed                                                                                                                 | Scenario class it unlocks                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `dynamic` | The homepage links expensive PHP endpoints, so recon discovers them (`extractPaths`) and seeds load at real origin-compute paths. | origin-exhaustion, expensive-path GET/POST floods |
| `h2`      | Real TLS + `http2 on` on `:443` (self-signed) plus an `Alt-Svc: h2` header on `:80` (recon reads Alt-Svc).                        | HTTP/2 burst family                               |
| `cache`   | `/` emits `X-Cache: HIT` / `Age` / `Cache-Control: public`, so recon reads `cache=hit`.                                           | cache-busting                                     |
| `waf`     | **Intentionally absent** — a bare origin has no WAF to evade, so signature-evasion scenarios stay correctly N/A.                  | —                                                 |

The real exhaustion lever is **`pm.max_children = 5`**: a handful of the
expensive endpoints in flight saturates every PHP-FPM worker, so nginx starts
returning 502/504 while the static root probe keeps answering — the
"Origin overwhelmed" case the Run Theater badge distinguishes.

## Endpoints (`www/`)

- `/` — store homepage that links every dynamic endpoint (recon's discovery surface).
- `/api/search.php?q=&rows=N` — catalogue scan + sort (CPU).
- `/api/db.php?id=&ms=N` — simulated slow query (`usleep` blocks an FPM worker).
- `/api/products.php?page=N` — paginated listing.
- `/api/report.php?ms=N` — heavy CPU (default 600ms, cap 2000ms).
- `/api/work.php?ms=N` — bounded busy-work (cap 2000ms).
- `/account.php` — moderate per-request work.
- `/login.php` — GET form; **POST runs bcrypt cost-12 (~300ms)** = auth-CPU exhaustion.
- `/api/cached.php` — cacheable response.
- `/api/echo.php` — uncacheable echo (GET/POST).
- `/health` — cheap liveness (served by nginx, used as the probe).

Every dynamic endpoint is bounded (≤2s/request via `api/_lib.php`) — weak, **not**
an unbounded amplifier.

## Provision / re-provision

Idempotent. As root on the benchmark host:

```bash
GENERATOR_IP=31.31.74.228 bash deploy/benchmark/provision.sh
```

Installs nginx + php-fpm, deploys `www/`, sets the small FPM pool, generates the
self-signed cert, installs `benchmark.nginx`, and **locks `:80`/`:443` to the
generator IP** (an exhaustible origin must never be internet-facing). Pass
`PUBLIC_HTTP=1` to also open `:80` publicly for a demo (not recommended once
weakened). The vhost's FastCGI socket is pinned to the host's PHP version.

## Verify from the generator (VPS1)

Recon should report `{h2:true, waf:false, cache:true, dynamic:true}` with the
dynamic/h2/cache actions applicable:

```
GET /api/recon?target=http://<benchmark-ip>/&actions=1   (campaign:read)
```
