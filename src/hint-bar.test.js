import { describe, it, expect } from 'vitest';
import { renderHintBar } from './hint-bar.js';

function entry(mode, chord, action, hint, id) {
  return { mode, chord, action, hint, id };
}

describe('renderHintBar - allowedActions', () => {
  it('returns empty hintsHtml when allowedActions is empty string', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', 'copy', 'copy')];
    const { hintsHtml, modeLabel } = renderHintBar(km, 'terminal', 'bash');
    expect(renderHintBar(km, 'terminal', 'bash', 'linux', '').hintsHtml).toBe('');
  });

  it('returns only allowed actions', () => {
    const km = [
      entry('*', 'Ctrl+C', 'copy', 'copy', 'copy'),
      entry('*', 'Ctrl+V', 'paste', 'paste', 'paste'),
    ];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux', 'copy');
    expect(hintsHtml).toContain('Ctrl+C');
    expect(hintsHtml).not.toContain('Ctrl+V');
  });

  it('returns all when allowedActions is null', () => {
    const km = [
      entry('*', 'Ctrl+C', 'copy', 'copy', 'copy'),
      entry('*', 'Ctrl+V', 'paste', 'paste', 'paste'),
    ];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux', null);
    expect(hintsHtml).toContain('Ctrl+C');
    expect(hintsHtml).toContain('Ctrl+V');
  });

  it('returns all when allowedActions is star', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', 'copy', 'copy')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux', '*');
    expect(hintsHtml).toContain('Ctrl+C');
  });
});

describe('renderHintBar - modeLabel', () => {
  it('uses focusedPaneLabel in terminal mode', () => {
    const { modeLabel } = renderHintBar([], 'terminal', 'vim');
    expect(modeLabel).toBe('vim');
  });

  it('falls back to terminal label when no pane label', () => {
    const { modeLabel } = renderHintBar([], 'terminal', '');
    expect(typeof modeLabel).toBe('string');
    expect(modeLabel.length).toBeGreaterThan(0);
  });

  it('shows navigation mode label in nav mode', () => {
    const { modeLabel } = renderHintBar([], 'nav', 'vim');
    expect(typeof modeLabel).toBe('string');
    expect(modeLabel.length).toBeGreaterThan(0);
  });
});

describe('renderHintBar - mode filtering', () => {
  it('shows * mode entries in terminal mode', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', 'copy', 'copy')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toContain('copy');
  });

  it('hides nav mode entries in terminal mode', () => {
    const km = [entry('nav', 'h', 'moveLeft', 'h prev', 'moveLeft')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toBe('');
  });

  it('shows nav mode entries in nav mode', () => {
    const km = [entry('nav', 'h', 'moveLeft', 'h prev', 'moveLeft')];
    const { hintsHtml } = renderHintBar(km, 'nav', '', 'linux');
    expect(hintsHtml).toContain('prev');
  });

  it('hides entries without hint text', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', '', 'copy')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toBe('');
  });
});

describe('renderHintBar - chord display (formatChordForHint)', () => {
  it('displays Ctrl+C on linux', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', 'copy', 'copy')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toContain('Ctrl+C');
  });

  it('BUG: Cmd+B on linux must display as Cmd+B, not Ctrl+B', () => {
    // formatChordForHint conflates ctrl/cmd/meta into a single branch,
    // so Cmd+B on linux renders as "Ctrl+B" — wrong and misleading because
    // Ctrl and Cmd are intentionally distinct in this codebase.
    const km = [entry('*', 'Cmd+B', 'test', 'test', 'test')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toContain('Cmd+B');
    expect(hintsHtml).not.toContain('Ctrl+B');
  });

  it('BUG: Ctrl+B on darwin must display as ^B, not ⌘B', () => {
    // Same conflation: on Mac, both Ctrl+B and Cmd+B render as ⌘B.
    // Ctrl on Mac should be ^ (caret), not ⌘.
    const km = [entry('*', 'Ctrl+B', 'test', 'test', 'test')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'darwin');
    expect(hintsHtml).toContain('^B');
    expect(hintsHtml).not.toContain('⌘B');
  });

  it('Cmd+T on darwin displays as ⌘T', () => {
    const km = [entry('*', 'Cmd+T', 'newTab', 'new tab', 'newTab')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'darwin');
    expect(hintsHtml).toContain('⌘T');
  });

  it('digit range 1..9 displays as 1-9', () => {
    const km = [entry('*', '1..9', 'selectPane', 'select pane', 'selectPane')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).toContain('1-9');
  });

  it('prefers single-char alternative over arrow key', () => {
    const km = [entry('nav', 'h|ArrowLeft', 'moveLeft', 'h left', 'moveLeft')];
    const { hintsHtml } = renderHintBar(km, 'nav', '', 'linux');
    expect(hintsHtml).toContain('h');
  });

  it('escapes html special chars in hint text', () => {
    const km = [entry('*', 'Ctrl+C', 'copy', '<copy> & "paste"', 'copy')];
    const { hintsHtml } = renderHintBar(km, 'terminal', '', 'linux');
    expect(hintsHtml).not.toContain('<copy>');
    expect(hintsHtml).toContain('&lt;copy&gt;');
    expect(hintsHtml).toContain('&amp;');
    expect(hintsHtml).toContain('&quot;');
  });
});

describe('renderHintBar - cycleRecent mutation BUG', () => {
  it('BUG: calling renderHintBar must not mutate the original keymap entry hint', () => {
    // When both cycleRecent and cycleRecentReverse exist, renderHintBar rewrites
    // cycleEntry.hint on the object reference inside the keymap array.
    // After the call, the original keymap entry is permanently changed.
    const cycleEntry = entry('*', 'Ctrl+Tab', 'cycleRecent', 'original hint', 'cycleRecent');
    const reverseEntry = entry('*', 'Ctrl+Shift+Tab', 'cycleRecentReverse', 'reverse', 'cycleRecentReverse');
    const km = [cycleEntry, reverseEntry];
    const originalHint = cycleEntry.hint;
    renderHintBar(km, 'terminal', '', 'linux');
    expect(cycleEntry.hint).toBe(originalHint);
  });
});

describe('renderHintBar - nav mode merging', () => {
  it('merges two entries with same action into key/key desc format', () => {
    const km = [
      entry('nav', 'h', 'moveLeft', 'h prev', 'moveLeft1'),
      entry('nav', 'ArrowLeft', 'moveLeft', 'ArrowLeft prev', 'moveLeft2'),
    ];
    const { hintsHtml } = renderHintBar(km, 'nav', '', 'linux');
    expect(hintsHtml).toContain('h/ArrowLeft');
  });

  it('preserves first-occurrence order after merge', () => {
    const km = [
      entry('nav', 'h', 'moveLeft', 'h left', 'ml1'),
      entry('nav', 'l', 'moveRight', 'l right', 'mr1'),
      entry('nav', 'ArrowLeft', 'moveLeft', 'ArrowLeft left', 'ml2'),
    ];
    const { hintsHtml } = renderHintBar(km, 'nav', '', 'linux');
    const leftIdx = hintsHtml.indexOf('left');
    const rightIdx = hintsHtml.indexOf('right');
    expect(leftIdx).toBeLessThan(rightIdx);
  });
});
