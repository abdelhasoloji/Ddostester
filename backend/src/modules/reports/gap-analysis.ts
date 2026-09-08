import { htmlEscape as esc } from '../../util/text.js';
import type { PostureReport } from '../posture/analyze.js';

/**
 * RPT-05 — Protection-gap analyzer.
 *
 * Given the DECLARED WEDOS defensive controls for the authorized target, map
 * them against the zeroBS P26-20371 threat lines and emit a PRIORITISED plan of
 * which bounded playbook lines to replay first (the tune-and-replay front half),
 * plus the lines that stay attestation-only because they are out of the bounded
 * model by design.
 *
 * This is purely analytical: it selects and orders EXISTING bounded vectors and
 * never synthesises new ones. It does not craft evasion payloads, does not
 * remove any cap or allowlist, and emits no traffic. Knowing the defense only
 * decides where to point the same governed test — never how to defeat a rule.
 */

/** A defensive control class that can mitigate one or more threat lines. */
export type ControlKey =
  | 'synFloodProtection'
  | 'slowRequestTimeout'
  | 'rateLimiting'
  | 'originShielding'
  | 'cacheKeyPolicy'
  | 'urlAllowlist'
  | 'methodPolicy'
  | 'http2Guard'
  | 'challenge'
  | 'wafSignatures'
  | 'bruteForceProtection';

export const CONTROL_LABELS: Record<ControlKey, string> = {
  synFloodProtection: 'SYN-flood / handshake protection (L3/4)',
  slowRequestTimeout: 'Slow-request / header timeout',
  rateLimiting: 'Request rate limiting',
  originShielding: 'Origin shielding / edge 404',
  cacheKeyPolicy: 'Cache-key policy',
  urlAllowlist: 'URL / path allowlist',
  methodPolicy: 'HTTP method policy',
  http2Guard: 'HTTP/2 abuse guard (rapid-reset / continuation)',
  challenge: 'Bot challenge (JS / PoW / CAPTCHA)',
  wafSignatures: 'WAF signature ruleset',
  bruteForceProtection: 'Credential brute-force protection',
};

/** How a control is declared: proven present, partial, absent, or not declared. */
export type ControlStatus = 'present' | 'partial' | 'absent' | 'unknown';

/** Declared WEDOS control profile for the target (missing keys → 'unknown'). */
export type ProtectionProfile = Partial<Record<ControlKey, ControlStatus>>;

/** Whether a threat line can be exercised by a bounded vector or stays attested. */
type Disposition = 'bounded' | 'attested';

interface ThreatLine {
  line: number;
  drs: number;
  name: string;
  control: ControlKey;
  disposition: Disposition;
  /** Bounded lines: the pretest-cra-l7 step that exercises this line. */
  step?: string;
  /** Attested lines / partials: why part of it is out of the bounded model. */
  attestedNote?: string;
}

/** The P26-20371 matrix, keyed to the mitigating control and its disposition. */
const THREAT_LINES: ThreatLine[] = [
  {
    line: 1,
    drs: 3,
    name: 'TCP-Handshakes',
    control: 'synFloodProtection',
    disposition: 'attested',
    attestedNote:
      'L3/4 state-table line — runs on the isolated class-C bench, not the L7 playbook.',
  },
  {
    line: 2,
    drs: 3,
    name: 'SlowLoris',
    control: 'slowRequestTimeout',
    disposition: 'bounded',
    step: 'SlowLoris (DRS3)',
  },
  {
    line: 3,
    drs: 3,
    name: 'HTTP GET-Flood',
    control: 'rateLimiting',
    disposition: 'bounded',
    step: 'GET-Flood (DRS3)',
  },
  {
    line: 4,
    drs: 3,
    name: 'GET-Random-Flood',
    control: 'originShielding',
    disposition: 'bounded',
    step: 'GET-Random-Flood (DRS3)',
  },
  {
    line: 5,
    drs: 4,
    name: 'GET /VALID_RANDOM',
    control: 'cacheKeyPolicy',
    disposition: 'bounded',
    step: 'GET /VALID_RANDOM (DRS4)',
  },
  {
    line: 6,
    drs: 4,
    name: 'HTTP POST-Flood',
    control: 'methodPolicy',
    disposition: 'bounded',
    step: 'POST-Flood (DRS4)',
  },
  {
    line: 7,
    drs: 4,
    name: 'HTTP/2 GET-Flood',
    control: 'http2Guard',
    disposition: 'bounded',
    step: 'HTTP/2 GET-Flood (DRS4)',
  },
  {
    line: 8,
    drs: 5,
    name: 'HTTP/2 Rapid Reset / Continuation / HPACK Bomb',
    control: 'http2Guard',
    disposition: 'bounded',
    step: 'HTTP/2 Continuation — header pressure (DRS4)',
    attestedNote:
      'Rapid-reset and continuation are exercised bounded; the HPACK decompression bomb stays attested (amplification exploit, not emitted).',
  },
  {
    line: 9,
    drs: 5,
    name: 'POST-Flood (login/account)',
    control: 'challenge',
    disposition: 'bounded',
    step: 'Login/account POST-Flood (DRS5)',
  },
  {
    line: 10,
    drs: 5,
    name: 'HTTP MultiVector',
    control: 'rateLimiting',
    disposition: 'bounded',
    step: 'L7 MultiVector (DRS5)',
  },
  {
    line: 11,
    drs: 5,
    name: 'Layer-7-THOR / PulseWave',
    control: 'challenge',
    disposition: 'bounded',
    step: 'THOR / PulseWave — synchronized (DRS5)',
  },
  {
    line: 12,
    drs: 5,
    name: 'WAF-Cracker',
    control: 'wafSignatures',
    disposition: 'attested',
    attestedNote:
      'Live SQLi/XSS/RCE payloads — weaponized, never emitted; WAF efficacy is attested from the ruleset.',
  },
  {
    line: 13,
    drs: 5,
    name: 'MultiTarget / carpet-bombing',
    control: 'challenge',
    disposition: 'bounded',
    step: 'MultiTarget / carpet-bombing (DRS5)',
  },
  {
    line: 14,
    drs: 4,
    name: 'RANDOM POST / LOGIN_BRUTE_FORCE',
    control: 'bruteForceProtection',
    disposition: 'attested',
    attestedNote:
      'Bounded POST is covered (line 6/9); credential brute-force stays out of the model by design.',
  },
];

