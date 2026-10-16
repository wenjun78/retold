'use strict';
// The shell: tabs, the language pair, settings, notices, and the helpers the modes share.
window.App = (() => {
  const $ = (s) => document.querySelector(s);
  let settings = null;

  function notice(text, kind = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind; t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4000);
  }

  // A small menu of actions under a button.
  function menu(anchor, items) {
    const old = document.querySelector('.menu'); if (old) old.remove();
    const m = document.createElement('div'); m.className = 'menu';
    Object.assign(m.style, { position: 'fixed', zIndex: 40, background: 'var(--shell-2)', border: '1px solid var(--rule)', borderRadius: '8px', padding: '4px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' });
    for (const [label, fn] of items) {
      const b = document.createElement('button'); b.textContent = label; Object.assign(b.style, { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none' });
      b.addEventListener('click', () => { m.remove(); fn(); });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px'; m.style.top = (r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!m.contains(e.target)) m.remove(); }, { once: true }), 0);
  }

  // Files dropped on `el` arrive as paths.
  function dropZone(el, onFiles) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('over');
      const files = [...e.dataTransfer.files].map(f => window.retold.pathFor(f)).filter(Boolean);
      if (files.length) onFiles(files);
    });
  }

  function setMode(mode) {
    for (const s of document.querySelectorAll('.mode')) s.hidden = s.id !== 'mode-' + mode;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.mode === mode);
    if (settings) window.retold.call('config:update', { ui: { mode } });
    if (mode === 'image') window.dispatchEvent(new Event('resize'));
  }

  function fillLanguages() {
    const opts = (withAuto) => settings.languages.filter(l => withAuto || l.code !== 'auto').map(l => `<option value="${l.code}">${l.name}</option>`).join('');
    $('#src-lang').innerHTML = opts(true); $('#dst-lang').innerHTML = opts(false);
    $('#src-lang').value = settings.config.languages.source; $('#dst-lang').value = settings.config.languages.target;
  }

  async function changeLanguages() {
    settings = await window.retold.call('config:update', { languages: { source: $('#src-lang').value, target: $('#dst-lang').value } });
    broadcast();
  }

  function broadcast() {
    document.documentElement.classList.toggle('light', settings.config.theme === 'light' || settings.config.ui.theme === 'light');
    window.Viewer.onSettings(settings); window.Video.onSettings(settings); window.Web.onSettings(settings); window.Docs.onSettings(settings);
  }

  // ---- settings dialog ----------------------------------------------------------
  const PRESETS = {
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', stt: 'whisper-1', vision: '' },
    groq: { base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3', vision: 'meta-llama/llama-4-scout-17b-16e-instruct' },
    ollama: { base: 'http://localhost:11434/v1', model: 'qwen3', stt: '', vision: 'llava' },
  };
  function openSettings() {
    const c = settings.config;
    $('#s-base').value = c.llm.baseUrl; $('#s-key').value = ''; $('#s-key').placeholder = settings.saved.llmKey ? '(saved — type to replace)' : '';
    $('#s-model').value = c.llm.model; $('#s-vision').value = c.vision.model; $('#s-stt').value = c.stt.model; $('#s-extra').value = JSON.stringify(c.llm.extra || {});
    $('#s-formality').value = c.style.formality; $('#s-glossary').value = c.style.glossary; $('#s-memory').textContent = settings.memory;
    $('#s-ocr').value = c.image.ocr; $('#s-bubbles').checked = c.image.bubbles; $('#s-mimic').checked = c.image.mimic; $('#s-font-latin').value = c.image.fontLatin; $('#s-font-cjk').value = c.image.fontCjk;
    $('#s-ahead').value = c.video.aheadSec; $('#s-chunk').value = c.video.chunkSec; $('#s-band').value = Math.round(c.video.band * 100); $('#s-position').value = c.video.position;
    $('#s-theme').value = c.ui.theme; $('#s-version').textContent = settings.version; $('#s-encrypted').textContent = settings.encrypted ? 'encrypted by the operating system' : 'as plain text in the app folder';
    $('#settings').showModal();
  }
  async function saveSettings() {
    let extra = {};
    try { extra = JSON.parse($('#s-extra').value || '{}'); } catch { notice('Extra parameters must be JSON, for example {"reasoning_effort":"low"}.', 'error'); return; }
    const patch = {
      llm: { baseUrl: $('#s-base').value.trim(), model: $('#s-model').value.trim(), extra },
      vision: { model: $('#s-vision').value.trim() }, stt: { model: $('#s-stt').value.trim() },
      style: { formality: $('#s-formality').value, glossary: $('#s-glossary').value },
      image: { ocr: $('#s-ocr').value, bubbles: $('#s-bubbles').checked, mimic: $('#s-mimic').checked, fontLatin: $('#s-font-latin').value.trim(), fontCjk: $('#s-font-cjk').value.trim() },
      video: { aheadSec: Number($('#s-ahead').value) || 60, chunkSec: Number($('#s-chunk').value) || 20, band: (Number($('#s-band').value) || 30) / 100, position: $('#s-position').value },
      ui: { theme: $('#s-theme').value },
    };
    if ($('#s-key').value.trim()) patch.llm.apiKey = $('#s-key').value.trim();
    settings = await window.retold.call('config:update', patch);
    broadcast();
  }

  async function init() {
    settings = await window.retold.call('config:get');
    fillLanguages();
    $('#src-lang').addEventListener('change', changeLanguages); $('#dst-lang').addEventListener('change', changeLanguages);
    $('#swap-langs').addEventListener('click', () => { const a = $('#src-lang').value, b = $('#dst-lang').value; if (a === 'auto') return; $('#src-lang').value = b; $('#dst-lang').value = a; changeLanguages(); });
    for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setMode(t.dataset.mode));
    $('#win-min').addEventListener('click', () => window.retold.call('window:minimize'));
    $('#win-max').addEventListener('click', () => window.retold.call('window:maximize'));
    $('#win-close').addEventListener('click', () => window.retold.call('window:close'));
    $('#open-settings').addEventListener('click', openSettings);
    $('#settings form').addEventListener('submit', (e) => { if (e.submitter && e.submitter.value === 'save') saveSettings(); });
    for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => { const p = PRESETS[b.dataset.preset]; $('#s-base').value = p.base; $('#s-model').value = p.model; $('#s-stt').value = p.stt; $('#s-vision').value = p.vision; });
    $('#s-memory-clear').addEventListener('click', async () => { settings = await window.retold.call('memory:clear'); $('#s-memory').textContent = settings.memory; });
    window.retold.on('notice', (m) => notice(m.text, m.kind));
    window.retold.on('window', (m) => { $('#win-max').textContent = m.maximized ? '❐' : '▢'; });
    window.Viewer.init(settings); window.Video.init(settings); window.Web.init(settings); window.Docs.init(settings);
    broadcast();
    setMode(settings.config.ui.mode || 'image');
    if (!settings.saved.llmKey && !/localhost|127\.0\.0\.1/.test(settings.config.llm.baseUrl)) { notice('Add your API key under Settings to start translating.'); }
    // Dropping anywhere on the window sends files to the right tab.
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...e.dataTransfer.files].map(f => window.retold.pathFor(f)).filter(Boolean);
      if (!files.length || e.target.closest('.canvas-wrap, .player-wrap, .drop')) return;
      if (files.some(f => /\.(mp4|mkv|webm|mov|m4v|avi|ts|mp3|m4a|wav|ogg|flac)$/i.test(f))) { setMode('video'); window.Video.open(files[0]); }
      else if (files.every(f => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f))) { setMode('image'); window.Viewer.openFiles(files); }
      else { setMode('doc'); window.Docs.open(files); }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  return { notice, menu, dropZone, setMode, settings: () => settings };
})();
