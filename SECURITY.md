# Security and usage policy

This tool is reserved for **authorized internal use**: resilience testing of
infrastructure the organization owns or holds a written authorization to test.

## Acceptable use

- Targets listed in the `ALLOWED_TARGETS` allowlist.
- Team/profile workflows require distinct author, approver and executor.
- In single mode, the unique owner explicitly confirms each launch.
- Rate and duration within the `HARD_CAPS` limits.

## Prohibited use

- Any campaign against a third-party system without written authorization.
- Any bypass of the safeguards (allowlist, caps, approval).
- Any extension adding volumetric or exhaustion vectors intended to saturate a
  third-party service.

## Synthetic network lab (separate repository)

The **closed research lab** that models UDP amplification traffic shape for
defensive measurement (no source-IP spoofing, no real reflector protocol, hard
caps, isolated `internal` network) lives in its own repository —
[`abdelhasoloji/shieldtest-lab`](https://github.com/abdelhasoloji/shieldtest-lab).
It is **not part of this control plane at all**: this repository performs only
bounded, allowlisted HTTP and contains no amplification/spoofing/UDP code.

- **Acceptable use** (in that repo): only inside the provided isolated lab — an
  `internal` Docker network with no published host ports, on an RFC1918 subnet
  you own.
- **Prohibited use**: attaching it, or running its components, against any
  production or public network, or removing its isolation, caps or no-spoofing
  properties.

See [docs/boundary-and-lab.md](./docs/boundary-and-lab.md).

## Reporting

Report any abuse or vulnerability through the WEDOS internal security channel.

## Unique administrator with managed profiles

The administrator has all application capabilities. USER_MODE=single selects the default
personal workflow: the owner explicitly confirms every launch; team mode retains separation
of duties. The persisted owner defaults to abdelha@wedos; other profiles remain manageable
and retain their status/password. A second admin and owner demotion/deletion are forbidden.
Run the versioned migration explicitly before the first new-version startup; ordinary startup
only verifies policy. Capabilities are returned by /api/auth/me and enforced by the API.
Allowlist, immutable caps, kill switch and audit remain mandatory. No campaign is required
for account/deployment validation. See [migration and operation](docs/single-user.md).
