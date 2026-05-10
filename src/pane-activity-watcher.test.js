import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPaneActivityWatcher } from './pane-activity-watcher.js';

const SETTLE_MS = 100;
const RESIZE_MS = 200;

function makeWatcher(opts = {}) {
  const alerts = [];
  const clears = [];
  const watcher = createPaneActivityWatcher({
    settleMs: SETTLE_MS,
    resizeSettleMs: RESIZE_MS,
    onAlert: (id) => alerts.push(id),
    onClear: (id) => clears.push(id),
    ...opts,
  });
  return { watcher, alerts, clears };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('no alert scenarios', () => {
  it('data before pane ever focused → no alert', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });

  it('data on the currently focused pane → no alert', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });

  it('data on pane focused to null → no alert without history', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus(null);
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });
});

describe('alert lifecycle', () => {
  it('fires alert after settleMs of silence on unfocused-but-was-focused pane', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    expect(alerts).toHaveLength(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);
  });

  it('does not fire before settleMs elapses', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(alerts).toHaveLength(0);
  });

  it('setFocus on alerted pane clears the alert', () => {
    const { watcher, alerts, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);

    watcher.setFocus('p1');
    expect(clears).toContain('p1');
  });

  it('new data on already-alerted pane resets the cycle', () => {
    const { watcher, alerts, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts.filter(a => a === 'p1')).toHaveLength(1);

    // More data arrives on alerted pane → clears existing alert, restarts timer
    watcher.noteData('p1');
    expect(clears).toContain('p1');

    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts.filter(a => a === 'p1')).toHaveLength(2);
  });

  it('multiple independent panes can alert simultaneously', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p3');
    watcher.noteData('p1');
    watcher.noteData('p2'); // p2 never focused → ignored
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toContain('p1');
    expect(alerts).not.toContain('p2');
  });
});

describe('forget', () => {
  it('clears an active alert on forget', () => {
    const { watcher, alerts, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toHaveLength(1);

    watcher.forget('p1');
    expect(clears).toContain('p1');
  });

  it('cancels pending timer on forget', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');

    watcher.forget('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });

  it('forget on unknown pane is a no-op', () => {
    const { watcher } = makeWatcher();
    expect(() => watcher.forget('nonexistent')).not.toThrow();
  });

  it('after forget, pane can be re-registered by focusing it', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    watcher.forget('p1');

    // Re-focus resets the pane; switch away and send data → alert again
    alerts.length = 0;
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);
  });
});

describe('setPaneEnabled', () => {
  it('disabled pane does not generate alerts', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.setPaneEnabled('p1', false);
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });

  it('disabling a pane clears its existing alert', () => {
    const { watcher, alerts, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);

    watcher.setPaneEnabled('p1', false);
    expect(clears).toContain('p1');
  });

  it('re-enabling a pane restores normal behavior', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.setPaneEnabled('p1', false);
    watcher.setPaneEnabled('p1', true);
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);
  });

  it('calling setPaneEnabled with same value is idempotent', () => {
    const { watcher, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);

    watcher.setPaneEnabled('p1', false);
    const clearsAfterFirst = clears.length;
    watcher.setPaneEnabled('p1', false); // same value — no-op
    expect(clears.length).toBe(clearsAfterFirst);
  });
});

describe('setGlobalEnabled', () => {
  it('disabling globally clears all active alerts', () => {
    const { watcher, alerts, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toHaveLength(1);

    watcher.setGlobalEnabled(false);
    expect(clears).toContain('p1');
  });

  it('disabling globally prevents new alerts', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setGlobalEnabled(false);
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });

  it('re-enabling globally restores alerting', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.setGlobalEnabled(false);
    watcher.setGlobalEnabled(true);
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);
  });

  it('setting same global value is idempotent', () => {
    const { watcher, clears } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);

    watcher.setGlobalEnabled(false);
    const n = clears.length;
    watcher.setGlobalEnabled(false); // no-op
    expect(clears.length).toBe(n);
  });

  it('watcher created with globalEnabled:false starts disabled', () => {
    const { watcher, alerts } = makeWatcher({ globalEnabled: false });
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS + 50);
    expect(alerts).toHaveLength(0);
  });
});

describe('noteResize — post-resize quiet window', () => {
  it('drops in-flight alert timer on resize', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS / 2);

    watcher.noteResize('p1'); // drops the timer
    vi.advanceTimersByTime(SETTLE_MS + 50); // settleMs passes — no alert
    expect(alerts).toHaveLength(0);
  });

  it('data during resize window is suppressed', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteResize('p1');

    watcher.noteData('p1'); // inside resize window
    vi.advanceTimersByTime(SETTLE_MS + 50); // settleMs passes but resize window still open
    expect(alerts).toHaveLength(0);
  });

  it('data during resize extends the window', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteResize('p1'); // window opens; closes after RESIZE_MS of silence

    vi.advanceTimersByTime(RESIZE_MS - 50); // 50ms before window closes
    watcher.noteData('p1'); // extends window by another RESIZE_MS

    vi.advanceTimersByTime(RESIZE_MS - 1); // still within the extended window
    expect(alerts).toHaveLength(0);

    vi.advanceTimersByTime(51); // window closes
    // Normal alerting resumes; p1 has no pending settle timer yet
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toHaveLength(1);
  });

  it('normal alerting resumes after resize window closes', () => {
    const { watcher, alerts } = makeWatcher();
    watcher.setFocus('p1');
    watcher.setFocus('p2');
    watcher.noteResize('p1');

    vi.advanceTimersByTime(RESIZE_MS + 10); // window closes
    watcher.noteData('p1');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(alerts).toEqual(['p1']);
  });

  it('resize on unknown pane creates the pane entry (no crash)', () => {
    const { watcher } = makeWatcher();
    expect(() => watcher.noteResize('never-seen')).not.toThrow();
  });
});
