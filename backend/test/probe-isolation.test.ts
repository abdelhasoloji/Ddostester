import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { Probe, KillSwitch } from '../src/modules/probe/probe.js';

/**
 * The probe must measure the TARGET, not the control plane's own pool
 * contention. The builtin generator floods over Node's global `fetch` pool;
 * the probe therefore keeps its OWN dedicated undici pool so a saturated
 * generator can never starve it into a false "unavailable" reading.
 * (Behavioural isolation against a live target is validated separately before
 * this ships — see the PR note.)
 */
describe('probe pool isolation', () => {
  it('gives each probe its own dedicated undici dispatcher', async () => {
    const a = new Probe('http://127.0.0.1:1/', new KillSwitch());
    const b = new Probe('http://127.0.0.1:1/', new KillSwitch());
    expect(a.dispatcher).toBeInstanceOf(Agent);
    expect(b.dispatcher).toBeInstanceOf(Agent);
    // Never shared — not with another probe, nor with the generator's global pool.
    expect(a.dispatcher).not.toBe(b.dispatcher);
    await a.dispatcher.close();
    await b.dispatcher.close();
  });

  it('releases its dedicated pool when the run ends', async () => {
    const kill = new KillSwitch();
    const probe = new Probe('http://127.0.0.1:1/', kill);
    // run() force-releases via destroy() (not close()) so an in-flight tick
    // against a dead target can't hang the shutdown past the hard deadline.
    const spy = vi.spyOn(probe.dispatcher, 'destroy');
    // Kill before run(): the loop body is skipped, but run() must still release
    // the pool in its finally block.
    kill.trigger('KILLED_MANUAL');
    await probe.run();
    expect(spy).toHaveBeenCalled();
  });
});
