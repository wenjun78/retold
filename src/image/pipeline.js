'use strict';
// One page of a comic (or any picture with text) from pixels to a translation plan:
// find the bubbles, read what is in them, lift the lettering out, note its style, and
// hand the window everything it needs to set the translation. Masks stay here; the
// window only sees boxes, text and styles.
const { PNG } = require('pngjs');
const { crop, toBmp } = require('./raster');
const { findBubbles, orderLeftToRight, readingOrder } = require('./bubbles');
const { textMask } = require('./mask');
const { inpaint } = require('./inpaint');
const { estimateStyle } = require('./style');
const { joinLines } = require('../ocr');
const { ocrLangsFor, isCjk, guessLanguage, byCode } = require('../languages');

const pngOf = (img) => { const p = new PNG({ width: img.width, height: img.height }); p.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength); return PNG.sync.write(p); };

// Scales a crop up so small lettering reads well, and pads it with the background colour,
// which OCR engines need around text. Inside a bubble only the paper and what it encloses
// is shown: the bubble's outline would otherwise be read as letters.
function prepareCrop(img, region, bg, scale = 1) {
  const pad = 12;
  const sub = crop(img, region);
  const s = Math.max(1, scale);
  const w = Math.round(sub.width * s) + 2 * pad, h = Math.round(sub.height * s) + 2 * pad;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255; }
  const inside = region.kind === 'bubble' && region.interior && region.interior.length === sub.width * sub.height ? region.interior : null;
  for (let y = 0; y < h - 2 * pad; y++) for (let x = 0; x < w - 2 * pad; x++) {
    const sx = Math.min(sub.width - 1, Math.floor(x / s)), sy = Math.min(sub.height - 1, Math.floor(y / s));
    if (inside && !inside[sy * sub.width + sx]) continue;
    const p = (sy * sub.width + sx) * 4, o = ((y + pad) * w + x + pad) * 4;
    out[o] = sub.data[p]; out[o + 1] = sub.data[p + 1]; out[o + 2] = sub.data[p + 2]; out[o + 3] = 255;
  }
  return { width: w, height: h, data: out, scale: s, pad };
}

class Page {
  // img: { width, height, data }. deps: { ocr, llm, translator, config() }.
  constructor(id, img, deps) { this.id = id; this.img = img; this.deps = deps; this.regions = []; this.next = 1; }

  // Finds bubbles (or, with bubbles off, text anywhere on the page via OCR).
  async detect({ bubbles = true, source = 'auto' } = {}) {
    this.regions = [];
    if (bubbles) {
      for (const r of findBubbles(this.img)) this.regions.push({ id: this.next++, ...r, source: '', target: '' });
    }
    if (!this.regions.length) {
      const lines = await this.readPageLines(source);
      for (const g of groupLines(lines)) this.regions.push({ id: this.next++, x: g.x, y: g.y, w: g.w, h: g.h, kind: 'text', lines: g.lines, source: joinLines(g.lines.map(l => l.text)), target: '', orientation: g.orientation });
    }
    const order = isCjk(source) || source === 'auto' ? readingOrder : orderLeftToRight;
    this.regions.sort(order);
    return this.publicRegions();
  }

  // A PDF page brings its own text with positions: no bubbles to find, nothing to OCR.
  prefill(lines) {
    this.prefilled = true; this.prefillLines = lines;
    this.regions = [];
    const ok = lines.filter(l => l && l.text && l.bbox).map(l => ({ text: l.text, confidence: 100, bbox: l.bbox }));
    for (const g of groupLines(ok)) {
      const source = joinLines(g.lines.map(l => l.text));
      this.regions.push({ id: this.next++, x: g.x, y: g.y, w: g.w, h: g.h, kind: 'text', lines: g.lines, source, target: '', orientation: g.orientation, language: guessLanguage(source), confidence: 100 });
    }
    this.regions.sort(orderLeftToRight);
    return this.publicRegions();
  }

  // Back to square one: bubbles found again, a PDF page's text laid out again.
  reset() { this.regions = []; this.context = ''; if (this.prefillLines) this.prefill(this.prefillLines); }

