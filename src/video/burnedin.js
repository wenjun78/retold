'use strict';
// Subtitles that are part of the picture. Frames from the bottom band of the video are
// read with OCR; frames that show the same text one after another become one cue with the
// time it was on screen and the box it covered, which the window paints over and sets the
// translation on.

const { components } = require('../image/raster');

// Letters only, lower case: what two OCR readings of the same line have in common.
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) / Math.max(x.length, y.length) > 0.5 ? 0.9 : 0.5;
  // Levenshtein on strings this short is cheap.
  const n = x.length, m = y.length;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

const union = (a, b) => {
  if (!a) return b; if (!b) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// Subtitles are words, mostly letters; a line that is mostly symbols is the picture itself.
function subtitleLike(l) {
  const t = l.text;
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters < 2 || letters / t.replace(/\s/g, '').length < 0.6) return false;
  if (/[぀-ヿ一-鿿가-힯]/.test(t)) return l.confidence > 40;
  return l.confidence > 55 && (letters >= 4 || /^[\p{L}]{2,}$/u.test(t));
}

// One frame's OCR lines -> the subtitle shown (lines joined top to bottom) and its box.
// Lines that are not subtitle-like (a lone symbol, a watermark in the corner) are left out.
function frameText(lines, { width = 0 } = {}) {
  const kept = lines.filter(subtitleLike);
  if (!kept.length) return null;
  // Subtitles are roughly centred; a line far off to one side is something else.
  const centred = width ? kept.filter(l => Math.abs((l.bbox.x + l.bbox.w / 2) - width / 2) < width * 0.3) : kept;
  const use = centred.length ? centred : kept;
  use.sort((a, b) => a.bbox.y - b.bbox.y);
  let box = null; for (const l of use) box = union(box, l.bbox);
  return { text: use.map(l => l.text).join('\n'), box, confidence: use.reduce((n, l) => n + l.confidence, 0) / use.length };
}

// frames: [{ t, lines:[{text, confidence, bbox}] }] in time order, sampled `step` seconds apart.
// Returns cues [{ start, end, text, box, confidence }].
function groupFrames(frames, { step = 1, width = 0, minSimilarity = 0.72 } = {}) {
  const cues = [];
  let cur = null, held = null; // held: one frame that did not match, kept in case the next one does
  const close = () => { if (cur) cues.push(cur); cur = null; };
  const open = (f, ft) => { cur = { start: f.t, end: f.t + step, text: ft.text, box: ft.box, readings: [ft] }; };
  for (const f of frames) {
    const ft = frameText(f.lines || [], { width });
    const matches = ft && cur && similarity(cur.text, ft.text) >= minSimilarity;
    if (matches) {
      // One odd frame between two matching ones was a misread, not a change of line.
      cur.end = f.t + step; cur.box = union(cur.box, ft.box); cur.readings.push(ft); held = null;
      continue;
    }
    if (cur && !held) { held = { f, ft }; continue; }
    // Two frames in a row that are not this line: it is over.
    close();
    const first = held; held = null;
    if (first && first.ft && ft && similarity(first.ft.text, ft.text) >= minSimilarity) { open(first.f, first.ft); cur.end = f.t + step; cur.box = union(cur.box, ft.box); cur.readings.push(ft); }
    else if (ft) open(f, ft);
  }
  close();
  if (held && held.ft) { open(held.f, held.ft); close(); }
  // The best reading of each cue is the one most like the others (OCR noise is rarely repeated).
  for (const c of cues) {
    let best = c.readings[0], bestScore = -1;
    for (const r of c.readings) {
      const score = c.readings.reduce((n, o) => n + similarity(r.text, o.text), 0) + r.confidence / 1000;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    // The box is the best reading's, widened by the readings of about the same size; a
    // misread that swallowed part of the picture does not stretch it.
    let box = best.box;
    for (const r of c.readings) if (r.box.h <= best.box.h * 1.5 && r.box.w <= best.box.w * 1.5) box = union(box, r.box);
    c.text = best.text; c.confidence = best.confidence; c.box = box; delete c.readings;
  }
  // A line seen in one frame only is noise unless it was read with real confidence.
  return cues.filter(c => c.end - c.start >= step * 1.9 || c.confidence > 80);
}

// Prepares a band frame for OCR: subtitles are almost always white (or yellow) letters with
// a dark edge, so only bright, unsaturated (or yellow) pixels are kept, as black on white.
// img: { width, height, data } RGBA, changed in place.
function binarize(img) {
  const { width: w, height: h, data: d } = img;
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const lum = (r * 77 + g * 151 + b * 28) >> 8;
    const white = lum > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 60;
    const yellow = r > 170 && g > 150 && b < 110;
    ink[i] = white || yellow ? 1 : 0;
  }
  // Bright patches of the picture are far bigger than letters: anything taller than half
  // the band, wider than a third of it, or a solid block is dropped.
  const { labels, comps } = components(ink, w, h);
  const drop = new Uint8Array(comps.length + 1);
  for (const c of comps) {
    const solid = c.area / (c.w * c.h) > 0.85 && c.w > 12 && c.h > 12;
    if (c.h > h * 0.5 || c.w > w * 0.34 || solid || c.area < 3) drop[c.id] = 1;
  }
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const v = ink[i] && !drop[labels[i]] ? 0 : 255;
    d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
  }
  return img;
}

module.exports = { groupFrames, frameText, similarity, union, binarize, subtitleLike };
