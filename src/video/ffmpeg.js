'use strict';
// Everything the app needs from a video file comes through ffmpeg: how long it is, which
// subtitle tracks it carries, its sound as 16 kHz mono WAV in windows, and frames from the
// band where burned-in subtitles live. The ffmpeg-static binary ships with the app; one
// found on the PATH is used instead when the bundled one is missing.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch { /* not installed */ }
  return 'ffmpeg';
}

function run(args, { signal, maxBuffer = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    const out = [], err = [];
    let size = 0;
    child.stdout.on('data', (d) => { size += d.length; if (size <= maxBuffer) out.push(d); });
    child.stderr.on('data', (d) => { if (err.length < 400) err.push(d); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found. Reinstall the app, or install ffmpeg and put it on the PATH.' : e.message)));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    if (signal) signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
}

// Duration, picture size and the subtitle tracks of a file.
async function probe(file) {
  const { stderr } = await run(['-i', file]);
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const video = stderr.match(/Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/);
  const subtitles = [];
  const re = /Stream #\d+:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: Subtitle: (\w+)/g;
  let m, index = 0;
  while ((m = re.exec(stderr))) subtitles.push({ index: index++, stream: Number(m[1]), language: m[2] || '', codec: m[3] });
  if (!duration && !video) throw new Error(/No such file/i.test(stderr) ? 'The file was not found.' : 'This file could not be read as a video.');
  return { duration, width: video ? Number(video[1]) : 0, height: video ? Number(video[2]) : 0, subtitles };
}

// Subtitle files next to the video: name.srt, name.en.srt, name.vtt ...
function sidecars(file) {
  const dir = path.dirname(file), stem = path.basename(file, path.extname(file));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.startsWith(stem) && /\.(srt|vtt)$/i.test(n)).map(n => ({ file: path.join(dir, n), language: (n.slice(stem.length).match(/\.([a-z]{2,3})\./i) || [])[1] || '' }));
}

// A text subtitle track as SRT text.
async function subtitleTrack(file, index, { signal } = {}) {
  const { code, stdout, stderr } = await run(['-i', file, '-map', `0:s:${index}`, '-f', 'srt', '-'], { signal });
  if (code !== 0 && !stdout.length) throw new Error('This subtitle track could not be read as text. ' + (stderr.split('\n').pop() || ''));
  return stdout.toString('utf8');
}

// `dur` seconds of sound from `start`, as a 16 kHz mono WAV buffer. An empty buffer means the
// window lies past the end of the file.
async function audioWindow(file, start, dur, { signal } = {}) {
  const { stdout } = await run(['-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-'], { signal });
  return stdout.length > 44 + 1600 ? stdout : Buffer.alloc(0);
}

// Frames from the bottom `band` of the picture at `fps`, each as a PNG, in time order. The
// crop is scaled to `width` pixels across so OCR sees the same size whatever the video is.
async function bandFrames(file, start, dur, { fps = 1, band = 0.3, width = 960, signal } = {}) {
  const b = Math.min(0.9, Math.max(0.1, band));
  const vf = `crop=iw:ih*${b}:0:ih*${(1 - b).toFixed(4)},fps=${fps},scale=${width}:-2`;
  const { stdout } = await run(['-ss', String(start), '-t', String(dur), '-i', file, '-vf', vf, '-f', 'image2pipe', '-vcodec', 'png', '-'], { signal });
  const pngs = splitPngs(stdout);
  return pngs.map((png, i) => ({ t: start + i / fps, png }));
}

// PNG files concatenated on a pipe: each ends with the IEND chunk and its CRC.
function splitPngs(buf) {
  const out = [];
  const END = Buffer.from('IEND');
  let from = 0;
  while (from < buf.length) {
    const sig = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]), from);
    if (sig < 0) break;
    const end = buf.indexOf(END, sig);
    if (end < 0) break;
    const stop = end + 4 + 4;
    out.push(buf.subarray(sig, stop));
    from = stop;
  }
  return out;
}

module.exports = { ffmpegPath, run, probe, sidecars, subtitleTrack, audioWindow, bandFrames, splitPngs };
