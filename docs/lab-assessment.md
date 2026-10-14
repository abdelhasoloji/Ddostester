# Laboratory capabilities and limits

Two complementary laboratories exist. The HTTP Kubernetes Fleet in this repository validates agent lifecycle, governed missions, shared budgets, stop acknowledgments, target receipts and independent HTTP observation. The companion synthetic bench validates detection/filtering and traffic-shape measurement inside a confined network. They share evidence/reporting concepts, not arbitrary traffic dispatch.

Three persistent workers are deployed in the HTTP lab; [current setup](current-setup.md) records Pods, source identities and quota. The separate synthetic runner is active at its own deployed commit. Documentation refresh does not update its running service.

Neither laboratory establishes full DRS load, persistent exposure, public-source diversity, functional journeys or complete entry/origin telemetry. The 5,000-device registry and source-06 image identity are not capacity measurements. Kusa remains pending.

Before adding an integration, specify injection point, real received load/units, physical and virtual clients, observed sources, missing dimensions and calibration. Preserve unexpected or failed results, then finalize even an inconclusive report. See [boundary](boundary-and-lab.md), [DRS engine](drs-engine.md) and [roadmap](roadmap.md).
