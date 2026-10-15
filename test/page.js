'use strict';
// Draws a comic page for the tests: two panels with screentone, a tall bubble of vertical
// Japanese, a wide bubble of English, and an empty white box that is not a bubble.
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');

const CJK_FONTS = ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'];
let cjkFamily = 'sans-serif';
for (const f of CJK_FONTS) if (fs.existsSync(f)) { try { GlobalFonts.registerFromPath(f, 'TestCJK'); cjkFamily = 'TestCJK'; break; } catch { /* next */ } }

function drawPage({ W = 900, H = 1300, japanese = 'おまえはもう死んでいる', english = ['WHAT DID YOU', 'JUST SAY?!'] } = {}) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#999'; ctx.fillRect(40, 40, 820, 560); ctx.fillRect(40, 640, 820, 620);
  ctx.fillStyle = '#000';
  for (let y = 60; y < 1240; y += 6) for (let x = 60; x < 840; x += 6) if ((x + y) % 12 === 0) ctx.fillRect(x, y, 2, 2);
  ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.strokeRect(40, 40, 820, 560); ctx.strokeRect(40, 640, 820, 620);
  const bubble = (cx, cy, rx, ry) => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.stroke(); };
  bubble(680, 220, 130, 160);
  ctx.fillStyle = '#000'; ctx.font = `bold 34px ${cjkFamily}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cols = []; for (let i = 0; i < japanese.length; i += 5) cols.push(japanese.slice(i, i + 5));
  cols.forEach((col, ci) => { const x = 680 + 40 - ci * 40; [...col].forEach((ch, i) => ctx.fillText(ch, x, 120 + i * 36)); });
  bubble(300, 900, 180, 110);
  ctx.font = 'bold 30px sans-serif'; ctx.fillStyle = '#000';
  english.forEach((l, i) => ctx.fillText(l, 300, 885 + i * 36));
  ctx.fillStyle = '#fff'; ctx.fillRect(600, 1000, 180, 120); ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.strokeRect(600, 1000, 180, 120);
  const img = ctx.getImageData(0, 0, W, H);
  return { canvas: c, ctx, img: { width: W, height: H, data: img.data } };
}

// A band frame as the video pipeline sees it: white subtitle with a dark edge over a picture.
function drawBand({ text = 'Where did you put the keys', W = 960, H = 160, noise = true } = {}) {
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#2b4a7a'); g.addColorStop(1, '#6a3a2a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (noise) { ctx.fillStyle = '#e8e8e8'; ctx.fillRect(20, 10, 120, 60); } // a bright patch of the picture
  if (text) {
    ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.strokeText(text, W / 2, H * 0.6); ctx.fillStyle = '#fff'; ctx.fillText(text, W / 2, H * 0.6);
  }
  return { png: c.toBuffer('image/png'), img: { width: W, height: H, data: ctx.getImageData(0, 0, W, H).data } };
}

module.exports = { drawPage, drawBand, cjkFamily };
