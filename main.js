'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, protocol, screen, desktopCapturer, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ConfigStore } = require('./src/config');
const { LLM } = require('./src/llm');
const { Translator, MemoryFile } = require('./src/translate');
const { OcrEngine } = require('./src/ocr');
const { Page } = require('./src/image/pipeline');
const { VideoSession } = require('./src/video/session');
const { LiveSession } = require('./src/video/live');
const { translateOffice, kindOf } = require('./src/docs/office');
const { translateText } = require('./src/docs/text');
const { pdfFromPages } = require('./src/docs/pdf');
const { LANGUAGES } = require('./src/languages');
const pagewalk = require('./src/web/pagewalk');

if (process.env.RETOLD_USER_DATA) app.setPath('userData', process.env.RETOLD_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('io.github.wenjun78.retold');

const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.restore(); win.focus(); } });

// The window is served from its own scheme so module scripts (pdf.js) load and local
// video files stream with range requests, which file:// pages are not allowed to do.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// net.fetch follows the system proxy settings, which matters on managed work laptops.
const netFetch = (url, init) => net.fetch(url, init);

let win, overlay, config, llm, translator, memory, ocr, live;
const pages = new Map();     // page id -> Page
let video = null;            // the open VideoSession
let captureSourceId = '';    // screen/window picked for the live overlay

const send = (event, payload) => { if (win && !win.isDestroyed()) win.webContents.send('retold:' + event, payload); };
const notice = (text, kind = 'info') => send('notice', { text, kind });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json' };
const MEDIA = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.pdf': 'application/pdf' };

// app://ui/<path> serves the app's own files; app://ui/-local/<encoded absolute path> serves
// a file the user opened (pictures, videos, PDFs), with the range requests video seeking
// needs. Both sit on one origin, so the window may read the pixels of a picture it opened.
function serve(request) {
  const url = new URL(request.url);
  if (url.host === 'ui' && !url.pathname.startsWith('/-local/')) {
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(__dirname, rel));
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
    return new Response(fs.createReadStream(file), { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  }
  if (url.host === 'ui') {
    const file = decodeURIComponent(url.pathname.replace(/^\/-local\//, ''));
    const abs = process.platform === 'win32' ? file : '/' + file;
    if (!opened.has(path.normalize(abs))) return new Response('Not allowed', { status: 403 });
    let stat; try { stat = fs.statSync(abs); } catch { return new Response('Not found', { status: 404 }); }
    const type = MEDIA[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');
    const m = range && range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
      return new Response(fs.createReadStream(abs, { start, end }), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
    }
    return new Response(fs.createReadStream(abs), { headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' } });
  }
  return new Response('Not found', { status: 404 });
}
const opened = new Set(); // files the user opened, the only ones app://local serves
const localUrl = (file) => { opened.add(path.normalize(file)); const p = process.platform === 'win32' ? file : file.replace(/^\//, ''); return 'app://ui/-local/' + p.split(/[\\/]/).map(encodeURIComponent).join('/'); };

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = config.get().ui.bounds;
  const bounds = saved && screen.getAllDisplays().some(d => saved.x >= d.bounds.x - 50 && saved.x < d.bounds.x + d.bounds.width && saved.y >= d.bounds.y - 50 && saved.y < d.bounds.y + d.bounds.height)
    ? saved : { width: Math.min(1280, area.width - 40), height: Math.min(840, area.height - 40), x: area.x + 20, y: area.y + 20 };
  win = new BrowserWindow({
    ...bounds, minWidth: 720, minHeight: 480,
    frame: false, show: false, backgroundColor: config.get().ui.theme === 'light' ? '#F3F5F7' : '#1B2530', title: 'Retold',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, backgroundThrottling: false },
  });
  win.loadURL('app://ui/renderer/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText && p.selectionText.trim()) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  let saveTimer;
  const remember = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) config.update({ ui: { bounds: win.getBounds() } }); }, 500); };
  win.on('resize', remember); win.on('move', remember);
  win.on('maximize', () => send('window', { maximized: true }));
  win.on('unmaximize', () => send('window', { maximized: false }));
  win.on('closed', () => { win = null; });
  // Pages opened in the Web tab: links open in the same tab, never in new windows.
  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) wc.loadURL(url); return { action: 'deny' }; });
  });
}

