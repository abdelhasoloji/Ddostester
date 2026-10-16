import type { Campaign, DrsReportView } from './api.js';
export function comparableReports(
  clientId: string,
  campaigns: [Campaign, Campaign],
  reports: [DrsReportView, DrsReportView],
) {
  if (campaigns[0].id === campaigns[1].id) throw Error('Choose two different assessments.');
  const revisions = campaigns.map((c, i) => {
    const r = c.drsDocument?.revisions.find((r) => r.number === c.drsDocument?.currentRevision);
    const report = reports[i];
    if (
      !['bank-cz', 'enisa-preprod', 'test-vps'].includes(clientId) ||
      c.drsMode !== 'engine-validation' ||
      c.clientWorkspace?.id !== clientId ||
      report.clientWorkspace?.id !== clientId ||
      r?.plan.mode !== 'engine-validation'
    )
      throw Error('Choose simulations belonging to this client.');
    if (
      !r.finalizedAt ||
      !r.planHash ||
      report.revisionId !== r.id ||
      report.revision !== r.number ||
      report.planHash !== r.planHash
    )
      throw Error('Report revision changed or incomplete. Refresh the archive.');
    if (
      report.clientWorkspace.revision !== c.clientWorkspace.revision ||
      report.clientWorkspace.hash !== c.clientWorkspace.hash
    )
      throw Error('Report client scope does not match the saved assessment.');
    for (const key of [
      'standardVersion',
      'catalogueHash',
      'engineVersion',
      'interpretationProfile',
    ] as const)
      if (r.reference[key] !== report.reference[key]) throw Error('Report reference changed.');
    return r;
  });
  const [a, b] = campaigns;
  if (
    a.clientWorkspace!.revision !== b.clientWorkspace!.revision ||
    a.clientWorkspace!.hash !== b.clientWorkspace!.hash
  )
    throw Error('Frozen client scopes differ.');
  for (const key of [
    'standardVersion',
    'catalogueHash',
    'engineVersion',
    'interpretationProfile',
  ] as const)
    if (!reports[0].reference[key] || reports[0].reference[key] !== reports[1].reference[key])
      throw Error('Report references differ.');
  if (revisions[0].planHash !== revisions[1].planHash) throw Error('Frozen plans differ.');
  const [left, right] = reports.map((r) => r.assessment);
  const levels = [...new Set([...left.levels, ...right.levels].map((l) => l.level))]
    .sort((a, b) => a - b)
    .map((level) => ({
      level,
      a: left.levels.find((l) => l.level === level),
      b: right.levels.find((l) => l.level === level),
    }));
  const delta =
    left.status === 'COMPLETE' &&
    right.status === 'COMPLETE' &&
    typeof left.score === 'number' &&
    Number.isFinite(left.score) &&
    typeof right.score === 'number' &&
    Number.isFinite(right.score)
      ? right.score - left.score
      : null;
  return { delta, levels };
}
