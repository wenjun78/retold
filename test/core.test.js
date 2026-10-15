'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');
const { drawPage, drawBand } = require('./page');
const languages = require('../src/languages');
const { ConfigStore, DEFAULTS } = require('../src/config');
const { LLM, segmentsOf } = require('../src/llm');
const { Translator, MemoryFile, parseReply, markersOf } = require('../src/translate');
const { OcrEngine, joinLines, cleanLine } = require('../src/ocr');
const raster = require('../src/image/raster');
const { findBubbles, readingOrder } = require('../src/image/bubbles');
const { textMask } = require('../src/image/mask');
const { inpaint } = require('../src/image/inpaint');
const { estimateStyle } = require('../src/image/style');
const layout = require('../src/image/layout');
const { Page, groupLines } = require('../src/image/pipeline');
const cues = require('../src/video/cues');
const { Lookahead } = require('../src/video/lookahead');
const { groupFrames, similarity, binarize, frameText } = require('../src/video/burnedin');
const ff = require('../src/video/ffmpeg');
const { VideoSession } = require('../src/video/session');
const { LiveSession } = require('../src/video/live');
const { script: pageScript } = require('../src/web/pagewalk');
const { translateOffice, paragraphsOf, applyToXml } = require('../src/docs/office');
const { translateText, planMarkdown, planText } = require('../src/docs/text');
const { pdfFromPages } = require('../src/docs/pdf');

