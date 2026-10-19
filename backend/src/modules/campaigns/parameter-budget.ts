/** Public, pure confirmation contract shared with the browser. */
export function parameterBudget(c: {
  id: string;
  maxRps: number;
  concurrency: number;
  maxDurationSec: number;
  scenario?: { maxRps: number; durationSec: number }[];
}) {
  return {
    id: c.id,
    maxRps: c.maxRps,
    concurrency: c.concurrency,
    maxDurationSec: c.maxDurationSec,
    scenario: c.scenario?.map(({ maxRps, durationSec }) => ({ maxRps, durationSec })) ?? null,
  };
}
