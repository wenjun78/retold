'use strict';
const fs = require('fs');
const path = require('path');

// Reads text, with the box of every line and word, out of an image with Tesseract on this
// machine. English data ships with the app; other languages (Japanese and Chinese, set
// horizontally or top to bottom) are downloaded once into the data folder.
class OcrEngine {
  constructor({ dataDir, fetchFn = fetch }) {
    this.dataDir = dataDir; this.fetch = fetchFn;
    this.worker = null; this.loaded = ''; this.lang = ''; this.psm = ''; this.queue = Promise.resolve();
  }

  async _ensureLang(lang) {
    const file = path.join(this.dataDir, `${lang}.traineddata.gz`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (lang === 'eng') {
      const bundled = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz');
      fs.copyFileSync(bundled, file);
      return;
    }
    // From the CDN, or, where that is blocked but npm is not (many office networks), the
    // same file out of the package on the npm registry.
    const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
    let data = null, why = '';
    try {
      const res = await this.fetch(url);
      if (res.ok) data = Buffer.from(await res.arrayBuffer()); else why = `${res.status} from the CDN`;
    } catch (e) { why = e.message; }
    if (!data) {
      try {
        const res = await this.fetch(`https://registry.npmjs.org/@tesseract.js-data/${lang}/-/${lang}-1.0.0.tgz`);
        if (res.ok) data = fileFromTgz(Buffer.from(await res.arrayBuffer()), `package/4.0.0_best_int/${lang}.traineddata.gz`);
        else why += `; ${res.status} from the npm registry`;
      } catch (e) { why += `; ${e.message}`; }
    }
    if (!data) throw new Error(`Could not download the OCR data for "${lang}" (${why}). Check the connection, or that the language code is right.`);
    fs.writeFileSync(file, data);
  }

  // One worker holds every language asked for so far; switching between them is a cheap
  // re-initialisation rather than a new worker.
  async _prepare(lang, psm) {
    const want = lang.split('+').filter(Boolean);
    const have = this.loaded ? this.loaded.split('+') : [];
    const missing = want.filter(l => !have.includes(l));
    if (!this.worker || missing.length) {
      for (const l of missing) await this._ensureLang(l);
      const all = [...have, ...missing];
      const { createWorker } = require('tesseract.js');
      if (this.worker) { try { await this.worker.terminate(); } catch { /* already gone */ } }
      this.worker = await createWorker(all, 1, { langPath: this.dataDir, cachePath: this.dataDir, gzip: true, cacheMethod: 'none' });
      this.loaded = all.join('+'); this.lang = all.join('+'); this.psm = '';
    }
    if (this.lang !== lang) { await this.worker.reinitialize(lang); this.lang = lang; this.psm = ''; }
    if (this.psm !== psm) { await this.worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' }); this.psm = psm; }
  }

  // image: PNG/JPEG Buffer. lang: 'jpn_vert' or 'jpn+eng' ... psm: '5' for one block of
  // vertical text, '6' for one block, '11' to find text anywhere on a page.
  // Returns { text, confidence, lines: [{ text, confidence, bbox:{x,y,w,h}, words:[...] }] }.
  read(image, { lang = 'eng', psm = '6' } = {}) {
    const job = this.queue.then(async () => {
      await this._prepare(lang, psm);
      const { data } = await this.worker.recognize(Buffer.from(image), {}, { text: true, blocks: true });
      return linesOf(data);
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async stop() {
    if (this.worker) { try { await this.worker.terminate(); } catch { /* ignore */ } this.worker = null; this.loaded = ''; }
  }
}

// One file out of a gzipped tar (an npm package): 512-byte headers, sizes in octal.
function fileFromTgz(tgz, wanted) {
  const tar = require('zlib').gunzipSync(tgz);
  let at = 0;
  while (at + 512 <= tar.length) {
    const name = tar.toString('utf8', at, at + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', at + 124, at + 136).replace(/\0.*$/s, '').trim(), 8) || 0;
    const prefix = tar.toString('utf8', at + 345, at + 500).replace(/\0.*$/s, '');
    const full = prefix ? `${prefix}/${name}` : name;
    if (full === wanted) return tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

const box = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });

function linesOf(data) {
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter(w => w.text && w.text.trim()).map(w => ({ text: w.text, confidence: w.confidence, bbox: box(w.bbox) }));
    const text = cleanLine(l.text);
    if (!text) continue;
    lines.push({ text, confidence: l.confidence, bbox: box(l.bbox), words });
  }
  const confidence = lines.length ? lines.reduce((n, l) => n + l.confidence, 0) / lines.length : 0;
  return { text: lines.map(l => l.text).join('\n'), confidence, lines };
}

// Trims a recognised line and drops the junk Tesseract makes of borders, screentone and icons.
function cleanLine(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (!letters) return /^[!?！？…。、.~〜♪♥]{1,6}$/.test(t) ? t : ''; // "!?" alone is a bubble too
  if (letters / t.length < 0.4 && t.length > 3) return '';
  return t;
}

// Joins the lines of one bubble into the text that is translated: Japanese and Chinese
// lines run together (no spaces inside a sentence), Latin lines join with a space, and a
// word broken over two lines with a hyphen is mended.
function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    if (!out) { out = line; continue; }
    const prevCjk = /[぀-ヿ一-鿿가-힯]$/.test(out), nextCjk = /^[぀-ヿ一-鿿가-힯]/.test(line);
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else if (prevCjk && nextCjk) out += line;
    else out += ' ' + line;
  }
  return out;
}

module.exports = { OcrEngine, linesOf, cleanLine, joinLines, fileFromTgz };
