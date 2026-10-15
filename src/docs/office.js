'use strict';
// Word and PowerPoint files are zipped XML. Each paragraph's text runs are gathered into
// one string with markers (<i1>…</i1> per run, so bold words stay bold), translated, and
// written back into the same runs; everything else in the file (styles, pictures, tables,
// page layout) is left exactly as it was.
const JSZip = require('jszip');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Which parts of the file hold text, by kind of document.
const KINDS = {
  docx: { parts: /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/, para: /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, text: /<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)/g, open: (attrs) => `<w:t${attrs.includes('xml:space') ? attrs : attrs + ' xml:space="preserve"'}>`, close: '</w:t>' },
  pptx: { parts: /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/, para: /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, text: /<a:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/a:t>)/g, open: (attrs) => `<a:t${attrs}>`, close: '</a:t>' },
  xlsx: { parts: /^xl\/sharedStrings\.xml$/, para: /<si>[\s\S]*?<\/si>/g, text: /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g, open: (attrs) => `<t${attrs.includes('xml:space') ? attrs : attrs + ' xml:space="preserve"'}>`, close: '</t>' },
};

const LETTERS = /\p{L}{2,}/u;

// Pulls the paragraphs of one XML part: [{ key, text (with markers), runs: n }].
function paragraphsOf(xml, kind) {
  const k = KINDS[kind];
  const out = [];
  let i = 0;
  for (const m of xml.matchAll(k.para)) {
    const texts = [...m[0].matchAll(k.text)].map(t => decode(t[1] || ''));
    const joined = texts.join('');
    if (!LETTERS.test(joined)) { i++; continue; }
    const text = texts.length === 1 ? texts[0] : texts.map((t, n) => (t ? `<i${n + 1}>${t}</i${n + 1}>` : '')).join('');
    out.push({ key: i, text, runs: texts.length, index: m.index, length: m[0].length });
    i++;
  }
  return out;
}

// Writes translations back: run n gets what sits inside its marker, or nothing.
function applyToXml(xml, kind, translations) {
  const k = KINDS[kind];
  let i = 0;
  return xml.replace(k.para, (para) => {
    const t = translations.get(i++);
    if (t === undefined) return para;
    const parts = [];
    for (const m of t.matchAll(/<i(\d+)>([\s\S]*?)<\/i\1>/g)) parts[Number(m[1]) - 1] = m[2];
    const single = !/<i\d+>/.test(t);
    let n = 0;
    return para.replace(k.text, (whole, inner) => {
      const idx = n++;
      const attrs = (whole.match(/^<[\w:]+(\s[^>]*?)?\/?>/)[1] || '').replace(/\s*\/$/, '');
      const value = single ? (idx === 0 ? t : '') : (parts[idx] ?? '');
      if (!value && !inner) return whole;
      return k.open(attrs) + encode(value) + k.close;
    });
  });
}

// buffer: the .docx/.pptx/.xlsx file. translate(items:[{id,text}]) -> Promise<Map id -> text>.
// Returns the translated file as a Buffer.
async function translateOffice(buffer, kind, translate, { onProgress = () => {} } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`Unsupported document kind "${kind}".`);
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter(f => k.parts.test(f)).sort();
  const items = [], where = [];
  const xmls = {};
  for (const part of parts) {
    xmls[part] = await zip.file(part).async('string');
    for (const p of paragraphsOf(xmls[part], kind)) { items.push({ id: String(items.length), text: p.text }); where.push({ part, key: p.key }); }
  }
  if (!items.length) throw new Error('No text was found in this file.');
  const got = await translate(items, { onProgress });
  const perPart = {};
  items.forEach((it, n) => {
    const t = got.get(it.id);
    if (t === undefined) return;
    const w = where[n];
    (perPart[w.part] = perPart[w.part] || new Map()).set(w.key, t);
  });
  for (const part of parts) if (perPart[part]) zip.file(part, applyToXml(xmls[part], kind, perPart[part]));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const kindOf = (name) => (/\.docx$/i.test(name) ? 'docx' : /\.pptx$/i.test(name) ? 'pptx' : /\.xlsx$/i.test(name) ? 'xlsx' : '');

module.exports = { translateOffice, paragraphsOf, applyToXml, kindOf, decode, encode };
