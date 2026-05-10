import { describe, it, expect, vi, afterEach } from 'vitest';
import { rafThrottle } from './utils.js';

// rafThrottle relies on global requestAnimationFrame / cancelAnimationFrame.
// We stub them with a manual driver so tests can control when the frame fires.

function makeRafDriver() {
  let pending = null;
  let nextId = 1;
  const raf = (cb) => { pending = cb; return nextId++; };
  const caf = () => { pending = null; };
  const flush = () => { const cb = pending; pending = null; if (cb) cb(); };
  const hasPending = () => pending !== null;
  return { raf, caf, flush, hasPending };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rafThrottle', () => {
  it('does not call fn synchronously', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('a');
    expect(calls).toHaveLength(0);
  });

  it('calls fn once when raf fires', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('a');
    driver.flush();
    expect(calls).toEqual(['a']);
  });

  it('delivers the last call when multiple fire before the frame', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('a');
    throttled('b');
    throttled('c');
    driver.flush();
    expect(calls).toEqual(['c']);
  });

  it('schedules only one raf per burst', () => {
    let rafCount = 0;
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCount++; return driver.raf(cb); });
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const throttled = rafThrottle(() => {});
    throttled();
    throttled();
    throttled();
    expect(rafCount).toBe(1);
  });

  it('allows a new call after the frame fires', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('first');
    driver.flush();
    throttled('second');
    driver.flush();
    expect(calls).toEqual(['first', 'second']);
  });

  it('.cancel() prevents the pending call', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('a');
    throttled.cancel();
    driver.flush(); // nothing pending after cancel
    expect(calls).toHaveLength(0);
  });

  it('.cancel() is idempotent when nothing is pending', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const throttled = rafThrottle(() => {});
    expect(() => throttled.cancel()).not.toThrow();
    expect(() => throttled.cancel()).not.toThrow();
  });

  it('can call throttled function after cancel', () => {
    const driver = makeRafDriver();
    vi.stubGlobal('requestAnimationFrame', driver.raf);
    vi.stubGlobal('cancelAnimationFrame', driver.caf);

    const calls = [];
    const throttled = rafThrottle((v) => calls.push(v));
    throttled('a');
    throttled.cancel();
    throttled('b');
    driver.flush();
    expect(calls).toEqual(['b']);
  });
});
