import { describe, expect, it, vi } from 'vitest';
import { onAiSupport, requestAiSupport } from './assistant-bus.js';

describe('assistant-bus', () => {
  it('delivers a request to a subscriber', () => {
    const seen: string[] = [];
    const off = onAiSupport((r) => seen.push(`${r.title}:${r.context}`));
    requestAiSupport({ title: 'A', context: 'x' });
    expect(seen).toEqual(['A:x']);
    off();
  });

  it('fans out to every subscriber and stops after unsubscribe', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onAiSupport(a);
    const offB = onAiSupport(b);
    requestAiSupport({ title: 'T', context: 'c' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    requestAiSupport({ title: 'T2', context: 'c2' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
  });
});
