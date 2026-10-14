# Overview — what ShieldTest is & why

WEDOS ShieldTest is the **internal proving ground for WEDOS Protection**: it lets
a sovereign European edge-protection platform **prove — governed, measured,
audited — that its Anycast edge actually mitigates what it sells**, full-stack,
per protected customer, over time. That is both a commercial argument (EU
sovereignty + demonstrated efficacy) and a regulatory necessity (NIS2/DORA
require _demonstrating_ resilience, not asserting it).

> **Non-negotiable design principle.** The control plane implements **no attack
> vector** — only a bounded HTTP generator (GET/POST, rate-capped, allowlisted).
> Everything volumetric/amplification lives in the closed class-C lab
> ([`shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab)) that
> models _traffic shape_ only. See [boundary-and-lab.md](./boundary-and-lab.md).

## Context — WEDOS Protection is the product being proven

WEDOS Protection is a sovereign European edge-protection platform (a direct
Cloudflare competitor): a global **Anycast network (120+ PoPs, 3000+ servers)**
doing multi-layer **L3/L4/L7 DDoS mitigation + WAF + rate-limiting + bot
management + Geo/ASN/IP-reputation filtering + Anycast CDN + DNS**, EU-only data
(GDPR-native, ISO 27001/17/18, NIS2-ready), on infrastructure WEDOS owns.
Sources: [wedos.com](https://wedos.com/), [wedos.global](https://wedos.global/),
[wedos.protection](https://wedos.protection/).

## The key insight — the tool mirrors the product

The **"absorbed by edge %"** number _is_ WEDOS Protection engaging. Every screen
proves a real product feature:

| WEDOS Protection (product)              | What ShieldTest proves                                 |
| --------------------------------------- | ------------------------------------------------------ |
| L3/L4 mitigation ("within seconds")     | Network DRS ladder, class-C lab · `synFloodProtection` |
| WAF (OWASP + WEDOS rules)               | DRS L7 templates · `wafSignatures`                     |
| Rate-limiting & bot challenge (ATP/PoW) | `rateLimiting` / `challenge` controls                  |
| Origin shielding & Anycast CDN cache    | `originShielding` / `cacheKeyPolicy`                   |
| Geo / ASN / IP-reputation filtering     | `urlAllowlist` / method policy                         |
| Real-time Grafana analytics             | 3-plane observability + WRS trend                      |
| NIS2-ready, GDPR, ISO 27001/17/18       | DORA/NIS2 evidence + tamper-evident audit              |

The **full-stack DRS ladder** (attacker capability 1→7) is the spine: the lab
owns L3/L4, the control plane owns L7; together they mirror WEDOS's own
multi-layer mitigation, and the **WRS** scores the protection's efficacy.
[measurement.md](./measurement.md) covers WRS + the five-phase engagement model;
the vision's `next` horizon (per-zone assurance, PoP/region fleet, measured WRS
from the real scrubber, compliance certificates) is tracked in
[roadmap.md](./roadmap.md).

## Implemented stack vs the TSD (v1.0)

The TSD specifies one stack; the implementation uses an equivalent one.

| Layer      | Specified (TSD)          | Implemented                                            | State         |
| ---------- | ------------------------ | ------------------------------------------------------ | ------------- |
| API        | FastAPI (Python)         | Fastify 5 (Node 22 / TS)                               | ✅ equivalent |
| Frontend   | Vue.js 3                 | React 18 + Vite 7                                      | ✅ equivalent |
| Database   | PostgreSQL + TimescaleDB | PostgreSQL (+ optional TimescaleDB hypertable)         | ✅            |
| Auth / SSO | Keycloak + mTLS          | JWT HS256 + RBAC (Keycloak-compatible); mTLS via Caddy | ✅            |
| Scheduler  | Celery + Redis           | In-process scheduler                                   | ✅ equivalent |
| Monitoring | Prometheus + Grafana     | Prometheus `/metrics` + provisioned Grafana            | ✅            |
| Reporting  | PDF + HTML               | HTML + PDF (browser print)                             | ✅            |

Functional coverage (CAM-01…04 creation/approval/execution/live view, PROBE,
3-level kill switch, WRS + history/regressions, campaign + DORA/NIS2 reports,
bounded combined scenarios, external-engine delegation, audit, `X-WEDOS-TEST`
tagging) is all ✅ — the detail lives in [roadmap.md](./roadmap.md).

**Deliberately not implemented** (TSD §5.2, outside the defensive scope): L3/L4
vectors, DNS/NTP/SSDP/CLDAP amplification, L7 exhaustion (Slowloris/RUDY/…),
unbounded rate or off-allowlist targets. These **saturate** rather than
**measure** — see [boundary-and-lab.md](./boundary-and-lab.md).
