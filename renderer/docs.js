'use strict';
// Documents: Office and text files are translated whole and saved beside the original;
// PDFs are rendered page by page into the Pictures tab, where the translation is set over
// the original text and the pages bound back into a PDF.
window.Docs = (() => {
  const $ = (s) => document.querySelector(s);
  let settings = null, pdfjs = null;

  function log(text, { file = '', kind = '' } = {}) {
    const li = document.createElement('li'); li.className = kind;
    li.textContent = text;
    if (file) { const a = document.createElement('a'); a.href = '#'; a.textContent = ' Show in folder'; a.addEventListener('click', (e) => { e.preventDefault(); window.gloss.call('shell:show', file); }); li.appendChild(a); }
    $('#doc-log').prepend(li);
  }

  async function open(files) {
    for (const file of files) {
      const name = file.split(/[\\/]/).pop();
      try {
        if (/\.pdf$/i.test(name)) { await openPdf(file, name); continue; }
        if (!/\.(docx|pptx|xlsx|txt|md|markdown|srt|vtt)$/i.test(name)) { log(`${name}: not a document this app translates.`, { kind: 'err' }); continue; }
        const ext = name.match(/\.(\w+)$/)[1];
        const target = settings.config.languages.target;
        const out = await window.gloss.call('dialog:save', { name: file.replace(/\.(\w+)$/, `.${target}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
        if (!out) continue;
        const li = document.createElement('li'); li.textContent = `${name}: translating…`; $('#doc-log').prepend(li);
        const onProgress = (m) => { if (m.what === 'doc') li.textContent = `${name}: translating ${m.done} of ${m.total}…`; };
        window.gloss.on('progress', onProgress);
        try {
          const saved = await window.gloss.call('doc:translate', file, out);
          li.remove(); log(`${name} → ${saved.split(/[\\/]/).pop()}`, { file: saved });
        } finally { /* the listener stays registered but refers to a removed element */ }
      } catch (e) { log(`${name}: ${e.message}`, { kind: 'err' }); }
    }
  }

  async function openPdf(file, name) {
    if (!pdfjs) {
      pdfjs = await import('../node_modules/pdfjs-dist/build/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', location.href).href;
    }
    const { data } = await window.gloss.call('file:read', file);
    const doc = await pdfjs.getDocument({ data }).promise;
    const stem = name.replace(/\.pdf$/i, '');
    log(`${name}: ${doc.numPages} pages opened in Pictures. Translate them there and save as PDF.`);
    window.App.setMode('image');
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const scale = 2; // 144 dpi: crisp text, pages that are not too heavy
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      // Each text item's box, in canvas pixels.
      const content = await page.getTextContent();
      const lines = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const tx = pdfjs.Util.transform(viewport.transform, it.transform);
        const fontH = Math.hypot(tx[2], tx[3]) || Math.abs(it.height * scale);
        lines.push({ text: it.str, bbox: { x: tx[4], y: tx[5] - fontH, w: it.width * scale, h: fontH } });
      }
      const [x0, y0, x1, y1] = page.view;
      await window.Viewer.addPage({ name: `${stem} · page ${n}`, canvas, lines, pt: { width: x1 - x0, height: y1 - y0 } });
    }
  }

  function init(s) {
    settings = s;
    $('#doc-open').addEventListener('click', async () => open(await window.gloss.call('dialog:open', { kind: 'doc', multiple: true })));
    window.App.dropZone($('#doc-drop'), open);
  }
  function onSettings(s) { settings = s; }

  return { init, onSettings, open };
})();
