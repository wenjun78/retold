'use strict';
// Video: the player, the subtitles laid over it (a box over burned-in lines, a line at the
// bottom for speech), the minute-ahead status, and the panel for translating over another app.
window.Video = (() => {
  const $ = (s) => document.querySelector(s);
  const cuesLib = window.Gloss.cues;
  let settings = null, info = null, cues = [], burned = [], mode = '', lastSent = -1, raf = 0;
  let liveSource = null, liveRunning = false;

  const cfg = () => settings.config;
  const status = (t) => { $('#vid-status').textContent = t || ''; };

  async function open(file) {
    const player = $('#player');
    try {
      await window.gloss.call('video:close');
      cues = []; burned = []; mode = ''; lastSent = -1;
      info = await window.gloss.call('video:open', file);
      player.src = info.url; player.hidden = false; $('#vid-drop').hidden = true;
      $('#vid-srt').disabled = false;
      const source = $('#vid-source').value;
      status('Starting…');
      mode = await window.gloss.call('video:start', source);
      const where = mode === 'track' ? (info.sidecars.length ? 'the subtitle file next to the video' : 'the subtitle track') : mode === 'picture' ? 'the speech, and any subtitles burned into the picture' : 'the speech';
      status(`${info.name} · translating ${where}, a minute ahead. Press play.`);
      $('#vid-ready').hidden = false;
      cancelAnimationFrame(raf); tick();
    } catch (e) { window.App.notice(e.message, 'error'); status(''); }
  }

  // Where the picture sits inside the player (it keeps its proportions).
  function videoRect() {
    const p = $('#player');
    const W = p.clientWidth, H = p.clientHeight, vw = p.videoWidth || 16, vh = p.videoHeight || 9;
    const s = Math.min(W / vw, H / vh);
    const w = vw * s, h = vh * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function coverClass() {
    const c = cfg().video.cover;
    return c === 'white' ? 'white' : 'black';
  }

  function tick() {
    const p = $('#player');
    if (!p.hidden) {
      const t = p.currentTime;
      if (Math.abs(t - lastSent) >= 0.5) { lastSent = t; window.gloss.call('video:playhead', t); }
      render(t);
    }
    raf = requestAnimationFrame(tick);
  }

  function render(t) {
    const host = $('#sub-overlay');
    const r = videoRect();
    const size = Number($('#vid-size').value) || 28;
    const parts = [];
    const bi = cuesLib.cueAt(burned, t);
    if (bi >= 0) {
      const b = burned[bi], box = b.box;
      // The box covers the original line with a little room, and the translation fills it.
      const pad = 0.012;
      const x = r.x + (box.x - pad) * r.w, y = r.y + (box.y - pad) * r.h, w = (box.w + 2 * pad) * r.w, h = (box.h + 2 * pad) * r.h;
      const lines = (b.translated || b.text).split('\n').length;
      const fs = Math.min(size * 1.6, Math.max(12, (h / lines) * 0.72));
      parts.push(`<div class="sub cover ${coverClass()}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${fs}px">${esc(b.translated || b.text)}</div>`);
    }
    const ci = cuesLib.cueAt(cues, t);
    if (ci >= 0) {
      const c = cues[ci];
      parts.push(`<div class="sub speech ${coverClass()} ${cfg().video.position === 'top' ? 'top' : ''}" style="font-size:${size * (r.w / 960)}px">${esc(c.translated || c.text)}</div>`);
    }
    const html = parts.join('');
    if (host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  function onVideoEvent(m) {
    if (m.kind === 'cues') { cues = m.cues; burned = m.burned; }
    else if (m.kind === 'status') {
      const ahead = Math.round(m.ready);
      $('#vid-ready').textContent = m.inflight.length ? `ready ${ahead}s ahead · working…` : `ready ${ahead}s ahead`;
      $('#vid-ready').title = m.failed.length ? m.failed[0] : '';
      if (m.failed.length) $('#vid-ready').textContent += ' · a piece failed (click to retry)';
    } else if (m.kind === 'error') window.App.notice(`Could not translate ${Math.round(m.start)}–${Math.round(m.end)} s: ${m.message}`, 'error');
  }

  async function saveSrt() {
    try {
      const file = await window.gloss.call('dialog:save', { name: (info ? info.name.replace(/\.[^.]+$/, '') : 'subtitles') + `.${cfg().languages.target}.srt`, filters: [{ name: 'SubRip', extensions: ['srt'] }] });
      if (!file) return;
      await window.gloss.call('video:exportSrt', file, {});
      status(`Saved ${file} (what has been translated so far).`);
    } catch (e) { window.App.notice(e.message, 'error'); }
  }

  // ---- translating over another app ---------------------------------------------------
  async function showLive() {
    $('#live-panel').hidden = false;
    const host = $('#live-sources'); host.innerHTML = '<span class="hint">Looking…</span>';
    const sources = await window.gloss.call('capture:sources');
    host.innerHTML = '';
    for (const s of sources) {
      const d = document.createElement('div'); d.className = 'src';
      d.innerHTML = `<img alt=""><div class="label"></div>`;
      d.querySelector('img').src = s.thumbnail; d.querySelector('.label').textContent = s.name; d.title = s.name;
      d.addEventListener('click', () => { liveSource = s; for (const x of host.children) x.classList.toggle('on', x === d); $('#live-start').disabled = false; });
      host.appendChild(d);
    }
  }
  function log(text, kind = '') {
    const l = $('#live-log'); const d = document.createElement('div');
    d.innerHTML = kind === 'cue' ? text : esc(text);
    l.prepend(d); while (l.children.length > 40) l.lastChild.remove();
  }
  async function startLive() {
    if (!liveSource) return;
    try {
      await window.gloss.call('live:start', { sourceId: liveSource.id, displayId: liveSource.displayId });
      const isScreen = liveSource.id.startsWith('screen:');
      await window.Capture.start({
        band: cfg().video.band,
        video: $('#live-video'),
        onAudio: (wav, duration) => window.gloss.call('live:audio', wav, duration),
        onFrame: (png, meta) => window.gloss.call('live:frame', png, { ...meta, isScreen }),
      });
      liveRunning = true;
      $('#live-start').hidden = true; $('#live-stop').hidden = false;
      log(`Listening to "${liveSource.name}". The translation shows over it; speech appears after each pause.`);
    } catch (e) { window.App.notice(e.message, 'error'); await window.gloss.call('live:stop'); }
  }
  async function stopLive() {
    window.Capture.stop();
    await window.gloss.call('live:stop');
    liveRunning = false;
    $('#live-start').hidden = false; $('#live-stop').hidden = true;
    log('Stopped.');
  }

  function init(s) {
    settings = s;
    $('#vid-open').addEventListener('click', async () => { const f = await window.gloss.call('dialog:open', { kind: 'video' }); if (f[0]) open(f[0]); });
    $('#vid-srt').addEventListener('click', saveSrt);
    $('#vid-ready').addEventListener('click', () => window.gloss.call('video:retry'));
    $('#vid-cover').addEventListener('change', (e) => window.gloss.call('config:update', { video: { cover: e.target.value } }).then(onSettings));
    $('#vid-size').addEventListener('change', (e) => window.gloss.call('config:update', { video: { fontSize: Number(e.target.value) } }).then(onSettings));
    $('#vid-source').addEventListener('change', (e) => window.gloss.call('config:update', { video: { source: e.target.value } }).then(onSettings));
    $('#player').addEventListener('seeking', () => { lastSent = -1; });
    $('#live-open').addEventListener('click', showLive);
    $('#live-close').addEventListener('click', () => { if (liveRunning) stopLive(); $('#live-panel').hidden = true; });
    $('#live-start').addEventListener('click', startLive);
    $('#live-stop').addEventListener('click', stopLive);
    window.gloss.on('video', onVideoEvent);
    window.gloss.on('overlay', (c) => { if (c.kind === 'speech' || c.kind === 'burned') { if (c.clear) return; log(`<b>${esc(c.translated)}</b><br>${esc(c.text)}`, 'cue'); } });
    window.App.dropZone($('#player-wrap'), (files) => open(files[0]));
    $('#vid-cover').value = cfg().video.cover; $('#vid-size').value = cfg().video.fontSize; $('#vid-source').value = cfg().video.source;
  }
  function onSettings(s) { settings = s; }

  return { init, onSettings, open };
})();