let srv, tmp;
test.before(async () => { srv = await mock.start(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-')); });
test.after(async () => { await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const cfgFor = (over = {}) => {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.llm = { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'chat-model', extra: {} };
  cfg.stt = { baseUrl: '', apiKey: '', model: 'whisper-1' };
  Object.assign(cfg, over);
  return () => cfg;
};
const measure = (size) => (s) => [...s].reduce((n, ch) => n + (/[぀-ヿ一-鿿]/.test(ch) ? size : size * 0.55), 0);

// ---- languages and settings --------------------------------------------------------
test('languages: direction, OCR data and script guessing', () => {
  assert.equal(languages.directionFor('zh-Hans', 'auto', 'vertical'), 'vertical');
  assert.equal(languages.directionFor('zh-Hans', 'auto', ''), 'vertical');
  assert.equal(languages.directionFor('en', 'auto', 'vertical'), 'horizontal');
  assert.equal(languages.directionFor('en', 'vertical', ''), 'horizontal', 'English is never set top to bottom');
  assert.equal(languages.directionFor('ja', 'horizontal', 'vertical'), 'horizontal');
  assert.equal(languages.ocrLangsFor('ja', { vertical: true }), 'jpn_vert+jpn');
  assert.equal(languages.ocrLangsFor('ms'), 'msa');
  assert.equal(languages.guessLanguage('おまえは'), 'ja');
  assert.equal(languages.guessLanguage('你好'), 'zh-Hans');
  assert.equal(languages.guessLanguage('hello'), 'en');
});

test('config: defaults merge, secrets encrypted on disk', () => {
  const file = path.join(tmp, 'config.json');
  const crypto = { encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString() };
  const store = new ConfigStore(file, crypto);
  store.load();
  store.update({ llm: { apiKey: 'sk-secret', extra: { reasoning_effort: 'high' } }, video: { aheadSec: 90 } });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.llm.apiKey.startsWith('enc:'));
  const again = new ConfigStore(file, crypto); again.load();
  assert.equal(again.get().llm.apiKey, 'sk-secret');
  assert.equal(again.get().video.aheadSec, 90);
  assert.equal(again.get().video.chunkSec, DEFAULTS.video.chunkSec);
  assert.deepEqual(again.get().llm.extra, { reasoning_effort: 'high' });
});

// ---- the API client and the translator -----------------------------------------------------
test('llm.chat asks for JSON and drops parameters a strict model refuses', async () => {
  const strict = await mock.start({ strict: true });
  try {
    const llm = new LLM(cfgFor({ llm: { baseUrl: strict.base + '/v1', apiKey: 'test-key', model: 'm', extra: { verbosity: 'low' } } }));
    const reply = await llm.chat([{ role: 'user', content: JSON.stringify({ items: [{ id: '1', text: 'hi' }] }) }], { json: true });
    const got = parseReply(reply);
    assert.equal(got.get('1'), '[hi]', 'a reply wrapped in a code fence is still read');
  } finally { await strict.close(); }
});

test('llm.transcribe returns timed segments, and spreads time when the service has none', async () => {
  const llm = new LLM(cfgFor());
  const wav = Buffer.alloc(44 + 16000 * 2);
  const r = await llm.transcribe(wav, { language: 'en', duration: 5 });
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[1].start, 2.6);
  assert.equal(srv.log.stt.at(-1).language, 'en');
  const plain = segmentsOf({ text: 'One sentence. Another one!' }, 10);
  assert.equal(plain.segments.length, 2);
  assert.ok(plain.segments[1].start > 4 && plain.segments[1].end === 10);
  assert.equal(segmentsOf({ text: 'Thanks for watching' }).segments.length, 0, 'a known hallucination is dropped');
});

test('translator: batches, markers kept, memory reused, duplicates once', async () => {
  const llm = new LLM(cfgFor());
  const memory = new MemoryFile(path.join(tmp, 'memory.json'));
  const tr = new Translator(llm, memory);
  const before = srv.log.chat.length;
  const items = [{ id: 'a', text: 'Hello <i1>world</i1>' }, { id: 'b', text: 'Hello <i1>world</i1>' }, { id: 'c', text: 'Bye' }, { id: 'd', text: '   ' }];
  const got = await tr.translate(items, { source: 'en', target: 'fr', kind: 'web' });
  assert.equal(got.get('a'), '[Hello <i1>world</i1>]');
  assert.equal(got.get('b'), got.get('a'));
  assert.equal(got.get('d'), '   ', 'blank text comes back as it was');
  assert.equal(srv.log.chat.length - before, 1, 'one request for the batch');
  const sys = srv.log.chat.at(-1).messages[0].content;
  assert.match(sys, /into French/); assert.match(sys, /web page/);
  const again = await tr.translate([{ id: 'x', text: 'Bye' }], { source: 'en', target: 'fr' });
  assert.equal(again.get('x'), '[Bye]');
  assert.equal(srv.log.chat.length - before, 1, 'the memory answered the second time');
  memory.save();
  assert.ok(fs.existsSync(path.join(tmp, 'memory.json')));
});

test('translator: a translation that loses a marker is asked for again, then left alone', async () => {
  let calls = 0;
  const bad = await mock.start({ translate: (t) => { calls++; return /<i\d+>/.test(t) && calls <= 2 ? `[${t.replace(/<\/?i\d+>/g, '')}]` : `[${t}]`; } });
  try {
    const tr = new Translator(new LLM(cfgFor({ llm: { baseUrl: bad.base + '/v1', apiKey: 'test-key', model: 'm', extra: {} } })));
    const got = await tr.translate([{ id: '1', text: 'See <i1>here</i1>' }, { id: '2', text: 'plain' }], { target: 'en' });
    assert.equal(got.get('2'), '[plain]');
    assert.ok(!got.has('1') || markersOf(got.get('1')) === markersOf('See <i1>here</i1>'));
  } finally { await bad.close(); }
});

test('translator: glossary and formality reach the prompt', async () => {
  const tr = new Translator(new LLM(cfgFor()));
  await tr.translate([{ id: '1', text: 'Mr Lau arrives' }], { target: 'zh-Hans', formality: 'formal', glossary: 'Lau = 刘' });
  const sys = srv.log.chat.at(-1).messages[0].content;
  assert.match(sys, /Lau = 刘/); assert.match(sys, /formal register/);
});

// ---- pictures --------------------------------------------------------------------------------
test('raster: components, flood fill, morphology, BMP', () => {
  const w = 6, h = 4, m = new Uint8Array([1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]);
  const { comps } = raster.components(m, w, h);
  assert.equal(comps.length, 3);
  const big = comps.find(c => c.area === 3);
  assert.ok(big.edge);
  const { count } = raster.floodFill(w, h, (x, y) => m[y * w + x] === 1, 0, 0);
  assert.equal(count, 3);
  assert.equal(raster.dilate(m, w, h, 1).reduce((a, b) => a + b, 0) > m.reduce((a, b) => a + b, 0), true);
  const bmp = raster.toBmp({ width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255]) });
  assert.equal(bmp.toString('latin1', 0, 2), 'BM');
  assert.equal(bmp.length, 54 + 8 * 2);
  assert.equal(raster.otsu(Uint8Array.from([0, 0, 0, 255, 255, 255])) < 255, true);
});

test('bubbles: the two bubbles are found in reading order, the empty box is not', () => {
  const { img } = drawPage();
  const regions = findBubbles(img);
  assert.equal(regions.length, 2);
  assert.ok(regions[0].x > 500 && regions[0].y < 100, 'top-right bubble reads first (right to left)');
  assert.ok(regions[1].x < 200 && regions[1].y > 700);
  for (const r of regions) { assert.equal(r.kind, 'bubble'); assert.deepEqual(r.bg, [255, 255, 255]); assert.equal(r.mask.length, r.w * r.h); }
  assert.equal([...regions].sort(readingOrder)[0], regions[0]);
});

test('mask, style and inpaint: lettering found, its size and direction read, paper left clean', () => {
  const { img } = drawPage();
  const [jp, en] = findBubbles(img);
  const tmJ = textMask(img, jp), tmE = textMask(img, en);
  assert.ok(tmJ.coverage > 0.01 && tmJ.coverage < 0.2);
  assert.deepEqual(tmJ.ink, [0, 0, 0]); assert.equal(tmJ.outline, null);
  const sJ = estimateStyle({ mask: tmJ.raw, w: jp.w, h: jp.h, ink: tmJ.ink, outline: null, cjk: true });
  const sE = estimateStyle({ mask: tmE.raw, w: en.w, h: en.h, ink: tmE.ink, outline: null, cjk: false });
  assert.equal(sJ.orientation, 'vertical'); assert.equal(sE.orientation, 'horizontal');
  assert.ok(sJ.size >= 24 && sJ.size <= 44, `size ${sJ.size}`);
  assert.ok(sE.size >= 20 && sE.size <= 40, `size ${sE.size}`);
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  inpaint(out, jp, tmJ.mask, tmJ.bg);
  // Inside the bubble nothing dark is left.
  let dark = 0, n = 0;
  for (let y = 0; y < jp.h; y++) for (let x = 0; x < jp.w; x++) {
    if (!jp.interior[y * jp.w + x]) continue;
    const p = ((jp.y + y) * img.width + jp.x + x) * 4; n++;
    if (out.data[p] < 128) dark++;
  }
  assert.ok(dark / n < 0.005, `dark left: ${dark}/${n}`);
});

test('mask on art: white letters with a black outline, the outline told from the fill', () => {
  const { drawBand } = require('./page');
  const { img } = drawBand({ text: 'ドドドド', noise: false });
  const region = { x: 300, y: 40, w: 360, h: 110, kind: 'text' };
  const tm = textMask(img, region);
  assert.ok(tm.ink[0] > 200 && tm.ink[1] > 200, 'ink is white');
  assert.ok(tm.outline && tm.outline.color[0] < 60, 'outline is black');
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  inpaint(out, region, tm.mask, null);
  let white = 0;
  for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) { const p = (y * img.width + x) * 4; if (out.data[p] > 230 && out.data[p + 1] > 230) white++; }
  assert.ok(white < region.w * region.h * 0.01, 'the white lettering is gone');
});

