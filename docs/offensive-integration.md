# Load generation integration (“offensive”)

How to address the traffic-generation part of the TSD **responsibly**, keeping
ShieldTest as the control plane and delegating load emission to a dedicated tool
operated by the team.

## Principle: separate govern/measure from generate

ShieldTest provides authorization, allowlist, caps, kill switch, probe, WRS,
audit, compliance. It **delegates** load production to an **agent** through an
interface (`AttackAgent`). No attack vector is coded in this repository:

Selection: `AGENT=builtin|k6|vegeta|locust` (default `builtin`). All produce a
**bounded HTTP load**; the last three delegate to an external tool installed and
operated by the team.

| Agent          | Tool                                        | Rate-capped                     | Multi-phase             | Parsed output       |
| -------------- | ------------------------------------------- | ------------------------------- | ----------------------- | ------------------- |
| `builtin-http` | built-in                                    | yes (sliding window)            | yes (phases)            | internal            |
| `k6`           | [k6](https://k6.io)                         | yes (arrival-rate)              | yes (ramping)           | `--summary-export`  |
| `vegeta`       | [Vegeta](https://github.com/tsenart/vegeta) | yes (`-rate`)                   | yes (sequential phases) | `report -type=json` |
| `locust`       | [Locust](https://locust.io)                 | approximate (`constant_pacing`) | no (→ k6/vegeta)        | `--csv`             |

Each adapter applies `validateConfig` (allowlist + caps), honours the kill
switch, and returns **503** with a clear message if the external tool is absent.

### Tools deliberately not scaffolded

- **wrk / hey**: designed for **maximum** throughput (no simple rate cap) —
  contrary to ShieldTest's bounded model. They can be integrated via the
  `AttackAgent` contract by imposing a cap, but are not provided for that reason.

> JMeter and Gatling are heavy (JVM): reserve them for cases where the team
> already uses them. k6 or Vegeta remain recommended for most tests.

## Governance prerequisites (before any campaign)

1. **Written internal authorization** + signed scope (Security Officer), dated window.
2. **Isolated environment** (UAT mirror), never production nor a third party.
3. **Upstream coordination**: hosting provider / network operator, and for
   volumetric traffic, transit/upstream, to avoid an incident or triggering protections.
4. **Blast radius**: dedicated test IPs, tagged traffic (`X-WEDOS-TEST`), rollback plan.

These prerequisites are the condition of legitimacy — independent of the tool.

## The agent contract

```ts
interface AttackAgent {
  readonly name: string;
  available(): Promise<boolean>;
  run(config, allowedHosts, killSignal?, onProgress?): Promise<LoadTestResult>;
}
```

An agent **must**: validate the config (allowlist + caps via `validateConfig`),
honour the `killSignal`, and produce only the described load. The agent thus
automatically inherits the control plane's safeguards.

## Wiring k6

```bash
# 1) install k6 on the host (official k6 docs)
# 2) enable the adapter
AGENT=k6 bash deploy/setup.sh      # or AGENT=k6 in the service environment
```

`GET /health` returns the active agent (`"agent":"k6"`). If the k6 binary is
absent, execution returns **503** with an explicit message (no crash).

## L3/L4 volumetric load

Out of the application scope: to be run by the **network team** on an isolated
bench (lab packet generators: TRex, MoonGen, pktgen), or via a **contracted DDoS
simulation provider**. ShieldTest can orchestrate/measure/score the result, but
**does not provide** these generators. A new agent can be added by implementing
`AttackAgent` around the chosen tool — the volumetric generator then comes from
that external tool, never from this repository.

## What is not provided

No flood/amplification/exhaustion vector. See [safeguards.md](./safeguards.md)
and [security-review.md](./security-review.md).
