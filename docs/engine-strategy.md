# Load-engine strategy — keep/drop decision & usage plan (E8)

> Historical assessment, 2026-09-13. The R01–R10 roadmap currently retains all six
> adapters and validates them explicitly. The installed/usage figures below are
> historical observations, not current availability or operational conformance.
> Gatling 3.16.0 now has an offline Maven-bundle path through `GATLING_HOME`;
> `GATLING_BIN` retains the legacy launcher path. See
> [the current execution evidence](roadmap-execution-2026-10-13.md) and
> [the bounded native recipe](../scripts/conformance/README.md).

Assessment of every load-generator adapter in `backend/src/agents/`, a keep/drop
decision, and a plan to maximise out-of-process engine usage. Sourced to
filenames; usage figures from the live VPS1 database (2026-09-13).

## 1. The six adapters (sourced)

Capabilities are the `readonly` flags on each adapter class; the registry is
`backend/src/agents/index.ts` (`FACTORIES`).

| Engine                         | multiPhase | flow | correlation | Bin (`*_BIN`) |       Installed on VPS1        | Campaigns ever run |
| ------------------------------ | :--------: | :--: | :---------: | ------------- | :----------------------------: | -----------------: |
| **builtin** (`builtin.ts`)     |     ✅     |  ✅  |     ✅      | in-process    |             always             |             **32** |
| **vegeta** (`vegeta.ts:232`)   |     ✅     |  ✗   |      ✗      | `vegeta`      |   ✅ `/usr/local/bin/vegeta`   |              **9** |
| **k6** (`k6.ts:133`)           |     ✅     |  ✅  |      ✗      | `k6`          |     ✅ `/usr/local/bin/k6`     |              **9** |
| **locust** (`locust.ts:115`)   |     ✗      |  ✅  |      ✗      | `locust`      |   ✅ `/usr/local/bin/locust`   |              **0** |
| **jmeter** (`jmeter.ts:168`)   |     ✗      |  ✅  |      ✗      | `jmeter`      |   ✅ `/usr/local/bin/jmeter`   |              **0** |
| **gatling** (`gatling.ts:117`) |     ✗      |  ✅  |      ✗      | `gatling.sh`  | ✅ `/usr/local/bin/gatling.sh` |              **0** |

All six are **installed and reachable** — surfaced with live availability via
`describeAgents()` (`GET /api/agents`, `app.ts:1013`) and selected through the
new-campaign wizard's template recommendation
(`frontend/src/new-campaign-wizard.tsx:70-88`, `recommendTemplate` ranked by
installed engines). High-rate simple floods now auto-route off the built-in
~150 rps ceiling to vegeta/k6 (`backend/src/modules/campaigns/engine-route.ts`,
`BUILTIN_RPS_CEILING`, `app.ts` runCampaign).

**The decisive fact:** `locust`, `jmeter`, and `gatling` have **never run a
single campaign**, and none of them offers a capability the kept three lack —
each is _flow-only, not multi-phase_, which `k6` (flow **and** multi-phase, plus
real HTTP/2) strictly dominates. They cost a JVM (jmeter, gatling) or a Python
runtime (locust) on the host, three adapter files, and three rows of UI/API
surface, for zero use and zero unique coverage.

## 2. Decision

| Engine      | Decision                   | Rationale                                                                                                                            |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **builtin** | **KEEP — core**            | Only correlation-capable engine; the default (`AGENT`), the always-available fallback, the live-progress/probe source.               |
| **vegeta**  | **KEEP — flood workhorse** | Delivers the real configured rate (proven: 400 rps, 48 000 req, 0 loss); the auto-route target for simple GET/POST floods.           |
| **k6**      | **KEEP — flow + HTTP/2**   | Flow **and** multi-phase; genuine HTTP/2 (unlike undici built-in); the auto-route target for flows. Dominates locust/jmeter/gatling. |
| **locust**  | **DROP** (or flag)         | 0 usage, flow-only, redundant with k6, Python runtime.                                                                               |
| **jmeter**  | **DROP** (or flag)         | 0 usage, flow-only, redundant with k6, heavy JVM.                                                                                    |
| **gatling** | **DROP** (or flag)         | 0 usage, flow-only, heavy JVM/Scala.                                                                                                 |

**Recommendation: retire the "core three" strategy — keep `builtin` + `vegeta` +
`k6`, retire `locust` + `jmeter` + `gatling`.** These three cover the whole
capability matrix (correlation, high-rate flood, flow/HTTP-2) with the lightest
footprint.

Two ways to execute, user's call — **left as a recommendation, not done in code**,
because it's a product decision and touches the registry, three files, their
tests, `rbac`/UI engine lists, and VPS provisioning:

- **Hard drop:** remove the three from `FACTORIES` (`agents/index.ts`), delete
  `locust.ts` / `jmeter.ts` / `gatling.ts` + their tests, and drop the binaries
  from VPS provisioning. Smallest surface, clearest product.
- **Soft (keep-behind-a-flag):** add a `LOAD_AGENTS` allowlist env (default
  `builtin,vegeta,k6`) that `FACTORIES`/`describeAgents` filter through, so the
  three stay in-tree but off every surface unless explicitly enabled. Preserves
  the option at near-zero cost.

Prefer the **hard drop** unless there is a concrete reason to keep JVM/Python
generators around (e.g. a customer expects JMeter output).

## 3. Maximise out-of-process usage

Built-in silently under-delivers above ~150 rps (see the run report /
`engine-route.ts`). The goal: any run that needs real rate or real HTTP/2 lands
on k6/vegeta, and the operator can _see_ it.

1. **Auto-route (done):** simple floods > ceiling → vegeta; flows > ceiling →
   k6; correlation/endpoint-mix/dataset/assertion → built-in
   (`engine-route.ts`). Extend the ceiling check to also prefer k6 for any
   HTTP/2-labelled template (built-in/undici is HTTP/1.1 only).
2. **Make the route visible:** the `run.autoroute` log already fires; surface it
   in the campaign review and Run Theater ("running on **vegeta** — auto-routed
   from built-in, 400 > 150 rps ceiling") and stamp it on the run/report so an
   A+ from a real 400 rps reads differently from a built-in ~140 rps A+.
3. **Template defaults:** set `recommendedAgent` on high-rate templates to k6/
   vegeta so the wizard proposes the right engine up front
   (`new-campaign-wizard.tsx:142`), instead of relying only on the runtime route.
4. **Surface capabilities in the picker:** show each engine's
   multiPhase/flow/correlation + availability (already in `describeAgents`) next
   to the choice, so an operator understands why an engine is (un)recommended.
5. **Fidelity guardrail:** flag any built-in run whose `actualRps` fell far short
   of `maxRps` as "under-delivered — re-run on an out-of-process engine for a
   true measurement" (the report's central finding).

## 4. Net effect

Retiring the three unused adapters removes ~three files + their tests, two heavy
host runtimes, and three dead UI/API rows, with **zero capability loss** — the
kept `builtin`/`vegeta`/`k6` trio spans the full matrix. Combined with the
auto-route made visible, every high-rate run is measured by an engine that can
actually deliver it, and the operator always knows which engine produced a score.
