import { describe, it, expect, afterEach } from 'vitest';
import { describeZoneAt, routeZone } from './assistant-zones.js';

// jsdom implements neither elementsFromPoint nor elementFromPoint, so we define
// the point API directly for each case (spyOn can't stub a missing method) and
// remove it afterwards.
type PointFn = ((x: number, y: number) => Element[]) | undefined;
function setPoints(fn: PointFn) {
  (document as unknown as { elementsFromPoint?: PointFn }).elementsFromPoint = fn;
}
afterEach(() => {
  delete (document as unknown as { elementsFromPoint?: PointFn }).elementsFromPoint;
});

describe('routeZone', () => {
  it('matches the longest route prefix and names the section', () => {
    expect(routeZone('/').title).toBe('Command Center');
    expect(routeZone('/campaigns?tab=plan').title).toBe('Campaigns');
    expect(routeZone('/theater').title).toBe('Run Theater');
    expect(routeZone('/zones').title).toBe('Protected zones');
    expect(routeZone('/nope').key).toBe('route:unknown');
  });
});

describe('describeZoneAt', () => {
  it('falls back to the route description when nothing is under the point', () => {
    setPoints(() => []);
  });

  it('reads the element BEHIND the mascot, skipping the float window itself', () => {
    const table = document.createElement('div');
    table.className = 'campaign-table';
    const floatEl = document.createElement('div');
    floatEl.setAttribute('data-assistant-float', '');
    // elementsFromPoint is front→back: the float is in front and must be skipped.
    setPoints(() => [floatEl, table]);
    const z = describeZoneAt(50, 50, '/');
    expect(z.title).toBe('Campaigns & suites');
    expect(z.key).toContain('campaign-table');
  });

  it('degrades to the route when the point API throws', () => {
    setPoints(() => {
      throw new Error('unsupported');
    });
    expect(describeZoneAt(0, 0, '/settings').title).toBe('Settings');
  });
});
