import { describe, it, expect } from 'vitest';
import {
  leaf,
  split,
  computeLayout,
  collectDividers,
  replaceLeaf,
  removeLeaf,
  collectPanelIds,
  serializeLayout,
  deserializeLayout,
  DIVIDER_PX,
  MIN_RATIO,
  MAX_RATIO,
} from './split-layout.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function rect(node, x, y, w, h) {
  const out = [];
  computeLayout(node, x, y, w, h, (leaf, lx, ly, lw, lh) => {
    out.push({ id: leaf.panelId, x: lx, y: ly, w: lw, h: lh });
  });
  return out;
}

// ── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DIVIDER_PX is 4', () => expect(DIVIDER_PX).toBe(4));
  it('MIN_RATIO is 0.1', () => expect(MIN_RATIO).toBe(0.1));
  it('MAX_RATIO is 0.9', () => expect(MAX_RATIO).toBe(0.9));
});

// ── Constructors ─────────────────────────────────────────────────────────────

describe('leaf()', () => {
  it('produces a leaf node', () => {
    expect(leaf('a')).toEqual({ type: 'leaf', panelId: 'a' });
  });
});

describe('split()', () => {
  it('produces a split node', () => {
    const node = split('v', 0.5, leaf('a'), leaf('b'));
    expect(node).toEqual({
      type: 'split',
      direction: 'v',
      ratio: 0.5,
      children: [leaf('a'), leaf('b')],
    });
  });
});

// ── computeLayout ─────────────────────────────────────────────────────────────

describe('computeLayout()', () => {
  it('single leaf fills entire rect', () => {
    const result = rect(leaf('a'), 0, 0, 800, 600);
    expect(result).toEqual([{ id: 'a', x: 0, y: 0, w: 800, h: 600 }]);
  });

  it('vertical split: left/right panels sum to total minus divider', () => {
    const node = split('v', 0.5, leaf('L'), leaf('R'));
    const result = rect(node, 0, 0, 800, 600);
    expect(result).toHaveLength(2);
    const [l, r] = result;
    expect(l.id).toBe('L');
    expect(r.id).toBe('R');
    expect(l.x).toBe(0);
    expect(l.w + DIVIDER_PX + r.w).toBe(800);
    expect(r.x).toBe(l.w + DIVIDER_PX);
    expect(l.h).toBe(600);
    expect(r.h).toBe(600);
  });

  it('vertical split with 0.5 ratio distributes width evenly', () => {
    const node = split('v', 0.5, leaf('L'), leaf('R'));
    const result = rect(node, 0, 0, 804, 600);
    const [l, r] = result;
    // (804 - 4) * 0.5 = 400 each
    expect(l.w).toBe(400);
    expect(r.w).toBe(400);
  });

  it('horizontal split: top/bottom panels sum to total minus divider', () => {
    const node = split('h', 0.5, leaf('T'), leaf('B'));
    const result = rect(node, 0, 0, 800, 604);
    const [t, b] = result;
    expect(t.id).toBe('T');
    expect(b.id).toBe('B');
    expect(t.y).toBe(0);
    expect(t.h + DIVIDER_PX + b.h).toBe(604);
    expect(b.y).toBe(t.h + DIVIDER_PX);
    expect(t.w).toBe(800);
    expect(b.w).toBe(800);
  });

  it('non-zero origin is preserved', () => {
    const node = leaf('a');
    const result = rect(node, 10, 20, 300, 200);
    expect(result[0]).toEqual({ id: 'a', x: 10, y: 20, w: 300, h: 200 });
  });

  it('nested vertical then horizontal split', () => {
    const node = split('v', 0.5, split('h', 0.5, leaf('TL'), leaf('BL')), leaf('R'));
    const result = rect(node, 0, 0, 804, 604);
    expect(result).toHaveLength(3);
    const [tl, bl, r] = result;
    expect(tl.id).toBe('TL');
    expect(bl.id).toBe('BL');
    expect(r.id).toBe('R');
    // Left half: x=0, w=400; right half: x=404, w=400
    expect(tl.x).toBe(0);
    expect(r.x).toBe(404);
    // Top-left: h=300, bottom-left: h=300
    expect(tl.h + DIVIDER_PX + bl.h).toBe(604);
  });

  it('asymmetric ratio produces correct widths', () => {
    const node = split('v', 0.25, leaf('A'), leaf('B'));
    const result = rect(node, 0, 0, 800, 100);
    const [a, b] = result;
    const usable = 800 - DIVIDER_PX;
    expect(a.w).toBe(Math.round(usable * 0.25));
    expect(b.w).toBe(usable - a.w);
  });
});

