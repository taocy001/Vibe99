import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncOutputGate } from './sync-output.js';

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';

describe('SyncOutputGate', () => {
  let written;
  let gate;

  const mkGate = (opts) => new SyncOutputGate((chunk) => written.push(chunk), opts);

  beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    gate = mkGate();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes plain chunks straight through', () => {
    gate.feed('hello');
    gate.feed('world');
    expect(written).toEqual(['hello', 'world']);
  });

  it('passes a fully contained sync block straight through (single write is atomic)', () => {
    const chunk = `before${BSU}frame${ESU}after`;
    gate.feed(chunk);
    expect(written).toEqual([chunk]);
  });

  it('holds chunks after BSU and releases them all on ESU', () => {
    gate.feed(`prompt${BSU}top half`);
    gate.feed('bottom half');
    expect(written).toEqual([]);
    gate.feed(`${ESU}done`);
    expect(written).toEqual([`prompt${BSU}top half`, 'bottom half', `${ESU}done`]);
  });

  it('resumes pass-through after a block closes', () => {
    gate.feed(BSU);
    gate.feed(ESU);
    gate.feed('plain');
    expect(written).toEqual([BSU, ESU, 'plain']);
  });

  it('detects a marker split across chunk boundaries', () => {
    gate.feed('x\x1b[?20');
    expect(written).toEqual(['x\x1b[?20']); // no complete marker yet — passes through
    gate.feed('26hheld');
    expect(written).toEqual(['x\x1b[?20']); // BSU completed — now holding
    gate.feed(ESU);
    expect(written).toEqual(['x\x1b[?20', '26hheld', ESU]);
  });

  it('does not double-count a marker that ends exactly at a chunk boundary', () => {
    gate.feed(`a${BSU}`);   // BSU detected here — holding starts
    gate.feed(ESU);          // carry contains the BSU tail; must not re-match
    gate.feed('plain');
    expect(written).toEqual([`a${BSU}`, ESU, 'plain']);
  });

  it('uses the LAST marker in a chunk to decide state', () => {
    gate.feed(`${BSU}a${ESU}b${BSU}held`);
    expect(written).toEqual([]); // final state: active
    gate.feed(ESU);
    expect(written).toEqual([`${BSU}a${ESU}b${BSU}held`, ESU]);
  });

  it('flushes on timeout and degrades to pass-through until the block closes', () => {
    gate.feed(`${BSU}stuck frame`);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(written).toEqual([`${BSU}stuck frame`]);
    gate.feed('more output');           // degraded: passes through
    expect(written).toEqual([`${BSU}stuck frame`, 'more output']);
    gate.feed(`${ESU}tail`);            // block closes — degradation ends
    expect(written).toEqual([`${BSU}stuck frame`, 'more output', `${ESU}tail`]);
    gate.feed(`${BSU}next`);            // gating works again
    expect(written).toHaveLength(3);
    gate.feed(ESU);
    expect(written).toEqual([
      `${BSU}stuck frame`, 'more output', `${ESU}tail`, `${BSU}next`, ESU,
    ]);
  });

  it('flushes when the queue cap is exceeded', () => {
    gate = mkGate({ maxQueuedChars: 10 });
    gate.feed(`${BSU}0123456789X`); // > 10 chars queued
    expect(written).toEqual([`${BSU}0123456789X`]);
    gate.feed('flood');             // degraded passthrough
    expect(written).toEqual([`${BSU}0123456789X`, 'flood']);
  });

  it('clears the flush timer when ESU arrives in time', () => {
    gate.feed(`${BSU}frame`);
    gate.feed(ESU);
    expect(written).toEqual([`${BSU}frame`, ESU]);
    vi.advanceTimersByTime(5000);   // timer must not fire again / double-write
    expect(written).toEqual([`${BSU}frame`, ESU]);
  });

  it('reset() drops held chunks and reports the dropped char count', () => {
    gate.feed(`${BSU}held frame`);
    const dropped = gate.reset();
    expect(dropped).toBe(BSU.length + 'held frame'.length);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(5000);   // timer cancelled — nothing flushes
    expect(written).toEqual([]);
    gate.feed('plain');             // state fully reset
    expect(written).toEqual(['plain']);
  });

  it('a stray ESU without BSU passes through', () => {
    gate.feed(`text${ESU}more`);
    expect(written).toEqual([`text${ESU}more`]);
  });
});
