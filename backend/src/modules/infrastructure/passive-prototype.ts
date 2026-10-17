/** Dated operator checkpoint, not a Kubernetes collector or an execution instruction. */
export function passivePrototypeCheckpoint() {
  return {
    schema: 'shieldtester.passive-prototype-status/v1',
    observedOn: '2026-10-15',
    observationKind: 'dated-checkpoint' as const,
    liveObservationAvailable: false as const,
    lastRecordedStatus: 'artifact-staged',
    host: {
      name: 'ac02',
      managementAddress: '10.20.2.1',
      architecture: 'amd64',
      virtualization: 'KVM',
    },
    namespace: 'shieldtest-qualification',
    expectedPods: 3,
    observedReadyPods: null,
    trafficGeneration: false as const,
    fleetEnrollment: false as const,
    resources: {
      requestCpuMillicores: 150,
      requestMemoryMiB: 192,
      limitCpuMillicores: 300,
      limitMemoryMiB: 384,
    },
    steps: [
      {
        id: 'prepared',
        status: 'recorded',
        detail: 'Manifest rendered and three sequential local no-network samples passed.',
      },
      {
        id: 'staged',
        status: 'recorded',
        detail: 'Rendered artifact copied over SSH; local and remote SHA-256 matched.',
      },
      {
        id: 'cluster-access',
        status: 'pending',
        detail: 'No Kubernetes context configured for at264 at the checkpoint.',
      },
      { id: 'deployed', status: 'unknown', detail: 'No apply or live Pod observation recorded.' },
      {
        id: 'accepted',
        status: 'pending',
        detail:
          'Placement, three Ready Pods, advancing logs and isolation need independent verification.',
      },
    ],
    artifact: {
      sha256: 'c7a27468b098438c5ee4436dd8affa8047504925b481c6468f83f58c186c1144',
      stagedPath: '/home/at264/shieldtest-qualification.huqRvtZK/resources.yml',
    },
    scope:
      'Passive telemetry preparation only. No Fleet migration, measured DRS qualification or live capacity claim.',
  };
}