  addRegion(box) {
    const r = { id: this.next++, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), kind: 'text', source: '', target: '' };
    this.regions.push(r);
    return this.publicRegion(r);
  }
  updateRegion(id, patch) {
    const r = this.regions.find(x => x.id === id);
    if (!r) return null;
    const moved = ['x', 'y', 'w', 'h'].some(k => patch[k] !== undefined && patch[k] !== r[k]);
    Object.assign(r, patch);
    if (moved) { delete r.mask; delete r.interior; delete r.lines; r.kind = 'text'; }
    return this.publicRegion(r);
  }
  removeRegion(id) { this.regions = this.regions.filter(r => r.id !== id); }

  publicRegion(r) {
    return { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h, kind: r.kind, source: r.source || '', target: r.target || '', orientation: r.orientation || '', style: r.style || null, confidence: r.confidence ?? null };
  }
  publicRegions() { return this.regions.map(r => this.publicRegion(r)); }

  // Text anywhere on the page, as lines with boxes.
  async readPageLines(source) {
    const { ocr } = this.deps;
    const lang = ocrLangsFor(source);
    const bmp = toBmp(this.img);
    const res = await ocr.read(bmp, { lang, psm: '11' });
    return res.lines.filter(l => l.confidence > 40);
  }

  // Reads the text of one region: with the image model, or with Tesseract set horizontally
  // and, for Chinese/Japanese, top to bottom as well, keeping whichever reads better.
  async read(id, { mode = 'vision', source = 'auto' } = {}) {
    const r = this.regions.find(x => x.id === id);
    if (!r) return null;
    const bg = r.bg || [255, 255, 255];
    if (mode === 'vision') {
      const prepared = prepareCrop(this.img, r, bg, 1);
      const png = pngOf(prepared);
      const prompt = 'This is one speech bubble or caption cut from a page. Read the text in it exactly as written, in its original language and script, with the line breaks of the original. '
        + 'Reply with one JSON object: {"text": "...", "direction": "vertical" or "horizontal", "language": "<BCP-47 code>"}. If there is no text, reply {"text": "", "direction": "horizontal", "language": ""}.';
      const reply = await this.deps.llm.see([png], prompt, { json: true, maxTokens: 600 });
      let j = {}; try { j = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)); } catch { j = { text: String(reply || '').trim() }; }
      r.source = String(j.text || '').trim();
      r.orientation = j.direction === 'vertical' ? 'vertical' : 'horizontal';
      r.language = j.language || guessLanguage(r.source);
      r.confidence = r.source ? 90 : 0;
    } else {
      const scale = Math.min(r.w, r.h) < 120 ? 2 : 1;
      const prepared = prepareCrop(this.img, r, bg, scale);
      const bmp = toBmp(prepared);
      const lang = source === 'auto' ? guessLanguage(r.source) : source;
      const vertical = source === 'auto' || isCjk(source) ? ocrLangsFor(source === 'auto' ? 'ja' : source, { vertical: true }).split('+')[0] : '';
      const passes = [{ lang: ocrLangsFor(lang === 'auto' ? 'auto' : lang), psm: '6', orientation: 'horizontal' }];
      if (vertical && (source === 'auto' || byCode(source).vertical)) passes.unshift({ lang: source === 'auto' ? 'jpn_vert+chi_sim_vert' : vertical, psm: '5', orientation: 'vertical' });
      let best = null, failure = null;
      for (const p of passes) {
        let res; try { res = await this.deps.ocr.read(bmp, { lang: p.lang, psm: p.psm }); } catch (e) { failure = e; continue; }
        const chars = res.text.replace(/\s/g, '').length;
        const score = res.confidence * Math.min(1, chars / 2);
        if (!best || score > best.score) best = { ...res, orientation: p.orientation, score };
      }
      if (!best && failure) throw failure;
      if (best) {
        r.lines = best.lines.map(l => ({ ...l, bbox: { x: (l.bbox.x - prepared.pad) / scale, y: (l.bbox.y - prepared.pad) / scale, w: l.bbox.w / scale, h: l.bbox.h / scale } }));
        r.source = joinLines(best.lines.map(l => l.text));
        r.orientation = best.orientation;
        r.confidence = Math.round(best.confidence);
        r.language = guessLanguage(r.source);
      }
    }
    return this.publicRegion(r);
  }

  // Lifts the lettering out of every region that has text, and notes how it was set.
  // Returns the cleaned page and the regions with their styles.
  erase() {
    const out = { width: this.img.width, height: this.img.height, data: new Uint8ClampedArray(this.img.data) };
    for (const r of this.regions) {
      if (!r.source || !r.source.trim()) continue;
      const tm = textMask(this.img, r);
      const cjk = isCjk(r.language || guessLanguage(r.source));
      r.style = estimateStyle({ mask: tm.raw, w: r.w, h: r.h, ink: tm.ink, outline: tm.outline, lines: r.lines || [], orientation: r.orientation, cjk, text: r.source });
      r.style.colorHex = tm.inkHex; r.style.bgHex = tm.bgHex;
      if (r.style.outline) r.style.outlineHex = '#' + r.style.outline.color.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
      if (!r.orientation) r.orientation = r.style.orientation;
      inpaint(out, r, tm.mask, r.kind === 'bubble' ? tm.bg : null);
    }
    return { image: out, regions: this.publicRegions() };
  }
}

// Lines close to one another (a paragraph, a bubble's worth of lines) become one region.
function groupLines(lines) {
  const groups = [];
  const sorted = lines.slice().sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  for (const l of sorted) {
    const b = l.bbox;
    const vertical = b.h > b.w * 2 && /[぀-ヿ一-鿿]/.test(l.text);
    let home = null;
    for (const g of groups) {
      const unit = Math.max(8, vertical ? Math.min(g.lineW, b.w) : Math.min(g.lineH, b.h));
      const nearY = b.y <= g.y + g.h + unit * 0.9 && b.y + b.h >= g.y - unit * 0.9;
      const nearX = b.x <= g.x + g.w + unit * 0.9 && b.x + b.w >= g.x - unit * 0.9;
      if (nearY && nearX && g.orientation === (vertical ? 'vertical' : 'horizontal')) { home = g; break; }
    }
    if (!home) { groups.push({ x: b.x, y: b.y, w: b.w, h: b.h, lines: [l], lineH: b.h, lineW: b.w, orientation: vertical ? 'vertical' : 'horizontal' }); continue; }
    const x0 = Math.min(home.x, b.x), y0 = Math.min(home.y, b.y);
    const x1 = Math.max(home.x + home.w, b.x + b.w), y1 = Math.max(home.y + home.h, b.y + b.h);
    home.x = x0; home.y = y0; home.w = x1 - x0; home.h = y1 - y0; home.lines.push(l);
  }
  // Boxes relative to the group, with a little room around the text.
  return groups.map(g => {
    const pad = Math.round(Math.max(4, g.lineH * 0.3));
    const x = Math.max(0, g.x - pad), y = Math.max(0, g.y - pad);
    return { x, y, w: g.w + 2 * pad, h: g.h + 2 * pad, orientation: g.orientation, lines: g.lines.map(l => ({ ...l, bbox: { x: l.bbox.x - x, y: l.bbox.y - y, w: l.bbox.w, h: l.bbox.h } })) };
  });
}

module.exports = { Page, groupLines, prepareCrop, pngOf };
