'use strict';
// Web: a browser tab whose pages are translated in place, block by block, keeping links and
// formatting, with the original a click away.
window.Web = (() => {
  const $ = (s) => document.querySelector(s);
  let settings = null, script = '', translating = false, pollTimer = 0, translatedOnce = false;
  const status = (t) => { $('#web-status').textContent = t || ''; };
  const wv = () => $('#webview');

  function normalizeUrl(s) {
    s = s.trim();
    if (!s) return '';
    if (/^[a-z]+:\/\//i.test(s)) return s;
    if (/\s/.test(s) || !/\./.test(s)) return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
    return 'https://' + s;
  }

  async function translatePage({ incremental = false } = {}) {
    if (translating) return;
    const w = wv();
    if (!/^https?:/.test(w.getURL())) return;
    translating = true;
    try {
      if (!script) script = await window.retold.call('web:script');
      await w.executeJavaScript(script);
      const items = await w.executeJavaScript(incremental ? 'window.__retold.pending()' : 'window.__retold.collect()');
      if (!items.length) { if (!incremental) status('Nothing to translate on this page.'); return; }
      const lang = await w.executeJavaScript('window.__retold.lang()');
      let done = 0;
      // Batches of blocks go out in order, so the top of the page changes first.
      for (let i = 0; i < items.length; i += 40) {
        const batch = items.slice(i, i + 40);
        const got = await window.retold.call('translate:items', batch, { kind: 'web', what: 'web', source: settings.config.languages.source === 'auto' && lang ? guess(lang) : settings.config.languages.source });
        await w.executeJavaScript(`window.__retold.apply(${JSON.stringify(got)})`);
        done += batch.length;
        status(`Translated ${done} of ${items.length} blocks…`);
      }
      status(`Translated ${items.length} blocks. Hover a passage for the original.`);
      translatedOnce = true;
      setView('translated');
    } catch (e) { window.App.notice(e.message, 'error'); status(''); }
    finally { translating = false; }
  }
  // The page's declared language is a hint for the translator when the user left "Detect".
  const guess = (lang) => { const code = String(lang).toLowerCase(); if (code.startsWith('zh')) return /hant|tw|hk/.test(code) ? 'zh-Hant' : 'zh-Hans'; const two = code.slice(0, 2); return (settings.languages.some(l => l.code === two)) ? two : 'auto'; };

  function setView(which) {
    $('#web-original').classList.toggle('on', which === 'original'); $('#web-translated').classList.toggle('on', which === 'translated');
    wv().executeJavaScript(`window.__retold && window.__retold.show(${JSON.stringify(which)})`).catch(() => {});
  }

  function poll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if ($('#web-auto').checked && translatedOnce && !translating) translatePage({ incremental: true }); }, 2500);
  }

  function init(s) {
    settings = s;
    const w = wv();
    $('#web-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const u = normalizeUrl(e.target.value); if (u) w.loadURL(u); } });
    $('#web-back').addEventListener('click', () => w.canGoBack() && w.goBack());
    $('#web-fwd').addEventListener('click', () => w.canGoForward() && w.goForward());
    $('#web-reload').addEventListener('click', () => w.reload());
    $('#web-translate').addEventListener('click', () => { sessionTranslated = true; translatePage(); });
    $('#web-original').addEventListener('click', () => setView('original'));
    $('#web-translated').addEventListener('click', () => setView('translated'));
    w.addEventListener('did-navigate', (e) => { $('#web-url').value = e.url; translatedOnce = false; status(''); });
    w.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) $('#web-url').value = e.url; });
    w.addEventListener('dom-ready', () => { if ($('#web-auto').checked && $('#web-translated').classList.contains('on') && sessionTranslated) translatePage(); });
    w.addEventListener('page-title-updated', (e) => { document.title = e.title ? `${e.title} — Retold` : 'Retold'; });
    w.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3 && e.isMainFrame) status(`Could not open ${e.validatedURL}: ${e.errorDescription}`); });
    const home = s.config.web.homepage;
    if (home && /^https?:\/\/./.test(home)) w.src = home;
    poll();
  }
  // Once the user has asked for a translation, later pages in the tab are translated too.
  let sessionTranslated = false;

  function onSettings(s) { settings = s; }

  return { init, onSettings, translatePage: () => { sessionTranslated = true; return translatePage(); } };
})();
