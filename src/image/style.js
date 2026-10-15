'use strict';
// What the original lettering looks like, so the translation can be set to match: how
// big, how heavy, which way it runs, what colour, whether it has an outline.

// mask: Uint8Array(w*h) of the ink (before growing). lines: OCR line boxes relative to the
// region, if any. cjk: whether the source script is Chinese/Japanese/Korean.
function estimateStyle({ mask, w, h, ink, outline, lines = [], orientation = '', cjk = false, text = '' }) {
  const rows = runs(mask, w, h, 'rows'), cols = runs(mask, w, h, 'cols');
  const dir = orientation || guessOrientation(rows, cols, w, h, cjk);
  // Line size from OCR boxes when there are some, else from the ink's own banding.
  let size = 0;
  const boxes = lines.map(l => (dir === 'vertical' ? l.bbox.w : l.bbox.h)).filter(v => v > 4);
  const bands = (dir === 'vertical' ? cols : rows).map(r => r.length).filter(v => v > 4);
  // A line's box is about the em for CJK, the cap height (0.72 em) for Latin capitals, and
  // ascender to descender (0.95 em) for mixed case; the same goes for the ink's banding.
  const caps = /[A-Z]/.test(text) && !/[a-z]/.test(text);
  const em = cjk ? 1 / 0.92 : caps ? 1 / 0.72 : 1 / 0.95;
  const fromBands = bands.length ? median(bands) * em : 0;
  if (boxes.length) size = median(boxes) * em;
  // OCR boxes that disagree with the ink's own banding by a lot are boxes around something
  // else (a border read as a letter); the banding wins then.
  if (!size || (fromBands && (size > fromBands * 1.8 || size < fromBands / 1.8))) size = fromBands || size;
  if (!size) size = Math.max(12, Math.min(w, h) / 6);
  size = Math.min(size, Math.min(w, h) * 0.8);
  size = Math.max(8, Math.round(size));
  // Stroke width from area and perimeter: a ribbon's width is about twice area over perimeter.
  let area = 0, perim = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    area++;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) perim++;
  }
  const stroke = perim ? (2 * area) / perim : 0;
  const bold = stroke / size >= (cjk ? 0.09 : 0.13); // CJK strokes are thin for their em
  return { size, bold, orientation: dir, color: ink, outline, stroke: Math.round(stroke * 10) / 10 };
}

// Runs of consecutive rows (or columns) that hold ink: one per line of text.
function runs(mask, w, h, axis) {
  const n = axis === 'rows' ? h : w, m = axis === 'rows' ? w : h;
  const has = new Uint8Array(n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < m; b++) { const i = axis === 'rows' ? a * w + b : b * w + a; if (mask[i]) { has[a] = 1; break; } }
  }
  const out = [];
  let start = -1;
  for (let a = 0; a <= n; a++) {
    if (a < n && has[a]) { if (start < 0) start = a; }
    else if (start >= 0) { out.push({ start, length: a - start }); start = -1; }
  }
  // Letters with gaps between them inside a line: merge runs separated by tiny gaps.
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.start - (last.start + last.length) <= 2) last.length = r.start + r.length - last.start;
    else merged.push({ ...r });
  }
  return merged;
}

// CJK characters sit on a grid with small gaps both ways, so the ink bands along each axis
// count characters: set top to bottom there are more rows of characters than columns of
// them; set left to right it is the other way round. (Latin lettering is never vertical.)
function guessOrientation(rows, cols, w, h, cjk) {
  if (!cjk) return 'horizontal';
  const rowBands = rows.filter(r => r.length > 3).length, colBands = cols.filter(c => c.length > 3).length;
  if (rowBands > colBands * 1.2) return 'vertical';
  if (colBands > rowBands * 1.2) return 'horizontal';
  return h > w * 1.3 ? 'vertical' : 'horizontal';
}

function median(a) { const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; }

module.exports = { estimateStyle, runs, guessOrientation };
