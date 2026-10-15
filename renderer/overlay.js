'use strict';
// The see-through layer over another app: a box over a burned-in subtitle with its
// translation, and the translated speech at the bottom for a few seconds.
(() => {
  const $ = (s) => document.querySelector(s);
  let video = { cover: 'auto', position: 'bottom', fontSize: 28 };
  let speechTimer = 0;
  const cls = () => (video.cover === 'white' ? 'white' : '');

  window.gloss.on('overlay', (c) => {
    if (c.kind === 'settings') { video = c.video; return; }
    if (c.kind === 'speech') {
      const el = $('#speech');
      el.className = `sub speech ${cls()} ${video.position === 'top' ? 'top' : ''}`;
      el.style.fontSize = (video.fontSize * 1.1) + 'px';
      el.textContent = c.translated;
      el.hidden = false;
      clearTimeout(speechTimer); speechTimer = setTimeout(() => { el.hidden = true; }, c.ttl * 1000);
      return;
    }
    if (c.kind === 'burned') {
      const el = $('#burned');
      if (c.clear) { el.hidden = true; return; }
      const W = window.innerWidth, H = window.innerHeight, b = c.box, pad = 0.012;
      el.className = `sub ${cls()}`;
      // Boxes are fractions of the captured picture; for a whole screen that is this window.
      if (c.isScreen !== false) {
        Object.assign(el.style, { left: (b.x - pad) * W + 'px', top: (b.y - pad) * H + 'px', width: (b.w + 2 * pad) * W + 'px', height: (b.h + 2 * pad) * H + 'px', transform: '', bottom: '' });
        const lines = c.translated.split('\n').length;
        el.style.fontSize = Math.max(12, ((b.h + 2 * pad) * H / lines) * 0.72) + 'px';
      } else {
        // A single window's place on the screen is not known: the line sits at the bottom instead.
        Object.assign(el.style, { left: '50%', top: '', bottom: '12%', width: '', height: '', transform: 'translateX(-50%)', fontSize: video.fontSize + 'px' });
      }
      el.textContent = c.translated;
      el.hidden = false;
    }
  });
})();