test('layout: horizontal lines are balanced and fit; vertical columns run right to left with vertical punctuation', () => {
  const h = layout.fit({ text: 'You are already dead.', box: { w: 260, h: 320 }, direction: 'horizontal', measure, padding: 0.1 });
  assert.ok(h.size > 20 && h.lines.length >= 2);
  assert.ok(h.lines.every(l => l.width <= 260 * 0.8 + 0.5));
  assert.ok(h.lines.length * h.size * h.lineHeight <= 320 * 0.8 + 0.5);
  const v = layout.fit({ text: '你已经死了。', box: { w: 260, h: 320 }, direction: 'vertical', measure, padding: 0.1 });
  assert.equal(v.direction, 'vertical');
  assert.ok(v.columns.length >= 1);
  const chars = v.columns.flat().map(c => c.ch).join('');
  assert.ok(chars.includes('︒'), 'the full stop takes its vertical form');
  const v2 = layout.fit({ text: '什么？OK吗', box: { w: 120, h: 300 }, direction: 'vertical', measure, padding: 0.1 });
  const latin = v2.columns.flat().find(c => c.ch === 'OK');
  assert.ok(latin && latin.upright, 'two Latin letters stand upright');
  const cells = layout.cells('Hello', 20, measure(20));
  assert.ok(cells[0].rotate, 'a Latin word turns on its side');
  const wrapped = layout.fit({ text: 'Supercalifragilistic', box: { w: 60, h: 40 }, direction: 'horizontal', measure, minSize: 6, padding: 0 });
  assert.equal(wrapped.size, 6, 'a word that cannot fit shrinks to the minimum');
  const cjk = layout.tokenize('你好，世界', true);
  assert.equal(cjk[1].text, '好，', 'a comma never starts a line');
});

