# Roadmap & implementation status

Single source of truth for **what is built vs. planned**. Keep it in sync with
the code in the same PR that changes behaviour — an external brief or plan should
be reconciled against this file, not the other way round.

> Scope is fixed: this control plane implements **no attack vector** and never
> weakens a safeguard (allowlist, HARD_CAPS, attestation, approval workflow,
> 3-level kill switch, `X-WEDOS-TEST` tagging, audit). Every item below is
> delivered **through** those safeguards. A **separate, closed synthetic network
> lab** (no spoofing / isolated / hard-capped) for defensive measurement lives in
> its own repository —
> [`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab) —
> and is not part of the control plane. See [security-and-governance.md](./security-and-governance.md) and
> [boundary-and-lab.md](./boundary-and-lab.md).

Legend: ✅ done · 🟡 partial · ⬜ planned · 🔒 needs external infra (lab / cluster)

## Improvement plan — October 2026

The detailed, prioritised implementation plan is
[Roadmap d’amélioration 2026](./improvement-roadmap-2026-10.md). It uses the
verified build 451 as its baseline and defines lots R01–R10, validation gates,
resources and the next sprint. Existing delivery statuses below remain historical
context: an implemented connector does not certify an external integration, and
a hash-chained audit is not yet an independently witnessed or signed proof.

## R01–R10 execution evidence — 13 October 2026

The [execution journal](./roadmap-execution-2026-10-13.md) distinguishes source
implementation, fixtures, real PostgreSQL tests, private-lab recipes and remaining
external validation. Production remains build 451; the Linux HTTP lab runs the
identified source-06 image with the v2 probe. Its API/UI release and authenticated
read contracts are checked; full fleet/browser recipes remain pending. Later source
changes are not implicitly deployed.

| Lot | Evidence acquired                                                                                                                                                                                                                                              | Remaining proof or implementation                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| R01 | Preserved initial checkout, deterministic source snapshots, manifests and identified lab images                                                                                                                                                                | Reviewable commits/PRs and CI promotion of the complete roadmap release                                  |
| R02 | Mandatory PostgreSQL suites, transactional audit/revocation, owner recovery on a test database                                                                                                                                                                 | Complete account-management browser corpus and production promotion of the one-hour write-session policy |
| R03 | Encrypted scheduled backup, off-host replica, isolated restore and independent audit witness                                                                                                                                                                   | Full retention/key-rotation and operational failure/alert corpus                                         |
| R04 | Independent probe, shared vantage, bounded I/O and resource diagnostics; recent-window monitor validated on Node 22                                                                                                                                            | Mac parity and complete baseline/recovery quality corpus on source-06                                    |
| R05 | Mac kind/Calico and isolated Linux k3d/K3s, immutable images, restricted identities, fresh-connection policy refusals, private Prometheus/Grafana with authenticated provisioning, Prometheus/Grafana persistence and live collection-alert trigger/resolution | Remaining network/operational corpus, full reproducibility/parity and physically dedicated VPS           |
| R06 | Versioned bounded assignments, autonomous agent, mTLS and leaf revocation tests                                                                                                                                                                                | Cluster certificate rotation/revocation recipe                                                           |
| R07 | Durable claims/fencing/no replay, target-confirmed manual stop, coordinator outage and control crash                                                                                                                                                           | Effective established-connection partition, agent loss/rejoin and live limit/target revocation corpus    |
| R08 | Histogram fusion, private target receipts, durable crash-evidence API/browser download, startup diagnostics, conservative comparison contract and native combined Vegeta quantiles                                                                             | Interrupted-report completeness, fleet dashboards and real homogeneous comparison corpus                 |
| R09 | Server capabilities, governed proposals/budgets, builtin conformance, bounded native k6/Vegeta recipes and deterministic builtin sensor form/exports                                                                                                           | Complete external-engine/Linux conformance, IoT fleet support, browser corpus and Kusa provider contract |
| R10 | Linux bounded recipes, encrypted lab backup with verified Mac replica, transactional isolated restore with single-mode authentication/audit-chain check and infrastructure handoff draft                                                                       | Remaining operations corpus, dedicated-host parity and team validation of CIDR/SNAT/public IPs           |

No row above establishes an entire gate by itself. G4 remains unvalidated. A shared
host with private container isolation is not the physically dedicated VPS requested
for the final infrastructure recipe. Missing external interfaces and team decisions
are recorded as dependencies rather than successful integrations. The unrelated
synthetic network-vector lab below remains a separate repository.

## Network lab (defensive measurement, separate repository)

The closed synthetic lab reproduces the _traffic shape_ of UDP amplification for
detection and mitigation study. It is a measurement model, not an attack tool,
and keeps hard, non-negotiable safety properties (no source-IP spoofing, no real
reflector, `internal` network, no host ports, hard caps). It now lives in its own
repository —
[`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab) —
so the boundary is **structural**: this control plane contains no amplification
code at all. The two connect only through a read-only, governed verdict contract
(see [boundary-and-lab.md](./boundary-and-lab.md)). See
[boundary-and-lab.md](./boundary-and-lab.md).

