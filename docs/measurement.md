# Measurement and scoring

## DRS evidence

The [versioned DRS engine](drs-engine.md) is the authoritative scoring contract. A plan names generator, protection-entry, user and origin instrumentation. User probes use separate resources and connections. Requested load, emitted load and actually received load are different measurements.

Store baseline stability, functional transactions, latency distributions, outage intervals, detection/mitigation/recovery timestamps, manual interventions, telemetry gaps, calibration, source addresses and represented dimensions. HTTP 200 alone cannot prove a functioning login, API journey or usable challenge. Missing latency is null, never zero.

Validity is VALID/INVALID/INCONCLUSIVE; outcome is PASS/FAIL/NOT_EVALUATED. Saturation, missing received load, gaps or incomplete recovery do not establish protection success. Imported evidence is labelled collector-import; archive integrity is not an assertion that the server witnessed its physical acquisition.

The full level denominator is retained. Score is `level - 1 + successful_vectors / total_vectors`. Threshold equality is MET under `strict-conservative/1`. Diagnostics after terminal level remain diagnostics; reruns preserve valid historical failures.

## WRS diagnostics

`backend/src/modules/wrs/` retains the existing weighted 0–100 resilience diagnostic. It is not the DRS level score, a certification or an average of family-level DRS values. Legacy protection providers may fall back to estimates on failure; their source/provenance must remain visible and cannot replace independent DRS evidence.

## Synthetic interpretation

One Gbit/s actually received remains one Gbit/s regardless of a declared synthetic factor. Virtual clients, private Pod IPs behind NAT and one public egress must be reported separately. Injection after a protection does not evaluate that bypassed protection. Existing run/bench attachments are diagnostic and never automatically PASS a DRS vector.

See [current instrumentation gaps](current-setup.md), [comparability](run-comparison.md) and [companion bench boundary](boundary-and-lab.md).