test('ocr: the English bubble is read with boxes, outline masked out; lines joined sensibly', async () => {
  const { img } = drawPage();
  const ocr = new OcrEngine({ dataDir: path.join(tmp, 'tessdata') });
  try {
    const page = new Page('p', img, { ocr, llm: null, config: () => ({}) });
    const regions = await page.detect({ bubbles: true, source: 'en' });
    assert.equal(regions.length, 2);
    const en = await page.read(regions[1].id, { mode: 'local', source: 'en' });
    assert.match(en.source.replace(/[^A-Z ]/g, ''), /WHAT DID YOU JUST SAY/);
    assert.equal(en.orientation, 'horizontal');
    assert.ok(!en.source.includes('|'), 'the bubble outline is not read as a letter');
    const { image, regions: styled } = page.erase();
    assert.equal(image.data.length, img.data.length);
    assert.ok(styled[1].style && styled[1].style.size >= 20 && styled[1].style.size <= 40);
  } finally { await ocr.stop(); }
  assert.equal(joinLines(['おまえは', 'もう死んで', 'いる']), 'おまえはもう死んでいる');
  assert.equal(joinLines(['WHAT DID', 'YOU SAY']), 'WHAT DID YOU SAY');
  assert.equal(joinLines(['some-', 'thing']), 'something');
  assert.equal(cleanLine('!?'), '!?'); assert.equal(cleanLine('| | ||'), '');
});

test('ocr: vertical Japanese is read top to bottom (language data fetched once)', async (t) => {
  const { img } = drawPage();
  const dir = path.join(tmp, 'tessdata-ja'); fs.mkdirSync(dir, { recursive: true });
  const local = path.join(__dirname, 'fixtures', 'tessdata');
  if (fs.existsSync(local)) for (const f of fs.readdirSync(local)) fs.copyFileSync(path.join(local, f), path.join(dir, f));
  const ocr = new OcrEngine({ dataDir: dir, fetchFn: (url) => fetch(url, { signal: AbortSignal.timeout(30000) }) });
  try {
    try { await ocr._ensureLang('jpn_vert'); await ocr._ensureLang('jpn'); } catch (e) { t.skip(`Japanese OCR data not available here (${e.message})`); return; }
    const page = new Page('p', img, { ocr, llm: null, config: () => ({}) });
    const regions = await page.detect({ bubbles: true, source: 'ja' });
    const jp = await page.read(regions[0].id, { mode: 'local', source: 'ja' });
    assert.equal(jp.orientation, 'vertical');
    assert.equal(jp.source, 'おまえはもう死んでいる');
  } finally { await ocr.stop(); }
});

