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

## Synthetic network lab (`lab/`)

The repository ships an **optional, closed research lab** that models UDP
amplification traffic shape for defensive measurement (no source-IP spoofing, no
real reflector protocol, hard caps). It is separate from the control plane.

- **Acceptable use**: only inside the provided isolated lab — an `internal`
  Docker network with no published host ports, on an RFC1918 subnet you own.
- **Prohibited use**: attaching it, or running its components, against any
  production or public network, or removing its isolation, caps or no-spoofing
  properties.

See [docs/network-lab.md](./docs/network-lab.md).

## Reporting

Report any abuse or vulnerability through the WEDOS internal security channel.
