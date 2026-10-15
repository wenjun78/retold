// Fits a translation into the space the original lettering had. Horizontal text is wrapped
// into balanced centred lines (the diamond shape of comic lettering); Chinese and Japanese
// set top to bottom go into columns read right to left, with punctuation in its vertical
// forms and Latin words turned on their side. Pure arithmetic: the caller supplies a
// measurer, so the same code runs in the window (canvas) and in tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Gloss = root.Gloss || {}).layout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/;
  const CLOSING = /^[、。，．！？」』）〕】〉》〙〗〟’”…‥ー～〜!?,.:;)\]]$/;
  const OPENING = /^[「『（〔【〈《〘〖〝‘“(\[]$/;
  const VERTICAL_FORMS = { '，': '︐', '、': '︑', '。': '︒', '：': '︓', '；': '︔', '！': '︕', '？': '︖', '（': '︵', '）': '︶', '「': '﹁', '」': '﹂', '『': '﹃', '』': '﹄', '…': '︙', '‥': '︰', '—': '︱', '－': '︱', '～': '〜', '〔': '︹', '〕': '︺', '【': '︻', '】': '︼', '《': '︽', '》': '︾', '〈': '︿', '〉': '﹀' };

  // text -> tokens [{ text, glue }] where glue is what joins this token to the previous one
  // on the same line. Line breaks in the text are kept as a token of their own.
  function tokenize(text, cjk) {
    const out = [];
    const paragraphs = String(text).replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi) out.push({ br: true });
      if (!cjk) { for (const w of para.trim().split(/\s+/).filter(Boolean)) out.push({ text: w, glue: ' ' }); return; }
      // CJK: one character per token, Latin words and numbers kept whole; a character that
      // may not start a line (closing punctuation) is glued onto the one before.
      const parts = para.match(/[A-Za-z0-9][A-Za-z0-9'’.\-]*|\s+|./gu) || [];
      let prev = null;
      for (const p of parts) {
        if (/^\s+$/.test(p)) { if (prev) prev.space = true; continue; }
        const tok = { text: p, glue: prev && prev.space ? ' ' : '' };
        if (prev && (CLOSING.test(p) || OPENING.test(prev.text))) { prev.text += (prev.space ? ' ' : '') + p; continue; }
        out.push(tok); prev = tok;
      }
    });
    return out;
  }

  function wrap(tokens, widthOf, maxWidth) {
    const lines = [];
    let cur = '', curW = 0;
    for (const t of tokens) {
      if (t.br) { lines.push(cur); cur = ''; curW = 0; continue; }
      const candidate = cur ? cur + t.glue + t.text : t.text;
      const w = widthOf(candidate);
      if (cur && w > maxWidth) { lines.push(cur); cur = t.text; curW = widthOf(cur); }
      else { cur = candidate; curW = w; }
    }
    lines.push(cur);
    return lines.filter((l, i) => l !== '' || i < lines.length - 1).map(l => ({ text: l, width: widthOf(l) }));
  }

  // measure(size) -> (str) => width in px at that size.
  function fitHorizontal({ text, box, measure, cjk = false, minSize = 8, maxSize = 160, lineHeight = 1.18, padding = 0.08 }) {
    const px = box.w * padding, py = box.h * padding;
    const W = Math.max(4, box.w - 2 * px), H = Math.max(4, box.h - 2 * py);
    const tokens = tokenize(text, cjk);
    if (!tokens.length) return { size: minSize, lines: [], lineHeight, direction: 'horizontal', width: 0, height: 0 };
    const fits = (size) => {
      const widthOf = measure(size);
      const lines = wrap(tokens, widthOf, W);
      return lines.every(l => l.width <= W + 0.5) && lines.length * size * lineHeight <= H + 0.5;
    };
    let lo = minSize, hi = Math.max(minSize, Math.min(maxSize, Math.floor(H / lineHeight)));
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    const size = lo;
    const widthOf = measure(size);
    let lines = wrap(tokens, widthOf, W);
    // Balance: the narrowest width that still gives the same number of lines.
    const n = lines.length;
    if (n > 1) {
      const longest = Math.max(...tokens.filter(t => !t.br).map(t => widthOf(t.text)));
      let a = longest, b = W;
      for (let i = 0; i < 12 && b - a > 1; i++) { const m = (a + b) / 2; if (wrap(tokens, widthOf, m).length === n) b = m; else a = m; }
      lines = wrap(tokens, widthOf, b);
    }
    const width = Math.max(0, ...lines.map(l => l.width));
    return { size, lines, lineHeight, direction: 'horizontal', width, height: lines.length * size * lineHeight };
  }

  // Cells of a vertical column: one per CJK character, or one rotated run per Latin word.
  function cells(text, size, widthOf) {
    const out = [];
    const paragraphs = String(text).replace(/\r/g, '').split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi) out.push({ br: true });
      const parts = para.replace(/\s+/g, ' ').trim().match(/[A-Za-z0-9][A-Za-z0-9'’.\-]*|./gu) || [];
      for (const p of parts) {
        if (p === ' ') { out.push({ ch: '', h: size * 0.5, gap: true }); continue; }
        if (/^[A-Za-z0-9]/.test(p)) {
          if (p.length <= 2) out.push({ ch: p, h: size * 1.05, upright: true });   // "OK", "12": tate-chū-yoko
          else out.push({ ch: p, h: widthOf(p) + size * 0.15, rotate: true });
          continue;
        }
        const ch = VERTICAL_FORMS[p] || p;
        const small = /^[、。，．,.]$/.test(p); // a comma or full stop takes half a cell set vertically
        out.push({ ch, h: size * (small ? 0.6 : 1.05), closing: CLOSING.test(p), opening: OPENING.test(p), original: p });
      }
    });
    return out;
  }

  function pack(items, maxH, size) {
    const columns = [];
    let cur = [], curH = 0;
    for (const it of items) {
      if (it.br) { if (cur.length) columns.push(cur); cur = []; curH = 0; continue; }
      if (it.gap && !cur.length) continue;
      const over = curH + it.h > maxH + 0.5;
      // A closing mark may hang past the bottom (up to a character) rather than open the next column.
      if (over && cur.length && !(it.closing && curH + it.h <= maxH + size * 1.05)) {
        const last = cur[cur.length - 1];
        if (last.opening) { cur.pop(); columns.push(cur); cur = [last]; curH = last.h; }
        else { columns.push(cur); cur = []; curH = 0; }
        if (it.gap) continue;
      }
      cur.push(it); curH += it.h;
    }
    if (cur.length) columns.push(cur);
    return columns.map(c => { while (c.length && c[c.length - 1].gap) c.pop(); return c; }).filter(c => c.length);
  }

  function fitVertical({ text, box, measure, minSize = 8, maxSize = 160, columnGap = 1.3, padding = 0.08 }) {
    const px = box.w * padding, py = box.h * padding;
    const W = Math.max(4, box.w - 2 * px), H = Math.max(4, box.h - 2 * py);
    const colsFor = (size) => pack(cells(text, size, measure(size)), H, size);
    const fits = (size) => {
      const cols = colsFor(size);
      const width = cols.length * size * columnGap - size * (columnGap - 1);
      return width <= W + 0.5 && cols.every(c => c.reduce((n, i) => n + i.h, 0) <= H + size * 1.05 + 0.5);
    };
    let lo = minSize, hi = Math.max(minSize, Math.min(maxSize, Math.floor(H)));
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
    const size = lo;
    let columns = colsFor(size);
    // Balance column heights: the shortest column height that keeps the column count.
    const n = columns.length;
    if (n > 1) {
      const items = cells(text, size, measure(size));
      let a = Math.max(...items.filter(i => !i.br).map(i => i.h)), b = H;
      for (let i = 0; i < 12 && b - a > 1; i++) { const m = (a + b) / 2; if (pack(items, m, size).length === n) b = m; else a = m; }
      columns = pack(items, b, size);
    }
    const height = Math.max(0, ...columns.map(c => c.reduce((s, i) => s + i.h, 0)));
    const width = columns.length ? columns.length * size * columnGap - size * (columnGap - 1) : 0;
    return { size, columns, columnGap, direction: 'vertical', width, height };
  }

  function fit(opts) { return opts.direction === 'vertical' ? fitVertical(opts) : fitHorizontal(opts); }

  return { fit, fitHorizontal, fitVertical, tokenize, wrap, cells, pack, VERTICAL_FORMS, CJK };
});
