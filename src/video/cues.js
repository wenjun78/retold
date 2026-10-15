// Subtitle cues: { start, end, text, translated? } with times in seconds. Reading and
// writing SRT and WebVTT, turning speech-to-text segments into lines that are read
// comfortably, and finding the cue showing at a moment. Pure, shared with the window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Gloss = root.Gloss || {}).cues = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parseTime(s) {
    const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
    if (!m) return NaN;
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  }

  function timecode(sec, { comma = true } = {}) {
    const t = Math.max(0, sec);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${pad(ms, 3)}`;
  }

  const stripTags = (t) => String(t).replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();

  // SRT and WebVTT share the shape: blocks separated by blank lines, a timing line with -->.
  function parseSubtitles(text) {
    const out = [];
    const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l.trim() !== '');
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      const [a, b] = lines[ti].split('-->').map(s => s.trim().split(/\s+/)[0]);
      const start = parseTime(a), end = parseTime(b);
      if (!(start >= 0) || !(end >= 0)) continue;
      const body = lines.slice(ti + 1).map(stripTags).filter(Boolean).join('\n');
      if (body) out.push({ start, end, text: body });
    }
    return out.sort((p, q) => p.start - q.start);
  }

  function formatSrt(cues, { translated = true, both = false } = {}) {
    return cues.map((c, i) => {
      const t = translated && c.translated ? c.translated : c.text;
      const body = both && c.translated ? `${c.translated}\n${c.text}` : t;
      return `${i + 1}\n${timecode(c.start)} --> ${timecode(c.end)}\n${body}\n`;
    }).join('\n');
  }

  function formatVtt(cues, opts = {}) {
    return 'WEBVTT\n\n' + cues.map(c => {
      const t = opts.translated !== false && c.translated ? c.translated : c.text;
      return `${timecode(c.start, { comma: false })} --> ${timecode(c.end, { comma: false })}\n${t}\n`;
    }).join('\n');
  }

  // Speech comes back in fragments; a subtitle should be a sentence or a comfortable part of
  // one. Fragments are joined until the sentence ends or the line gets long, and a fragment
  // that is itself too long is split at its punctuation in proportion to its length.
  function mergeSegments(segments, { maxDur = 7, maxChars = 84, gap = 1.2 } = {}) {
    const out = [];
    let cur = null;
    const endsSentence = (t) => /[.!?。！？…]["”’」』)]?$/.test(t.trim());
    const flush = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
    for (const s of segments) {
      const text = String(s.text || '').trim();
      if (!text) continue;
      if (cur && (s.start - cur.end > gap || cur.text.length + text.length + 1 > maxChars || s.end - cur.start > maxDur)) flush();
      if (!cur) cur = { start: s.start, end: s.end, text };
      else { cur.end = s.end; cur.text += (/[぀-ヿ一-鿿]$/.test(cur.text) ? '' : ' ') + text; }
      if (endsSentence(cur.text)) flush();
    }
    flush();
    const split = [];
    for (const c of out) {
      if (c.text.length <= maxChars * 1.3 && c.end - c.start <= maxDur * 1.3) { split.push(c); continue; }
      const parts = c.text.match(/[^,;:，；、.!?。！？]+[,;:，；、.!?。！？]*\s*/g) || [c.text];
      const total = parts.reduce((n, p) => n + p.length, 0) || 1;
      let t = c.start, piece = null;
      for (const p of parts) {
        const dur = (c.end - c.start) * (p.length / total);
        if (piece && piece.text.length + p.length <= maxChars) { piece.text += p; piece.end += dur; }
        else { if (piece) split.push(piece); piece = { start: t, end: t + dur, text: p }; }
        t += dur;
      }
      if (piece) split.push(piece);
      for (const p of split) p.text = p.text.trim();
    }
    return split;
  }

  // The cue (index) showing at time t, or -1.
  function cueAt(cues, t) {
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, c = cues[mid];
      if (t < c.start) hi = mid - 1; else if (t >= c.end) lo = mid + 1; else return mid;
    }
    return -1;
  }

  // Keeps cues sorted and without duplicates when chunks arrive out of order.
  function mergeInto(list, incoming) {
    const key = (c) => `${c.start.toFixed(2)}|${c.text}`;
    const seen = new Set(list.map(key));
    for (const c of incoming) if (!seen.has(key(c))) { list.push(c); seen.add(key(c)); }
    list.sort((a, b) => a.start - b.start);
    return list;
  }

  return { parseTime, timecode, parseSubtitles, formatSrt, formatVtt, mergeSegments, cueAt, mergeInto, stripTags };
});
