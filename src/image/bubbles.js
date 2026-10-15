'use strict';
// Finds speech bubbles: the light, closed shapes of a comic page that hold dark lettering.
// Detection runs on a shrunken copy; each candidate is then traced at full size so the
// mask follows the bubble's real outline. Returns regions { x, y, w, h, kind:'bubble',
// bg:[r,g,b], mask, interior } where mask and interior are Uint8Array(w*h) over the
// region's box: mask is the bubble's paper, interior is paper plus everything enclosed by
// it (the lettering).
const { gray, downscale, components, floodFill, medianColor } = require('./raster');

function findBubbles(img, { maxDim = 1200, bright = 200, dark = 110, minArea = 0.0008, maxArea = 0.3 } = {}) {
  const { img: small, factor } = downscale(img, maxDim);
  const sw = small.width, sh = small.height;
  const g = gray(small);
  const light = new Uint8Array(sw * sh);
  for (let i = 0; i < g.length; i++) light[i] = g[i] >= bright ? 1 : 0;
  const { labels, comps } = components(light, sw, sh);
  const total = sw * sh;
  const out = [];
  for (const c of comps) {
    const rel = c.area / total;
    if (rel < minArea || rel > maxArea) continue;
    if (c.w < 18 || c.h < 18) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < 0.3) continue;
    const aspect = c.w / c.h;
    if (aspect < 0.12 || aspect > 8) continue;
    if (c.edge && rel > 0.12) continue; // the page's own background, or a gutter network
    // Dark pixels inside the box: lettering. Empty panels and plain white shapes have none.
    let darkIn = 0;
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) {
      const i = y * sw + x; if (labels[i] !== c.id && g[i] < dark) darkIn++;
    }
    const darkRel = darkIn / (c.w * c.h);
    if (darkRel < 0.015 || darkRel > 0.5) continue;
    // Seed for the full-size trace: the component pixel nearest the centre of its box.
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let seed = -1, best = Infinity;
    for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) {
      const i = y * sw + x; if (labels[i] !== c.id) continue;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < best) { best = d; seed = i; }
    }
    if (seed < 0) continue;
    const region = trace(img, { x: (seed % sw) * factor + (factor >> 1), y: Math.floor(seed / sw) * factor + (factor >> 1) },
      { x: c.x * factor, y: c.y * factor, w: c.w * factor, h: c.h * factor }, { bright, dark });
    if (region) out.push(region);
  }
  return dedupe(out);
}

// Traces one bubble at full size: bright pixels connected to the seed, then everything the
// paper encloses (the holes are the lettering). Returns null when it is not a bubble after all.
function trace(img, seed, box, { bright, dark }) {
  const pad = Math.max(6, Math.round(Math.max(box.w, box.h) * 0.08));
  const x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad);
  const x1 = Math.min(img.width, box.x + box.w + pad), y1 = Math.min(img.height, box.y + box.h + pad);
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const full = img.data, W = img.width;
  const lum = (x, y) => { const p = ((y0 + y) * W + x0 + x) * 4; return (full[p] * 77 + full[p + 1] * 151 + full[p + 2] * 28) >> 8; };
  const { mask, count } = floodFill(w, h, (x, y) => lum(x, y) >= bright, seed.x - x0, seed.y - y0);
  if (count < 64) return null;
  // Holes: non-paper pixels not reachable from the box edge without crossing paper.
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (q) => { if (!mask[q] && !outside[q]) { outside[q] = 1; stack.push(q); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(); const x = p % w, y = (p - x) / w;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const interior = new Uint8Array(w * h);
  let holes = 0, darkHoles = 0, bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] || !outside[i]) {
      interior[i] = 1;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (!mask[i]) { holes++; if (lum(x, y) < dark) darkHoles++; }
    }
  }
  const area = count + holes;
  if (holes / area < 0.01 || holes / area > 0.6) return null;   // nothing written in it, or not paper at all
  if (darkHoles < holes * 0.3) return null;                    // the holes are not ink
  // Tighten to the traced shape.
  const rw = bx1 - bx0 + 1, rh = by1 - by0 + 1;
  if (rw < 16 || rh < 16) return null;
  const tm = new Uint8Array(rw * rh), ti = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) { tm.set(mask.subarray((by0 + y) * w + bx0, (by0 + y) * w + bx0 + rw), y * rw); ti.set(interior.subarray((by0 + y) * w + bx0, (by0 + y) * w + bx0 + rw), y * rw); }
  const sub = { width: rw, height: rh, data: new Uint8ClampedArray(rw * rh * 4) };
  for (let y = 0; y < rh; y++) sub.data.set(full.subarray(((y0 + by0 + y) * W + x0 + bx0) * 4, ((y0 + by0 + y) * W + x0 + bx0 + rw) * 4), y * rw * 4);
  const bg = medianColor(sub, (i) => tm[i] === 1) || [255, 255, 255];
  return { x: x0 + bx0, y: y0 + by0, w: rw, h: rh, kind: 'bubble', bg, mask: tm, interior: ti, area };
}

// A bubble inside another (a nested trace of the same shape) is dropped; the larger wins.
function dedupe(regions) {
  const keep = [];
  const sorted = regions.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  for (const r of sorted) {
    const inside = keep.some(k => r.x >= k.x - 2 && r.y >= k.y - 2 && r.x + r.w <= k.x + k.w + 2 && r.y + r.h <= k.y + k.h + 2);
    if (!inside) keep.push(r);
  }
  return keep.sort(readingOrder);
}

// Manga reads right to left, top to bottom: rows of bubbles by their vertical band, right first.
function readingOrder(a, b) {
  const rowTol = Math.max(a.h, b.h) * 0.5;
  if (Math.abs(a.y - b.y) > rowTol) return a.y - b.y;
  return (b.x + b.w) - (a.x + a.w);
}
function orderLeftToRight(a, b) {
  const rowTol = Math.max(a.h, b.h) * 0.5;
  if (Math.abs(a.y - b.y) > rowTol) return a.y - b.y;
  return a.x - b.x;
}

module.exports = { findBubbles, trace, dedupe, readingOrder, orderLeftToRight };