// Secrets never go to the renderer; it only learns whether one is saved.
function publicConfig() {
  const c = JSON.parse(JSON.stringify(config.get()));
  const saved = { llmKey: !!c.llm.apiKey, visionKey: !!c.vision.apiKey, sttKey: !!c.stt.apiKey };
  c.llm.apiKey = c.vision.apiKey = c.stt.apiKey = '';
  return { config: c, saved, platform: process.platform, encrypted: safeStorage.isEncryptionAvailable(), version: app.getVersion(), languages: LANGUAGES, memory: memory.size };
}

const translateOpts = (over = {}) => {
  const cfg = config.get();
  return { source: cfg.languages.source, target: cfg.languages.target, formality: cfg.style.formality, glossary: cfg.style.glossary, ...over };
};

app.whenReady().then(() => {
  protocol.handle('app', serve);
  const crypto = safeStorage.isEncryptionAvailable() ? { encrypt: (s) => safeStorage.encryptString(s).toString('base64'), decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')) } : null;
  config = new ConfigStore(path.join(app.getPath('userData'), 'config.json'), crypto);
  config.load();
  llm = new LLM(() => config.get(), netFetch);
  memory = new MemoryFile(path.join(app.getPath('userData'), 'memory.json'));
  translator = new Translator(llm, memory);
  ocr = new OcrEngine({ dataDir: path.join(app.getPath('userData'), 'tessdata'), fetchFn: netFetch });
  // The live overlay captures the screen or window the user picked.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find(s => s.id === captureSourceId) || sources[0];
      cb(src ? { video: src, audio: 'loopback' } : {});
    }).catch(() => cb({}));
  });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', () => { memory.save(); if (video) video.close(); if (live) live.stop(); ocr.stop(); });

