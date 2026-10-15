'use strict';
// Plain text, Markdown and subtitle files. Markdown keeps its structure: heading marks,
// list bullets, quotes and code fences are not translated, only the words after them.
// Subtitle files keep their timing and get their lines translated with context.
const cues = require('../video/cues');

const LETTERS = /\p{L}{2,}/u;
const PREFIX = /^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*|\|?\s*))/;

// text -> { items:[{id,text}], rebuild(map) -> text }
function planMarkdown(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const items = [];
  const slots = []; // per line: { prefix, id } or null
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; slots.push(null); continue; }
    if (fence || !LETTERS.test(line) || /^\s*\|?\s*:?-{2,}/.test(line) || /^\s*!?\[.*\]\(.*\)\s*$/.test(line)) { slots.push(null); continue; }
    const prefix = (line.match(PREFIX) || ['', ''])[1];
    const body = line.slice(prefix.length);
    if (!LETTERS.test(body)) { slots.push(null); continue; }
    const id = String(items.length);
    items.push({ id, text: body });
    slots.push({ prefix, id });
  }
  return {
    items,
    rebuild: (map) => lines.map((line, i) => { const s = slots[i]; if (!s) return line; const t = map.get(s.id); return t === undefined ? line : s.prefix + t; }).join('\n'),
  };
}

// Prose is translated a paragraph at a time (its wrapped lines joined); short lines
// (verse, lists, addresses) stay one item per line.
function planText(text) {
  const paragraphs = String(text).replace(/\r/g, '').split(/\n{2,}/);
  const items = [];
  const plan = paragraphs.map((p) => {
    const lines = p.split('\n');
    if (!LETTERS.test(p)) return { keep: p };
    const avg = lines.reduce((n, l) => n + l.length, 0) / lines.length;
    if (lines.length > 1 && avg < 45) {
      const ids = lines.map(l => { if (!LETTERS.test(l)) return null; const id = String(items.length); items.push({ id, text: l }); return id; });
      return { lines, ids };
    }
    const id = String(items.length);
    items.push({ id, text: lines.map(l => l.trim()).join(' ') });
    return { id };
  });
  return {
    items,
    rebuild: (map) => plan.map(p => {
      if (p.keep !== undefined) return p.keep;
      if (p.lines) return p.lines.map((l, i) => (p.ids[i] !== null && map.get(p.ids[i]) !== undefined ? map.get(p.ids[i]) : l)).join('\n');
      return map.get(p.id) ?? '';
    }).join('\n\n'),
  };
}

function planSubtitles(text, { vtt = false, both = false } = {}) {
  const list = cues.parseSubtitles(text);
  const items = list.map((c, i) => ({ id: String(i), text: c.text }));
  return {
    items,
    rebuild: (map) => {
      const out = list.map((c, i) => ({ ...c, translated: map.get(String(i)) ?? c.text }));
      return vtt ? cues.formatVtt(out) : cues.formatSrt(out, { translated: true, both });
    },
  };
}

// name decides the plan; translate(items) -> Promise<Map>. Returns the translated text.
async function translateText(name, text, translate, opts = {}) {
  const ext = (name.match(/\.(\w+)$/) || ['', ''])[1].toLowerCase();
  const plan = ext === 'srt' || ext === 'vtt' ? planSubtitles(text, { vtt: ext === 'vtt', both: opts.both })
    : ext === 'md' || ext === 'markdown' ? planMarkdown(text) : planText(text);
  if (!plan.items.length) throw new Error('No text was found in this file.');
  const map = await translate(plan.items, { kind: ext === 'srt' || ext === 'vtt' ? 'subtitle' : 'document' });
  return plan.rebuild(map);
}

module.exports = { translateText, planMarkdown, planText, planSubtitles };
