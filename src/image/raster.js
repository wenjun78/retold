'use strict';
// Small pixel toolkit on plain RGBA images ({ width, height, data: Uint8ClampedArray }),
// the same shape as the browser's ImageData, so pages move between renderer and main
// process untouched. No native code: a manga page is a few million pixels, which plain
// typed-array loops handle in well under a second.

function gray(img) {
  const { width: w, height: h, data } = img;
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  return g;
}

// Shrinks by an integer factor (box average) so detection runs on a page-sized image.
function downscale(img, maxDim) {
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxDim));
  if (f === 1) return { img, factor: 1 };
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const src = img.data, sw = img.width;
  const n = f * f;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy++) {
      let p = ((y * f + dy) * sw + x * f) * 4;
      for (let dx = 0; dx < f; dx++, p += 4) { r += src[p]; g += src[p + 1]; b += src[p + 2]; }
    }
    const o = (y * w + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
  }
  return { img: { width: w, height: h, data: out }, factor: f };
}

function crop(img, { x, y, w, h }) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w)), y1 = Math.min(img.height, Math.ceil(y + h));
  const cw = Math.max(0, x1 - x0), ch = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let r = 0; r < ch; r++) out.set(img.data.subarray(((y0 + r) * img.width + x0) * 4, ((y0 + r) * img.width + x1) * 4), r * cw * 4);
  return { width: cw, height: ch, data: out, x: x0, y: y0 };
}

// Otsu's threshold over a gray histogram: the cut between ink and paper.
function otsu(values) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]]++;
  const total = values.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Connected components (8-connected) of a binary mask. Returns the label per pixel (0 = none)
// and, per component, its area, bounding box and whether it touches the image edge.
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = next++;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, edge = false;
    stack[sp++] = start; labels[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id, area, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, edge });
  }
  return { labels, comps };
}

// Flood fill from a seed over pixels that pass `test`, limited to the box. Returns the
// filled mask (w*h of the box) and how many pixels it holds.
function floodFill(w, h, test, seedX, seedY) {
  const mask = new Uint8Array(w * h);
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h || !test(seedX, seedY)) return { mask, count: 0 };
  const stack = [seedY * w + seedX];
  mask[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const p = stack.pop(); count++;
    const x = p % w, y = (p - x) / w;
    const tryPx = (nx, ny) => { if (nx < 0 || ny < 0 || nx >= w || ny >= h) return; const q = ny * w + nx; if (!mask[q] && test(nx, ny)) { mask[q] = 1; stack.push(q); } };
    tryPx(x - 1, y); tryPx(x + 1, y); tryPx(x, y - 1); tryPx(x, y + 1);
  }
  return { mask, count };
}

// Binary dilation/erosion with a square kernel of radius r, as two 1-D max/min passes.
function dilate(mask, w, h, r) { return morph(mask, w, h, r, true); }
function erode(mask, w, h, r) { return morph(mask, w, h, r, false); }
function morph(mask, w, h, r, grow) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let d = -r; d <= r; d++) { const nx = x + d; const s = nx < 0 || nx >= w ? (grow ? 0 : 0) : mask[y * w + nx]; if (grow ? s : !s) { v = grow ? 1 : 0; break; } }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 1;
    for (let d = -r; d <= r; d++) { const ny = y + d; const s = ny < 0 || ny >= h ? 0 : tmp[ny * w + x]; if (grow ? s : !s) { v = grow ? 1 : 0; break; } }
    out[y * w + x] = v;
  }
  return out;
}

// Median colour of the pixels where pick(i) is true (i = pixel index).
function medianColor(img, pick) {
  const rs = [], gs = [], bs = [];
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 20000)); // a sample is plenty for a median
  for (let i = 0; i < n; i += step) if (pick(i)) { rs.push(img.data[i * 4]); gs.push(img.data[i * 4 + 1]); bs.push(img.data[i * 4 + 2]); }
  if (!rs.length) return null;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

// The commonest colour (to within a coarse bin) among the picked pixels: lettering is one
// colour, the art behind it is many, so this finds the ink even in a messy selection.
function dominantColor(img, pick) { const c = dominantColors(img, pick, 1); return c.length ? c[0].color : null; }

// The k commonest colours among the picked pixels, each with its pixel count, colours
// closer than `apart` merged into the larger one.
function dominantColors(img, pick, k = 2, apart = 60) {
  const bins = new Map();
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    if (!pick(i)) continue;
    const p = i * 4, key = ((img.data[p] >> 4) << 8) | ((img.data[p + 1] >> 4) << 4) | (img.data[p + 2] >> 4);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += img.data[p]; b.g += img.data[p + 1]; b.b += img.data[p + 2];
    bins.set(key, b);
  }
  const sorted = [...bins.values()].map(b => ({ n: b.n, color: [b.r / b.n, b.g / b.n, b.b / b.n] })).sort((a, b) => b.n - a.n);
  const out = [];
  for (const b of sorted) {
    const near = out.find(o => Math.max(Math.abs(o.color[0] - b.color[0]), Math.abs(o.color[1] - b.color[1]), Math.abs(o.color[2] - b.color[2])) < apart);
    if (near) near.n += b.n; else out.push({ n: b.n, color: b.color });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, k);
}

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const colorDist = (data, p, [r, g, b]) => Math.max(Math.abs(data[p] - r), Math.abs(data[p + 1] - g), Math.abs(data[p + 2] - b));

// Uncompressed 24-bit BMP, which Tesseract reads directly: no image codec needed for OCR.
function toBmp(img) {
  const { width: w, height: h, data } = img;
  const rowBytes = (w * 3 + 3) & ~3;
  const size = 54 + rowBytes * h;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0); buf.writeUInt32LE(size, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowBytes * h, 34); buf.writeInt32LE(2835, 38); buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * rowBytes, p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4) { buf[o++] = data[p + 2]; buf[o++] = data[p + 1]; buf[o++] = data[p]; }
  }
  return buf;
}

module.exports = { gray, downscale, crop, otsu, components, floodFill, dilate, erode, medianColor, dominantColor, dominantColors, hex, colorDist, toBmp };