// ── collectDividers ───────────────────────────────────────────────────────────

describe('collectDividers()', () => {
  it('leaf node returns empty array', () => {
    expect(collectDividers(leaf('a'), 0, 0, 800, 600)).toEqual([]);
  });

  it('single vertical split returns one divider', () => {
    const node = split('v', 0.5, leaf('L'), leaf('R'));
    const divs = collectDividers(node, 0, 0, 800, 600);
    expect(divs).toHaveLength(1);
    const d = divs[0];
    expect(d.direction).toBe('v');
    expect(d.w).toBe(DIVIDER_PX);
    expect(d.h).toBe(600);
    expect(d.x).toBe(Math.round((800 - DIVIDER_PX) * 0.5));
    expect(d.usableSize).toBe(800 - DIVIDER_PX);
  });

  it('single horizontal split returns one divider', () => {
    const node = split('h', 0.5, leaf('T'), leaf('B'));
    const divs = collectDividers(node, 0, 0, 800, 600);
    expect(divs).toHaveLength(1);
    const d = divs[0];
    expect(d.direction).toBe('h');
    expect(d.w).toBe(800);
    expect(d.h).toBe(DIVIDER_PX);
  });

  it('two nested splits return two dividers', () => {
    const node = split('v', 0.5, split('h', 0.5, leaf('TL'), leaf('BL')), leaf('R'));
    const divs = collectDividers(node, 0, 0, 800, 600);
    expect(divs).toHaveLength(2);
  });

  it('divider node reference matches the split node', () => {
    const inner = split('v', 0.5, leaf('A'), leaf('B'));
    const divs = collectDividers(inner, 0, 0, 800, 600);
    expect(divs[0].node).toBe(inner);
  });
});

// ── collectPanelIds ───────────────────────────────────────────────────────────

describe('collectPanelIds()', () => {
  it('single leaf returns [panelId]', () => {
    expect(collectPanelIds(leaf('a'))).toEqual(['a']);
  });

  it('split returns left-first depth-first order', () => {
    const node = split('v', 0.5, leaf('a'), leaf('b'));
    expect(collectPanelIds(node)).toEqual(['a', 'b']);
  });

  it('deep tree returns all ids in document order', () => {
    const node = split('v', 0.5,
      split('h', 0.5, leaf('1'), leaf('2')),
      split('h', 0.5, leaf('3'), leaf('4')),
    );
    expect(collectPanelIds(node)).toEqual(['1', '2', '3', '4']);
  });

  it('accumulates into provided array', () => {
    const existing = ['x'];
    collectPanelIds(leaf('a'), existing);
    expect(existing).toEqual(['x', 'a']);
  });
});

// ── replaceLeaf ───────────────────────────────────────────────────────────────

describe('replaceLeaf()', () => {
  it('replaces a leaf at root', () => {
    const result = replaceLeaf(leaf('a'), 'a', leaf('b'));
    expect(result).toEqual(leaf('b'));
  });

  it('no-op when panelId not found', () => {
    const tree = leaf('a');
    const result = replaceLeaf(tree, 'z', leaf('b'));
    expect(result).toBe(tree);
  });

  it('replaces left child', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    const result = replaceLeaf(tree, 'a', leaf('x'));
    expect(collectPanelIds(result)).toEqual(['x', 'b']);
  });

  it('replaces right child', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    const result = replaceLeaf(tree, 'b', leaf('x'));
    expect(collectPanelIds(result)).toEqual(['a', 'x']);
  });

  it('replaces leaf in nested tree', () => {
    const tree = split('v', 0.5,
      split('h', 0.5, leaf('1'), leaf('2')),
      leaf('3'),
    );
    const result = replaceLeaf(tree, '2', leaf('X'));
    expect(collectPanelIds(result)).toEqual(['1', 'X', '3']);
  });

  it('returns new tree (immutable — original unchanged)', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    const result = replaceLeaf(tree, 'a', leaf('x'));
    expect(collectPanelIds(tree)).toEqual(['a', 'b']);
    expect(collectPanelIds(result)).toEqual(['x', 'b']);
  });

  it('can replace leaf with a split node', () => {
    const tree = leaf('a');
    const replacement = split('v', 0.5, leaf('a'), leaf('new'));
    const result = replaceLeaf(tree, 'a', replacement);
    expect(collectPanelIds(result)).toEqual(['a', 'new']);
  });
});

// ── removeLeaf ────────────────────────────────────────────────────────────────

