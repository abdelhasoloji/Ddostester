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
- **CORS `origin: true`**: needed in dev (Vite UI on another port). Without
  cookies (Bearer auth), no CSRF; in prod the UI is served same-origin.
  Restrict via the proxy if desired.
- **Authorization attestation**: a declarative barrier — responsibility for the
  scope lies with the operator (cf. SECURITY.md).
- **mTLS**: provided at the reverse-proxy level (Caddy), not in the application.

## What the tool does not do (by design)

No attack vector (L3/L4 floods, amplification, L7 exhaustion). The only generator
is bounded HTTP. The separate closed lab (`lab/`) models amplification _traffic
shape_ synthetically (no spoofing, no real reflector, isolated, hard-capped) for
defensive measurement only. See [safeguards.md](./safeguards.md) and
[network-lab.md](./network-lab.md).
