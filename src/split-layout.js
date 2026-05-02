/**
 * split-layout.js — pure-function binary tree layout engine.
 * No DOM dependencies; fully testable in isolation.
 *
 * Node shapes:
 *   { type: 'leaf', panelId: string }
 *   { type: 'split', direction: 'v'|'h', ratio: number, children: [NodeA, NodeB] }
 *
 * direction 'v' = vertical divider (left/right split)
 * direction 'h' = horizontal divider (top/bottom split)
 * ratio = fraction of total space given to children[0], in [MIN_RATIO, MAX_RATIO]
 */

export const DIVIDER_PX = 4;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

// ── Constructors ─────────────────────────────────────────────────────────────

export function leaf(panelId) {
  return { type: 'leaf', panelId };
}

export function split(direction, ratio, first, second) {
  return { type: 'split', direction, ratio, children: [first, second] };
}

// ── Layout computation ───────────────────────────────────────────────────────

/**
 * Recursively visit each leaf node with its pixel rect.
 * @param {object} node
 * @param {number} x Left edge of this node's allocated rect
 * @param {number} y Top edge
 * @param {number} w Width
 * @param {number} h Height
 * @param {function} visitor  (leafNode, x, y, w, h) => void
 */
export function computeLayout(node, x, y, w, h, visitor) {
  if (node.type === 'leaf') {
    visitor(node, x, y, w, h);
    return;
  }
  const { direction, ratio, children } = node;
  const [a, b] = children;
  if (direction === 'v') {
    const wA = Math.round((w - DIVIDER_PX) * ratio);
    const wB = w - DIVIDER_PX - wA;
    computeLayout(a, x, y, wA, h, visitor);
    computeLayout(b, x + wA + DIVIDER_PX, y, wB, h, visitor);
  } else {
    const hA = Math.round((h - DIVIDER_PX) * ratio);
    const hB = h - DIVIDER_PX - hA;
    computeLayout(a, x, y, w, hA, visitor);
    computeLayout(b, x, y + hA + DIVIDER_PX, w, hB, visitor);
  }
}

/**
 * Collect divider descriptors for rendering and drag handling.
 * Each entry: { node, direction, x, y, w, h }
 * where (x,y,w,h) is the divider's pixel rect on the stage.
 */
export function collectDividers(node, x, y, w, h, out = []) {
  if (node.type === 'leaf') return out;
  const { direction, ratio, children } = node;
  const [a, b] = children;
  if (direction === 'v') {
    const wA = Math.round((w - DIVIDER_PX) * ratio);
    // usableSize = total width minus the divider bar; ratio = wA / usableSize
    out.push({ node, direction, x: x + wA, y, w: DIVIDER_PX, h, usableSize: w - DIVIDER_PX });
    collectDividers(a, x, y, wA, h, out);
    collectDividers(b, x + wA + DIVIDER_PX, y, w - DIVIDER_PX - wA, h, out);
  } else {
    const hA = Math.round((h - DIVIDER_PX) * ratio);
    out.push({ node, direction, x, y: y + hA, w, h: DIVIDER_PX, usableSize: h - DIVIDER_PX });
    collectDividers(a, x, y, w, hA, out);
    collectDividers(b, x, y + hA + DIVIDER_PX, w, h - DIVIDER_PX - hA, out);
  }
  return out;
}

// ── Tree operations (immutable) ───────────────────────────────────────────────

/**
 * Return a new tree with the leaf for panelId replaced by replacement.
 * Returns node unchanged if panelId is not found.
 */
export function replaceLeaf(node, panelId, replacement) {
  if (node.type === 'leaf') {
    return node.panelId === panelId ? replacement : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], panelId, replacement),
      replaceLeaf(node.children[1], panelId, replacement),
    ],
  };
}

/**
 * Return a new tree with the leaf for panelId removed.
 * When a split node loses one child, the remaining child takes its place.
 * Returns null if the whole tree is removed.
 */
export function removeLeaf(node, panelId) {
  if (node.type === 'leaf') {
    return node.panelId === panelId ? null : node;
  }
  const newA = removeLeaf(node.children[0], panelId);
  const newB = removeLeaf(node.children[1], panelId);
  if (newA === null) return newB;
  if (newB === null) return newA;
  return { ...node, children: [newA, newB] };
}

/**
 * Collect all panelIds in document order (depth-first, left before right).
 */
export function collectPanelIds(node, out = []) {
  if (node.type === 'leaf') {
    out.push(node.panelId);
  } else {
    collectPanelIds(node.children[0], out);
    collectPanelIds(node.children[1], out);
  }
  return out;
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize a layout tree for persistence.
 * Leaf nodes are replaced with panel data from getPanel(panelId).
 */
export function serializeLayout(node, getPanel) {
  if (node.type === 'leaf') {
    const data = getPanel(node.panelId);
    return { type: 'leaf', ...data };
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    children: [
      serializeLayout(node.children[0], getPanel),
      serializeLayout(node.children[1], getPanel),
    ],
  };
}

/**
 * Deserialize a layout tree from persistence.
 * Leaf nodes get fresh panelIds via makePanel(leafData) which returns a panelId.
 */
export function deserializeLayout(node, makePanel) {
  if (node.type === 'leaf') {
    const panelId = makePanel(node);
    return { type: 'leaf', panelId };
  }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    children: [
      deserializeLayout(node.children[0], makePanel),
      deserializeLayout(node.children[1], makePanel),
    ],
  };
}
