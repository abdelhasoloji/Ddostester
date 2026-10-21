import type { ReactNode } from 'react';

/** Internal DRS states, in the words an operator and a client actually use. */
const STATE_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PLAN_FROZEN: 'Plan frozen',
  CAPACITY_CHECK: 'Capacity',
  BASELINE: 'Baseline',
  LEVEL_EXECUTION: 'Running',
  RECOVERY: 'Recovery',
  EVIDENCE_VALIDATION: 'Evidence',
  LEVEL_CALCULATION: 'Calculation',
  FINAL_REPORT: 'Verdict',
  ENGINE_VALIDATED: 'Instrument validated',
};

const STATE_TONE: Record<string, ChipTone> = {
  DRAFT: 'plain',
  PLAN_FROZEN: 'info',
  CAPACITY_CHECK: 'info',
  BASELINE: 'info',
  LEVEL_EXECUTION: 'warn',
  RECOVERY: 'info',
  EVIDENCE_VALIDATION: 'info',
  LEVEL_CALCULATION: 'info',
  FINAL_REPORT: 'ok',
  ENGINE_VALIDATED: 'plain',
};

export type ChipTone = 'ok' | 'warn' | 'bad' | 'info' | 'plain';

export function Chip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`ui-chip ui-chip-${tone}`}>{children}</span>;
}

/** A DRS state rendered as a chip, never as the raw enum. */
export function StateChip({ state }: { state: string }) {
  return <Chip tone={STATE_TONE[state] ?? 'plain'}>{STATE_LABELS[state] ?? state}</Chip>;
}

export function ModeChip({ mode }: { mode: string }) {
  return mode === 'measured' ? (
    <Chip tone="info">measured</Chip>
  ) : mode === 'synthetic-lab' ? (
    <Chip tone="plain">synthetic</Chip>
  ) : (
    <Chip tone="plain">{mode}</Chip>
  );
}

export function verdictTone(status: string): ChipTone {
  if (status === 'COMPLETE') return 'ok';
  if (status === 'FAIL' || status === 'INDETERMINATE') return 'bad';
  return 'warn';
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`ui-card ${className}`.trim()}>{children}</section>;
}

export function Kpi({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="ui-kpi">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Bar({
  value,
  tone = 'info',
  height = 7,
}: {
  value: number;
  tone?: ChipTone;
  height?: number;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="ui-bar" style={{ height }} role="progressbar" aria-valuenow={Math.round(pct)}>
      <i style={{ width: `${pct}%` }} className={`ui-bar-${tone}`} />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <b>{title}</b>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function stateTone(state: string): ChipTone {
  return STATE_TONE[state] ?? 'plain';
}