/** Weight added to a line's DRS level by how well its control is declared. */
const STATUS_WEIGHT: Record<ControlStatus, number> = {
  absent: 3,
  unknown: 2,
  partial: 1,
  present: 0,
};

export type Priority = 'high' | 'medium' | 'low';

function priorityOf(score: number): Priority {
  if (score >= 7) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

export interface PlanItem {
  line: number;
  drs: number;
  name: string;
  control: ControlKey;
  controlLabel: string;
  status: ControlStatus;
  priority: Priority;
  score: number;
  step: string;
  rationale: string;
  attestedNote?: string;
}

export interface AttestationItem {
  line: number;
  drs: number;
  name: string;
  control: ControlKey;
  controlLabel: string;
  status: ControlStatus;
  note: string;
}

export interface GapAnalysis {
  generatedAt: string;
  target?: string;
  /** Bounded lines to replay, highest priority first. */
  plan: PlanItem[];
  /** Out-of-model lines: verify by attestation, never emitted. */
  attestationOnly: AttestationItem[];
  summary: { high: number; medium: number; low: number; attested: number };
}

/**
 * Maps a declared control profile to a prioritised replay plan. Lines whose
 * control is absent/partial/undeclared and that have a bounded test rank first;
 * out-of-model lines are listed separately for attestation.
 */
export function analyzeGaps(profile: ProtectionProfile, target?: string): GapAnalysis {
  const plan: PlanItem[] = [];
  const attestationOnly: AttestationItem[] = [];

  for (const t of THREAT_LINES) {
    const status: ControlStatus = profile[t.control] ?? 'unknown';
    const controlLabel = CONTROL_LABELS[t.control];
    if (t.disposition === 'bounded') {
      const score = t.drs + STATUS_WEIGHT[status];
      const priority = priorityOf(score);
      const rationale =
        status === 'absent'
          ? `No ${controlLabel.toLowerCase()} declared — replay to see if the edge holds anyway.`
          : status === 'partial'
            ? `${controlLabel} is partial — replay to find where it stops holding.`
            : status === 'unknown'
              ? `${controlLabel} not declared — replay to establish the baseline.`
              : `${controlLabel} declared present — replay to confirm and measure collateral.`;
      plan.push({
        line: t.line,
        drs: t.drs,
        name: t.name,
        control: t.control,
        controlLabel,
        status,
        priority,
        score,
        step: t.step!,
        rationale,
        attestedNote: t.attestedNote,
      });
    } else {
      attestationOnly.push({
        line: t.line,
        drs: t.drs,
        name: t.name,
        control: t.control,
        controlLabel,
        status,
        note: t.attestedNote ?? 'Out of the bounded model by design.',
      });
    }
  }

  plan.sort((a, b) => b.score - a.score || a.line - b.line);
  const summary = {
    high: plan.filter((p) => p.priority === 'high').length,
    medium: plan.filter((p) => p.priority === 'medium').length,
    low: plan.filter((p) => p.priority === 'low').length,
    attested: attestationOnly.length,
  };
  return { generatedAt: new Date().toISOString(), target, plan, attestationOnly, summary };
}

/**
 * Seeds a profile from the passive posture inference (posture/analyze.ts). Only
 * sets controls the probe positively observed to 'present'; everything else is
 * left 'unknown' — passive inference cannot prove a control is absent.
 */
export function postureToProfile(posture: PostureReport): ProtectionProfile {
  const p: ProtectionProfile = {};
  if (posture.rateLimiting) p.rateLimiting = 'present';
  if (posture.waf) {
    p.wafSignatures = 'present';
    p.methodPolicy = 'present';
  }
  if (posture.cdn) {
    p.originShielding = 'present';
    p.cacheKeyPolicy = 'present';
  }
  return p;
}

const PRIORITY_CLASS: Record<Priority, string> = { high: 'p-high', medium: 'p-med', low: 'p-low' };

/** Renders the gap analysis as a standalone HTML report (print/PDF ready). */
export function renderGapAnalysisHtml(a: GapAnalysis): string {
  const planRows = a.plan
    .map(
      (p) =>
        `<tr><td>${p.line}</td><td>DRS${p.drs}</td><td>${esc(p.name)}</td><td>${esc(
          p.controlLabel,
        )} <span class="muted">(${p.status})</span></td><td><span class="pill ${
          PRIORITY_CLASS[p.priority]
        }">${p.priority}</span></td><td>${esc(p.step)}<br><span class="muted">${esc(
          p.rationale,
        )}</span>${p.attestedNote ? `<br><span class="muted">⚠ ${esc(p.attestedNote)}</span>` : ''}</td></tr>`,
    )
    .join('\n');
  const attRows = a.attestationOnly
    .map(
      (x) =>
        `<tr><td>${x.line}</td><td>DRS${x.drs}</td><td>${esc(x.name)}</td><td>${esc(
          x.controlLabel,
        )} <span class="muted">(${x.status})</span></td><td>${esc(x.note)}</td></tr>`,
    )
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Protection-gap analysis — WEDOS ShieldTest</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;color:#111;max-width:960px}
 .brand{display:flex;align-items:center;gap:.6rem;border-bottom:3px solid #003484;padding-bottom:.6rem;margin-bottom:1rem}
 .brand h1{font-size:1.25rem;margin:0}.wm{font-weight:800;color:#003484}
 h2{color:#003484;margin-top:1.4rem;font-size:1.1rem}
 table{border-collapse:collapse;width:100%;margin:.6rem 0}
 th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
 .muted{color:#666}
 .pill{display:inline-block;padding:.05rem .5rem;border-radius:999px;font-weight:700;color:#fff;font-size:.85rem}
 .p-high{background:#c23b34}.p-med{background:#b8860b}.p-low{background:#0f8a5f}
 .print-btn{position:fixed;top:1rem;right:1rem;background:#003484;color:#fff;border:0;border-radius:6px;padding:.5rem .9rem;font:inherit;font-weight:600;cursor:pointer}
 @media print{.print-btn{display:none}body{margin:0}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Print / PDF</button>
<div class="brand">
 <svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a4aa0"/><stop offset="1" stop-color="#003484"/></linearGradient></defs><path d="M24 3 L42 9 V24 C42 35 34 44 24 46 C14 44 6 35 6 24 V9 Z" fill="url(#g)"/><path d="M15 24 l6 6 l12 -14" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
 <h1><span class="wm">WEDOS ShieldTest</span> — Protection-gap analysis</h1>
</div>
<p class="muted">Generated on ${esc(a.generatedAt)}${
    a.target ? ` · target <code>${esc(a.target)}</code>` : ''
  } · WEDOS internal use</p>
<p><b>${a.summary.high}</b> high · <b>${a.summary.medium}</b> medium · <b>${a.summary.low}</b> low priority to replay · <b>${a.summary.attested}</b> attestation-only line(s).</p>
<h2>Prioritised replay plan (bounded lines)</h2>
<p class="muted">Replay these <code>pretest-cra-l7</code> steps in this order, then read the per-line delta with the suite-compare (tune &amp; replay).</p>
<table><tr><th>#</th><th>DRS</th><th>Threat line</th><th>Mitigating control</th><th>Priority</th><th>Step to replay &amp; why</th></tr>
${planRows}
</table>
<h2>Attestation-only (out of the bounded model)</h2>
<p class="muted">These are validated by attestation of the control, never emitted — no exploit, amplification or spoofing.</p>
<table><tr><th>#</th><th>DRS</th><th>Threat line</th><th>Mitigating control</th><th>Disposition</th></tr>
${attRows}
</table>
<p class="muted">Analytical only — selects and orders existing bounded vectors against the
authorized target; it does not synthesise attacks, defeat rules, or relax any cap/allowlist.</p>
</body></html>`;
}
