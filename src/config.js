'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  defaults: 1,                        // which set of defaults these settings were last brought up to
  autoUpdate: true,
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-6.1-sol', extra: { reasoning_effort: 'low' } },
  // A model that can see images, for reading manga lettering; empty = the chat model.
  vision: { baseUrl: '', apiKey: '', model: '' },
  // Speech to text with timestamps (verbose_json): whisper-1 on OpenAI, whisper-large-v3 on Groq.
  stt: { baseUrl: '', apiKey: '', model: 'whisper-1' },
  languages: { source: 'auto', target: 'en' },
  // formality: 'natural' | 'formal' | 'casual'; glossary: "term = translation" per line
  style: { formality: 'natural', glossary: '' },
  image: {
    ocr: 'vision',                    // 'vision' (the image model reads each bubble) | 'local' (Tesseract on this machine)
    direction: 'auto',                // 'auto' | 'horizontal' | 'vertical' — how the translation is set
    mimic: true,                      // copy the size, weight, colour and outline of the original lettering
    opacity: 1,                       // of the translated layer over the original
    fontLatin: '',                    // '' = a comic lettering font when available, else the system sans
    fontCjk: '',
    bubbles: true,                    // find speech bubbles; off = text lines from OCR only
  },
  video: {
    aheadSec: 60,                     // how far ahead of the playhead the translation is prepared
    chunkSec: 20,                     // audio is transcribed in pieces this long
    source: 'auto',                   // 'auto' (subtitle track, then burned-in subtitles, then speech) | 'speech' | 'subtitles'
    band: 0.3,                        // share of the frame, from the bottom, where burned-in subtitles are looked for
    fps: 1,                           // frames per second sampled for burned-in subtitles
    cover: 'auto',                    // 'auto' | 'black' | 'white' — box drawn over burned-in subtitles
    position: 'bottom',               // 'bottom' | 'top' for subtitles from speech
    fontSize: 28,
  },
  web: { homepage: 'https://', attributes: true }, // attributes: also translate alt, title and placeholder
  ui: { theme: 'dark', bounds: null, mode: 'image' },
};

const SECRET_PATHS = [['llm', 'apiKey'], ['vision', 'apiKey'], ['stt', 'apiKey']];

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined || over === null ? base : over;
}

// crypto: { encrypt(str)->base64, decrypt(base64)->str } or null (keys stored as plain text).
class ConfigStore {
  constructor(file, crypto = null) { this.file = file; this.crypto = crypto; this.data = merge(DEFAULTS, {}); }

  load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    for (const [a, b] of SECRET_PATHS) {
      const v = raw[a] && raw[a][b];
      if (typeof v === 'string' && v.startsWith('enc:')) {
        try { raw[a][b] = this.crypto ? this.crypto.decrypt(v.slice(4)) : ''; } catch { raw[a][b] = ''; }
      }
    }
    raw.defaults = DEFAULTS.defaults;
    this.data = merge(DEFAULTS, raw);
    if (raw.llm && raw.llm.extra && typeof raw.llm.extra === 'object') this.data.llm.extra = raw.llm.extra;
    return this.data;
  }

  get() { return this.data; }

  update(patch) {
    const extra = patch && patch.llm && patch.llm.extra;
    this.data = merge(this.data, patch);
    if (extra && typeof extra === 'object') this.data.llm.extra = extra;
    this.save();
    return this.data;
  }

  save() {
    const out = JSON.parse(JSON.stringify(this.data));
    if (this.crypto) for (const [a, b] of SECRET_PATHS) if (out[a][b]) out[a][b] = 'enc:' + this.crypto.encrypt(out[a][b]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
  }
}

module.exports = { ConfigStore, DEFAULTS, merge };
