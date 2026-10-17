# ZeroBS full-suite acceptance — 17 October 2026

Outcome: **NOT VALIDATED**. All 12 original steps were attempted once, with their original configured durations (eight × 120 s, four × 180 s), profiles and caps. Four runs completed normally; four were stopped by the existing availability kill switch; four k6 executions failed on the process-output byte budget and retained no normal run record. No retry, raised cap or forced continuation past a guard was used.

## Environment and method

Fresh isolated MemoryStore application on the lab VPS, using the current UI working tree and unchanged backend behavior. Build labels identify b688e27/build 477, a documentation commit plus uncommitted UI work; this is not an immutable release identity. Two temporary fixture identities (engineer and CISO) exercised normal template instantiation, distinct-author approval and suite execution APIs. Production single-admin confirmation was not exercised. The initial development-mode UI attempt created 12 drafts but self-approval skipped them; this attempt is retained separately. The actual authenticated suite is `07fc0a22-46d2-4889-86fc-53088b76fbe7`.

Target: private Kubernetes service `http://10.98.215.52:8080/`. Existing builtin, Vegeta and k6 engines were used; the external binaries were copied from the installed central host, with no global installation/configuration changes. Fleet and the synthetic UDP/TCP companion were not used. The target is HTTP, not HTTPS/h2: no HTTP/2 protocol resilience is demonstrated. The probe shares the generator host; independent ingress/origin instrumentation was absent. The current three persistent IoT Pods were not recreated or used.

Configured duration total was 1,680 s. The sequence ended after approximately 842 s because the existing safety controls and process failures ended eight steps early. The four normally completed load windows each ran their original 120 s. This is not a successful 28-minute load qualification.

## Per-step observations

| #   | Scenario                                     | Configured duration | Execution outcome                    | Recorded rate |
| --- | -------------------------------------------- | ------------------: | ------------------------------------ | ------------: |
| 1   | SlowLoris (DRS3)                             |               120 s | COMPLETED                            |          0.83 |
| 2   | GET-Flood (DRS3)                             |               120 s | COMPLETED                            |        395.49 |
| 3   | GET-Random-Flood (DRS3)                      |               120 s | COMPLETED                            |        284.20 |
| 4   | GET /VALID_RANDOM (DRS4)                     |               120 s | COMPLETED                            |        432.03 |
| 5   | POST-Flood (DRS4)                            |               120 s | KILLED_AUTO                          |        380.53 |
| 6   | HTTP/2 GET-Flood (DRS4)                      |               120 s | TECHNICAL ERROR — output byte budget |       unknown |
| 7   | HTTP/2 Rapid Reset — bounded (DRS4)          |               120 s | TECHNICAL ERROR — output byte budget |       unknown |
| 8   | HTTP/2 Continuation — header pressure (DRS4) |               120 s | TECHNICAL ERROR — output byte budget |       unknown |
| 9   | Login/account POST-Flood (DRS5)              |               180 s | KILLED_AUTO                          |        475.51 |
| 10  | L7 MultiVector (DRS5)                        |               180 s | KILLED_AUTO                          |        170.50 |
| 11  | THOR / PulseWave — synchronized (DRS5)       |               180 s | TECHNICAL ERROR — output byte budget |       unknown |
| 12  | MultiTarget / carpet-bombing (DRS5)          |               180 s | KILLED_AUTO                          |        186.08 |

GET-Flood retained 47,977 successful responses, zero failures and 395.49 req/s against a configured 400 req/s. Other completed GET profiles showed under-delivery and availability impact. SlowLoris measurements concern slow connections, not HTTP throughput. Four interrupted runs were stopped after the probe remained unavailable long enough to trigger the existing guard. Calibration reduced the graded rate for later multivector scenarios; original intent and actual measurements are retained separately.

## Confirmed product defects

1. k6 output exceeds the existing 1 MiB combined process capture budget (`agents/proc.ts`, `IO_LIMITS.processOutputBytes`). The supervisor stops the process. `agents/k6.ts` reads its summary only after this awaited process succeeds, so these exceptions leave no normal run evidence. This finding does not establish which stream/content exhausted the budget; do not simply raise the budget.
2. Failed engine attempts return campaigns to APPROVED with a diagnostic reference. During sequencing, Theater can still show them as queued; after the sequence ends, its default view returns to “No run in flight”. The underlying audit contains four explicit errors.
3. The consolidated report shows all 12 rows, including four inconclusive rows, but their detail says “No run data; legitimate availability dipped to 0%” and displays zero delivered rate. Missing measurements cannot establish those zero values.
4. In development mode the suite approval UI reports approval even when all authored steps were skipped. The authenticated two-identity run proved approval of all 12; the development-mode false-positive remains a separate finding.

The report is retained exactly as generated, not corrected. Its WRS and reference-level labels are not a measured DRS score, and its mechanism labels do not prove edge filtering or tarpitting without ingress/origin evidence. No physical DRS qualification or certification is established.

## Verification and cleanup

Theater was visually checked during SlowLoris, Vegeta GET, GET path scenarios, recovery and later multivector execution. It showed the live queue, measurements, kill control and recovery gate. The consolidated report was opened with the fixture read session and archived as HTML/AX/screenshot. No production browser restriction was bypassed.

After the sequence the target returned HTTP 200. The three IoT Pod UIDs and readiness match the prior checkpoint. Temporary application and SSH tunnel were stopped; the normal lab runner remains active. Production data, admin and deployed build 476 were untouched. Credentials and tokens are excluded from these artifacts.

See `created.json`, `approved.json`, `runs.json`, `campaigns.json`, `audit.json`, `suite.json`, `report.html` and screenshots.
