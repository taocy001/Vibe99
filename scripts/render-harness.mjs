// Autonomous frontend render-stability harness.
//
// Boots the REAL render pipeline (renderer.js + xterm + WebglAddon +
// GraphemeUnicodeAddon) in headless Chrome with SwiftShader WebGL — a separate
// process that never touches a running Vibe99 session — feeds it stress input,
// and asserts pixel self-consistency directly off the WebGL canvas. This is how
// the frontend is debugged/verified without the Tauri app.
//
//   npm run harness              # run all scenarios, exit non-zero on garble
//   node scripts/render-harness.mjs atlas 60
//
// Prereqs: `npm run vite:dev` must be serving on :1420, and Playwright's
// Chromium must be cached (npx playwright install chromium, already present on
// this machine). Runs at dpr=1: headless SwiftShader mis-scales the WebGL canvas
// at dpr>1 (a harness artifact — verified fine on real Metal GPU), while the
// garble modes we guard against are dpr-independent.
import pw from 'playwright-core';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { chromium } = pw;
const URL = 'http://localhost:1420/harness.html';

function findChromium() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dir = readdirSync(cache).find((d) => d.startsWith('chromium-') && !d.includes('headless_shell'));
  if (!dir) throw new Error('Playwright chromium not found; run: npx playwright install chromium');
  return join(cache, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents/MacOS/Google Chrome for Testing');
}

const only = process.argv[2];
const rounds = Number(process.argv[3] || 40);
const log = (...a) => console.log(...a);

const browser = await chromium.launch({
  executablePath: findChromium(), headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

async function newHarness(dsf = 1) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dsf });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__h?.nodes?.size > 0 && window.__h.node()?.terminal?.cols > 0, { timeout: 20000 });
  const api = {
    page, errors,
    feed: (d, id) => page.evaluate(([d, id]) => window.__h.feed(d, id), [d, id]),
    check: (id) => page.evaluate((id) => window.__h.checkUniform(id), id),
    atlas: (id) => page.evaluate((id) => window.__h.atlas(id), id),
    paneIds: () => page.evaluate(() => window.__h.paneIds),
    dims: (id) => page.evaluate((id) => { const t = window.__h.node(id).terminal; return { cols: t.cols, rows: t.rows }; }, id),
    rAF: () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))),
    close: () => page.close(),
  };
  return api;
}

// ── scenarios: each returns { name, garble, detail } ──────────────────────────
const scenarios = {};

// Flood a stable-header pane and confirm the header never garbles through many
// atlas page merges (the "long session garbling" failure the atlas fix targets).
scenarios.atlas = async () => {
  const h = await newHarness();
  const { cols, rows } = await h.dims();
  await h.feed('\x1b[2J\x1b[H\x1b[0m');
  for (let r = 0; r < 8; r++) await h.feed(`\x1b[${r + 1};1H` + 'M'.repeat(cols));
  await h.feed(`\x1b[10;${rows}r`);
  await h.rAF();
  let idx = 0, maxPages = 1, worst = 0;
  for (let round = 0; round < rounds; round++) {
    let batch = `\x1b[${rows};1H`;
    for (let line = 0; line < 60; line++) {
      batch += `\r\n\x1b[38;5;${16 + (idx % 200)}m`;
      for (let i = 0; i < cols; i++) batch += String.fromCodePoint(0x4E00 + ((idx * 7 + i * 13) % 6000));
      idx++;
    }
    await h.feed(batch); await h.rAF();
    const a = await h.atlas(); if (a) maxPages = Math.max(maxPages, a.pageCount);
    const c = await h.check(); worst = Math.max(worst, c.mismatches.length);
  }
  await h.close();
  return { name: 'atlas', garble: worst > 0, detail: `maxPages=${maxPages} worstMismatch=${worst}` };
};

// Three panes flood a SHARED atlas concurrently (real "live preview" usage).
scenarios.multi = async () => {
  const h = await newHarness();
  const ids = await h.paneIds();
  const chs = ['W', 'H', 'N'];
  for (let k = 0; k < ids.length; k++) {
    const { cols, rows } = await h.dims(ids[k]);
    await h.feed('\x1b[2J\x1b[H\x1b[0m', ids[k]);
    for (let r = 0; r < 8; r++) await h.feed(`\x1b[${r + 1};1H` + chs[k].repeat(cols), ids[k]);
    await h.feed(`\x1b[10;${rows}r`, ids[k]);
  }
  await h.rAF();
  let worst = 0;
  const idxs = [0, 2000, 4000];
  for (let round = 0; round < rounds; round++) {
    await h.page.evaluate(([ids, idxs]) => {
      for (let k = 0; k < ids.length; k++) {
        const t = window.__h.node(ids[k]).terminal, cols = t.cols;
        let batch = `\x1b[${t.rows};1H`;
        for (let line = 0; line < 40; line++) {
          batch += '\r\n\x1b[38;5;' + (16 + (idxs[k] % 200)) + 'm';
          for (let i = 0; i < cols; i++) batch += String.fromCodePoint(0x4E00 + ((idxs[k] * 7 + i * 13) % 6000));
          idxs[k]++;
        }
        window.__h.feed(batch, ids[k]);
      }
    }, [ids, idxs]);
    await h.rAF();
    for (const id of ids) worst = Math.max(worst, (await h.check(id)).mismatches.length);
  }
  await h.close();
  return { name: 'multi', garble: worst > 0, detail: `panes=${ids.length} worstMismatch=${worst}` };
};