test('page with the image model: bubbles read by the vision model, translated, erased, styled', async () => {
  const { img } = drawPage();
  const llm = new LLM(cfgFor());
  const translator = new Translator(llm);
  const page = new Page('p', img, { ocr: null, llm, translator, config: cfgFor() });
  await page.detect({ bubbles: true, source: 'auto' });
  const r = await page.read(page.regions[0].id, { mode: 'vision', source: 'auto' });
  assert.equal(r.source, 'おまえはもう死んでいる'); assert.equal(r.orientation, 'vertical');
  assert.equal(srv.log.vision.at(-1).images, 1);
  const { regions } = page.erase();
  assert.equal(regions[0].style.orientation, 'vertical');
  assert.equal(regions[0].style.colorHex, '#000000');
  page.updateRegion(page.regions[1].id, { source: 'WHAT DID YOU JUST SAY?!' });
  const added = page.addRegion({ x: 600, y: 1000, w: 180, h: 120 });
  assert.equal(page.regions.length, 3);
  page.removeRegion(added.id);
  assert.equal(page.regions.length, 2);
  page.reset();
  assert.equal(page.regions.length, 0);
});

test('page from a PDF: text with positions becomes blocks, no OCR', () => {
  const lines = [
    { text: 'The quick brown fox', bbox: { x: 100, y: 100, w: 300, h: 20 } }, { text: 'jumps over the lazy dog.', bbox: { x: 100, y: 124, w: 320, h: 20 } },
    { text: 'A new paragraph far below.', bbox: { x: 100, y: 300, w: 330, h: 20 } },
  ];
  const page = new Page('pdf', { width: 800, height: 1000, data: new Uint8ClampedArray(800 * 1000 * 4).fill(255) }, { config: () => ({}) });
  const regions = page.prefill(lines);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].source, 'The quick brown fox jumps over the lazy dog.');
  assert.ok(groupLines(lines.map(l => ({ ...l, confidence: 90 }))).length === 2);
});

// ---- video --------------------------------------------------------------------------------------
test('cues: SRT in and out, fragments merged into readable lines, lookup by time', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,500\n<i>Hello</i> there\n\n2\n00:00:04,000 --> 00:00:06,000\nBye\n';
  const list = cues.parseSubtitles(srt);
  assert.equal(list.length, 2); assert.equal(list[0].text, 'Hello there'); assert.equal(list[0].end, 3.5);
  assert.equal(cues.cueAt(list, 2), 0); assert.equal(cues.cueAt(list, 3.7), -1); assert.equal(cues.cueAt(list, 5), 1);
  const out = cues.formatSrt(list.map((c, i) => ({ ...c, translated: 'T' + i })));
  assert.match(out, /00:00:01,000 --> 00:00:03,500\nT0/);
  assert.match(cues.formatVtt(list), /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.500/);
  const merged = cues.mergeSegments([{ start: 0, end: 1, text: 'So I was' }, { start: 1, end: 2, text: 'thinking about it.' }, { start: 2.5, end: 4, text: 'And then' }, { start: 9, end: 10, text: 'later.' }]);
  assert.equal(merged[0].text, 'So I was thinking about it.');
  assert.equal(merged.length, 3, 'a long pause separates lines');
  const long = cues.mergeSegments([{ start: 0, end: 20, text: 'A, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, aa, bb, cc, dd, ee, ff, gg, hh, ii, jj.' }]);
  assert.ok(long.length > 1, 'a very long fragment is split at its punctuation');
  assert.ok(long.every(c => c.end > c.start));
});

test('lookahead: works a minute ahead, in order, and moves with a seek', async () => {
  const worked = [];
  const la = new Lookahead({ duration: 200, chunkSec: 20, aheadSec: 60, parallel: 2, work: async (s, e, i) => { worked.push(i); await new Promise(r => setTimeout(r, 5)); return { i }; } });
  const done = []; la.on('chunk', c => done.push(c.index));
  la.update(0);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(done, [0, 1, 2, 3]);
  assert.equal(la.readyFrom(0), 80);
  assert.equal(la.readyFrom(100), 0);
  la.update(150);
  await new Promise(r => setTimeout(r, 120));
  assert.ok(done.includes(7) && done.includes(9));
  assert.ok(!worked.includes(5), 'chunks between the old and new place are not touched');
  assert.equal(la.readyFrom(150), 50);
  la.stop();
  const failing = new Lookahead({ duration: 40, chunkSec: 20, aheadSec: 60, work: async () => { throw new Error('no key'); } });
  const errors = []; failing.on('error', e => errors.push(e));
  failing.update(0);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(errors.length, 2);
  assert.equal(failing.status().failed.length, 2);
  failing.stop();
  const open = new Lookahead({ duration: 0, chunkSec: 10, aheadSec: 45, work: async (s) => (s >= 30 ? { pastEnd: true } : { s }) });
  open.update(0);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(open.lastChunk(), 2, 'an unknown length ends where the work says it does');
  open.stop();
});

