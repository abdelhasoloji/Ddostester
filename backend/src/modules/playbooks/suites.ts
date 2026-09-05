import type { Campaign } from '../campaigns/model.js';
import { wrsLevel } from '../wrs/scoring.js';
import type { WrsLevel } from '../wrs/scoring.js';
import { htmlEscape as esc } from '../../util/text.js';

/**
 * Consolidated view of an assessment suite (campaigns created from one
 * playbook, linked by suiteId). Aggregates status and WRS across the member
 * campaigns so a whole assessment can be read — and reported — as one unit.
 */

export interface SuiteMember {
  id: string;
  name: string;
  order: number;
  status: Campaign['status'];
  wrs?: number;
  level?: WrsLevel;
  runId?: string;
}

export interface SuiteSummary {
  suiteId: string;
  suiteName: string;
  target: string;
  createdAt: string;
  total: number;
  pending: number;
  approved: number;
  running: number;
  completed: number;
  members: SuiteMember[];
  /** Aggregate WRS over scored members, or null if none scored yet. */
  wrs: { avg: number; min: number; level: WrsLevel; scored: number } | null;
}

const TERMINAL = ['COMPLETED', 'KILLED_AUTO', 'KILLED_MANUAL'];

/** Groups campaigns into suites and computes per-suite aggregates. */
export function buildSuites(campaigns: Campaign[]): SuiteSummary[] {
  const bySuite = new Map<string, Campaign[]>();
  for (const c of campaigns) {
    if (!c.suiteId) continue;
    const arr = bySuite.get(c.suiteId) ?? [];
    arr.push(c);
    bySuite.set(c.suiteId, arr);
  }

  const suites: SuiteSummary[] = [];
  for (const [suiteId, members] of bySuite) {
    members.sort((a, b) => (a.suiteOrder ?? 0) - (b.suiteOrder ?? 0));
    const scored = members.filter((m) => m.wrs);
    let wrs: SuiteSummary['wrs'] = null;
    if (scored.length) {
      const values = scored.map((m) => m.wrs!.wrs);
      const avg = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
      const min = Math.min(...values);
      wrs = { avg, min, level: wrsLevel(min), scored: scored.length };
    }
    suites.push({
      suiteId,
      suiteName: members[0].suiteName ?? 'Assessment',
      target: members[0].target,
      createdAt: members.reduce(
        (min, c) => (c.createdAt < min ? c.createdAt : min),
        members[0].createdAt,
      ),
      total: members.length,
      pending: members.filter((c) => c.status === 'PENDING_APPROVAL').length,
      approved: members.filter((c) => c.status === 'APPROVED').length,
      running: members.filter((c) => c.status === 'RUNNING').length,
      completed: members.filter((c) => TERMINAL.includes(c.status)).length,
      members: members.map((c) => ({
        id: c.id,
        name: c.name,
        order: c.suiteOrder ?? 0,
        status: c.status,
        wrs: c.wrs?.wrs,
        level: c.wrs?.level,
        runId: c.runId,
      })),
      wrs,
    });
  }
  suites.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return suites;
}

/** Renders an aggregated HTML report for one assessment suite. */
export function renderSuiteReportHtml(suite: SuiteSummary): string {
  const rows = suite.members
    .map(
      (m) =>
        `<tr><td>${m.order + 1}</td><td>${esc(m.name)}</td><td>${m.status}</td><td>${
          m.wrs != null ? `${m.wrs} (${m.level})` : '—'
        }</td></tr>`,
    )
    .join('\n');
  const overall = suite.wrs
    ? `<span class="score">${suite.wrs.avg}</span> avg / <span class="score">${suite.wrs.min}</span> min &nbsp; <span class="level">worst level ${suite.wrs.level}</span> &nbsp;(${suite.wrs.scored}/${suite.total} scored)`
    : 'No scored runs yet.';
  return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Assessment report — ${esc(suite.suiteName)}</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem} table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 .score{font-size:1.2rem;font-weight:700} .level{padding:.1rem .5rem;border:1px solid #999;border-radius:4px}
 .muted{color:#666;font-size:.9rem}
</style></head><body>
<h1>Assessment report — ${esc(suite.suiteName)}</h1>
<p class="muted">Target: <code>${esc(suite.target)}</code> · ${suite.total} campaigns · created ${esc(suite.createdAt)}</p>
<h2>Overall resilience</h2>
<p>${overall}</p>
<h2>Steps</h2>
<table><tr><th>#</th><th>Campaign</th><th>Status</th><th>WRS</th></tr>
${rows}
</table>
<p class="muted">Consolidated assessment — WEDOS internal use only. Every step is a bounded,
allowlisted HTTP test; no volumetric or exhaustion vector is implemented.</p>
</body></html>`;
}
