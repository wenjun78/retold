'use strict';
// Where the lettering is inside a region, and what it looks like: a mask of the ink, its
// colour, and the outline drawn around it, if any. Everything is over the region's own box.
const { gray, otsu, dilate, erode, medianColor, dominantColors, hex, colorDist, crop } = require('./raster');

// img: the page; region: { x, y, w, h, kind, mask?, interior?, bg? }. Returns
// { mask: Uint8Array(w*h) to erase, raw: the ink itself, bg, ink, outline:{color,width}|null }.
function textMask(img, region, { grow = 2 } = {}) {
  const sub = crop(img, region);
  const w = sub.width, h = sub.height;
  const g = gray(sub);
  const bubble = Boolean(region.kind === 'bubble' && region.interior);
  let bg, within;
  if (bubble) {
    // Only what the paper encloses can be lettering; the paper's edge (anti-aliased against
    // the outline) is kept out by shrinking the area a little.
    within = erode(region.interior, w, h, 2);
    bg = region.bg;
  } else {
    // A box drawn by hand or found by OCR: the background is whatever the box's rim is.
    within = new Uint8Array(w * h).fill(1);
    const rim = Math.max(2, Math.round(Math.min(w, h) * 0.08));
    bg = medianColor(sub, (i) => { const x = i % w, y = (i - x) / w; return x < rim || y < rim || x >= w - rim || y >= h - rim; }) || [255, 255, 255];
  }
  // First look: ink is what differs from the background. On paper that is the dark side of
  // Otsu's cut; on art it is any strong difference in colour.
  const vals = [];
  for (let i = 0; i < g.length; i++) if (within[i]) vals.push(g[i]);
  const thr = vals.length ? otsu(Uint8Array.from(vals)) : 128;
  const bgLum = (bg[0] * 77 + bg[1] * 151 + bg[2] * 28) >> 8;
  let mask = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0; i < g.length; i++) {
    if (!within[i]) continue;
    const diff = colorDist(sub.data, i * 4, bg);
    const inkByLum = bgLum > thr ? g[i] <= thr : g[i] > thr;
    if (bubble ? (diff > 60 && inkByLum) || diff > 110 : diff > 60) { mask[i] = 1; count++; }
  }
  let ink, outline = null;
  if (bubble || !count) {
    ink = (count && medianColor(sub, (i) => mask[i] === 1)) || (bgLum > 128 ? [0, 0, 0] : [255, 255, 255]);
    if (count) outline = ringOf(sub, mask, within, bg, ink);
  } else {
    // On art the lettering is one colour, or two with its outline, while the picture behind
    // it is many. Of the two commonest colours in the selection, the outline is the one
    // that borders the background; only pixels of those colours are kept, so a box drawn
    // generously around a sound effect does not erase the drawing with it.
    const top = dominantColors(sub, (i) => mask[i] === 1, 2);
    const a = top[0].color, b = top[1] && top[1].n > top[0].n * 0.12 ? top[1].color : null;
    const isA = (i) => colorDist(sub.data, i * 4, a) < 60, isB = (i) => b && colorDist(sub.data, i * 4, b) < 60;
    if (b) {
      // The outline is the colour whose pixels border the background; the fill sits inside
      // it. Failing that (lettering right against the box edge), the thinner shape is the ring.
      let bgA = 0, nA = 0, bgB = 0, nB = 0, edgeA = 0, edgeB = 0;
      const isBg = (q) => colorDist(sub.data, q * 4, bg) < 90;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!mask[i]) continue;
        const inA = isA(i), inB = !inA && isB(i);
        if (!inA && !inB) continue;
        const around = [i - 1, i + 1, i - w, i + w];
        const touchesBg = around.some(isBg), edge = around.some(q => (inA ? !isA(q) : !isB(q)));
        if (inA) { nA++; if (touchesBg) bgA++; if (edge) edgeA++; } else { nB++; if (touchesBg) bgB++; if (edge) edgeB++; }
      }
      let aOutside;
      if (bgA + bgB > 0) aOutside = bgA / Math.max(1, nA) >= bgB / Math.max(1, nB);
      else aOutside = edgeA / Math.max(1, nA) > edgeB / Math.max(1, nB);
      ink = aOutside ? b : a; outline = { color: aOutside ? a : b, width: 2 };
    } else ink = a;
    // The outline colour only counts right next to the ink: a line of the drawing in the
    // same colour further away stays.
    const isInk = (i) => colorDist(sub.data, i * 4, ink) < 60;
    const inkMask = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) if (within[i] && isInk(i)) inkMask[i] = 1;
    const near = outline ? dilate(inkMask, w, h, Math.max(4, Math.round(Math.min(w, h) * 0.08))) : null;
    const refined = new Uint8Array(w * h);
    let n = 0;
    for (let i = 0; i < g.length; i++) {
      if (!within[i]) continue;
      if (inkMask[i] || (near && near[i] && colorDist(sub.data, i * 4, outline.color) < 60)) { refined[i] = 1; n++; }
    }
    if (n) { mask = refined; count = n; }
  }
  const covered = outline ? dilate(mask, w, h, grow + 2) : dilate(mask, w, h, grow);
  for (let i = 0; i < covered.length; i++) if (!within[i]) covered[i] = 0;
  return { mask: covered, raw: mask, bg, ink, outline, coverage: count / Math.max(1, w * h), bgHex: hex(bg), inkHex: hex(ink) };
}

// An outline is a ring of a third colour hugging the ink (white letters with a black border).
function ringOf(sub, mask, within, bg, ink) {
  const w = sub.width, h = sub.height;
  const ring = dilate(mask, w, h, 3);
  let ringN = 0, third = 0;
  const thirdPick = new Uint8Array(w * h);
  for (let i = 0; i < ring.length; i++) {
    if (!ring[i] || mask[i] || !within[i]) continue;
    ringN++;
    if (colorDist(sub.data, i * 4, bg) > 60 && colorDist(sub.data, i * 4, ink) > 60) { third++; thirdPick[i] = 1; }
  }
  if (!ringN || third / ringN <= 0.35) return null;
  const color = medianColor(sub, (i) => thirdPick[i] === 1);
  return color ? { color, width: 2 } : null;
}

module.exports = { textMask };
