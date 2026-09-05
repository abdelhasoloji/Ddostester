export type LoadProfile = 'constant' | 'ramp' | 'wave';

export type PresetCategory = 'Quick check' | 'Capacity' | 'Stress' | 'Endurance';

/** Ordered categories for grouping in the UI. */
export const PRESET_CATEGORIES: PresetCategory[] = [
  'Quick check',
  'Capacity',
  'Stress',
  'Endurance',
];

/**
 * Ready-made, bounded load configurations. They set the load shape only
 * (rate/concurrency/duration/profile) and a recommended engine — never the
 * target — so they stay safe to apply to any allowlisted host. All values are
 * well within HARD_CAPS.
 */
export interface Preset {
  id: string;
  name: string;
  icon: string;
  category: PresetCategory;
  /** One-line description. */
  summary: string;
  /** When to reach for this profile. */
  when: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  profile: LoadProfile;
  /** Engine best suited to this profile (applied if installed, else default). */
  recommendedAgent: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'smoke',
    name: 'Smoke test',
    icon: '🚬',
    category: 'Quick check',
    summary: 'Tiny, fast end-to-end check.',
    when: 'First run against a new target, or to confirm the pipeline works before a real test.',
    maxRps: 10,
    concurrency: 3,
    maxDurationSec: 20,
    profile: 'constant',
    recommendedAgent: 'builtin',
  },
  {
    id: 'baseline',
    name: 'Baseline / capacity',
    icon: '📊',
    category: 'Capacity',
    summary: 'Moderate, steady load.',
    when: 'Establish a reference: steady-state latency and availability under sustained, safe load.',
    maxRps: 100,
    concurrency: 20,
    maxDurationSec: 120,
    profile: 'constant',
    recommendedAgent: 'vegeta',
  },
  {
    id: 'ceiling',
    name: 'Capacity ceiling',
    icon: '🧱',
    category: 'Capacity',
    summary: 'High steady rate to find the ceiling.',
    when: 'Push a constant, higher rate to see where sustained throughput starts to degrade.',
    maxRps: 800,
    concurrency: 150,
    maxDurationSec: 120,
    profile: 'constant',
    recommendedAgent: 'vegeta',
  },
  {
    id: 'ramp',
    name: 'Ramp-up (find the knee)',
    icon: '📈',
    category: 'Stress',
    summary: 'Gradually rising rate (25→50→100 %).',
    when: 'Find the point where latency or errors start climbing as load increases.',
    maxRps: 300,
    concurrency: 50,
    maxDurationSec: 180,
    profile: 'ramp',
    recommendedAgent: 'k6',
  },
  {
    id: 'spike',
    name: 'Spike / waves',
    icon: '🌊',
    category: 'Stress',
    summary: 'Alternating bursts and lulls (100→20→100 %).',
    when: 'Test how protection and autoscaling react to sudden bursts, then recover.',
    maxRps: 500,
    concurrency: 100,
    maxDurationSec: 180,
    profile: 'wave',
    recommendedAgent: 'k6',
  },
  {
    id: 'soak',
    name: 'Soak / endurance',
    icon: '⏳',
    category: 'Endurance',
    summary: 'Long, gentle load (15 min).',
    when: 'Reveal slow degradation, memory leaks or resource exhaustion over time.',
    maxRps: 50,
    concurrency: 20,
    maxDurationSec: 900,
    profile: 'constant',
    recommendedAgent: 'builtin',
  },
];

/**
 * Rough number of requests a run will emit, accounting for the profile's
 * average rate over its duration. Indicative only (the real count depends on
 * the target's latency and the rate cap).
 */
export function estimatedRequests(
  maxRps: number,
  durationSec: number,
  profile: LoadProfile | string,
): number {
  const avgFactor =
    profile === 'ramp' ? (0.25 + 0.5 + 1) / 3 : profile === 'wave' ? (1 + 0.2 + 1) / 3 : 1;
  return Math.round(maxRps * durationSec * avgFactor);
}

/** Compact human-readable count (e.g. 12 000 → "12k"). */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
