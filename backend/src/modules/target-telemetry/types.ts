/**
 * Target telemetry (EPIC B1): host-side counters of the target under test —
 * CPU, conntrack, NIC throughput — sampled during a run and correlated to the
 * run timeline, so a result shows not just "the service stayed up" but how hard
 * the host worked. Strictly INBOUND measurement pulled from a metrics endpoint
 * the lab exposes; it generates no traffic and adds no attack surface.
 */

/** One host-telemetry sample. All fields optional — a source reports what it has. */
export interface TargetSample {
  at: string; // ISO
  /** Host CPU utilisation (%). */
  cpuPct?: number;
  /** Active tracked connections (conntrack). */
  conntrack?: number;
  /** NIC receive throughput (Mbit/s). */
  nicRxMbps?: number;
  /** NIC transmit throughput (Mbit/s). */
  nicTxMbps?: number;
}

/** Identifies the run a sample is requested for. */
export interface TargetTelemetryContext {
  campaignId: string;
  target: string;
}

/**
 * Provides host-telemetry samples for the target during a run, or null when
 * none are available. Implementations MUST NOT throw.
 */
export interface TargetTelemetryProvider {
  /** Whether a source is configured (surfaced in /health). */
  readonly configured: boolean;
  sample(ctx: TargetTelemetryContext): Promise<TargetSample | null>;
}