// Alt-screen TUI frames + viewport resizes; verify a uniform repaint stays clean.
scenarios.churn = async () => {
  const h = await newHarness();
  const sizes = [[1200, 800], [900, 700], [1400, 900], [1100, 600], [1300, 850]];
  let worst = 0;
  for (let round = 0; round < Math.min(rounds, 25); round++) {
    const [w, hh] = sizes[round % sizes.length];
    await h.page.setViewportSize({ width: w, height: hh });
    await h.page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await h.page.evaluate(() => {
      const t = window.__h.node().terminal, cols = t.cols, rows = t.rows;
      let s = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?2026h';
      for (let r = 0; r < rows; r++) { s += `\x1b[${r + 1};1H`; for (let c = 0; c < cols; c++) s += String.fromCodePoint(0x4E00 + ((r * 31 + c * 17) % 5000)); }
      s += '\x1b[?2026l'; window.__h.feed(s); window.__h.feed('\x1b[?1049l');
    });
    await h.rAF();
    await h.page.evaluate(() => {
      const t = window.__h.node().terminal, cols = t.cols;
      let s = '\x1b[2J\x1b[H\x1b[0m'; for (let r = 0; r < Math.min(t.rows, 20); r++) s += `\x1b[${r + 1};1H` + 'K'.repeat(cols);
      window.__h.feed(s);
    });
    await h.rAF();
    worst = Math.max(worst, (await h.check()).mismatches.length);
  }
  await h.close();
  return { name: 'churn', garble: worst > 0, detail: `worstMismatch=${worst}` };
};

// Force a WebGL canvas dpr-desync (the garble/black failure mode) and confirm
// the renderer's self-heal guard repairs it on the next resize event.
scenarios.selfheal = async () => {
  const h = await newHarness();
  await h.feed('\x1b[2J\x1b[H\x1b[38;5;82mSELF-HEAL 你好世界 ABCDEF\x1b[0m\r\n');
  await h.rAF();
  await h.page.evaluate(() => { const gl = window.__h.node().webglAddon._renderer._gl; gl.canvas.width >>= 1; gl.canvas.height >>= 1; window.__h.node().terminal.refresh(0, window.__h.node().terminal.rows - 1); });
  await h.rAF();
  const black = await h.page.evaluate(() => { const gl = window.__h.node().webglAddon._renderer._gl, cv = gl.canvas; const px = new Uint8Array(4 * cv.width * cv.height); gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px); let nb = 0; for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) nb++; return nb; });
  await h.page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await h.rAF(); await h.page.waitForTimeout(150);
  const healed = await h.page.evaluate(() => { const rnd = window.__h.node().webglAddon._renderer, gl = rnd._gl, cv = gl.canvas, dev = rnd.dimensions.device.canvas; const px = new Uint8Array(4 * cv.width * cv.height); gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px); let nb = 0; for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) nb++; return { synced: cv.width === dev.width && cv.height === dev.height, nb }; });
  await h.close();
  const ok = black === 0 && healed.synced && healed.nb > 0;
  return { name: 'selfheal', garble: !ok, detail: `desyncedBlack=${black === 0} healed=${healed.synced} pixels=${healed.nb}` };
};

const toRun = only && scenarios[only] ? [only] : Object.keys(scenarios);
let failed = 0;
for (const name of toRun) {
  try {
    const r = await scenarios[name]();
    const status = r.garble ? 'GARBLE ❌' : 'clean  ✅';
    log(`${status}  ${r.name.padEnd(9)} ${r.detail}`);
    if (r.garble) failed++;
  } catch (e) {
    log(`ERROR  ⚠️  ${name}: ${e.message}`);
    failed++;
  }
}
await browser.close();
log(failed ? `\n${failed} scenario(s) failed` : '\nall render-stability scenarios clean');
process.exit(failed ? 1 : 0);
