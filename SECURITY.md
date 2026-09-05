# Security and usage policy

This tool is reserved for **authorized internal use**: resilience testing of
infrastructure the organization owns or holds a written authorization to test.

## Acceptable use

- Targets listed in the `ALLOWED_TARGETS` allowlist.
- Campaigns approved by a role distinct from the author (Security Officer).
- Rate and duration within the `HARD_CAPS` limits.

## Prohibited use

- Any campaign against a third-party system without written authorization.
- Any bypass of the safeguards (allowlist, caps, approval).
- Any extension adding volumetric or exhaustion vectors intended to saturate a
  third-party service.

## Reporting

Report any abuse or vulnerability through the WEDOS internal security channel.