test('burned-in subtitles: frames grouped into cues, noise ignored, one misread frame tolerated', () => {
  const f = (t, text, conf = 90) => ({ t, lines: text ? [{ text, confidence: conf, bbox: { x: 200, y: 60, w: 500, h: 40 } }] : [] });
  const frames = [f(0, ''), f(1, 'Where did you put the keys'), f(2, 'Where did y0u put the keys'), f(3, 'LB re i CO', 50), f(4, 'Where did you put the keys'), f(5, ''), f(6, ''), f(7, 'They are on the table'), f(8, 'They are on the table'), f(9, '~ |', 30)];
  const out = groupFrames(frames, { step: 1, width: 960 });
  assert.equal(out.length, 2);
  assert.equal(out[0].text, 'Where did you put the keys'); assert.equal(out[0].start, 1); assert.equal(out[0].end, 5);
  assert.equal(out[1].text, 'They are on the table'); assert.equal(out[1].end, 9);
  assert.ok(similarity('Where did you put the keys', 'Where did y0u put the keys') > 0.9);
  assert.equal(similarity('abc', ''), 0);
  assert.equal(frameText([{ text: '12', confidence: 90, bbox: { x: 0, y: 0, w: 10, h: 10 } }]), null, 'a bare number is not a subtitle');
});

