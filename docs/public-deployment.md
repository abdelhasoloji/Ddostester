# Public / networked deployment — hardening & governance (CISO dossier)

ShieldTest is a DDoS-resilience **control plane**. The engagement traffic stays
bounded, allowlisted and authorized (no amplification/spoofing/evasion — see
`docs/safeguards.md`); the risk of putting the control plane on a networked VPS
is that a third party could take over the plane itself. This dossier is the set
of controls required before any deployment beyond loopback. It is meant to be
reviewed and signed off by the CISO.

## Network exposure — mTLS (approved posture)

The API binds **loopback** by default. A non-loopback bind is gated in code
(`ALLOW_PUBLIC_BIND`, see `backend/src/util/bind.ts`): a private address is
allowed with a firewall warning; a public / all-interfaces bind is refused
unless explicitly acknowledged.

Approved topology: the API is **never** exposed directly. It sits behind a
reverse proxy (Caddy/nginx/Traefik) that:

- terminates **TLS**, and requires a **client certificate (mTLS)** — only hosts
  holding a certificate issued by our internal CA can reach the API;
- forwards to the app on loopback (`127.0.0.1:8080`), so the app never listens
  on a public interface;
- applies a connection/request **rate limit** and standard timeouts.

The lab runner (VPS 2) reaches the API over a **private tunnel** (WireGuard or
SSH), not the public interface — see `docs/provisioning-4vps.md`.

**Ready-to-use proxy config:** `deploy/proxy/` ships the mTLS `Caddyfile`, a PKI
generator (`make-ca-certs.sh` — internal CA, server cert, per-admin client
certs), and a step-by-step `README.md` (cert placement, firewall, verification,
and an nginx alternative with built-in rate limiting). The private keys it
produces are gitignored and never leave the operator's workstation / the VPS.

## Dual control — mandatory CISO sign-off

Set `REQUIRE_CISO_APPROVAL=1` on the server. Every campaign then needs **two**
approvals before it can run, with separation of duties across three roles:

1. author (engineer) creates it;
2. a **Security Officer** approves it (`author ≠ officer`);
3. a **CISO** gives the mandatory sign-off (`ciso ≠ author` and `ciso ≠ officer`).

Enforced server-side in `runCampaign`, so **neither** the execute endpoint
**nor** the one-click suite sequencer can bypass it — a step without the CISO
sign-off is skipped by the sequence and refused (400/409) on a manual run. The
sign-off is recorded and audited (`campaign.ciso_approve`) and shown in the UI
(a "CISO ✓ / pending" badge and a "CISO sign-off" action for the CISO role).
Endpoint: `POST /api/campaigns/:id/ciso-approval` (`campaign:ciso-approve`, CISO
only). `/health` advertises the posture as `requireCisoApproval`.

## Prerequisites (before flipping the switch)

- [ ] **Rotate every secret** that was ever shared in plaintext (DB password,
      `AUTH_JWT_SECRET`, `BENCH_RUNNER_TOKEN`) and re-issue user password hashes.
- [ ] Reverse proxy with TLS **+ mTLS** in front; app stays on loopback.
- [ ] `REQUIRE_CISO_APPROVAL=1`; at least one `officer` **and** one `ciso` user.
- [ ] Firewall: only the proxy (and the lab tunnel) may reach the app port.
- [ ] Audit export scheduled off-host (tamper-evident chain, `docs/api.md`).
- [ ] `ALLOWED_TARGETS` limited to the mandated targets; `LAB_TARGETS` disjoint.

## Already in place (baseline governance)

RBAC + separation of duties, immutable HARD_CAPS + CISO operational limits,
attested authorization per campaign, allowlist, kill switch + auto-kill,
tamper-evident audit chain, login lockout, security headers, and the bind guard.
