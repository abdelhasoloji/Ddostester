import { expect, it } from 'vitest';
import { passivePrototypeCheckpoint } from '../src/modules/infrastructure/passive-prototype.js';
it('returns a detached dated checkpoint with no invented live deployment or traffic authority', () => {
  const p = passivePrototypeCheckpoint();
  expect(p.observationKind).toBe('dated-checkpoint');
  expect(p.observedReadyPods).toBeNull();
  expect(p.liveObservationAvailable).toBe(false);
  expect(p.trafficGeneration).toBe(false);
  expect(p.fleetEnrollment).toBe(false);
  expect(p.host.architecture).toBe('amd64');
  expect(p.steps.find((s) => s.id === 'deployed')?.status).toBe('unknown');
  p.steps[0].status = 'changed';
  expect(passivePrototypeCheckpoint().steps[0].status).toBe('recorded');
});