## Horizon 1 — reliability of the measurement

| Epic                                        | Status | Where                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Measured WRS**                        | ✅     | `modules/protection/{provider,types}.ts`, `modules/wrs/scoring.ts`, `app.ts` (`/api/protection/lab-metrics`) | Push (webhook) **and** pull (metrics) connectors + a lab-only `mock`, both labelled by provenance; timeout + best-effort fallback; scoring stays a pure function. Formula weights are frozen. A **lab-scrubber adapter** (`GET /api/protection/lab-metrics`, source `wedos-lab-scrubber`) surfaces the latest class-C lab verdict's detection/mitigation timing in the pull-connector shape — point `PROTECTION_METRICS_URL` at it (404 → clean fall-back to the estimate). Remaining: the **real WEDOS scrubber** metric endpoint (a governed class-C dispatch that engages the scrubber is still needed to feed measured TTD/TTM through the flow). |
| **B1 — Target telemetry in correlation**    | 🟡 🔒  | `modules/target-telemetry/`, `.../campaigns/runner.ts`, `modules/reports/report.ts`                          | **Pull** connector (no inbound surface): during a run the control plane GETs a lab metrics endpoint once a second (CPU/conntrack/NIC), correlated to the run timeline and summarised on the report; unit-tested with a mock. Remaining: wire the real lab metrics endpoint (field names/units) and optional time-series persistence.                                                                                                                                                                                                                                                                                                                  |
| **B2 — Automatic baseline**                 | ✅     | `modules/campaigns/baseline.ts`, `.../runner.ts`, `modules/reports/report.ts`                                | Each run captures a pre-ramp **legitimate-traffic-only** snapshot (nominal availability + latency) and reports the **under-load deltas** on the run detail and HTML report. WRS history + cross-run regression comparison already shipped (P0-2).                                                                                                                                                                                                                                                                                                                                                                                                     |
| **C — SLO gate in CI**                      | 🟡 🔒  | `modules/campaigns/slogate.ts`, `cli/slogate.ts`, `.github/workflows/slo-gate.yml`                           | Gate logic (SLO thresholds + WRS-regression tolerance band) is built and unit-tested; the CLI + workflow run a bounded campaign through the allowlist/caps/approval path with an absolute timeout. **Manual-dispatch only** until a lab target is reachable from CI (uncomment the schedule then).                                                                                                                                                                                                                                                                                                                                                    |
| **D — Signed proof & tamper-evident audit** | ✅     | `modules/audit/integrity.ts`, `store/{memory,postgres}.ts`, `app.ts`                                         | Hash-chained audit log (`prevHash`/`hash`), `GET /api/audit/verify` and `/api/audit/export`, verified end to end (memory + postgres). See [security-and-governance.md](./security-and-governance.md). Optional next: a **signature** over the export head (key management) beyond tamper-evidence.                                                                                                                                                                                                                                                                                                                                                    |
| **E — Drift alerting**                      | ✅     | `modules/notify/events.ts`, `.../campaigns/baseline.ts`                                                      | WRS-regression and kill alerts (Slack/webhook, opt-in) plus a distinct **`baseline.drift`** alert when a target's nominal baseline degrades between recurring runs (availability −≥5 pts, or p95 +≥25% and ≥20 ms).                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Operational hardening (delivered)

Reliability, faithfulness and observability of the measurement itself — the
foundation Horizons 2/3 build on.

