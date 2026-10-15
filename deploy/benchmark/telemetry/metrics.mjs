// Bounded by the existing 1,000 campaign/run receipt buckets; no source-IP labels.
const label = (value) =>
  String(value ?? 'unknown')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
export function renderReceiptsMetrics({
  campaigns,
  complete,
  logAvailable,
  lastCollectionAt,
  startedAt,
  podUid,
}) {
  const lines = [];
  const define = (name, type, help) =>
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  const source = `pod_uid="${label(podUid)}"`;
  for (const [name, help, value] of [
    [
      'collector_complete',
      'Receipt collector continuity; not a campaign verdict',
      Number(complete),
    ],
    [
      'log_available',
      'Whether the receipt log was available at the last poll',
      Number(logAvailable),
    ],
    ['collector_start_timestamp_seconds', 'Start of this telemetry process', startedAt / 1000],
    [
      'last_collection_timestamp_seconds',
      'Last successful receipt-log read; absent before the first read',
      lastCollectionAt === null ? null : lastCollectionAt / 1000,
    ],
  ]) {
    define(`shieldtest_http_target_${name}`, 'gauge', help);
    if (value !== null) lines.push(`shieldtest_http_target_${name}{${source}} ${value}`);
  }
  const families = {
    received_requests_total: {
      type: 'counter',
      help: 'HTTP requests actually recorded at the dedicated target; excludes untagged requests',
      samples: [],
    },
    last_request_timestamp_seconds: {
      type: 'gauge',
      help: 'Timestamp of the latest tagged receipt, not scrape time',
      samples: [],
    },
    receipt_complete: {
      type: 'gauge',
      help: 'Collector continuity for an observed campaign/run; never a protection PASS',
      samples: [],
    },
  };
  for (const [id, receipt] of campaigns) {
    const [campaignId, runId] = id.split(':');
    const labels = `${source},campaign_id="${label(campaignId)}",run_id="${label(runId)}"`;
    families.received_requests_total.samples.push(`{${labels}} ${receipt.receivedRequests}`);
    if (Number.isFinite(receipt.latestRequestAt) && receipt.latestRequestAt > 0)
      families.last_request_timestamp_seconds.samples.push(
        `{${labels}} ${receipt.latestRequestAt / 1000}`,
      );
    families.receipt_complete.samples.push(`{${labels}} ${Number(complete)}`);
  }
  for (const [suffix, family] of Object.entries(families)) {
    const name = `shieldtest_http_target_${suffix}`;
    define(name, family.type, family.help);
    for (const sample of family.samples) lines.push(name + sample);
  }
  return lines.join('\n') + '\n';
}
