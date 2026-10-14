import { expect, it } from 'vitest';
import { jobEvidence } from '../src/modules/fleet/kubernetes.js';
it('retains Job provenance without exporting environment or admission annotations', () => {
  const evidence = jobEvidence({
    metadata: { name: 'fleet-job', uid: 'uid', annotations: { secret: 'private' } },
    spec: {
      activeDeadlineSeconds: 18,
      backoffLimit: 0,
      template: {
        spec: {
          containers: [
            { name: 'agent', image: 'agent@sha256:digest', env: [{ value: 'private' }] },
          ],
        },
      },
    },
    status: { succeeded: 1 },
  });
  expect(evidence.uid).toBe('uid');
  expect(evidence.containers).toEqual([{ name: 'agent', image: 'agent@sha256:digest' }]);
  expect(evidence.succeeded).toBe(1);
  expect(JSON.stringify(evidence)).not.toContain('private');
});