| Item                                                     | Status | Where                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run always settles (hard backstop)**                   | ✅     | `engine/loadTest.ts`, `.../probe/probe.ts`, `.../campaigns/runner.ts`                                          | A run can never hang past its cap. Against a tarpitting target Node's `fetch` (undici) can strand every worker in `await fetch()` on an exhausted keep-alive pool (neither the per-request timeout nor the kill signal cancels a queued request). Two guards: the probe has a wall-clock deadline (cap + grace) and the engine races `Promise.all(workers)` against a hard backstop (cap + 15 s), settling with the metrics gathered so far and flagging `LoadTestResult.hardStopped`. Verified live against a real target that tarpitted a wave step from 617 s+ down to a clean completion. Tests: `probe-deadline`, `loadTest` hard-backstop.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Faithful reports under throttling/blocking**           | ✅     | `modules/reports/{report,compliance}.ts`                                                                       | When the target rate-limits or tarpits a flood, reports now show **configured → effective** load (not only the throttled achieved rate), split failures into edge-rejected (4xx/5xx) vs no-response (timed out / rate-limited), and add a plain-language callout so a high score beside "0 successful" is explained as the protection working — not left as a bare contradiction. Tests: `report`, `compliance`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Template applicability (`requires` → N/A) in reports** | ✅     | `modules/reports/report.ts`, `modules/playbooks/{playbooks,suites}.ts`, `modules/campaigns/model.ts`, `app.ts` | A template declares the target features its line needs (`requires`: h2/waf/cache/dynamic). At instantiation a compact recon posture snapshot (`{h2,waf,cache,dynamic}`) is captured and copied onto each campaign; the run report and the suite "Applicability caveats" section then mark any requirement the target lacks as **N/A** (a benign result there is not resistance) — the same mapping the sweep (`scripts/template-matrix.mjs`) uses. Extends the template-card `needs <feature>` badge (already shipped) into the report itself. Persisted in the campaign's `data` jsonb (no migration). Tests: `report`, `suites`, `playbooks`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Runtime observability (`/metrics` + logs)**            | ✅     | `modules/metrics/{prometheus,runtime}.ts`, `app.ts`, `routes/read-routes.ts`                                   | `/metrics` now serves live operational metrics (HTTP throughput/latency by route, runs in-flight/completed/duration, `loadtest_hard_stopped_total`, event-loop lag, process health) alongside the business gauges, plus structured `run.start`/`run.settled` pino logs. See [observability.md](./observability.md). A Prometheus/Grafana stack now runs on VPS 2 (scraping the control plane via the existing tunnel), with a provisioned **ShieldTest — Runs & Absorption** Grafana dashboard. The app deep-links into it: Settings → Observability sets a Grafana base URL (a local SSH tunnel or a reverse-proxied route), after which Run Theater shows **Open in Grafana ↗** scoped to the run (`api.ts` `grafanaRunUrl`). Remaining: expose Grafana to the browser by default (Caddy route under mTLS) rather than a per-operator tunnel.                                                                                                                                                                                                                             |
| **Template runtime coverage**                            | ✅     | `test/playbooks-instantiate.test.ts` + live                                                                    | All curated templates instantiate into valid, in-caps campaigns (unit-tested) and were validated end-to-end against the allowlisted target — every step COMPLETED after the backstop fix. Each reproducible line of the DRS P26-20371 L7 playbook is also exposed as its own single-step template (category "DRS L7 lines", ids `cra-l7-*`, derived from the parent so they never drift) so any line can be replayed independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Mature user management**                               | ✅     | `auth/{users,password-policy,guard}.ts`, `modules/users/service.ts`, `store/*`, `app.ts`, `frontend/*`         | Full account lifecycle on top of the existing RBAC: a shared **password policy** (min 12, no common/email-derived passwords) on create/reset/change; **self-service password change** (`POST /api/auth/password`) that rotates the token and revokes other sessions; **admin reset** (`POST /api/users/:email/password`) setting a temporary password; **forced first-login change** (admin-set passwords are temporary — guarded routes return `403 password_change_required` until changed); **soft deactivation** (status active/disabled; disabled accounts can't sign in) protecting the last **active** officer and forbidding self-lockout; **immediate session revocation** via a per-user token version (password change/reset, role change, deactivation and deletion invalidate outstanding tokens at once, not at the 8h exp); **login/last-login tracking** and `auth.login`/`auth.logout`/lockout auditing. UI: forced-change gate, self-service card, and a Users & access admin (status, reset, deactivate, last-login). Next (Epic K): SSO/OIDC, MFA/TOTP. |

## Horizon 2 & 3 — scale (only once the measurement is stable)

| Epic                                                                  | Status | Guard-rail reminder                                                  |
| --------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| F — Distributed agent fleet                                           | ⬜     | Caps enforced **centrally** by the control plane                     |
| G — mTLS control plane ↔ agents                                       | ⬜     | No unauthorised agent                                                |
| H — Durable job queue + resumable runs                                | ⬜     | Kill switch and audit preserved                                      |
| I — Realistic bounded traffic (flows, think-time, endpoint weighting) | 🟡     | Flows / endpoint mix / UA rotation already bounded + tagged          |
| J — Playbook builder UI                                               | 🟡     | Custom playbooks exist; each step still goes through approval + caps |
| K — Multi-tenant / SSO / Vault / HA                                   | ⬜     | RBAC and separation of duties reinforced                             |

## Sequencing

A → B → C, with D and E in parallel; Horizons 2/3 only after the measurement is
trustworthy. Do not scale a fragile measurement.

## Unique administrator and managed profiles

Implemented: administrator has complete capabilities in every workflow; the owner defaults
to abdelha@wedos and is persisted by an explicit versioned migration. Other account statuses
and passwords are preserved. Users & access supports profiles, deactivate/reactivate,
password resets and token revocation; the owner cannot be demoted/deleted/disabled and a
second admin cannot be created. Account mutations and audit use serialized transactions.
The frontend consumes the /api/auth/me capability contract. Personal admin launches require
explicit confirmation; team separation of duties and immutable load caps remain enforced.
See [single-user.md](single-user.md) for migration, release verification and rollback.
Per-device session listings and optional MFA remain future work.

## Application audit corrections — October 2026

Destination/probe validation and redirects, independent probe safety, current
start caps, bounded bodies/process supervision, transactional mutation receipts,
async password budgets, read cookies, verified immutable releases and a runtime
singleton lease are implemented. Distributed leases/shard budgets/agent stop
acknowledgements remain planned for the Kubernetes laboratory. An independent
collector must be configured for audit witness retention before infrastructure
integration. No infrastructure deployment is included in these code changes.

## Execution evidence

[Execution journal October 2026](./roadmap-execution-2026-10-13.md) records the current
implementation, bounded lab recipes and remaining external gates. Distributed
fleet code and local recipes do not certify team-cluster compatibility or public
source IPs.

### Fleet : missions des agents enregistrés

Le parcours de sélection, lancement confirmé, mesures par agent et arrêt utilise
le coordinateur durable existant pour les trois agents du VPS lab. La cible reste
privée et le trafic HTTP GET est borné. Voir [contrat et limites](fleet-missions.md).
La création de pods depuis l'interface, les profils POST et l'intégration Kusa
restent à faire.

Le build 456 ajoute le premier parcours de campagne Fleet intégrée : entrée depuis
Fleet, reconnaissance et URLs de campagne, moteur des trois agents persistants,
Run Theater filtré par campagne, arrêt global avec reçus et rapport commun.
La recette navigateur sur `http://46.28.109.92/` confirme une exécution normale et
un arrêt manuel. Le périmètre reste un GET, 3–15 RPS partagés, 3–6 workers,
10–60 secondes. POST, suites, refonte générale et Kusa attendent une reprise explicite.

Le build 457 livre les lots mesures/rapport et interface du parcours IoT : sélection
de un à trois agents, vue Fleet de préparation et d'affectation, résumé dashboard,
moteur/effectif dans les campagnes, template GET compatible, tableaux de mesures
par agent et comparaison avec des reçus cible importés. La recette navigateur
sur 46.28.109.92 valide deux agents (49 réponses) puis l'arrêt des trois (19 réponses),
avec sonde indépendante et 68 logs cible concordants. Les profils POST, suites
Fleet, collecteur automatique, provisioning, renouvellement et Kusa restent à faire.

### Simplification des campagnes local / Fleet — 14 octobre 2026

Implémenté dans le dépôt : un choix de générateur **Local generator / IoT Fleet** dans le formulaire partagé, moteurs locaux sous options avancées, duplication en brouillon depuis chaque campagne. La duplication conserve cible, sonde, phases exactes et configuration HTTP, mais retire approbations, planification et état d’exécution. Le passage à Fleet demande une revue et remet les options incompatibles à un GET constant borné ; les contrôles client et serveur restent actifs. Les missions historiques restent consultables et arrêtables dans Fleet, sans second formulaire de lancement. Le banc réseau reste une entrée avancée distincte de classe C.

Cette modification ne change ni les plafonds, ni les agents, ni la politique de cibles. Aucune campagne externe lancée pour cette simplification. Déployé le 14 octobre 2026 au build 458 ; snapshot source `6a950544bd734726b7563470d10e5d14577ceb5669a7b3eb6ee8d61e4842b7bc`. Base sauvegardée, comptes et inventaire préservés, version précédente conservée pour retour arrière.

Validation : 1 135 tests backend réussis (30 conditionnels ignorés), 421 tests frontend réussis, typecheck, lint des fichiers concernés et build réussis. Les essais de duplication vérifient les phases, endpoints et données conservés ainsi que la nouvelle attestation.

### Compteur de bots dans Run Theater — 14 octobre 2026

Compteur visuel réservé aux campagnes Fleet : nombre d’agents en état RUNNING sur le total affecté à cette campagne, jauge circulaire et cartes individuelles. États en attente, actifs, terminés, arrêtés, échoués et résultat inconnu distingués. Rafraîchissement toutes les secondes via l’observation déjà utilisée par le tableau ; aucune nouvelle collecte ni modification du trafic. Observation manquante ou indisponible : valeur inconnue, sans faux zéro. Animation discrète désactivée si réduction des mouvements demandée. Les campagnes locales ne montent pas ce composant.

Déployé au **build 459** (snapshot `2ff61016de6c4f200c13268f0cffba307da053122fdb06b86f7f1a93d5f10242`). Validation : 423 tests frontend, 1 135 backend réussis (30 conditionnels ignorés), typecheck/lint/build ; sur VPS 34 tests backend et 54 frontend. Affichage production vérifié via mTLS sur les campagnes historiques à deux bots terminés et trois bots arrêtés, ordinateur et mobile. Aucune campagne créée ou exécutée pour cette livraison. Base sauvegardée, comptes et inventaire préservés, build458 conservé pour retour arrière.

### Choix du générateur depuis les modèles préconfigurés — 14 octobre 2026

Entrée corrigée : les actions de création d’un modèle ou d’une composition ouvrent un choix explicite du générateur. Local conserve la séquence et les moteurs du modèle. Fleet ouvre la reconnaissance de la même cible et un nouveau brouillon GET borné (3 RPS total, 20 secondes, sélection des agents à revoir), sans créer automatiquement la suite ni reprendre sa récurrence. La différence avec le scénario d’origine est indiquée avant le choix ; les suites multiétapes Fleet demeurent hors périmètre. Option visible mais désactivée si Fleet indisponible. Les campagnes existantes ne changent pas de moteur.

Déployé au **build 460**, source26 `89a6621006d361bb471f4645a62d3743dc9a6299474cfa20843b4cddae19c05b`. Tests locaux : 1 135 backend (30 conditionnels ignorés), 424 frontend ; typecheck, lint et build réussis. Tests natifs : 34 backend, 55 frontend. Recette navigateur en lecture seule : choix Local/Fleet pour un modèle et une composition, alternative explicite, transfert de la cible vers la préparation Fleet, annulation sans création. Base sauvegardée, comptes et inventaire préservés, build459 conservé pour rollback. Aucune campagne lancée pour cette correction.

Run Theater simplification (14 October 2026): restore the chart-first presentation, with only a compact campaign-scoped active/assigned bot counter in the run header. Individual bot details remain available in Fleet evidence rather than the live theater. Remove external vendor branding from catalogue, templates, assessment reports and documentation; profile IDs and safety controls remain unchanged.

Delivered as build 462 on 14 October 2026 (source e089410572645d3a08639c905db76e2e95dde61850e80567d38e3bbaaa26a423). Full local verification: typecheck, 1,142 backend tests and 426 frontend tests passed, production build and changed-file lint passed. Native VPS gate: 120 backend and 75 frontend tests passed; API and asset release verification succeeded. Desktop and mobile screenshots were checked with an isolated local campaign fixture; no real campaign executed. Production campaign history remains at 282 records, including 281 archived and the existing pending draft; accounts and Fleet inventory unchanged.

## DRS 3.00.00 evidence engine — 14 October 2026

Implemented: archived official standard (PDF, GFDL license, per-page text), 37 type definitions and 131 per-level vector rows; immutable SHA256 manifest; source values and unresolved conflicts; scoring engine `shieldtester-drs/1`, interpretation `strict-conservative/1`; separate simulation, synthetic-laboratory and measured modes; immutable plan revisions; independent-source evidence contracts; historical attempt archive and integrity chain; level coverage, terminal rules, diagnostic-only later trials; reproducible JSON and HTML reports, including partial/indeterminate results. The legacy WRS remains distinct, with no inferred DRS 4.5 cap or averaged DRS value.

Campaigns now expose a DRS assessment workspace. New DRS drafts include their campaign mode and a draft assessment revision; they must freeze their plan before a physical diagnostic. Simulation runs create virtual events and never call generators. Measured-mode dispatch is disabled until independent physical collectors and capacity are qualified. Reference vectors do not install generators; only bounded Fleet GET approximations remain configurable, without raising existing ceilings. The legacy GET profile ID is accepted only for historical draft compatibility.

Independent low-rate HTTP baseline for planned physical laboratory diagnostics: minimum 300 seconds, bounded extension to 600 seconds if unstable; retain latency distributions and stop before injection on an unhealthy/incomplete baseline. HTTP health alone is explicitly not a functional-journey proof. Generator preparation receives a separate short freshness check, preserving the long baseline. Existing diagnostics can attach their raw run archive; laboratory verdicts can attach actual received counters read-only. Neither attachment passes standard vectors or multiplies received traffic.

The orchestration module has separate bounded generator and independent collector ports, capacity/health checks, stop acknowledgment, recovery observation, cancellation and report finalization. No physical ports for the entire standard are enabled by default. Entry/origin collector endpoints, functional journey collectors and qualified calibration are still required to make measured conclusions; absent data remains unknown, never a protected-service success. The original 3-agent / 15 requests/s / concurrency 6 / 60-second execution ceiling and 5,000-device / 100-site registry ceiling are unchanged. No external campaign or generator deployment is part of this increment.

### Livraison vérifiée — build 463

Déployée le 14 octobre 2026 à partir de la source `bbd4293fb91e57abda167478b44ab7d9ade4f07f39f730d68e98c17c4799ed2e`. Vérifications : typecheck/build/lint, suite globale locale de 1 178 tests backend et 428 tests frontend réussis, puis contrôle final ciblé de 56 tests backend pour les dernières garanties d'isolation ; 44 tests PostgreSQL et restauration chiffrée réussis ; gate native VPS de 164 tests backend et 77 tests frontend réussis. Recette locale visuelle complète, catalogue paginé, mobile sans débordement et rapport HTML vérifiés.

L'API et les assets de production correspondent à la source livrée. Les 11 comptes, l'administrateur unique et les trois appareils sont conservés. Les 282 campagnes existantes sont préservées, dont les 281 archives et le brouillon Fleet précédent. Une nouvelle campagne de validation logicielle `ff87194b-5e50-4b32-b148-4881ba3f83ef` est terminée, sans cible réelle, sans attestation de cible et sans générateur : score de simulation 1, recalculé à l'identique depuis les preuves archivées. Aucun trafic de campagne physique émis. La session de vérification temporaire a été supprimée ; la version précédente reste disponible pour rollback.

Le catalogue vérifié contient 37 définitions de types et 131 lignes par niveau, avec 140 anomalies ou choix d'interprétation tracés. Les ambiguïtés non résolues restent visibles et peuvent empêcher un score exploitable. Les collecteurs d'entrée/origine, les parcours fonctionnels et la capacité réelle restent à qualifier/raccorder ; le mode mesuré ne prétend pas qu'ils sont présents. Le reste de la roadmap générale n'a pas été repris.
