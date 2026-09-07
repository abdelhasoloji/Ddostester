# Security review (self-assessment)

Summary of the control plane's security posture. **Internal** tool, to be exposed
only behind loopback + SSH tunnel or a TLS/mTLS reverse proxy.

## Threat model

| Threat                        | Handling                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| Using the tool against others | Mandatory allowlist + attestation; out of scope = 400/403 rejection    |
| Public exposure of the API    | Loopback bind by default; TLS/mTLS reverse proxy for any remote access |
| Privilege escalation          | RBAC (engineer/officer/viewer) on every route; separation of duties    |
| Author/approver spoofing      | Derived from the JWT token, never from the request body                |
| Credential theft              | scrypt passwords; anti-brute-force lock (5 failures → 60 s)            |
| Token leak in logs            | `?token=` redaction + Authorization header not logged                  |
| SQL injection                 | 100 % parameterized queries (`pg`)                                     |
| Uncontrolled load             | Hard caps (RPS ≤ 2000, duration ≤ 900 s), 3-level kill switch          |

## Verified points

- **JWT HS256**: signature recomputed and compared in constant time
  (`timingSafeEqual`); `exp` checked; the header algorithm is not used to choose
  the verification (no `alg:none` flaw).
- **Permission guards** on all `/api` routes (integration tests: 401 without a
  token, 403 depending on the role).
- **Separation of duties** at approval (approver ≠ author), tested.
- **Allowlist** for target + probe; `http`/`https` protocols only.
- **Report / SSE**: read token accepted as a query param for browser links,
  verified through the same permission logic.

## Residual risks (accepted / to be handled by the operator)

- **No authentication on `/metrics`** (non-sensitive aggregates; internal
  network). Protect via the reverse proxy if needed.
- **CORS**: default `origin: false` (same-origin only — the API serves the UI).
  Cross-origin access is opt-in via `CORS_ORIGIN` (explicit allowlist of
  origins). With Bearer auth (no cookies) there is no CSRF surface.
- **Authorization attestation**: a declarative barrier — responsibility for the
  scope lies with the operator (cf. SECURITY.md).
- **mTLS**: provided at the reverse-proxy level (Caddy), not in the application.

## What the tool does not do (by design)

No attack vector (L3/L4 floods, amplification, L7 exhaustion). The only generator
is bounded HTTP. The closed lab that models amplification _traffic shape_
synthetically (no spoofing, no real reflector, isolated, hard-capped) for
defensive measurement lives in a **separate repository**
([`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab)),
so this control plane contains no such code at all. See
[safeguards.md](./safeguards.md) and [network-lab.md](./network-lab.md).

## Go-live review pass (Docker Compose exposure)

Focused review of the production-exposed surface ahead of the Docker Compose
go-live. Verified:

- **Loopback-only publishing** for `api` (8080), `db` (5432) and Grafana (3000);
  the internal lab network is `internal: true`.
- **No weak secret defaults**: `POSTGRES_PASSWORD` and `GRAFANA_PASSWORD` are
  both required (Compose refuses to start without them); `.env` is gitignored and
  excluded from the Docker build context.
- **Outbound TLS verification on by default**: `INSECURE_TLS` is off, logs a loud
  warning when enabled, and is surfaced in `/health` (`tlsInsecure`).

Finding fixed in this pass:

- **Redirects were auto-followed (allowlist / SSRF bypass).** The builtin engine
  called `fetch()` with no `redirect` option, so Node/undici followed 3xx
  responses by default. An allowlisted target returning a redirect to an
  off-allowlist host (e.g. cloud metadata `169.254.169.254`, or an internal
  service) would have been contacted, defeating the allowlist bound. **Fix:**
  `redirect: 'manual'` — a 3xx is now measured as a 3xx against the allowlisted
  host and never chased. Covered by a regression test
  (`loadTest.test.ts` → "redirects are not followed").

Residual (accepted, operator-configured): the protection/target-telemetry pull
connectors and notification webhooks fetch **operator-set** URLs
(`PROTECTION_METRICS_URL`, `TARGET_TELEMETRY_METRICS_URL`, `NOTIFY_*`), not
campaign inputs; these are trusted configuration, not attacker-controlled.
