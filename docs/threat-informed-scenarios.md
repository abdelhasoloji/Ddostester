# Threat-informed scenarios

Some templates in the catalogue are derived from public reporting on real L7
traffic patterns. They are **bounded, authorized HTTP scenarios**, not emulations:
the payload is a normal HTTP request, the rate is capped, the target must be on
the allowlist, and the run still goes through approval, the kill switch and the
independent probe.

Each such template carries a `threat` block:

| Field | Meaning |
| --- | --- |
| `technique` | the pattern being approximated |
| `source` / `reference` | public reporting, not internal intelligence |
| `measures` | the resilience question the run answers |
| `notReproduced` | the harmful mechanism deliberately left out |

## What exists

The catalogue carries 20 threat-informed templates (`GET /api/playbooks`, or the
**Threat-informed** category in the UI). Examples, including the cache-busted L7
pattern added for the hacktivist HTTP-flood case:

| Template | Pattern | What it measures |
| --- | --- | --- |
| `threat-l7-signature-evasion` | randomized L7 flood over several endpoints with rotating User-Agent | WAF / rate-limit efficacy against fingerprint and endpoint spread |
| `threat-l7-cache-busted-flood` | the same, plus a unique query token per request and a POST burst on the login/session path | origin exposure and rate-limit behaviour when the edge cache is bypassed |
| `threat-http2-burst` | sustained h2 request rate | the HTTP/2 request path |
| `threat-cache-key-stress` | cache-key pressure | cache policy under unique URLs |

## What none of them reproduce

- **No spoofing.** The generator has no raw-socket path; every request comes from
  the operator's own egress address. At L7 this is not a fidelity loss — the
  traffic that matters is the request, not the claimed source.
- **No botnet scale.** A documented actor may use hundreds or thousands of hosts.
  Two sites are two egresses. Per [boundary and lab](boundary-and-lab.md), pods
  behind one public egress do not establish distributed source diversity, and a
  template cannot manufacture it.
- **No attribution.** A template name says which pattern a scenario approximates.
  It asserts nothing about who will attack, and a PASS on it is not a claim about
  any actor's real capability.
- **No protocol abuse.** Rapid Reset, continuation floods and reflected traffic are
  explicitly out of scope; the templates that mention them state the approximation.

## Running one defensively

1. Put the **staging or authorized** address on the allowlist; nothing else is
   reachable — `validateConfig` rejects any other host at execution.
2. Pick the template from the **Threat-informed** category. It declares required
   target features (`waf`, `cache`, `h2`); a target that lacks them shows N/A
   rather than being scored as if it had them.
3. Keep the probe on a **separate resource and connection pool** so availability is
   measured independently of the flood.
4. Read the outcome as: WAF / rate-limit behaviour, origin exposure, availability
   under load, and whether the kill switch held. Not as a certification.
5. Preserve the run: a calibrated or reduced exposure stays inconclusive for the
   originally requested conditions.
