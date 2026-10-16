'use strict';
// Starts the real app against the mock API, has it open and translate a drawn comic page
// through the window, and checks what came out. Runs from source (`node test/smoke.js`)
// or against a packaged build (RETOLD_SMOKE_BIN=path/to/Retold.exe). On Linux without a
// display it runs under xvfb-run when that is installed.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mock = require('./mock-server');
const { drawPage } = require('./page');
const { PNG } = require('pngjs');

(async () => {
  const srv = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retold-smoke-'));
  const outDir = process.env.RETOLD_SMOKE_OUTDIR || dir;
  fs.mkdirSync(outDir, { recursive: true });
  const config = { llm: { baseUrl: srv.base + '/v1', apiKey: 'test-key', model: 'chat-model', extra: {} }, image: { ocr: 'vision' }, languages: { source: 'ja', target: process.env.RETOLD_SMOKE_TARGET || 'en' }, ui: { mode: 'image' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const { canvas } = drawPage();
  const image = path.join(dir, 'page.png');
  fs.writeFileSync(image, canvas.toBuffer('image/png'));
  const clip = path.join(dir, 'clip.mp4');
  const ff = require('../src/video/ffmpeg');
  const made = await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const pg = pdfDoc.addPage([400, 300]); const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pg.drawText('The quick brown fox', { x: 40, y: 240, size: 18, font }); pg.drawText('jumps over the lazy dog.', { x: 40, y: 216, size: 18, font }); pg.drawText('A second paragraph.', { x: 40, y: 120, size: 18, font });
  const pdfFile = path.join(dir, 'doc.pdf'); fs.writeFileSync(pdfFile, await pdfDoc.save());
  const resultFile = path.join(outDir, 'result.json'), out = path.join(outDir, 'translated.png');
  const env = { ...process.env, RETOLD_USER_DATA: dir, RETOLD_SMOKE: resultFile, RETOLD_SMOKE_IMAGE: image, RETOLD_SMOKE_OUT: out, RETOLD_SMOKE_WEB: srv.base + '/page.html', RETOLD_SMOKE_VIDEO: made.code === 0 ? clip : '', RETOLD_SMOKE_PDF: pdfFile };
  let cmd, args;
  if (process.env.RETOLD_SMOKE_BIN) { cmd = process.env.RETOLD_SMOKE_BIN; args = []; }
  else { cmd = require('electron'); args = [path.join(__dirname, '..')]; }
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    let xvfb = ''; try { xvfb = execSync('which xvfb-run').toString().trim(); } catch { /* none */ }
    if (xvfb) { args = ['-a', '-s', '-screen 0 1400x900x24', cmd, ...args, '--no-sandbox']; cmd = xvfb; }
    else args.push('--no-sandbox');
  } else if (process.platform === 'linux') args.push('--no-sandbox');
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const code = await new Promise((resolve) => { child.on('exit', resolve); setTimeout(() => { child.kill(); resolve('timeout'); }, 120000); });
  let result = null;
  try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { /* nothing written */ }
  await srv.close();
  const ok = result && result.ok && result.modules.length === 7 && result.state === 'translated' && result.regions.length === 2 && result.regions.every(r => r.target) && result.errors.length === 0
    && result.web && /\[Willkommen\]/.test(result.web.text) && /Bleib/.test(result.web.text) && !/\[Bleib\]/.test(result.web.text) && result.web.title === '[Seite]'
    && result.pdf && result.pdf.pages === 1 && result.pdf.state === 'translated' && result.pdf.regions.length === 2 && /\[The quick brown fox jumps over the lazy dog\.\]/.test(result.pdf.regions[0].target)
    && (made.code !== 0 || (result.video && result.video.duration > 7 && /\[Where did you put the keys\?\]/.test(result.video.overlay) && /\[They are on the table\.\]/.test(result.video.overlay2)));
  console.log(JSON.stringify({ ok, code, result, vision: srv.log.vision.length, chat: srv.log.chat.length, stderr: stderr.split('\n').filter(l => /error|Error/.test(l)).slice(0, 5) }, null, 1));
  if (ok && fs.existsSync(out)) { const png = PNG.sync.read(fs.readFileSync(out)); console.log(`translated page: ${png.width}x${png.height} at ${out}`); }
  process.exit(ok ? 0 : 1);
})();
