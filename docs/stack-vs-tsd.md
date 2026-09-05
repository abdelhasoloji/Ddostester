# Stack réalisé vs spécifications (TSD WEDOS ShieldTest v1.0)

État de correspondance entre le TSD et l'implémentation actuelle.

## Control plane (couches)

| Couche          | Spécifié (TSD)           | Réalisé                                                                        | État                         |
| --------------- | ------------------------ | ------------------------------------------------------------------------------ | ---------------------------- |
| API             | FastAPI (Python)         | Fastify 5 (Node 22 / TS)                                                       | ✅ équivalent                |
| Frontend        | Vue.js 3                 | React 18 + Vite 7                                                              | ✅ équivalent                |
| Base de données | PostgreSQL + TimescaleDB | PostgreSQL (+ TimescaleDB optionnel : hypertable wrs_samples)                  | ✅                           |
| Auth / SSO      | Keycloak + mTLS          | JWT HS256 + RBAC (compatible Keycloak) ; mTLS via reverse-proxy Caddy (profil) | ✅                           |
| Ordonnanceur    | Celery + Redis           | Ordonnanceur in-process (CAM-01)                                               | ✅ équivalent                |
| Monitoring      | Prometheus + Grafana     | `/metrics` Prometheus                                                          | ✅ (Grafana = conf. externe) |
| Reporting       | PDF + HTML               | HTML + PDF (impression navigateur)                                             | ✅                           |

## Fonctionnel

| Élément (TSD)                                   | Réalisé                                            | État            |
| ----------------------------------------------- | -------------------------------------------------- | --------------- |
| CAM-01 création + fenêtre planifiée             | oui + ordonnanceur                                 | ✅              |
| CAM-02 approbation (séparation des rôles, 24 h) | oui                                                | ✅              |
| CAM-03 exécution                                | oui (manuelle + planifiée)                         | ✅              |
| CAM-04 visualisation temps réel                 | progression live SSE (barre + compteurs)           | ✅              |
| PROBE sonde légitime                            | oui                                                | ✅              |
| Kill switch 3 niveaux                           | auto / manuel / temporel                           | ✅              |
| WRS scoring                                     | oui (formule TSD)                                  | ✅              |
| WRS-03 historique + régressions                 | oui (sparklines + alerte)                          | ✅              |
| RPT-01 rapport campagne (PDF)                   | HTML + PDF                                         | ✅              |
| RPT-02 rapport conformité DORA/NIS2             | oui (agrégé)                                       | ✅              |
| GEN-03 scénarios combinés                       | ramp-up / vagues **bornés HTTP**                   | ✅ (borné)      |
| Génération de charge externe (agents)           | interface AttackAgent + adaptateur k6 (HTTP borné) | ✅ (délégation) |
| Journal d'audit / traçabilité                   | oui (persistant)                                   | ✅              |
| Marquage de trafic `X-WEDOS-TEST`               | oui                                                | ✅              |

## Volontairement NON réalisé (hors périmètre défensif)

| Élément (TSD §5.2)                                                                           | État     |
| -------------------------------------------------------------------------------------------- | -------- |
| GEN-01 vecteurs L3/L4 (UDP/ICMP/SYN/ACK/RST flood, fragmentation, GRE/DTLS)                  | ❌ exclu |
| Amplification/réflexion DNS/NTP/SSDP/CLDAP, Smurf                                            | ❌ exclu |
| GEN-02 vecteurs L7 d'épuisement (Slowloris, RUDY, WebSocket flood, XML bomb, browser botnet) | ❌ exclu |
| Débit non borné / cible hors allowlist                                                       | ❌ exclu |

Ces vecteurs servent à **saturer** un service, pas à mesurer sa résilience de
façon maîtrisée. Le seul vecteur fourni est un générateur HTTP applicatif borné
(GET/POST), plafonné et traçable. Voir [safeguards.md](./safeguards.md).

## Restant possible (légitime, non prioritaire)

- Dashboards Grafana pré-provisionnés sur `/metrics`.