// ---- settings and window ---------------------------------------------------------
ipcMain.handle('config:get', () => publicConfig());
ipcMain.handle('config:update', (_e, patch) => { config.update(patch); return publicConfig(); });
ipcMain.handle('memory:clear', () => { memory.clear(); return publicConfig(); });
ipcMain.handle('window:minimize', () => win && win.minimize());
ipcMain.handle('window:maximize', () => { if (!win) return; if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.handle('window:close', () => win && win.close());
ipcMain.handle('shell:open', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('shell:show', (_e, file) => { if (opened.has(path.normalize(file)) || savedFiles.has(file)) shell.showItemInFolder(file); });

const FILTERS = {
  image: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  video: [{ name: 'Video and audio', extensions: ['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'mp3', 'm4a', 'wav', 'ogg', 'flac'] }],
  doc: [{ name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'srt', 'vtt'] }],
  subtitle: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};
ipcMain.handle('dialog:open', async (_e, { kind = 'any', multiple = false, folder = false } = {}) => {
  const props = folder ? ['openDirectory'] : ['openFile'];
  if (multiple) props.push('multiSelections');
  const r = await dialog.showOpenDialog(win, { properties: props, filters: FILTERS[kind] || FILTERS.any });
  if (r.canceled) return [];
  if (folder) {
    const dir = r.filePaths[0];
    return fs.readdirSync(dir).filter(n => /\.(png|jpe?g|webp|bmp|gif)$/i.test(n)).sort(naturalCompare).map(n => path.join(dir, n));
  }
  return r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, { name = '', filters = FILTERS.any } = {}) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  return r.canceled ? '' : r.filePath;
});
const savedFiles = new Set();
ipcMain.handle('file:write', async (_e, file, data) => { fs.writeFileSync(file, Buffer.from(data)); savedFiles.add(file); return file; });
ipcMain.handle('file:read', async (_e, file) => { opened.add(path.normalize(file)); const data = fs.readFileSync(file); return { name: path.basename(file), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }; });
ipcMain.handle('file:url', (_e, file) => localUrl(file));
ipcMain.handle('file:siblings', (_e, file) => {
  const dir = path.dirname(file);
  try { return fs.readdirSync(dir).filter(n => /\.(png|jpe?g|webp|bmp|gif)$/i.test(n)).sort(naturalCompare).map(n => path.join(dir, n)); } catch { return [file]; }
});
function naturalCompare(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

// ---- pictures and manga pages --------------------------------------------------------
const pageDeps = () => ({ ocr, llm, translator, config: () => config.get() });
const pageOf = (id) => { const p = pages.get(id); if (!p) throw new Error('This page is no longer open.'); return p; };

ipcMain.handle('page:open', (_e, { id, width, height, data, lines }) => {
  const page = new Page(id, { width, height, data: new Uint8ClampedArray(data) }, pageDeps());
  if (lines && lines.length) page.prefill(lines);
  pages.set(id, page);
  return true;
});
ipcMain.handle('page:close', (_e, id) => { pages.delete(id); });
ipcMain.handle('page:reset', (_e, id) => { pageOf(id).reset(); return pageOf(id).publicRegions(); });
ipcMain.handle('page:detect', async (_e, id) => {
  const cfg = config.get();
  const page = pageOf(id);
  if (page.prefilled) return page.publicRegions();
  return page.detect({ bubbles: cfg.image.bubbles, source: cfg.languages.source });
});
ipcMain.handle('page:read', async (_e, id, regionId) => {
  const cfg = config.get();
  return pageOf(id).read(regionId, { mode: cfg.image.ocr, source: cfg.languages.source });
});
ipcMain.handle('page:readAll', async (_e, id) => {
  const cfg = config.get();
  const page = pageOf(id);
  const todo = page.regions.filter(r => !r.source);
  let n = 0;
  // The image model is asked a few bubbles at a time; Tesseract reads one after another.
  const parallel = cfg.image.ocr === 'vision' ? 4 : 1;
  const queue = todo.slice();
  const worker = async () => { while (queue.length) { const r = queue.shift(); try { await page.read(r.id, { mode: cfg.image.ocr, source: cfg.languages.source }); } catch (e) { notice(e.message, 'error'); queue.length = 0; } send('progress', { what: 'read', page: id, done: ++n, total: todo.length }); } };
  await Promise.all(Array.from({ length: parallel }, worker));
  page.regions = page.regions.filter(r => r.source || r.manual);
  return page.publicRegions();
});
// The last lines of the page translated before are sent along with the next one, so a
// conversation that runs across pages is translated as one.
let pageContext = '';
ipcMain.handle('page:translate', async (_e, id, ids = null) => {
  const page = pageOf(id);
  const list = page.regions.filter(r => r.source && (!ids || ids.includes(r.id)));
  if (!list.length) return page.publicRegions();
  const got = await translator.translate(list.map(r => ({ id: String(r.id), text: r.source })), translateOpts({ kind: 'manga', context: page.context || pageContext }));
  for (const r of list) if (got.has(String(r.id))) r.target = got.get(String(r.id));
  pageContext = page.context = list.slice(-4).map(r => r.source).join('\n');
  return page.publicRegions();
});
ipcMain.handle('page:erase', (_e, id) => {
  const { image, regions } = pageOf(id).erase();
  return { regions, image: image.data.buffer };
});
ipcMain.handle('page:add', (_e, id, box) => { const r = pageOf(id).addRegion(box); pageOf(id).regions.find(x => x.id === r.id).manual = true; return r; });
ipcMain.handle('page:update', (_e, id, rid, patch) => pageOf(id).updateRegion(rid, patch));
ipcMain.handle('page:remove', (_e, id, rid) => { pageOf(id).removeRegion(rid); return pageOf(id).publicRegions(); });

// ---- any text: web pages, documents --------------------------------------------------------
ipcMain.handle('translate:items', async (_e, items, opts = {}) => {
  const got = await translator.translate(items, translateOpts({ ...opts, onProgress: (done, total) => send('progress', { what: opts.what || 'translate', done, total }) }));
  return Object.fromEntries(got);
});

ipcMain.handle('web:script', () => pagewalk.script);

ipcMain.handle('doc:translate', async (_e, file, savePath) => {
  const name = path.basename(file);
  const translate = (items, extra = {}) => translator.translate(items, translateOpts({ kind: extra.kind || 'document', onProgress: (done, total) => send('progress', { what: 'doc', done, total }) }));
  const kind = kindOf(name);
  let out;
  if (kind) out = await translateOffice(fs.readFileSync(file), kind, translate);
  else out = Buffer.from(await translateText(name, fs.readFileSync(file, 'utf8'), translate), 'utf8');
  fs.writeFileSync(savePath, out);
  savedFiles.add(savePath);
  return savePath;
});
ipcMain.handle('pdf:export', async (_e, pagesIn, savePath) => {
  const buf = await pdfFromPages(pagesIn.map(p => ({ png: Buffer.from(p.png), width: p.width, height: p.height })));
  fs.writeFileSync(savePath, buf);
  savedFiles.add(savePath);
  return savePath;
});

// ---- video files -----------------------------------------------------------------------------
ipcMain.handle('video:open', async (_e, file) => {
  if (video) { video.close(); video = null; }
  video = new VideoSession(file, { llm, translator, ocr, config: () => config.get() });
  const info = await video.open();
  return { ...info, url: localUrl(file), name: path.basename(file) };
});
ipcMain.handle('video:start', async (_e, source) => {
  if (!video) throw new Error('Open a video first.');
  video.removeAllListeners();
  video.on('cues', (c) => send('video', { kind: 'cues', ...c }));
  video.on('status', (s) => send('video', { kind: 'status', ...s }));
  video.on('error', (e) => send('video', { kind: 'error', ...e }));
  video.on('notice', (t) => notice(t, 'error'));
  return video.start(source || config.get().video.source);
});
ipcMain.handle('video:playhead', (_e, t) => { if (video) video.update(t); });
ipcMain.handle('video:retry', () => { if (video) video.retry(); });
ipcMain.handle('video:close', () => { if (video) { video.close(); video = null; } });
ipcMain.handle('video:exportSrt', async (_e, savePath, opts) => { if (!video) throw new Error('No video is open.'); fs.writeFileSync(savePath, video.exportSrt(opts || {})); savedFiles.add(savePath); return savePath; });

// ---- watching elsewhere: the live overlay ---------------------------------------------------
ipcMain.handle('capture:sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 240, height: 150 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), displayId: s.display_id || '' }));
});
ipcMain.handle('live:start', async (_e, { sourceId, displayId }) => {
  captureSourceId = sourceId;
  const display = screen.getAllDisplays().find(d => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  if (live) live.stop();
  live = new LiveSession({ llm, translator, ocr, config: () => config.get() });
  live.on('cue', (c) => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('retold:overlay', c); send('overlay', c); });
  live.on('notice', (t) => notice(t, 'error'));
  openOverlay(display);
  return true;
});
ipcMain.handle('live:audio', async (_e, wav, duration) => { if (live) live.audio(Buffer.from(wav), duration); });
ipcMain.handle('live:frame', async (_e, png, meta) => { if (live) live.frame(Buffer.from(png), meta); });
ipcMain.handle('live:stop', () => { if (live) { live.stop(); live = null; } if (overlay && !overlay.isDestroyed()) overlay.close(); overlay = null; });

function openOverlay(display) {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = new BrowserWindow({
    ...display.bounds, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, resizable: false, show: false, title: 'Retold overlay',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadURL('app://ui/renderer/overlay.html');
  overlay.once('ready-to-show', () => { overlay.showInactive(); overlay.webContents.send('retold:overlay', { kind: 'settings', video: config.get().video }); });
  overlay.on('closed', () => { overlay = null; });
}

process.on('unhandledRejection', (e) => { notice(e && e.message ? e.message : String(e), 'error'); });

// Smoke test (test/smoke.js): with RETOLD_SMOKE set to a file path, the window is driven
// through a page translation against a mock API and the outcome written there.
if (process.env.RETOLD_SMOKE) {
  app.whenReady().then(() => {
    const errors = [];
    const start = Date.now();
    const finish = (result) => { fs.writeFileSync(process.env.RETOLD_SMOKE, JSON.stringify({ ...result, errors, ms: Date.now() - start })); app.quit(); };
    const attach = () => {
      win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(String(e.message).slice(0, 300)); });
      win.webContents.once('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          const image = process.env.RETOLD_SMOKE_IMAGE, out = process.env.RETOLD_SMOKE_OUT;
          const result = await win.webContents.executeJavaScript(`(async () => {
            const have = ['App', 'Viewer', 'Video', 'Web', 'Docs', 'Lettering', 'Capture'].filter(k => window[k]);
            const r = { title: document.title, modules: have, tabs: document.querySelectorAll('.tab').length, languages: document.querySelectorAll('#dst-lang option').length };
            if (${JSON.stringify(Boolean(image))}) {
              await window.Viewer.openFiles([${JSON.stringify(image || '')}]);
              const p = window.Viewer.pages[0];
              if (!p) { r.toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent); return r; }
              await window.Viewer.translatePage(p);
              r.regions = p.regions.map(x => ({ source: x.source, target: x.target, orientation: x.orientation, size: x.style && x.style.size }));
              r.state = p.state; r.status = document.querySelector('#img-status').textContent;
            }
            const webUrl = ${JSON.stringify(process.env.RETOLD_SMOKE_WEB || '')};
            if (webUrl) {
              window.App.setMode('web');
              const wv = document.querySelector('#webview');
              await new Promise((res) => { wv.addEventListener('dom-ready', res, { once: true }); wv.loadURL(webUrl); });
              await window.Web.translatePage();
              r.web = { text: await wv.executeJavaScript('document.body.innerText'), title: await wv.executeJavaScript('document.title'), status: document.querySelector('#web-status').textContent };
              window.App.setMode('image');
            }
            const videoFile = ${JSON.stringify(process.env.RETOLD_SMOKE_VIDEO || '')};
            if (videoFile) {
              window.App.setMode('video');
              await window.Video.open(videoFile);
              const player = document.querySelector('#player');
              await new Promise((res) => { if (player.readyState >= 1) res(); else player.addEventListener('loadedmetadata', res, { once: true }); });
              await new Promise(r => setTimeout(r, 3500));
              player.currentTime = 1; await new Promise(r => setTimeout(r, 700));
              r.video = { duration: player.duration, status: document.querySelector('#vid-status').textContent, ready: document.querySelector('#vid-ready').textContent, overlay: document.querySelector('#sub-overlay').innerText };
              player.currentTime = 3; await new Promise(r => setTimeout(r, 700));
              r.video.overlay2 = document.querySelector('#sub-overlay').innerText;
              window.App.setMode('image');
            }
            const pdfFile = ${JSON.stringify(process.env.RETOLD_SMOKE_PDF || '')};
            if (pdfFile) {
              await window.Docs.open([pdfFile]);
              const p = window.Viewer.pages.find(q => q.fromPdf);
              await window.Viewer.translatePage(p);
              r.pdf = { pages: window.Viewer.pages.filter(q => q.fromPdf).length, regions: p.regions.map(x => ({ source: x.source, target: x.target })), state: p.state };
            }
            r.toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent);
            if (${JSON.stringify(Boolean(image))} && window.Viewer.pages[0]) {
              const p = window.Viewer.pages[0];
              const c = document.querySelector('#c-translated');
              const blob = await new Promise(res => c.toBlob(res, 'image/png'));
              await window.retold.call('file:write', ${JSON.stringify(out || '')}, await blob.arrayBuffer());
            }
            return r;
          })()`);
          finish({ ok: true, ...result });
        } catch (e) { finish({ ok: false, error: e.message }); }
      });
    };
    if (win) attach(); else app.once('browser-window-created', attach);
  });
}
