// Synchronized output gate (DEC private mode 2026).
//
// xterm.js does not implement mode 2026. TUI apps that use it (Claude Code,
// newer Ink/zellij/notcurses output) emit:
//   ESC [ ? 2026 h   begin synchronized update (BSU)
//   ...full frame...
//   ESC [ ? 2026 l   end synchronized update (ESU)
// expecting the terminal to present the frame atomically. Without support,
// xterm paints whatever happens to be parsed when the next animation frame
// fires, showing torn half-frames during heavy redraws.
//
// xterm exposes no public way to pause its renderer, so we gate the DATA
// instead: chunks arriving between BSU and ESU are queued and released in one
// burst when ESU arrives, so the parser crosses frame boundaries atomically
// and the renderer never observes a partial frame.
//
// Robustness:
// - Markers split across chunk boundaries are detected via a small carry tail
//   (markers are 8 chars; the carry keeps at most 7, so a marker can never be
//   counted twice across scans).
// - A flush timer bounds how long output is held if an app dies inside a sync
//   block; the queue size is capped so a flooding app cannot exhaust memory.
//   Either event degrades to pass-through until the block closes (atomicity
//   is already lost at that point), then normal gating resumes.
// - Marker sequences are passed through to xterm unmodified (it ignores the
//   unknown mode), so downstream consumers keep seeing the full byte stream.

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
// The longest prefix of a marker that can dangle unfinished at a chunk
// boundary. Both markers have the same length.
const CARRY_MAX = BSU.length - 1;

export class SyncOutputGate {
  // write: (chunk: string) => void — called for every chunk, in feed() order,
  // exactly once per chunk (immediately, or on flush).
  constructor(write, { flushTimeoutMs = 1000, maxQueuedChars = 4 * 1024 * 1024 } = {}) {
    this._write = write;
    this._flushTimeoutMs = flushTimeoutMs;
    this._maxQueuedChars = maxQueuedChars;
    this._active = false;
    this._degraded = false;
    this._queue = [];
    this._queued = 0;
    this._carry = '';
    this._timer = null;
  }

  feed(data) {
    const scan = this._carry + data;
    this._carry = scan.slice(Math.max(0, scan.length - CARRY_MAX));

    let active = this._active;
    let sawMarker = false;
    let idx = 0;
    for (;;) {
      const b = scan.indexOf(BSU, idx);
      const e = scan.indexOf(ESU, idx);
      if (b === -1 && e === -1) break;
      const isBsu = e === -1 || (b !== -1 && b < e);
      idx = (isBsu ? b : e) + BSU.length;
      active = isBsu;
      sawMarker = true;
    }

    // A closing ESU ends any degraded (timeout/overflow) episode.
    if (sawMarker && !active) this._degraded = false;

    const overlapsBlock = this._active || active;
    this._active = active;

    if (!overlapsBlock || this._degraded) {
      // No sync block in play (a block fully contained in this chunk is
      // already atomic in a single write), or atomicity was already lost.
      this._write(data);
      return;
    }

    this._queue.push(data);
    this._queued += data.length;

    if (!active) {
      // ESU closed the block: release the whole frame atomically.
      this._flush();
    } else if (this._queued > this._maxQueuedChars) {
      this._degraded = true;
      this._flush();
    } else if (this._timer === null) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._degraded = true;
        this._flush();
      }, this._flushTimeoutMs);
    }
  }

  _flush() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const queue = this._queue;
    this._queue = [];
    this._queued = 0;
    for (const chunk of queue) this._write(chunk);
  }

  // Drop all held state (PTY session ended mid-block — its partial frame is
  // meaningless). Returns the number of dropped chars so the caller can fix
  // up any byte accounting tied to the write callback.
  reset() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const dropped = this._queued;
    this._queue = [];
    this._queued = 0;
    this._active = false;
    this._degraded = false;
    this._carry = '';
    return dropped;
  }
}
