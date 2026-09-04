/**
 * PROBE — sonde légitime (TSD §5.3). Mesure la disponibilité et la latence
 * d'un endpoint pendant une campagne, et pilote le KILL SWITCH à 3 niveaux :
 *   1. auto-kill : indisponibilité consécutive > 30 s
 *   2. manuel    : appel de KillSwitch.trigger('KILLED_MANUAL')
 *   3. temporel  : timeout absolu (fixé par l'appelant, ≤ 15 min)
 * Elle n'émet aucune charge d'attaque : ce sont des requêtes légitimes de mesure.
 */

export interface ProbeSample {
  at: number;
  ok: boolean;
  status: number;
  latencyMs: number;
}

export interface ProbeMetrics {
  samples: number;
  available: number;
  errorRate5xx: number;
  latencyMs: { p50: number; p95: number; p99: number };
  successful: number;
}

export type KillReason = 'KILLED_AUTO' | 'KILLED_MANUAL' | 'TIMEOUT' | null;

const AUTO_KILL_UNAVAILABLE_MS = 30_000;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

export class KillSwitch {
  reason: KillReason = null;
  private controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get killed(): boolean {
    return this.reason !== null;
  }
  trigger(reason: Exclude<KillReason, null>): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }
}

export class Probe {
  private samples: ProbeSample[] = [];
  private unavailableSince: number | null = null;

  constructor(
    private readonly url: string,
    private readonly kill: KillSwitch,
    private readonly intervalMs = 5000,
    private readonly timeoutMs = 5000,
  ) {}

  async run(): Promise<void> {
    while (!this.kill.killed) {
      await this.tick();
      await this.sleep(this.intervalMs);
    }
  }

  private async tick(): Promise<void> {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let ok = false;
    let status = 0;
    try {
      const res = await fetch(this.url, { signal: ac.signal });
      status = res.status;
      ok = res.ok;
      await res.arrayBuffer().catch(() => undefined);
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }
    const sample: ProbeSample = { at: Date.now(), ok, status, latencyMs: performance.now() - t0 };
    this.samples.push(sample);
    this.evaluateAutoKill(sample);
  }

  /** Niveau 1 du kill switch : > 30 s d'indisponibilité consécutive. */
  private evaluateAutoKill(sample: ProbeSample): void {
    if (sample.ok) {
      this.unavailableSince = null;
      return;
    }
    this.unavailableSince ??= sample.at;
    if (sample.at - this.unavailableSince >= AUTO_KILL_UNAVAILABLE_MS) {
      this.kill.trigger('KILLED_AUTO');
    }
  }

  metrics(): ProbeMetrics {
    const total = this.samples.length;
    const available = this.samples.filter((s) => s.ok).length;
    const server5xx = this.samples.filter((s) => s.status >= 500).length;
    const lat = this.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    return {
      samples: total,
      available,
      errorRate5xx: total ? Number(((server5xx / total) * 100).toFixed(2)) : 0,
      latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), p99: percentile(lat, 99) },
      successful: available,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
