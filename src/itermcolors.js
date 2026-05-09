// Utilities for parsing and generating .itermcolors (Apple plist XML) files
// and JSON colour scheme files.

const ANSI_KEYS = [
  'Ansi 0 Color', 'Ansi 1 Color', 'Ansi 2 Color',  'Ansi 3 Color',
  'Ansi 4 Color', 'Ansi 5 Color', 'Ansi 6 Color',  'Ansi 7 Color',
  'Ansi 8 Color', 'Ansi 9 Color', 'Ansi 10 Color', 'Ansi 11 Color',
  'Ansi 12 Color', 'Ansi 13 Color', 'Ansi 14 Color', 'Ansi 15 Color',
];

function compToHex(c) {
  const h = Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16);
  return h.length === 1 ? '0' + h : h;
}

function rgbToHex(r, g, b) {
  return '#' + compToHex(r) + compToHex(g) + compToHex(b);
}

function hexToComps(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function parsePlistDict(dict) {
  const result = {};
  const keys = dict.querySelectorAll(':scope > key');
  for (const key of keys) {
    const val = key.nextElementSibling;
    if (!val) continue;
    const name = key.textContent.trim();
    const tag  = val.tagName.toLowerCase();
    if (tag === 'dict')    result[name] = parsePlistDict(val);
    else if (tag === 'real' || tag === 'integer') result[name] = parseFloat(val.textContent);
    else if (tag === 'string')  result[name] = val.textContent;
    else if (tag === 'true')    result[name] = true;
    else if (tag === 'false')   result[name] = false;
  }
  return result;
}

function dictToHex(d) {
  if (!d || typeof d !== 'object') return null;
  return rgbToHex(d['Red Component'] ?? 0, d['Green Component'] ?? 0, d['Blue Component'] ?? 0);
}

export function parseItermcolors(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  const root = doc.querySelector('plist > dict');
  if (!root) return null;
  const data = parsePlistDict(root);
  return {
    background:  dictToHex(data['Background Color']) ?? '#111111',
    foreground:  dictToHex(data['Foreground Color']) ?? '#d9d4c7',
    selectionBg: dictToHex(data['Selection Color'])  ?? '#2a2a2a',
    ansi: ANSI_KEYS.map(k => dictToHex(data[k]) ?? '#000000'),
  };
}

export function generateItermcolors(palette) {
  function entry(key, hex) {
    const { r, g, b } = hexToComps(hex);
    return `\n\t<key>${key}</key>\n\t<dict>\n\t\t<key>Alpha Component</key><real>1</real>\n\t\t<key>Blue Component</key><real>${b.toFixed(10)}</real>\n\t\t<key>Color Space</key><string>sRGB</string>\n\t\t<key>Green Component</key><real>${g.toFixed(10)}</real>\n\t\t<key>Red Component</key><real>${r.toFixed(10)}</real>\n\t</dict>`;
  }
  const ansiEntries = ANSI_KEYS.map((k, i) => entry(k, palette.ansi[i])).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>${ansiEntries}${entry('Background Color', palette.background)}${entry('Foreground Color', palette.foreground)}${entry('Selection Color', palette.selectionBg)}\n</dict>\n</plist>`;
}
