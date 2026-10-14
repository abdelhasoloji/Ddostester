# Fleet management

The Fleet page manages a paginated multisite inventory, agent enrollment, fresh status, missions and evidence. Run Theater shows campaign graphs and a compact active/assigned count when Fleet is used; detailed agent operations remain in Fleet.

## Inventory contract

The registry accepts at most 5,000 devices and 100 sites, with pages of 100. Agent identity is globally unique. An RFC1918 address must be unique within its site; separate sites may use overlapping private ranges. Name, profile, group and notes are metadata. Sensor/camera/gateway labels do not establish a real device or POST business workflow.

Changing agent identity, site or IP revokes enrollment. Campaign selection persists exact IDs across pages; no automatic replacement of unavailable agents. Receipt site identity is preserved at launch. Admin manages inventory; other capabilities determine read and campaign access.

## Identity and status

Enrollment creates an agent-specific secret, separate from the browser session and the proxy's mTLS identity. The secret is shown/downloaded once; re-enrollment rotates it. Application keys expire after seven days; current client certificates were issued for fourteen days. Automatic renewal is not implemented. Keep downloaded enrollment/state files and TLS private keys outside Git, mode 0600.

Status distinguishes unenrolled, awaiting, online, offline, expired and revoked. Online requires a fresh authenticated heartbeat (under 30 seconds); a failed UI read clears the confident status. Declared private IP does not prove public routing or absence of NAT. Heartbeat sequence state prevents replay across restart.

The downloadable heartbeat-only client supports inventory checks, not campaign execution. The three deployed IoT Pods use persistent `fleet-mission-agent/v1` workers that receive bounded HTTP missions and report progress/receipts. See [mission contract](fleet-missions.md).

## Current scope

Three workers on `31.31.74.187`, site `vps-lab`, use private IPs `10.247.0.71`–`.73`; shared public egress is one IP. Physical execution caps are 3 agents, 15 requests/s total, concurrency 6, 10–60 seconds. Kubernetes lifecycle and certificate renewal remain operator actions. Inventory capacity is not proof of 5,000 connected workers or simultaneous execution.

[Current setup](current-setup.md) gives the observed topology, quotas and source identities. [Infrastructure handoff](infrastructure-handoff.md) describes admission dependencies; Kusa and team sites are not yet connected.
