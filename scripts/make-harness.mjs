// Generates src/harness.html from src/index.html by injecting the render-debug
// harness bridge (src/harness-inject.js) as an ordered module script that runs
// before renderer.js. Kept as a generator so the harness never drifts from the
// real index.html DOM. Run: node scripts/make-harness.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'src/index.html'), 'utf8');

const marker = '<script type="module" src="./renderer.js"></script>';
if (!html.includes(marker)) throw new Error('make-harness: renderer.js script tag not found');

const out = html
  .replace('<title>Vibe99</title>', '<title>Vibe99 — render harness</title>')
  .replace(marker, '<script type="module" src="./harness-inject.js"></script>\n    ' + marker);

writeFileSync(join(root, 'src/harness.html'), out);
console.log('wrote src/harness.html');