test('burned-in subtitles: a band frame binarised and read, bright patches dropped', async () => {
  const { png, img } = drawBand({ text: 'Where did you put the keys' });
  const bin = binarize({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
  let patch = 0; for (let y = 12; y < 60; y++) for (let x = 24; x < 130; x++) if (bin.data[(y * img.width + x) * 4] === 0) patch++;
  assert.equal(patch, 0, 'the bright patch of the picture is not kept as lettering');
  const ocr = new OcrEngine({ dataDir: path.join(tmp, 'tessdata') });
  try {
    const res = await ocr.read(raster.toBmp(bin), { lang: 'eng', psm: '6' });
    const ft = frameText(res.lines, { width: img.width });
    assert.ok(ft && ft.text.toLowerCase().replace(/[^a-z ]/g, '').includes('where did you put the keys'), `read: ${ft && ft.text}`);
    assert.ok(ft.box.y > 40 && ft.box.h < 80);
  } finally { await ocr.stop(); }
  assert.equal(png[0], 0x89);
});

test('ffmpeg: a generated clip is probed, its sound and band frames extracted', async () => {
  const file = path.join(tmp, 'clip.mp4');
  const r = await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  assert.equal(r.code, 0, r.stderr.slice(-400));
  const info = await ff.probe(file);
  assert.ok(Math.abs(info.duration - 6) < 0.5); assert.equal(info.width, 320); assert.equal(info.subtitles.length, 0);
  const wav = await ff.audioWindow(file, 0, 3);
  assert.ok(wav.length > 44 + 16000 * 2 * 2.5 && wav.toString('latin1', 0, 4) === 'RIFF');
  assert.equal((await ff.audioWindow(file, 30, 3)).length, 0, 'past the end there is nothing');
  const frames = await ff.bandFrames(file, 0, 3, { fps: 1, band: 0.3, width: 320 });
  assert.equal(frames.length, 3);
  assert.equal(frames[0].png.readUInt32BE(16), 320);
  assert.equal(ff.sidecars(file).length, 0);
  fs.writeFileSync(path.join(tmp, 'clip.en.srt'), '1\n00:00:00,000 --> 00:00:02,000\nHi\n');
  assert.equal(ff.sidecars(file)[0].language, 'en');
  assert.equal(ff.splitPngs(Buffer.concat([frames[0].png, frames[1].png])).length, 2);
});

test('video session: a minute ahead from speech, then from a subtitle file', async () => {
  const file = path.join(tmp, 'clip.mp4');
  const deps = { llm: new LLM(cfgFor()), translator: new Translator(new LLM(cfgFor())), ocr: new OcrEngine({ dataDir: path.join(tmp, 'tessdata') }), config: cfgFor({ video: { ...DEFAULTS.video, chunkSec: 3, aheadSec: 6, source: 'speech' } }) };
  const session = new VideoSession(file, deps);
  const info = await session.open();
  assert.equal(info.sidecars.length, 1);
  const events = []; session.on('cues', (c) => events.push(c));
  const mode = await session.start('speech');
  assert.equal(mode, 'speech');
  await new Promise(r => setTimeout(r, 2500));
  assert.ok(events.length >= 1);
  const all = events.at(-1).cues;
  assert.ok(all.length >= 2, `got ${all.length} cues`);
  assert.equal(all[0].translated, '[Where did you put the keys?]');
  assert.ok(all.some(c => c.start >= 3), 'the second chunk was translated ahead');
  assert.match(session.exportSrt(), /\[They are on the table\.\]/);
  session.close();
  const tracked = new VideoSession(file, deps);
  await tracked.open();
  assert.equal(await tracked.start('auto'), 'track');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(tracked.cues[0].translated, '[Hi]');
  tracked.close();
  await deps.ocr.stop();
});

test('live session: an utterance and a burned-in frame come back translated', async () => {
  const deps = { llm: new LLM(cfgFor()), translator: new Translator(new LLM(cfgFor())), ocr: new OcrEngine({ dataDir: path.join(tmp, 'tessdata') }), config: cfgFor({ languages: { source: 'en', target: 'zh-Hans' } }) };
  const live = new LiveSession(deps);
  const got = []; live.on('cue', (c) => got.push(c));
  live.audio(Buffer.alloc(44 + 16000 * 2), 1);
  const { png } = drawBand({ text: 'They are on the table' });
  live.frame(png, { width: 960, height: 540, band: 0.3, isScreen: true });
  live.frame(png, { width: 960, height: 540, band: 0.3, isScreen: true });
  await live.queue;
  assert.equal(got[0].kind, 'speech'); assert.match(got[0].translated, /^\[Where did/);
  const burned = got.find(c => c.kind === 'burned');
  assert.ok(burned && burned.box.y > 0.7 && burned.box.y < 1, 'the box is a fraction of the whole picture');
  assert.equal(got.filter(c => c.kind === 'burned').length, 1, 'the same line twice is one cue');
  live.stop(); await deps.ocr.stop();
});

// ---- web pages --------------------------------------------------------------------------------
test('page script: runs of text collected with inline markers, applied, flipped back, new text noticed', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<html lang="de"><head><title>Hallo</title></head><body><p>Klick <a href="/x">hier</a>, um fortzufahren.<br>Zweite Zeile.</p><pre>code</pre><button title="Speichern">OK</button><img alt="Ein Hund"><p translate="no">Bleib</p></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(pageScript);
  const items = w.__gloss.collect();
  const byId = Object.fromEntries(items.map(i => [i.id, i.text]));
  assert.equal(items[0].text, 'Klick <i1>hier</i1>, um fortzufahren.\nZweite Zeile.');
  assert.ok(Object.values(byId).includes('Speichern') && Object.values(byId).includes('Ein Hund') && Object.values(byId).includes('Hallo'));
  assert.ok(!Object.values(byId).includes('code') && !Object.values(byId).includes('Bleib'));
  assert.equal(w.__gloss.lang(), 'de');
  const map = {}; for (const it of items) map[it.id] = it.text.replace('Klick', 'Click').replace('hier', 'here').replace('um fortzufahren', 'to continue').replace('Zweite Zeile', 'Second line').replace('Speichern', 'Save').replace('Ein Hund', 'A dog').replace('Hallo', 'Hello');
  w.__gloss.apply(map);
  const p = w.document.querySelector('p');
  assert.equal(p.textContent, 'Click here, to continue.Second line.');
  assert.equal(p.querySelector('a').getAttribute('href'), '/x', 'the link survives');
  assert.equal(w.document.querySelector('img').getAttribute('alt'), 'A dog');
  assert.equal(w.document.title, 'Hello');
  assert.equal(w.document.querySelector('.gloss-t').title, 'Klick hier, um fortzufahren.Zweite Zeile.');
  w.__gloss.show('original');
  assert.equal(p.textContent, 'Klick hier, um fortzufahren.Zweite Zeile.');
  assert.equal(w.document.title, 'Hallo');
  w.__gloss.show('translated');
  const late = w.document.createElement('p'); late.textContent = 'Später'; w.document.body.appendChild(late);
  await new Promise(r => setTimeout(r, 20));
  const pending = w.__gloss.pending();
  assert.equal(pending.length, 1); assert.equal(pending[0].text, 'Später');
  assert.equal(w.__gloss.collect().length, 0, 'nothing is collected twice');
});

// ---- documents ---------------------------------------------------------------------------------
test('office: a docx keeps its runs; each run gets its part of the translation', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and plain &amp; more</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p><w:p><w:r><w:t>42</w:t></w:r></w:p><w:p><w:r><w:t/></w:r></w:p></w:body></w:document>');
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const seen = [];
  const up = (t) => t.replace(/<\/?i\d+>|[^<]+/g, (m) => (m.startsWith('<') ? m : m.toUpperCase()));
  const out = await translateOffice(buf, 'docx', async (items) => { seen.push(...items.map(i => i.text)); return new Map(items.map(i => [i.id, up(i.text)])); });
  assert.deepEqual(seen, ['<i1>Bold</i1><i2> and plain & more</i2>', 'Second', 'Header']);
  const back = await JSZip.loadAsync(out);
  const xml = await back.file('word/document.xml').async('string');
  assert.match(xml, /<w:b\/><\/w:rPr><w:t xml:space="preserve">BOLD<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve"> AND PLAIN &amp; MORE<\/w:t>/);
  assert.match(xml, /<w:t xml:space="preserve">SECOND<\/w:t>/);
  assert.match(xml, /<w:t>42<\/w:t>/, 'a number alone is left as it was');
  assert.match(await back.file('word/header1.xml').async('string'), /HEADER/);
  assert.equal(paragraphsOf('<a:p><a:r><a:t>Slide title</a:t></a:r></a:p>', 'pptx')[0].text, 'Slide title');
  assert.match(applyToXml('<a:p><a:r><a:t>Slide title</a:t></a:r></a:p>', 'pptx', new Map([[0, 'Titre']])), /<a:t>Titre<\/a:t>/);
});

test('text documents: markdown keeps its structure, prose joins wrapped lines, subtitles keep timing', async () => {
  const md = '# Title\n\n- item one\n- item two\n\n```\ncode stays\n```\n\nA paragraph.\n';
  const out = await translateText('a.md', md, async (items) => new Map(items.map(i => [i.id, i.text.toUpperCase()])));
  assert.equal(out, '# TITLE\n\n- ITEM ONE\n- ITEM TWO\n\n```\ncode stays\n```\n\nA PARAGRAPH.\n');
  const txt = await translateText('a.txt', 'The first line of a paragraph that somebody has wrapped\nby hand at about sixty characters, as plain text files often are.\n\nShort\nverse\nlines', async (items) => new Map(items.map(i => [i.id, '[' + i.text + ']'])));
  assert.equal(txt, '[The first line of a paragraph that somebody has wrapped by hand at about sixty characters, as plain text files often are.]\n\n[Short]\n[verse]\n[lines]');
  const srt = await translateText('a.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n', async (items, opts) => { assert.equal(opts.kind, 'subtitle'); return new Map([['0', 'Bonjour']]); });
  assert.match(srt, /00:00:01,000 --> 00:00:02,000\nBonjour/);
  assert.equal(planMarkdown('![img](x.png)\n\n---').items.length, 0);
  assert.equal(planText('').items.length, 0);
});

test('pdf: pages bound back at their original sizes', async () => {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: 20, height: 30 }); png.data.fill(200);
  const buf = await pdfFromPages([{ png: PNG.sync.write(png), width: 595, height: 842 }]);
  assert.equal(buf.toString('latin1', 0, 5), '%PDF-');
  assert.match(buf.toString('latin1'), /MediaBox \[\s*0 0 595 842\s*\]/);
});
