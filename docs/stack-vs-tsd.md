# Implemented stack vs specification (TSD WEDOS ShieldTest v1.0)

Mapping between the TSD and the current implementation.

## Control plane (layers)

| Layer      | Specified (TSD)          | Implemented                                                                    | State                         |
| ---------- | ------------------------ | ------------------------------------------------------------------------------ | ----------------------------- |
| API        | FastAPI (Python)         | Fastify 5 (Node 22 / TS)                                                       | ✅ equivalent                 |
| Frontend   | Vue.js 3                 | React 18 + Vite 7                                                              | ✅ equivalent                 |
| Database   | PostgreSQL + TimescaleDB | PostgreSQL (+ optional TimescaleDB: wrs_samples hypertable)                    | ✅                            |
| Auth / SSO | Keycloak + mTLS          | JWT HS256 + RBAC (Keycloak-compatible); mTLS via Caddy reverse proxy (profile) | ✅                            |
| Scheduler  | Celery + Redis           | In-process scheduler (CAM-01)                                                  | ✅ equivalent                 |
| Monitoring | Prometheus + Grafana     | Prometheus `/metrics`                                                          | ✅ (Grafana = external conf.) |
| Reporting  | PDF + HTML               | HTML + PDF (browser print)                                                     | ✅                            |

## Functional

| Item (TSD)                                   | Implemented                                                                     | State           |
| -------------------------------------------- | ------------------------------------------------------------------------------- | --------------- |
| CAM-01 creation + scheduled window           | yes + scheduler                                                                 | ✅              |
| CAM-02 approval (separation of duties, 24 h) | yes                                                                             | ✅              |
| CAM-03 execution                             | yes (manual + scheduled)                                                        | ✅              |
| CAM-04 real-time visualization               | live SSE progress (bar + counters)                                              | ✅              |
| PROBE legitimate probe                       | yes                                                                             | ✅              |
| 3-level kill switch                          | auto / manual / time-based                                                      | ✅              |
| WRS scoring                                  | yes (TSD formula)                                                               | ✅              |
| WRS-03 history + regressions                 | yes (sparklines + alert)                                                        | ✅              |
| RPT-01 campaign report (PDF)                 | HTML + PDF                                                                      | ✅              |
| RPT-02 DORA/NIS2 compliance report           | yes (aggregated)                                                                | ✅              |
| GEN-03 combined scenarios                    | ramp-up / waves **bounded HTTP**                                                | ✅ (bounded)    |
| External load generation (agents)            | AttackAgent interface + k6/Vegeta/Locust/JMeter/Gatling adapters (bounded HTTP) | ✅ (delegation) |
| Audit log / traceability                     | yes (persistent)                                                                | ✅              |
| `X-WEDOS-TEST` traffic tagging               | yes                                                                             | ✅              |

## Deliberately NOT implemented (outside the defensive scope)

| Item (TSD §5.2)                                                                           | State       |
| ----------------------------------------------------------------------------------------- | ----------- |
| GEN-01 L3/L4 vectors (UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS)                | ❌ excluded |
| DNS/NTP/SSDP/CLDAP amplification/reflection, Smurf                                        | ❌ excluded |
| GEN-02 L7 exhaustion vectors (Slowloris, RUDY, WebSocket flood, XML bomb, browser botnet) | ❌ excluded |
| Unbounded rate / target outside allowlist                                                 | ❌ excluded |

These vectors serve to **saturate** a service, not to measure its resilience in a
controlled way. The only provided vector is a bounded application HTTP generator
(GET/POST), capped and traceable. See [safeguards.md](./safeguards.md).

## Still possible (legitimate, not prioritized)

- Pre-provisioned Grafana dashboards on `/metrics`.
