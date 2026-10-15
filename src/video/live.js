'use strict';
// Translation for a video playing somewhere else on the screen (a browser, a player, a
// call). The window captures that screen or window's sound and picture and sends them
// here in pieces: each utterance as WAV once a pause is heard, and the bottom band of the
// picture once a second. Nothing can be read a minute ahead of a live picture, so this
// works a sentence behind; the overlay window shows what comes out.
const { EventEmitter } = require('events');
const { PNG } = require('pngjs');
const { binarize, frameText, similarity } = require('./burnedin');
const { mergeSegments } = require('./cues');
const { toBmp } = require('../image/raster');
const { ocrLangsFor } = require('../languages');

class LiveSession extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.queue = Promise.resolve();
    this.current = null;       // burned-in line on screen: { text, box, misses, translated }
    this.recent = [];          // last few source lines, for context
    this.stopped = false;
  }

  _opts(kind) {
    const cfg = this.deps.config();
    return { source: cfg.languages.source, target: cfg.languages.target, kind, formality: cfg.style.formality, glossary: cfg.style.glossary, context: this.recent.slice(-3).join('\n') };
  }

  // wav: Buffer, one utterance; duration in seconds.
  audio(wav, duration) {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      const cfg = this.deps.config();
      let segments;
      try { ({ segments } = await this.deps.llm.transcribe(wav, { language: cfg.languages.source, duration })); } catch (e) { this.emit('notice', e.message); return; }
      const lines = mergeSegments(segments, { maxChars: 120 });
      if (!lines.length) return;
      const text = lines.map(l => l.text).join(' ');
      let translated = text;
      try { translated = await this.deps.translator.translateOne(text, this._opts('subtitle')); } catch (e) { this.emit('notice', e.message); }
      this.recent.push(text);
      this.emit('cue', { kind: 'speech', text, translated, ttl: Math.max(3, Math.min(12, duration + 1)) });
    }).catch(() => {});
  }

  // png: the bottom band of the picture; meta: { width, height, band } of the whole picture.
  // Frames arrive once a second; when OCR falls behind, the ones waiting are dropped rather
  // than queued, so the overlay never lags further than one frame.
  frame(png, meta) {
    if (this.waiting > 0) return;
    this.waiting = (this.waiting || 0) + 1;
    this.queue = this.queue.then(async () => {
      this.waiting--;
      if (this.stopped) return;
      const cfg = this.deps.config();
      const decoded = PNG.sync.read(png);
      const img = binarize({ width: decoded.width, height: decoded.height, data: decoded.data });
      let res;
      try { res = await this.deps.ocr.read(toBmp(img), { lang: ocrLangsFor(cfg.languages.source), psm: '6' }); } catch (e) { this.emit('notice', e.message); return; }
      const ft = frameText(res.lines, { width: decoded.width });
      const cur = this.current;
      if (ft && cur && similarity(cur.text, ft.text) >= 0.72) { cur.misses = 0; return; }
      if (!ft) {
        if (cur && ++cur.misses >= 2) { this.current = null; this.emit('cue', { kind: 'burned', clear: true }); }
        return;
      }
      // A new line: translate it and put it up over the old one.
      const box = { x: ft.box.x / decoded.width, y: (1 - meta.band) + (ft.box.y / decoded.height) * meta.band, w: ft.box.w / decoded.width, h: (ft.box.h / decoded.height) * meta.band };
      this.current = { text: ft.text, box, misses: 0 };
      let translated = ft.text;
      try { translated = await this.deps.translator.translateOne(ft.text, this._opts('subtitle')); } catch (e) { this.emit('notice', e.message); }
      if (this.current && this.current.text === ft.text) { this.recent.push(ft.text); this.emit('cue', { kind: 'burned', text: ft.text, translated, box, isScreen: meta.isScreen !== false }); }
    }).catch(() => {});
  }

  stop() { this.stopped = true; this.removeAllListeners(); }
}

module.exports = { LiveSession };
