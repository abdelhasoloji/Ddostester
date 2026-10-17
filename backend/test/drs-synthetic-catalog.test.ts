import { expect, it } from 'vitest';
import { drsCatalog } from '../src/modules/drs/catalog.js';
import { BENCH_SCENARIOS } from '../src/modules/bench/model.js';
import { syntheticApproximation } from '../src/modules/drs/synthetic-catalog.js';

it('keeps the full reference and only associates registered reproducible partial shapes', () => {
  const catalog = drsCatalog();
  expect(catalog.profiles).toHaveLength(131);
  expect(catalog.profiles.filter((p) => p.supported)).toHaveLength(7);
  const shapes = catalog.profiles.filter((p) => p.laboratory);
  expect(shapes.length).toBeGreaterThan(0);
  for (const row of shapes) {
    expect(BENCH_SCENARIOS.find((s) => s.id === row.laboratory!.scenarioId)?.reproducible).toBe(
      true,
    );
    expect(row.laboratory!.scoreEligible).toBe(false);
    expect(row.laboratory!.qualification).toBe('partial-shape');
    expect(row.laboratory!.missingDimensions.length).toBeGreaterThan(0);
    expect(row.supported).toBe(false);
  }
});

it('does not replace missing protocol semantics with arbitrary synthetic traffic', () => {
  expect(syntheticApproximation('13004')).toBeUndefined();
  expect(syntheticApproximation('85023')).toBeUndefined();
  expect(syntheticApproximation('__proto__')).toBeUndefined();
  expect(syntheticApproximation('23006')?.scenarioId).toBe('udp_ntp_reflection');
});
