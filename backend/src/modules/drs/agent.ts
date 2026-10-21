/**
 * Fleet agents: the record that decides whether a calibrated generator is admitted.
 *
 * A calibration alone said "this machine measured X". It did not say whether the machine is in
 * service, in maintenance, or gone. That distinction belongs to the fleet record, and the
 * envelope must respect it: an agent in maintenance contributes nothing.
 */
export type DrsAgentState = 'active' | 'maintenance' | 'retired';

export interface DrsAgent {
  id: string;
  label: string;
  region?: string;
  tags?: string[];
  state: DrsAgentState;
  createdAt: string;
  updatedAt: string;
}

export const DRS_AGENT_STATES: DrsAgentState[] = ['active', 'maintenance', 'retired'];

export class DrsAgentError extends Error {}

const label = (v: unknown): string => {
  if (typeof v !== 'string' || v.trim().length < 2 || v.trim().length > 64)
    throw new DrsAgentError('label must be 2–64 characters.');
  return v.trim();
};

const optionalText = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new DrsAgentError(`${field} must be a string.`);
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) throw new DrsAgentError(`${field} must be at most ${max} characters.`);
  return trimmed;
};

/** Registration input: everything but the state, which is set explicitly afterwards. */
export function parseAgentInput(input: unknown): Pick<DrsAgent, 'label' | 'region' | 'tags'> {
  if (typeof input !== 'object' || input === null)
    throw new DrsAgentError('An agent object is required.');
  const raw = input as Record<string, unknown>;
  const tagsRaw = Array.isArray(raw.tags) ? raw.tags : [];
  const tags = [
    ...new Set(tagsRaw.map((t) => optionalText(t, 'tags[]', 32)).filter(Boolean)),
  ] as string[];
  return {
    label: label(raw.label),
    ...(optionalText(raw.region, 'region', 32)
      ? { region: optionalText(raw.region, 'region', 32) }
      : {}),
    ...(tags.length ? { tags } : {}),
  };
}

export function parseAgentState(input: unknown): DrsAgentState {
  if (typeof input !== 'string' || !DRS_AGENT_STATES.includes(input as DrsAgentState))
    throw new DrsAgentError(`state must be one of ${DRS_AGENT_STATES.join(', ')}.`);
  return input as DrsAgentState;
}
