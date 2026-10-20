import { describe, expect, it } from 'vitest';
import { compareDrsReports } from '../src/modules/drs/report.js';

// The comparison answers the question a client asks after a protection change: which
// archived requirement is now met, which is still not, and which regressed.
type Report = Parameters<typeof compareDrsReports>[0];

const report = (
  revision: number,
  status: string,
  level: number,
  gaps: { vectorId: string; dimension: string; met: boolean }[],
  proofs = 1,
) =>
  ({
    revision,
    assessment: {
      status,
      score: null,
      terminalLevel: level,
      terminalOutcome: status,
      requirementGaps: gaps.map((g) => ({
        ...g,
        level,
        required: 'x',
        achieved: 'y',
      })),
    },
    proofs: Array.from({ length: proofs }, () => ({})),
  }) as unknown as Report;

describe('DRS comparison', () => {
  it('reports resolved, remaining and regressed requirements', () => {
    const before = report(1, 'PARTIAL', 1, [
      { vectorId: 'v1', dimension: 'load', met: false },
      { vectorId: 'v1', dimension: 'sources', met: false },
      { vectorId: 'v1', dimension: 'persistence', met: true },
    ]);
    const after = report(2, 'COMPLETE', 2, [
      { vectorId: 'v1', dimension: 'load', met: true },
      { vectorId: 'v1', dimension: 'sources', met: false },
      { vectorId: 'v1', dimension: 'persistence', met: false },
    ]);

    const result = compareDrsReports(before, after);
    expect(result.deltas.statusChanged).toBe(true);
    expect(result.deltas.levelChange).toBe(1);
    expect(result.deltas.gapsResolved).toEqual([{ vectorId: 'v1', dimension: 'load' }]);
    expect(result.deltas.gapsRemaining).toEqual([
      { vectorId: 'v1', dimension: 'sources' },
      { vectorId: 'v1', dimension: 'persistence' },
    ]);
    expect(result.deltas.gapsRegressed).toEqual([{ vectorId: 'v1', dimension: 'persistence' }]);
  });

  it('counts a proof delta and leaves an unchanged run flat', () => {
    const a = report(1, 'PARTIAL', 1, [{ vectorId: 'v1', dimension: 'load', met: false }], 1);
    const b = report(2, 'PARTIAL', 1, [{ vectorId: 'v1', dimension: 'load', met: false }], 2);
    const result = compareDrsReports(a, b);
    expect(result.deltas.statusChanged).toBe(false);
    expect(result.deltas.levelChange).toBe(0);
    expect(result.deltas.proofDelta).toBe(1);
    expect(result.deltas.gapsResolved).toEqual([]);
    expect(result.deltas.gapsRemaining).toHaveLength(1);
  });
});
