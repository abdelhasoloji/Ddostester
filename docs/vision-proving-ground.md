# Vision — the Proving Ground for WEDOS Protection

> North star for the `vision/proving-ground` line of work. It reframes what
> ShieldTest is _for_ and defines the feature set that follows. It complements
> [roadmap.md](./roadmap.md) (the source of truth for built-vs-planned) — this
> doc is the _why_ and the _shape_; the roadmap tracks the _what_ and _status_.

## Context correction

WEDOS is **not "just a hoster"** any more. **WEDOS Protection** is a **sovereign
European edge-protection platform — a direct Cloudflare competitor**: a global
**Anycast network (120+/123 PoPs, 3000+ servers)** doing multi-layer
**L3/L4/L7 DDoS mitigation + WAF (OWASP + managed rules) + rate-limiting + bot
management (ATP/PoW challenge) + Geo/ASN/IP-reputation filtering + Anycast CDN +
DNS**, EU-only data (Luxembourg HQ, GDPR-native, ISO 27001/17/18, NIS2-ready),
running on infrastructure WEDOS owns. It blocks ~17.6M threats/day.

Sources: [wedos.com](https://wedos.com/), [wedos.global](https://wedos.global/),
[wedos.protection](https://wedos.protection/).

## Purpose

**ShieldTest is the internal proving ground for WEDOS Protection.** Its mission:
let a Cloudflare competitor **prove — governed, measured, audited — that its
Anycast edge actually mitigates what it sells**, full-stack, per protected
customer, over time. That is both a **commercial argument** (EU sovereignty +
demonstrated efficacy) and a **regulatory necessity** (NIS2/DORA require
_demonstrating_ resilience, not asserting it).

The design principle stays absolute: **the control plane implements no attack
vector** — only a bounded HTTP generator (GET/POST, rate-capped, allowlisted).
Everything volumetric/amplification lives in the closed class-C lab
([`shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab)) that models
_traffic shape_ only (no spoofing, no real reflector, isolated network).

## The key insight — the tool mirrors the product

The **"absorbed by edge %"** number _is_ WEDOS Protection engaging. Every screen
proves a real product feature:

| WEDOS Protection (the product)          | What ShieldTest proves                                 |
| --------------------------------------- | ------------------------------------------------------ |
| L3/L4 mitigation ("within seconds")     | Network DRS ladder, class-C lab · `synFloodProtection` |
| WAF (OWASP + WEDOS rules)               | zeroBS L7 templates · `wafSignatures`                  |
| Rate-limiting & bot challenge (ATP/PoW) | `rateLimiting` / `challenge` controls                  |
| Origin shielding & Anycast CDN cache    | `originShielding` / `cacheKeyPolicy`                   |
| Geo / ASN / IP-reputation filtering     | `urlAllowlist` / method policy                         |
| Real-time Grafana analytics             | 3-plane observability + WRS trend                      |
| NIS2-ready, GDPR, ISO 27001/17/18       | DORA/NIS2 evidence + tamper-evident audit              |

The **full-stack DRS ladder** (attacker capability 1→7) is the spine: the **lab
owns L3/L4**, the **control plane owns L7**, together they mirror WEDOS's own
multi-layer mitigation. The **WRS** scores the protection's _efficacy_.

## Feature set

Design mockup: **https://claude.ai/code/artifact/ea429a73-526f-433f-8e7e-baed02ec5adc**

### Built (`now`) — already in the platform

- **Full-stack DRS testing** — L7 bounded HTTP (control plane) + L3/L4 (class-C lab), one DRS ladder; threat-informed library (real 2024–26 shapes).
- **Control-coverage planner** — validate each WEDOS control actually engages, seeded from evidence (recon + prior runs + lab), weakest-link break point, **create the campaign straight from the plan**.
- **Live protection theatre** — offered → absorbed by edge → reached origin, mechanism split, legit-probe uptime.
- **Measured score (WRS)** — 0.20·D + 0.30·M + 0.30·A + 0.20·C, history + cross-run compare (tune-and-replay).
- **Sovereign governance** — allowlist + hard caps + dual-control approval + kill switch + hash-chained audit; EU-only, self-hosted (loopback + mTLS).
- **Engines & realism** — built-in + delegated (k6/Vegeta/Locust), flows/endpoint-mix/UA-rotation, compose several templates into one campaign.

### To build (`next`) — what makes it a true proving ground for a Cloudflare rival

1. **Protected-zone assurance (multi-tenant)** — one bench _per protected
   customer/zone_: posture at a glance (WRS, DRS reached, edge-absorption, last
   test), **scheduled re-tests**, **regression alerts**, tiered by plan
   (NoLimit / Managed EU) and compliance (NIS2/DORA). _Why: the product is
   sold per-customer; assurance must be per-customer too._
2. **PoP / multi-region fleet** — generate from **several regions** to exercise
   Anycast routing, measure **absorption + mitigation timing per PoP** (123
   PoPs). Needs a distributed agent fleet + durable job queue + resumable runs
   (roadmap Horizon 2/3 F–H). _Why: a single-origin generator can't prove an
   Anycast edge._
3. **Measured WRS from the real scrubber** — wire the **real WEDOS Protection
   scrubber telemetry endpoint** so Detection/Mitigation timing (TTD/TTM) is
   _measured_, not estimated (roadmap A). **This is the single most important
   bridge** — it turns the whole score from a model into evidence.
4. **Compliance evidence** — signed, tamper-evident **assurance certificates**
   per zone ("tested to DRS N, WRS X, on date"), mapped to **NIS2 / DORA**, for
   regulators and customers.

## How this branch develops the vision

Suggested sequence (each shippable on its own, smallest-first):

1. **Reframe the surface** — README/CLAUDE.md/UI copy from generic "internal
   resilience testing" to "proving ground for WEDOS Protection" (low risk,
   high clarity).
2. **Protected-zone model** — introduce a `zone` entity (a protected customer),
   group campaigns/WRS/DRS coverage under it; a zones list + per-zone posture.
3. **Measured WRS bridge** — the scrubber-telemetry connector (roadmap A) so the
   Run Theatre's TTD/TTM and the WRS are real.
4. **Per-zone assurance schedule + regression alerting** on top of the zone model.
5. **PoP/region fleet** and **compliance certificates** as the scale/evidence
   horizon.

Keep every step inside the non-negotiable boundary: bounded HTTP only, safeguards
first, no attack vector in the control plane.
