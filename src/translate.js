'use strict';
// Translation through the chat model: pieces of text go in batches, each with an id, and
// come back as a JSON object keyed the same way. Everything translated once is kept in a
// translation memory, so a page re-opened, a chapter's recurring sound effect or a seek back
// in a video costs nothing the second time.
const fs = require('fs');
const path = require('path');
const { nameOf } = require('./languages');

const KINDS = {
  manga: 'These are the speech bubbles and captions of a comic page, in reading order. Keep each line short and spoken, as a letterer would set it. Match the tone (shouting, whispering, narration). Sound effects become the usual onomatopoeia of the target language.',
  subtitle: 'These are subtitle lines in time order. Keep each short enough to read in the seconds it is shown, and keep wording consistent across lines.',
  web: 'These are the text blocks of a web page. Use the conventional wording of the target language for buttons, menus and labels.',
  document: 'These are the paragraphs of a document, in order. Keep headings as headings and lists as lists.',
  text: 'These are pieces of text.',
};
const FORMALITY = { formal: 'Use formal register.', casual: 'Use casual, everyday register.', natural: '' };

// Markers the app plants in text to keep inline formatting: <i1>…</i1> around a link or bold
// run, {{3}} for something that must come back untouched.
const MARKER = /<\/?i\d+>|\{\{\d+\}\}/g;

function systemPrompt({ source, target, kind, formality, glossary }) {
  const from = source && source !== 'auto' ? `from ${nameOf(source)} ` : '';
  const lines = [
    `You are a professional translator. Translate ${from}into ${nameOf(target)}.`,
    KINDS[kind] || KINDS.text,
    'Reply with one JSON object only: {"t":[{"id":"<id>","text":"<translation>"}]} with exactly one entry per input id, in the same order.',
    'Translate the meaning naturally, as a native writer of the target language would put it; never translate word by word.',
    'Keep names, numbers, URLs, code and anything already in the target language as they are.',
    'Markers such as <i1>…</i1> and {{2}} must appear in the translation exactly as given, around or in place of the corresponding words, with none added or dropped.',
    'No explanations, notes or alternatives.',
    FORMALITY[formality] || '',
  ];
  const terms = String(glossary || '').split('\n').map(l => l.trim()).filter(l => /=|→/.test(l));
  if (terms.length) lines.push('Always translate these terms this way:\n' + terms.join('\n'));
  return lines.filter(Boolean).join('\n');
}

// Pulls the JSON object out of a reply that may be wrapped in a code fence or prose.
function parseReply(text) {
  const s = String(text || '').trim();
  const tryParse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  let j = tryParse(s);
  if (!j) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) j = tryParse(s.slice(a, b + 1)); }
  if (!j || typeof j !== 'object') return null;
  const list = Array.isArray(j.t) ? j.t : Array.isArray(j.translations) ? j.translations : Array.isArray(j) ? j : null;
  if (!list) return null;
  const out = new Map();
  for (const e of list) if (e && e.id !== undefined && typeof e.text === 'string') out.set(String(e.id), e.text);
  return out;
}

function markersOf(text) { return (String(text).match(MARKER) || []).sort().join(' '); }

class MemoryFile {
  constructor(file) { this.file = file; this.map = new Map(); this.dirty = false; this.timer = null; this.load(); }
  load() { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(k, v); } catch { /* first run */ } }
  get(k) { return this.map.get(k); }
  set(k, v) { this.map.set(k, v); this.dirty = true; clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 1500); }
  save() {
    if (!this.dirty) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map))); this.dirty = false; } catch { /* kept in memory */ }
  }
  clear() { this.map.clear(); this.dirty = true; this.save(); }
  get size() { return this.map.size; }
}

class Translator {
  // memory: { get(key), set(key, value) } or null.
  constructor(llm, memory = null) { this.llm = llm; this.memory = memory; this.batchChars = 2000; this.batchItems = 40; }

