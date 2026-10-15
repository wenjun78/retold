'use strict';
// The script run inside a web page to translate it in place. It cuts the page into runs of
// text (a paragraph, a list item, a button label), keeps inline formatting as numbered
// markers (<i1>…</i1> around a link or a bold run), swaps each run for its translation
// wrapped in a layout-neutral span, and remembers the original so the page can be flipped
// back. New text the page adds later (comments loading, a menu opening) is collected by a
// mutation observer and handed over on request.
//
// It is sent to the page as a string, so it has no imports; `install` is serialised whole.

function install() {
  if (window.__gloss) return;
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'BR', 'IMG', 'LABEL', 'CODE']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME', 'SVG', 'MATH', 'PRE', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE', 'OBJECT', 'HEAD']);
  const ATTRS = ['alt', 'title', 'placeholder', 'aria-label'];
  const LETTERS = /[\p{L}]{2,}/u;
  const runs = new Map();   // id -> { wrapper, original: Node[], translated: Node[] }
  const attrs = new Map();  // id -> { el, name, original }
  let next = 1, mode = 'translated', pending = [];
  const seen = new WeakSet(); // text nodes already in a run

  const skipped = (el) => !el || SKIP.has(el.tagName) || el.isContentEditable || el.getAttribute('translate') === 'no' || /\bnotranslate\b/.test(el.className || '') || el.closest('.gloss-t,[translate="no"],.notranslate');
  const isInline = (n) => n.nodeType === 1 && INLINE.has(n.tagName) && !skipped(n) && !hasBlockInside(n);
  function hasBlockInside(el) {
    for (const c of el.childNodes) if (c.nodeType === 1 && (!INLINE.has(c.tagName) || hasBlockInside(c))) return true;
    return false;
  }

  // Serialises a run of nodes to text with markers; `map` collects the elements by number.
  function serialize(nodes, map) {
    let s = '';
    for (const n of nodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.tagName === 'BR') { s += '\n'; continue; }
        const k = map.length + 1; map.push(n);
        if (n.tagName === 'IMG' || n.tagName === 'WBR' || !n.childNodes.length) s += `<i${k}></i${k}>`;
        else s += `<i${k}>` + serialize([...n.childNodes], map) + `</i${k}>`;
      }
    }
    return s;
  }

  // Walks the page and collects runs under `root`: consecutive text and inline nodes
  // between block elements, holding at least one word.
  function collect(root) {
    const out = [];
    const walk = (el) => {
      if (el.nodeType !== 1 || skipped(el)) return;
      let run = [];
      const flush = () => {
        if (run.length) {
          const text = run.map(n => n.textContent).join('');
          if (LETTERS.test(text)) {
            const map = [];
            const serialized = serialize(run, map).replace(/[ \t]*\n[ \t]*/g, '\n');
            const lead = serialized.match(/^\s*/)[0], trail = serialized.match(/\s*$/)[0];
            const body = serialized.slice(lead.length, serialized.length - trail.length);
            if (LETTERS.test(body) && body.length <= 3000) {
              const id = 'r' + next++;
              runs.set(id, { nodes: run.slice(), map, lead, trail, parent: run[0].parentNode });
              for (const n of run) if (n.nodeType === 3) seen.add(n);
              out.push({ id, text: body });
            }
          }
          run = [];
        }
      };
      for (const n of [...el.childNodes]) {
        if (n.nodeType === 3) { if (!seen.has(n) && n.nodeValue.trim()) run.push(n); else if (!n.nodeValue.trim()) { if (run.length) run.push(n); } else flush(); }
        else if (n.nodeType === 1) {
          if (isInline(n)) run.push(n);
          else { flush(); walk(n); }
        }
      }
      flush();
    };
    const top = root || document.body;
    walk(top);
    // Text in attributes: a picture's alt text, a button's tooltip, a field's placeholder.
    const withAttrs = [top, ...top.querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))];
    for (const el of withAttrs) {
      if (el.nodeType !== 1 || skipped(el) || el.closest('.gloss-t')) continue;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && LETTERS.test(v) && !el.hasAttribute('data-gloss-' + a)) {
          const id = 'a' + next++;
          attrs.set(id, { el, name: a, original: v });
          el.setAttribute('data-gloss-' + a, '1');
          out.push({ id, text: v });
        }
      }
    }
    if (!root && document.title && LETTERS.test(document.title) && !attrs.has('doc-title')) { attrs.set('doc-title', { el: null, name: 'doc-title', original: document.title }); out.push({ id: 'doc-title', text: document.title }); }
    return out;
  }

  // Turns a translation with markers back into nodes, reusing the original inline elements.
  function build(text, map, doc) {
    const frag = doc.createDocumentFragment();
    const re = /<i(\d+)>([\s\S]*?)<\/i\1>/g;
    let last = 0, m;
    const addText = (s) => { if (!s) return; const parts = s.split('\n'); parts.forEach((p, i) => { if (i) frag.appendChild(doc.createElement('br')); if (p) frag.appendChild(doc.createTextNode(p)); }); };
    while ((m = re.exec(text))) {
      addText(text.slice(last, m.index));
      const el = map[Number(m[1]) - 1];
      if (el) {
        const clone = el.cloneNode(false);
        if (el.tagName !== 'IMG' && el.tagName !== 'WBR') clone.appendChild(build(m[2], map, doc));
        frag.appendChild(clone);
      } else addText(m[2]);
      last = m.index + m[0].length;
    }
    addText(text.slice(last));
    return frag;
  }

  function apply(translations) {
    let n = 0;
    for (const [id, t] of Object.entries(translations)) {
      if (attrs.has(id)) {
        const a = attrs.get(id);
        if (a.name === 'doc-title') document.title = t; else a.el.setAttribute(a.name, t);
        a.translated = t; n++;
        continue;
      }
      const r = runs.get(id);
      if (!r || r.wrapper) continue;
      const first = r.nodes[0];
      if (!first.parentNode) continue;
      const wrapper = document.createElement('span');
      wrapper.className = 'gloss-t'; wrapper.style.display = 'contents'; wrapper.setAttribute('data-gloss-id', id);
      wrapper.title = r.nodes.map(x => x.textContent).join('').trim();
      first.parentNode.insertBefore(wrapper, first);
      const original = document.createDocumentFragment();
      for (const node of r.nodes) original.appendChild(node);
      r.original = [...original.childNodes];
      const translated = build(r.lead + t + r.trail, r.map, document);
      r.translated = [...translated.childNodes];
      wrapper.appendChild(mode === 'translated' ? translated : original);
      r.wrapper = wrapper; n++;
    }
    return n;
  }

  function show(which) {
    mode = which === 'original' ? 'original' : 'translated';
    for (const r of runs.values()) {
      if (!r.wrapper) continue;
      const want = mode === 'original' ? r.original : r.translated;
      if (r.wrapper.firstChild === want[0]) continue;
      while (r.wrapper.firstChild) r.wrapper.removeChild(r.wrapper.firstChild);
      for (const node of want) r.wrapper.appendChild(node);
    }
    for (const a of attrs.values()) {
      if (a.translated === undefined) continue;
      const v = mode === 'original' ? a.original : a.translated;
      if (a.name === 'doc-title') document.title = v; else a.el.setAttribute(a.name, v);
    }
    return mode;
  }

  // Text the page added after the first pass.
  const observer = new MutationObserver((records) => {
    for (const rec of records) for (const node of rec.addedNodes) {
      if (node.nodeType !== 1 || node.closest('.gloss-t') || skipped(node)) continue;
      pending.push(node);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function collectPending() {
    const roots = pending.filter(n => n.isConnected); pending = [];
    const out = [];
    for (const r of roots) { if (r.closest('.gloss-t')) continue; for (const x of collect(r)) out.push(x); }
    return out;
  }

  window.__gloss = { collect: () => collect(), pending: collectPending, apply, show, count: () => runs.size, lang: () => document.documentElement.lang || '' };
}

const script = `(${install.toString()})();`;

module.exports = { install, script };