describe('removeLeaf()', () => {
  it('removing the only leaf returns null', () => {
    expect(removeLeaf(leaf('a'), 'a')).toBeNull();
  });

  it('not found returns original node', () => {
    const tree = leaf('a');
    expect(removeLeaf(tree, 'z')).toBe(tree);
  });

  it('removing left child collapses to right child', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    const result = removeLeaf(tree, 'a');
    expect(result).toEqual(leaf('b'));
  });

  it('removing right child collapses to left child', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    const result = removeLeaf(tree, 'b');
    expect(result).toEqual(leaf('a'));
  });

  it('removing deeply nested leaf collapses correctly', () => {
    const tree = split('v', 0.5,
      split('h', 0.5, leaf('1'), leaf('2')),
      leaf('3'),
    );
    // Remove '2' → left subtree collapses to leaf('1')
    const result = removeLeaf(tree, '2');
    expect(collectPanelIds(result)).toEqual(['1', '3']);
    // The split node that had '1' and '2' is now just leaf('1')
    expect(result.children[0]).toEqual(leaf('1'));
  });

  it('removing a leaf from three-panel layout leaves two panels', () => {
    const tree = split('v', 0.5,
      leaf('a'),
      split('v', 0.5, leaf('b'), leaf('c')),
    );
    const result = removeLeaf(tree, 'c');
    expect(collectPanelIds(result)).toEqual(['a', 'b']);
  });

  it('immutable: original tree unchanged after removal', () => {
    const tree = split('v', 0.5, leaf('a'), leaf('b'));
    removeLeaf(tree, 'a');
    expect(collectPanelIds(tree)).toEqual(['a', 'b']);
  });
});

// ── serializeLayout / deserializeLayout ──────────────────────────────────────

describe('serializeLayout()', () => {
  it('serializes a leaf with panel data', () => {
    const getPanel = (id) => ({ cwd: `/home/${id}`, shellProfileId: null });
    const result = serializeLayout(leaf('a'), getPanel);
    expect(result).toEqual({ type: 'leaf', cwd: '/home/a', shellProfileId: null });
  });

  it('serializes a split preserving structure', () => {
    const getPanel = (id) => ({ cwd: id });
    const tree = split('v', 0.33, leaf('a'), leaf('b'));
    const result = serializeLayout(tree, getPanel);
    expect(result).toEqual({
      type: 'split',
      direction: 'v',
      ratio: 0.33,
      children: [
        { type: 'leaf', cwd: 'a' },
        { type: 'leaf', cwd: 'b' },
      ],
    });
  });
});

describe('deserializeLayout()', () => {
  it('deserializes a leaf, calling makePanel with the data', () => {
    const calls = [];
    const makePanel = (data) => { calls.push(data); return 'newId'; };
    const result = deserializeLayout({ type: 'leaf', cwd: '/home' }, makePanel);
    expect(result).toEqual(leaf('newId'));
    expect(calls).toEqual([{ type: 'leaf', cwd: '/home' }]);
  });

  it('deserializes a split, assigning fresh panelIds to leaves', () => {
    let counter = 0;
    const makePanel = () => `p${++counter}`;
    const serialized = {
      type: 'split',
      direction: 'h',
      ratio: 0.6,
      children: [
        { type: 'leaf', cwd: '/a' },
        { type: 'leaf', cwd: '/b' },
      ],
    };
    const result = deserializeLayout(serialized, makePanel);
    expect(result.type).toBe('split');
    expect(result.direction).toBe('h');
    expect(result.ratio).toBe(0.6);
    expect(collectPanelIds(result)).toEqual(['p1', 'p2']);
  });
});

describe('serialize → deserialize roundtrip', () => {
  it('recreates the same structure with new panelIds', () => {
    const original = split('v', 0.5,
      split('h', 0.4, leaf('id1'), leaf('id2')),
      leaf('id3'),
    );
    const store = new Map();
    store.set('id1', { cwd: '/a' });
    store.set('id2', { cwd: '/b' });
    store.set('id3', { cwd: '/c' });

    const serialized = serializeLayout(original, (id) => store.get(id));

    let counter = 0;
    const restored = deserializeLayout(serialized, () => `new${++counter}`);

    // Structure preserved
    expect(restored.type).toBe('split');
    expect(restored.direction).toBe('v');
    expect(restored.ratio).toBe(0.5);
    expect(restored.children[0].type).toBe('split');
    expect(restored.children[0].direction).toBe('h');
    expect(collectPanelIds(restored)).toHaveLength(3);
  });
});
