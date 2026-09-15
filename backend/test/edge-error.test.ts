import { describe, it, expect } from 'vitest';
import { detectEdgeError, describeEdgeError } from '../src/modules/posture/edge-error.js';

// A faithful transcription of a real WEDOS.protection origin-error page captured
// against bank.cz under load (502 origin error).
const WEDOS_502 = `
WEDOS.PROTECTION · ORIGIN LAYER · HTTP 502
Erreur sur le serveur d'origine (502)
Le serveur d'origine a renvoyé une réponse invalide ou inattendue.
Error: HTTP 502 — origin server returned invalid response
IP:       88.185.186.206
Node:     ac10-Paris
Server:   BE-ALB-AVC-WP / S-ALB-to-AVC-WP
Req-ID:   583990db-1b33-428e-9568-69985139a1f2
Time:     2026-09-15 17:25:57 UTC
Protocol: HTTPS (H3) (443)
Request:  https://bank.cz/
Protected by WEDOS.protection
`;

describe('detectEdgeError', () => {
  it('classifies the WEDOS 502 as an ORIGIN buckle and extracts the leaked diagnostics', () => {
    const e = detectEdgeError(502, WEDOS_502);
    expect(e).not.toBeNull();
    expect(e!.layer).toBe('origin');
    expect(e!.status).toBe(502);
    expect(e!.vendor).toBe('WEDOS');
    expect(e!.node).toBe('ac10-Paris');
    expect(e!.reqId).toBe('583990db-1b33-428e-9568-69985139a1f2');
    expect(e!.server).toContain('BE-ALB-AVC-WP');
    expect(e!.protocol).toContain('HTTPS (H3)');
    // The origin IP is captured as an information-disclosure finding.
    expect(e!.originIpLeaked).toBe('88.185.186.206');
  });

  it('reads the origin buckle as a plain-language impact statement', () => {
    const e = detectEdgeError(502, WEDOS_502)!;
    expect(describeEdgeError(e)).toMatch(/origin.*buckled/i);
    expect(describeEdgeError(e)).toContain('WEDOS');
  });

  it('classifies a 429 as a rate-limit signal', () => {
    const e = detectEdgeError(429, 'Too Many Requests — rate limited by the edge');
    expect(e!.layer).toBe('rate-limit');
    expect(e!.status).toBe(429);
  });

  it('classifies a challenge / block page', () => {
    const e = detectEdgeError(403, 'Access denied. Please complete the CAPTCHA challenge.');
    expect(e!.layer).toBe('challenge');
  });

  it('returns null for a healthy 200 and for a plain origin 500 with no edge signature', () => {
    expect(detectEdgeError(200, '<html>ok</html>')).toBeNull();
    expect(detectEdgeError(500, 'Internal Server Error')).toBeNull(); // no edge-page signature
  });

  it('is bounded and safe on empty/huge bodies', () => {
    expect(detectEdgeError(502, '')).toBeNull();
    const huge = 'origin server error '.repeat(100000);
    expect(detectEdgeError(502, huge)!.layer).toBe('origin'); // still classifies, bounded slice
  });
});
