'use strict';
// Draws a comic page for the tests: two panels with screentone, a tall bubble of vertical
// Japanese, a wide bubble of English, and an empty white box that is not a bubble.
// Japanese needs a font with Japanese glyphs; one is looked for on this machine and checked
// by actually drawing with it. Without one, the tall bubble holds stacked Latin capitals
// instead (same shape of ink), and `cjk` says so, for the tests that need the real thing.
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const WIN = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
const CJK_FONTS = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  path.join(WIN, 'Fonts', 'YuGothB.ttc'), path.join(WIN, 'Fonts', 'YuGothM.ttc'), path.join(WIN, 'Fonts', 'meiryo.ttc'), path.join(WIN, 'Fonts', 'msgothic.ttc'),
  path.join(WIN, 'Fonts', 'msyh.ttc'), path.join(WIN, 'Fonts', 'msyhbd.ttc'), path.join(WIN, 'Fonts', 'simsun.ttc'), path.join(WIN, 'Fonts', 'malgun.ttf'),
  '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf',
];

// Whether `family` really draws Japanese: two different characters must both leave ink and
// must not come out as the same box (the "tofu" a font draws for glyphs it lacks).
function drawsJapanese(family) {
  const ink = (ch) => {
    const c = createCanvas(40, 40), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 40, 40); x.fillStyle = '#000'; x.font = `bold 30px ${family}`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 20, 20);
    const d = x.getImageData(0, 0, 40, 40).data; let n = 0; const bits = [];
    for (let i = 0; i < d.length; i += 4) { const on = d[i] < 128; if (on) n++; bits.push(on ? 1 : 0); }
    return { n, bits: bits.join('') };
  };
  const a = ink('お'), b = ink('ま');
  return a.n > 20 && b.n > 20 && a.bits !== b.bits;
}

let cjkFamily = '';
for (const f of (process.env.RETOLD_TEST_NO_CJK ? [] : CJK_FONTS)) {
  if (!fs.existsSync(f)) continue;
  try { GlobalFonts.registerFromPath(f, 'TestCJK'); } catch { continue; }
  if (drawsJapanese('TestCJK')) { cjkFamily = 'TestCJK'; break; }
}
if (!cjkFamily && !process.env.RETOLD_TEST_NO_CJK && drawsJapanese('sans-serif')) cjkFamily = 'sans-serif';
const cjk = Boolean(cjkFamily);

function drawPage({ W = 900, H = 1300, japanese = 'おまえはもう死んでいる', english = ['WHAT DID YOU', 'JUST SAY?!'] } = {}) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#999'; ctx.fillRect(40, 40, 820, 560); ctx.fillRect(40, 640, 820, 620);
  ctx.fillStyle = '#000';
  for (let y = 60; y < 1240; y += 6) for (let x = 60; x < 840; x += 6) if ((x + y) % 12 === 0) ctx.fillRect(x, y, 2, 2);
  ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.strokeRect(40, 40, 820, 560); ctx.strokeRect(40, 640, 820, 620);
  const bubble = (cx, cy, rx, ry) => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.stroke(); };
  bubble(680, 220, 130, 160);
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // Top to bottom, columns right to left: Japanese, or stacked capitals when no font draws it.
  const text = cjk ? japanese : 'YOUAREDEADX'.slice(0, japanese.length);
  ctx.font = cjk ? `bold 34px ${cjkFamily}` : 'bold 34px sans-serif';
  const cols = []; for (let i = 0; i < text.length; i += 5) cols.push(text.slice(i, i + 5));
  cols.forEach((col, ci) => { const x = 680 + 40 - ci * 40; [...col].forEach((ch, i) => ctx.fillText(ch, x, 120 + i * 36)); });
  bubble(300, 900, 180, 110);
  ctx.font = 'bold 30px sans-serif'; ctx.fillStyle = '#000';
  english.forEach((l, i) => ctx.fillText(l, 300, 885 + i * 36));
  ctx.fillStyle = '#fff'; ctx.fillRect(600, 1000, 180, 120); ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.strokeRect(600, 1000, 180, 120);
  const img = ctx.getImageData(0, 0, W, H);
  return { canvas: c, ctx, img: { width: W, height: H, data: img.data }, cjk };
}

// A band frame as the video pipeline sees it: white subtitle with a dark edge over a picture.
function drawBand({ text = 'Where did you put the keys', W = 960, H = 160, noise = true } = {}) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#2b4a7a'); g.addColorStop(1, '#6a3a2a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (noise) { ctx.fillStyle = '#e8e8e8'; ctx.fillRect(20, 10, 120, 60); } // a bright patch of the picture
  if (text) {
    const japanese = /[぀-ヿ一-鿿]/.test(text);
    ctx.font = `bold 34px ${japanese && cjk ? cjkFamily : 'sans-serif'}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const shown = japanese && !cjk ? 'DODODODO' : text;
    ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.strokeText(shown, W / 2, H * 0.6); ctx.fillStyle = '#fff'; ctx.fillText(shown, W / 2, H * 0.6);
  }
  return { png: c.toBuffer('image/png'), img: { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data } };
}

module.exports = { drawPage, drawBand, cjkFamily, cjk };