  // items: [{ id, text }]. Returns a Map id -> translation. Options: source, target, kind
  // ('manga' | 'subtitle' | 'web' | 'document' | 'text'), formality, glossary, context
  // (text that came just before, for continuity), signal, onProgress(done, total).
  async translate(items, opts = {}) {
    const { source = 'auto', target = 'en', kind = 'text', formality = 'natural', glossary = '', context = '', signal, onProgress = () => {} } = opts;
    const out = new Map();
    const pending = [];
    const seen = new Map(); // same text twice in a page: translated once
    for (const it of items) {
      const id = String(it.id), text = String(it.text ?? '');
      if (!text.trim()) { out.set(id, text); continue; }
      const key = `${source}|${target}|${formality}|${text}`;
      const cached = this.memory && this.memory.get(key);
      if (cached !== undefined && cached !== null) { out.set(id, cached); continue; }
      if (seen.has(text)) { seen.get(text).push(id); continue; }
      seen.set(text, [id]);
      pending.push({ id, text, key });
    }
    const total = pending.length;
    let done = 0;
    onProgress(0, total);
    const system = systemPrompt({ source, target, kind, formality, glossary });
    const batches = [];
    let cur = [], chars = 0;
    for (const p of pending) {
      if (cur.length && (chars + p.text.length > this.batchChars || cur.length >= this.batchItems)) { batches.push(cur); cur = []; chars = 0; }
      cur.push(p); chars += p.text.length;
    }
    if (cur.length) batches.push(cur);
    let before = context;
    for (const batch of batches) {
      const got = await this._batch(batch, { system, signal, before });
      for (const p of batch) {
        const t = got.get(p.id);
        if (t === undefined) continue;
        out.set(p.id, t);
        if (this.memory) this.memory.set(p.key, t);
      }
      before = batch.slice(-3).map(p => p.text).join('\n');
      done += batch.length;
      onProgress(done, total);
    }
    for (const [text, ids] of seen) { const t = out.get(ids[0]); if (t !== undefined) for (const id of ids.slice(1)) out.set(id, t); }
    return out;
  }

  async translateOne(text, opts = {}) {
    const got = await this.translate([{ id: '1', text }], opts);
    return got.get('1') ?? text;
  }

  // One request for a batch; whatever comes back wrong (missing id, lost marker) is asked for
  // again on its own, once, and then left untranslated rather than mangled.
  async _batch(batch, { system, signal, before }, retry = true) {
    const messages = [{ role: 'system', content: system }];
    if (before) messages.push({ role: 'user', content: `For context only (already translated, do not include in the reply):\n${before}` }, { role: 'assistant', content: '{"t":[]}' });
    messages.push({ role: 'user', content: JSON.stringify({ items: batch.map(p => ({ id: p.id, text: p.text })) }) });
    const budget = Math.min(16000, 300 + batch.reduce((n, p) => n + p.text.length, 0) * 3);
    let reply;
    try { reply = await this.llm.chat(messages, { json: true, maxTokens: budget, temperature: 0.2, signal }); }
    catch (e) { if (!retry || batch.length === 1) throw e; return this._split(batch, { system, signal, before }); }
    const got = parseReply(reply) || new Map();
    const ok = new Map(), bad = [];
    for (const p of batch) {
      const t = got.get(p.id);
      if (typeof t === 'string' && t.trim() && markersOf(t) === markersOf(p.text)) ok.set(p.id, t.trim());
      else bad.push(p);
    }
    if (bad.length && retry) {
      const again = bad.length === batch.length && batch.length > 1 ? await this._split(batch, { system, signal, before }) : await this._each(bad, { system, signal, before });
      for (const [k, v] of again) ok.set(k, v);
    }
    return ok;
  }

  async _split(batch, ctx) {
    const mid = Math.ceil(batch.length / 2);
    const a = await this._batch(batch.slice(0, mid), ctx, batch.length > 2);
    const b = await this._batch(batch.slice(mid), ctx, batch.length > 2);
    return new Map([...a, ...b]);
  }

  async _each(items, ctx) {
    const out = new Map();
    for (const p of items) {
      try { const got = await this._batch([p], ctx, false); for (const [k, v] of got) out.set(k, v); } catch { /* left untranslated */ }
    }
    return out;
  }
}

module.exports = { Translator, MemoryFile, systemPrompt, parseReply, markersOf, MARKER };
