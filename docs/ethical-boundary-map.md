# Ethical boundary map

Where the project's ethical boundary is stated and where it is enforced in code.
Two boundaries coexist and must both hold:

1. **Control plane** — the deployed product (`backend/` + `frontend/`) implements
   **no attack vector**; its only load vector is a bounded, allowlisted, capped,
   audited HTTP generator.
2. **Closed synthetic lab** (`lab/`) — a **measurement model, not an amplifier**:
   it reproduces UDP-amplification _traffic shape_ (synthetic protocol profiles)
   with no source-IP spoofing, no real reflector protocol, an `internal` network
   with no host ports, and hard caps.

## Policy (intent)

| File                      | Defines                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `SECURITY.md`             | Acceptable / prohibited use; synthetic-lab usage policy        |
| `CLAUDE.md`               | Non-negotiable boundary for every contributor/agent            |
| `docs/safeguards.md`      | Security model, "What is NOT implemented", lab carve-out       |
| `README.md`               | "Defensive scope" banner + "What is NOT implemented"           |
| `docs/roadmap.md`         | Scope banner (source of truth for status) + lab section        |
| `docs/security-review.md` | Threat model, verified points, residual risks                  |
| `docs/network-lab.md`     | Lab safety properties (no-spoofing, isolation, caps, profiles) |
| `CONTRIBUTING.md`         | Contribution rules (points back to the safeguards)             |

## Code — control plane (enforcement)

| File                                       | Enforces                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| `backend/src/modules/campaigns/model.ts`   | `HARD_CAPS` (2000 rps / 500 conc. / 900 s) + attestation shape |
| `backend/src/modules/campaigns/service.ts` | Allowlist, caps, `authorized:true`, approval + duty separation |
| `backend/src/engine/loadTest.ts`           | Rejects off-allowlist targets + generator rate cap             |
| `backend/src/auth/rbac.ts`                 | Roles / permissions (separation of duties)                     |
| `backend/src/auth/guard.ts`                | Per-route permission enforcement                               |
| `backend/src/modules/probe/probe.ts`       | 3-level kill switch (auto / manual / timeout)                  |
| `backend/src/modules/campaigns/runner.ts`  | Absolute timeout + `X-WEDOS-TEST` tag on every request         |
| `backend/src/agents/types.ts`              | `AttackAgent` contract (delegation, `allowedHosts` propagated) |
| `backend/src/util/tls.ts`                  | `INSECURE_TLS` escape hatch (lab-only; startup warning logged) |
| `.env.example`                             | Documents `ALLOWED_TARGETS`, `INSECURE_TLS` warning, lab caps  |

## Code — closed lab (enforcement)

| File                                 | Enforces                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `lab/synthetic-reflector/server.mjs` | No source spoofing (target fixed by config), byte/packet caps, CIDR guard |
| `lab/generator/generate.mjs`         | PPS/duration caps, CIDR guard, profile validation                         |
| `lab/profiles.mjs`                   | Fixed profile allowlist (shape presets only), label sanitisation          |
| `lab/test/amplification.test.mjs`    | Verifies caps, out-of-CIDR rejection, and profile-label injection safety  |
| `docker-compose.yml`                 | `internal: true` network, no published host ports for lab services        |

## Review priority

- **Intent** → `SECURITY.md`, `CLAUDE.md`, `docs/safeguards.md`.
- **Control-plane enforcement** → `campaigns/model.ts`, `campaigns/service.ts`,
  `auth/rbac.ts`, `engine/loadTest.ts`.
- **Lab** → `docs/network-lab.md`, `lab/synthetic-reflector/server.mjs`,
  `lab/profiles.mjs`.

## Residual risks (accepted / operator-handled)

- **Authorization attestation** is declarative: a technical barrier, not proof of
  authorization — scope responsibility stays with the operator (see `SECURITY.md`).
- **Lab CIDR guard** validates a configured prefix, not routing reality; it is a
  guard rail, and the real containment is the `internal` Docker network with no
  host ports. Do not rely on the prefix check alone.
- **`/metrics` has no authentication** (non-sensitive aggregates, internal
  network); protect via the reverse proxy if exposed.
- **`INSECURE_TLS`** disables TLS verification **process-wide** (target, probe and
  webhooks), intended for an isolated lab only; it logs a loud warning at startup.
  Prefer `NODE_EXTRA_CA_CERTS` (internal CA), which keeps verification on.
