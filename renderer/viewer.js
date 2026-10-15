'use strict';
// Pictures: a list of pages, the current one shown as two layers (the original, and the
// translation set over a copy with the lettering lifted out), boxes to adjust, and the
// text of every bubble to correct.
window.Viewer = (() => {
  const $ = (s) => document.querySelector(s);
  const pages = [];
  let current = -1, settings = null, editing = false, selected = null, scale = 1;
  let nextId = 1;
  const state = { opacity: 1, show: 'translated', direction: 'auto', caps: false };

  const cfg = () => settings ? settings.config : null;
  const status = (t) => { $('#img-status').textContent = t || ''; };
  const page = () => pages[current] || null;

  // ---- loading ----------------------------------------------------------------
  async function openFiles(paths) {
    for (const file of paths) {
      try { await addFile(file); } catch (e) { window.App.notice(`${file.split(/[\\/]/).pop()}: ${e.message}`, 'error'); }
    }
    if (current < 0 && pages.length) select(0);
  }

  async function addFile(file) {
    const url = await window.gloss.call('file:url', file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('This picture could not be opened.')); img.src = url; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    await addPage({ name: file.split(/[\\/]/).pop(), path: file, canvas: c });
  }

  // canvas: the page's pixels; lines: text with positions when the page comes from a PDF.
  async function addPage({ name, path = '', canvas, lines = null, pt = null }) {
    const id = 'p' + nextId++;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    await window.gloss.call('page:open', { id, width: canvas.width, height: canvas.height, data: data.data.buffer.slice(0), lines });
    const thumb = document.createElement('canvas'); thumb.width = 150; thumb.height = Math.round(150 * canvas.height / canvas.width);
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    const p = { id, name, path, canvas, width: canvas.width, height: canvas.height, erased: null, regions: [], state: 'new', thumb: thumb.toDataURL('image/jpeg', 0.7), pt, fromPdf: Boolean(lines) };
    pages.push(p);
    renderList();
    $('#img-translate-all').disabled = false;
    if (current < 0) select(pages.length - 1);
    return p;
  }

  function renderList() {
    const ol = $('#page-list');
    ol.innerHTML = '';
    pages.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = (i === current ? 'on ' : '') + (p.state === 'translated' ? 'done' : '');
      li.innerHTML = `<img alt=""><span class="tag"></span>`;
      li.querySelector('img').src = p.thumb;
      li.querySelector('.tag').textContent = p.state === 'translated' ? '✓ ' + p.name : p.state === 'busy' ? '… ' + p.name : p.name;
      li.title = p.name;
      li.addEventListener('click', () => select(i));
      ol.appendChild(li);
    });
  }

  function select(i) {
    current = i;
    selected = null;
    renderList();
    $('#img-drop').hidden = true; $('#layers').hidden = false;
    $('#img-translate').disabled = false;
    draw();
    renderRegions();
  }

  // ---- drawing ------------------------------------------------------------------
  function fitScale(p) {
    const wrap = $('#canvas-wrap');
    const availW = wrap.clientWidth - 24, availH = wrap.clientHeight - 24;
    return Math.min(1, availW / p.width, availH / p.height) || 1;
  }

  function draw() {
    const p = page(); if (!p) return;
    const co = $('#c-original'), ct = $('#c-translated');
    co.width = ct.width = p.width; co.height = ct.height = p.height;
    co.getContext('2d').drawImage(p.canvas, 0, 0);
    const ctx = ct.getContext('2d');
    if (p.erased) ctx.putImageData(p.erased, 0, 0); else ctx.drawImage(p.canvas, 0, 0);
    for (const r of p.regions) {
      if (!r.target) continue;
      const plan = window.Lettering.plan(ctx, r, r.target, { target: cfg().languages.target, direction: state.direction, mimic: cfg().image.mimic, caps: state.caps, settings: cfg().image });
      window.Lettering.draw(ctx, r, plan);
    }
    scale = fitScale(p);
    const layers = $('#layers');
    layers.style.width = Math.round(p.width * scale) + 'px'; layers.style.height = Math.round(p.height * scale) + 'px';
    co.style.width = ct.style.width = layers.style.width; co.style.height = ct.style.height = layers.style.height;
    applyOpacity();
    drawBoxes();
  }

  function applyOpacity() {
    const v = state.show === 'original' ? 0 : state.opacity;
    $('#c-translated').style.opacity = String(v);
  }

  // ---- boxes --------------------------------------------------------------------------
  function drawBoxes() {
    const p = page(); const host = $('#boxes');
    host.innerHTML = '';
    host.classList.toggle('editing', editing);
    if (!p || !editing) return;
    for (const r of p.regions) {
      const d = document.createElement('div');
      d.className = 'box' + (r.id === selected ? ' sel' : '') + (r.source ? '' : ' empty');
      d.style.left = r.x * scale + 'px'; d.style.top = r.y * scale + 'px'; d.style.width = r.w * scale + 'px'; d.style.height = r.h * scale + 'px';
      d.innerHTML = '<span class="handle"></span><span class="del" title="Remove">✕</span>';
      d.addEventListener('pointerdown', (e) => startDrag(e, r, e.target.classList.contains('handle') ? 'resize' : 'move'));
      d.querySelector('.del').addEventListener('pointerdown', (e) => { e.stopPropagation(); removeRegion(r.id); });
      host.appendChild(d);
    }
  }

  let drag = null;
  function startDrag(e, r, kind) {
    e.preventDefault(); e.stopPropagation();
    selected = r.id; renderRegions(); drawBoxes();
    drag = { r, kind, x0: e.clientX, y0: e.clientY, box: { x: r.x, y: r.y, w: r.w, h: r.h } };
    window.addEventListener('pointermove', onDrag); window.addEventListener('pointerup', endDrag, { once: true });
  }
  function onDrag(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.x0) / scale, dy = (e.clientY - drag.y0) / scale;
    const b = drag.box, r = drag.r;
    if (drag.kind === 'move') { r.x = Math.round(b.x + dx); r.y = Math.round(b.y + dy); }
    else { r.w = Math.max(12, Math.round(b.w + dx)); r.h = Math.max(12, Math.round(b.h + dy)); }
    drawBoxes();
  }
  async function endDrag() {
    window.removeEventListener('pointermove', onDrag);
    if (!drag) return;
    const { r } = drag; drag = null;
    const p = page();
    await window.gloss.call('page:update', p.id, r.id, { x: r.x, y: r.y, w: r.w, h: r.h });
    await refresh(p, { reread: !r.source });
  }
  // Drawing a new box on empty space.
  $('#boxes').addEventListener('pointerdown', (e) => {
    if (!editing || e.target !== e.currentTarget) return;
    const p = page(); if (!p) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x0 = (e.clientX - rect.left) / scale, y0 = (e.clientY - rect.top) / scale;
    const ghost = document.createElement('div'); ghost.className = 'box'; e.currentTarget.appendChild(ghost);
    const move = (ev) => { const x1 = (ev.clientX - rect.left) / scale, y1 = (ev.clientY - rect.top) / scale; Object.assign(ghost.style, { left: Math.min(x0, x1) * scale + 'px', top: Math.min(y0, y1) * scale + 'px', width: Math.abs(x1 - x0) * scale + 'px', height: Math.abs(y1 - y0) * scale + 'px' }); };
    const up = async (ev) => {
      window.removeEventListener('pointermove', move);
      const x1 = (ev.clientX - rect.left) / scale, y1 = (ev.clientY - rect.top) / scale;
      ghost.remove();
      const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      if (box.w < 12 || box.h < 12) return;
      const r = await window.gloss.call('page:add', p.id, box);
      p.regions.push(r); selected = r.id;
      await refresh(p, { reread: true, only: [r.id] });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  });

  async function removeRegion(id) {
    const p = page();
    p.regions = await window.gloss.call('page:remove', p.id, id);
    if (selected === id) selected = null;
    await refresh(p, {});
  }

  // Reads (when asked), translates what has no translation yet, lifts the lettering and redraws.
  async function refresh(p, { reread = false, only = null } = {}) {
    try {
      if (reread) for (const id of (only || p.regions.map(r => r.id))) { const r = await window.gloss.call('page:read', p.id, id); if (r) p.regions = p.regions.map(x => x.id === r.id ? { ...x, ...r } : x); }
      const todo = p.regions.filter(r => r.source && !r.target).map(r => r.id);
      if (todo.length) p.regions = await window.gloss.call('page:translate', p.id, todo);
      const { regions, image } = await window.gloss.call('page:erase', p.id);
      p.regions = regions; p.erased = new ImageData(new Uint8ClampedArray(image), p.width, p.height);
      if (p.regions.some(r => r.target)) p.state = 'translated';
    } catch (e) { window.App.notice(e.message, 'error'); }
    if (page() === p) { draw(); renderRegions(); renderList(); }
  }

  // ---- the panel of texts -------------------------------------------------------------
  function renderRegions() {
    const p = page(); const ol = $('#region-list');
    ol.innerHTML = '';
    if (!p) return;
    p.regions.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = r.id === selected ? 'sel' : '';
      li.innerHTML = `<div class="n"><span>${i + 1} · ${r.kind === 'bubble' ? 'bubble' : 'text'}${r.orientation === 'vertical' ? ' · vertical' : ''}</span><span><button data-act="read" title="Read this box again">Read</button> <button data-act="retranslate" title="Translate the original again">Translate</button></span></div>
        <textarea class="src" rows="2" placeholder="Original (edit if misread)"></textarea><textarea class="dst" rows="2" placeholder="Translation"></textarea>`;
      li.querySelector('.src').value = r.source || ''; li.querySelector('.dst').value = r.target || '';
      li.addEventListener('focusin', () => { if (selected !== r.id) { selected = r.id; drawBoxes(); for (const x of ol.children) x.classList.toggle('sel', x === li); } });
      li.querySelector('.src').addEventListener('change', async (e) => { await window.gloss.call('page:update', p.id, r.id, { source: e.target.value, target: '' }); r.source = e.target.value; r.target = ''; await refresh(p, {}); });
      li.querySelector('.dst').addEventListener('input', (e) => { r.target = e.target.value; draw(); });
      li.querySelector('.dst').addEventListener('change', (e) => { window.gloss.call('page:update', p.id, r.id, { target: e.target.value }); });
      li.querySelector('[data-act=read]').addEventListener('click', async () => { r.target = ''; await window.gloss.call('page:update', p.id, r.id, { target: '' }); await refresh(p, { reread: true, only: [r.id] }); });
      li.querySelector('[data-act=retranslate]').addEventListener('click', async () => { await window.gloss.call('page:update', p.id, r.id, { target: '' }); r.target = ''; await refresh(p, {}); });
      ol.appendChild(li);
    });
  }

  // ---- translating a page --------------------------------------------------------------
  async function translatePage(p) {
    if (!p || p.state === 'busy') return;
    p.state = 'busy'; renderList();
    const mine = () => page() === p;
    try {
      if (mine()) status(p.fromPdf ? 'Reading the page…' : 'Finding speech bubbles…');
      p.regions = await window.gloss.call('page:detect', p.id);
      if (mine()) { renderRegions(); status(`Reading ${p.regions.length} ${p.fromPdf ? 'blocks' : 'bubbles'}…`); }
      if (!p.fromPdf) p.regions = await window.gloss.call('page:readAll', p.id);
      if (!p.regions.length) { p.state = 'new'; if (mine()) status('No text was found. Turn on "Edit boxes" and draw a box around the text.'); renderList(); return; }
      if (mine()) { renderRegions(); status('Translating…'); }
      p.regions = await window.gloss.call('page:translate', p.id);
      if (mine()) status('Lifting the original lettering out…');
      const { regions, image } = await window.gloss.call('page:erase', p.id);
      p.regions = regions; p.erased = new ImageData(new Uint8ClampedArray(image), p.width, p.height);
      p.state = 'translated';
      if (mine()) status(`${p.regions.filter(r => r.target).length} translated. Slide the overlay to compare; fix any text on the right.`);
    } catch (e) { p.state = 'new'; window.App.notice(e.message, 'error'); if (mine()) status(''); }
    if (mine()) { draw(); renderRegions(); }
    renderList();
  }

  async function translateAll() {
    for (const p of pages) if (p.state !== 'translated') await translatePage(p);
  }

  // ---- saving ---------------------------------------------------------------------------------
  function translatedCanvas(p) {
    const c = document.createElement('canvas'); c.width = p.width; c.height = p.height;
    const ctx = c.getContext('2d');
    if (p.erased) ctx.putImageData(p.erased, 0, 0); else ctx.drawImage(p.canvas, 0, 0);
    for (const r of p.regions) if (r.target) window.Lettering.draw(ctx, r, window.Lettering.plan(ctx, r, r.target, { target: cfg().languages.target, direction: state.direction, mimic: cfg().image.mimic, caps: state.caps, settings: cfg().image }));
    if (state.opacity < 1) { // what is on screen: the translation blended over the original
      const blend = document.createElement('canvas'); blend.width = p.width; blend.height = p.height;
      const b = blend.getContext('2d'); b.drawImage(p.canvas, 0, 0); b.globalAlpha = state.opacity; b.drawImage(c, 0, 0);
      return blend;
    }
    return c;
  }
  const pngOf = (canvas) => new Promise((res) => canvas.toBlob((b) => b.arrayBuffer().then(res), 'image/png'));

  async function save(kind) {
    const p = page(); if (!p) return;
    const stem = p.name.replace(/\.[^.]+$/, '');
    try {
      if (kind === 'png') {
        const file = await window.gloss.call('dialog:save', { name: `${stem}.${cfg().languages.target}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (file) { await window.gloss.call('file:write', file, await pngOf(translatedCanvas(p))); status(`Saved ${file}`); }
      } else if (kind === 'side') {
        const c = document.createElement('canvas'); c.width = p.width * 2 + 12; c.height = p.height;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(p.canvas, 0, 0); ctx.drawImage(translatedCanvas(p), p.width + 12, 0);
        const file = await window.gloss.call('dialog:save', { name: `${stem}.side-by-side.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (file) { await window.gloss.call('file:write', file, await pngOf(c)); status(`Saved ${file}`); }
      } else if (kind === 'all') {
        const files = [];
        for (const q of pages) {
          if (!q.path) continue;
          const out = q.path.replace(/\.[^.]+$/, '') + `.${cfg().languages.target}.png`;
          await window.gloss.call('file:write', out, await pngOf(translatedCanvas(q))); files.push(out);
        }
        status(`Saved ${files.length} pages next to the originals.`);
      } else if (kind === 'pdf') {
        const file = await window.gloss.call('dialog:save', { name: `${stem.replace(/\.pdf$/i, '')}.${cfg().languages.target}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!file) return;
        const out = [];
        for (const q of pages) out.push({ png: await pngOf(translatedCanvas(q)), width: q.pt ? q.pt.width : q.width, height: q.pt ? q.pt.height : q.height });
        await window.gloss.call('pdf:export', out, file);
        status(`Saved ${file}`);
      }
    } catch (e) { window.App.notice(e.message, 'error'); }
  }

  // ---- wiring ----------------------------------------------------------------------------------
  function init(s) {
    settings = s;
    $('#img-open').addEventListener('click', async () => openFiles(await window.gloss.call('dialog:open', { kind: 'image', multiple: true })));
    $('#img-folder').addEventListener('click', async () => openFiles(await window.gloss.call('dialog:open', { folder: true })));
    $('#img-translate').addEventListener('click', () => translatePage(page()));
    $('#img-translate-all').addEventListener('click', translateAll);
    $('#img-reread').addEventListener('click', async () => { const p = page(); if (!p) return; p.regions = []; p.erased = null; p.state = 'new'; await window.gloss.call('page:reset', p.id); await translatePage(p); });
    $('#opacity').addEventListener('input', (e) => { state.opacity = Number(e.target.value) / 100; $('#opacity-val').textContent = e.target.value + '%'; applyOpacity(); });
    $('#show-original').addEventListener('click', () => { state.show = 'original'; $('#show-original').classList.add('on'); $('#show-translated').classList.remove('on'); applyOpacity(); });
    $('#show-translated').addEventListener('click', () => { state.show = 'translated'; $('#show-translated').classList.add('on'); $('#show-original').classList.remove('on'); applyOpacity(); });
    $('#edit-boxes').addEventListener('change', (e) => { editing = e.target.checked; drawBoxes(); });
    $('#direction').addEventListener('change', (e) => { state.direction = e.target.value; draw(); });
    $('#caps').addEventListener('change', (e) => { state.caps = e.target.checked; draw(); });
    $('#img-export').addEventListener('click', (e) => window.App.menu(e.currentTarget, [
      ['Save this page as PNG (as shown)…', () => save('png')], ['Save side by side (original | translated)…', () => save('side')],
      ['Save every page as PNG next to the originals', () => save('all')], ['Save all pages as one PDF…', () => save('pdf')],
    ]));
    window.addEventListener('resize', () => { if (page()) draw(); });
    window.App.dropZone($('#canvas-wrap'), (files) => openFiles(files.filter(f => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f))));
    window.gloss.on('progress', (m) => { if (m.what === 'read' && page() && m.page === page().id) status(`Reading ${m.done} of ${m.total}…`); });
  }

  function onSettings(s) { settings = s; if (page()) draw(); }

  return { init, onSettings, openFiles, addPage, translatePage, pages };
})();
