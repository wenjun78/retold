'use strict';
// One open video. Works out where its words come from (a subtitle track, subtitles burned
// into the picture, or the speech itself), then keeps translated cues ready a minute ahead
// of wherever the viewer is. Emits 'cues' with everything known so far and 'status' with
// how far ahead it has got.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { Lookahead } = require('./lookahead');
const cuesLib = require('./cues');
const { groupFrames, binarize } = require('./burnedin');
const { ocrLangsFor } = require('../languages');
const { PNG } = require('pngjs');
const { toBmp } = require('../image/raster');

class VideoSession extends EventEmitter {
  // deps: { llm, translator, ocr, config: () => cfg }
  constructor(file, deps) {
    super();
    this.file = file; this.deps = deps;
    this.info = null; this.mode = ''; this.track = []; this.cues = []; this.burned = [];
    this.ahead = null; this.abort = new AbortController();
  }

  async open() {
    this.info = await ff.probe(this.file);
    this.info.sidecars = ff.sidecars(this.file);
    return this.info;
  }

  // source: 'auto' | 'speech' | 'subtitles' | { track: n } | { sidecar: file }.
  // Returns the mode chosen: 'track' (text subtitles found), 'picture' (burned-in subtitles
  // looked for, speech as the fallback) or 'speech'.
  async start(source) {
    const cfg = this.deps.config();
    let text = '';
    if (source && typeof source === 'object') {
      if (source.sidecar) text = fs.readFileSync(source.sidecar, 'utf8');
      else if (source.track !== undefined) text = await ff.subtitleTrack(this.file, source.track, { signal: this.abort.signal });
    } else if (source === 'auto' || source === 'subtitles') {
      if (this.info.sidecars.length) text = fs.readFileSync(this.info.sidecars[0].file, 'utf8');
      else if (this.info.subtitles.length) { try { text = await ff.subtitleTrack(this.file, this.info.subtitles[0].index, { signal: this.abort.signal }); } catch { text = ''; } }
    }
    if (text) { this.track = cuesLib.parseSubtitles(text); this.mode = this.track.length ? 'track' : ''; }
    if (!this.mode) this.mode = source === 'speech' ? 'speech' : 'picture';
    const v = cfg.video;
    this.ahead = new Lookahead({
      duration: this.info.duration,
      chunkSec: this.mode === 'track' ? 120 : v.chunkSec,
      aheadSec: v.aheadSec,
      parallel: 2,
      work: (start, end, i) => this._work(start, end, i),
    });
    this.ahead.on('chunk', ({ result }) => {
      cuesLib.mergeInto(this.cues, result.cues || []);
      cuesLib.mergeInto(this.burned, result.burned || []);
      this.emit('cues', { cues: this.cues, burned: this.burned });
    });
    this.ahead.on('status', (s) => this.emit('status', { ...s, mode: this.mode }));
    this.ahead.on('error', (e) => this.emit('error', e));
    this.ahead.update(0);
    return this.mode;
  }

  update(t) { if (this.ahead) this.ahead.update(t); }
  retry() { if (this.ahead) this.ahead.retry(); }

  async _work(start, end, index) {
    const cfg = this.deps.config();
    const { translator } = this.deps;
    const lang = cfg.languages;
    const signal = this.abort.signal;
    const translate = async (list, kind = 'subtitle') => {
      if (!list.length) return list;
      const before = this.cues.filter(c => c.end <= start).slice(-3).map(c => c.text).join('\n');
      const got = await translator.translate(list.map((c, i) => ({ id: String(i), text: c.text })), { source: lang.source, target: lang.target, kind, formality: cfg.style.formality, glossary: cfg.style.glossary, context: before, signal });
      return list.map((c, i) => ({ ...c, translated: got.get(String(i)) ?? c.text }));
    };
    if (this.mode === 'track') {
      const slice = this.track.filter(c => c.start >= start && c.start < end);
      return { cues: await translate(slice) };
    }
    // Speech and burned-in subtitles are read side by side; where a burned-in line is on
    // screen its text is the better source (no mishearing), so speech cues under it are dropped.
    const v = cfg.video;
    const jobs = [this._speech(start, end, signal)];
    if (this.mode === 'picture') jobs.push(this._burned(start, end, signal));
    const [speech, burned = []] = await Promise.all(jobs);
    if (speech.pastEnd) return { pastEnd: true };
    const kept = speech.cues.filter(c => !burned.some(b => Math.min(c.end, b.end) - Math.max(c.start, b.start) > (c.end - c.start) * 0.5));
    const [cues, burnedOut] = await Promise.all([translate(kept), translate(burned)]);
    return { cues, burned: burnedOut.map(b => ({ ...b, band: v.band })) };
  }

  async _speech(start, end, signal) {
    const cfg = this.deps.config();
    const wav = await ff.audioWindow(this.file, start, end - start, { signal });
    if (!wav.length) return { pastEnd: start > 0, cues: [] };
    const { segments } = await this.deps.llm.transcribe(wav, { language: cfg.languages.source, signal, duration: end - start });
    const cues = cuesLib.mergeSegments(segments).map(c => ({ start: start + c.start, end: start + c.end, text: c.text }));
    return { cues };
  }

  async _burned(start, end, signal) {
    const cfg = this.deps.config();
    const v = cfg.video;
    const width = 960;
    const frames = await ff.bandFrames(this.file, start, end - start, { fps: v.fps, band: v.band, width, signal });
    if (!frames.length) return [];
    const lang = ocrLangsFor(cfg.languages.source);
    const read = [];
    let bandH = 0;
    for (const f of frames) {
      if (signal.aborted) break;
      const png = PNG.sync.read(f.png);
      if (!bandH) bandH = png.height;
      const img = binarize({ width: png.width, height: png.height, data: png.data });
      let res;
      try { res = await this.deps.ocr.read(toBmp(img), { lang, psm: '6' }); }
      catch (e) { if (!this.ocrNoted) { this.ocrNoted = true; this.emit('notice', `Burned-in subtitles are not being read: ${e.message} Speech is still translated.`); } return []; }
      read.push({ t: f.t, lines: res.lines });
    }
    const cues = groupFrames(read, { step: 1 / v.fps, width });
    // Boxes become fractions of the whole picture, so the window can place them whatever
    // size the video is shown at.
    return cues.map(c => ({
      start: c.start, end: c.end, text: c.text, confidence: c.confidence,
      box: { x: c.box.x / width, y: (1 - v.band) + (c.box.y / bandH) * v.band, w: c.box.w / width, h: (c.box.h / bandH) * v.band },
    }));
  }

  exportSrt({ both = false } = {}) {
    const all = cuesLib.mergeInto(this.cues.slice(), this.burned);
    return cuesLib.formatSrt(all, { translated: true, both });
  }

  close() { this.abort.abort(); if (this.ahead) this.ahead.stop(); this.removeAllListeners(); }
}

function pngHeight(png) { return png.readUInt32BE(20); }

module.exports = { VideoSession };
