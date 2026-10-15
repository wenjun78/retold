'use strict';
// A local stand-in for an OpenAI-compatible API: chat completions that "translate" (by a
// rule the test picks), the same with images, and speech-to-text with timestamps. Used by
// the unit tests and the smoke test of the packaged app.
const http = require('http');

// translate(text) -> text decides what the "model" replies for each item. Items are read
// out of the JSON the app sends ({items:[{id,text}]}); markers are kept as they are.
function start({ translate = (t) => `[${t}]`, vision = { text: 'おまえはもう死んでいる', direction: 'vertical', language: 'ja' }, segments = null, strict = false, sttFormatOnly = '' } = {}) {
  const log = { chat: [], stt: [], vision: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/page.html') { // a web page for the smoke test's Web tab
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html lang="de"><head><title>Seite</title></head><body><h1>Willkommen</h1><p>Klick <a href="/page.html">hier</a>, um fortzufahren.</p><p translate="no">Bleib</p></body></html>');
      }
      if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: { message: 'bad key' } });

      if (url.pathname === '/v1/audio/transcriptions') {
        const text = body.toString('latin1');
        const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(text) || [])[1] || '';
        const asked = { bytes: body.length, hasWav: text.includes('RIFF'), model: field('model'), language: field('language'), format: field('response_format') };
        log.stt.push(asked);
        if (sttFormatOnly && asked.format !== sttFormatOnly) return json(400, { error: { message: `response_format ${asked.format} is not supported` } });
        const segs = segments || [{ start: 0.5, end: 2.2, text: 'Where did you put the keys?', no_speech_prob: 0.01, avg_logprob: -0.2 }, { start: 2.6, end: 4.0, text: 'They are on the table.', no_speech_prob: 0.02, avg_logprob: -0.3 }];
        if (asked.format !== 'verbose_json') return json(200, { text: segs.map(s => s.text).join(' ') });
        return json(200, { text: segs.map(s => s.text).join(' '), language: 'english', segments: segs });
      }
      if (url.pathname === '/v1/chat/completions') {
        const payload = JSON.parse(body.toString());
        if (strict) {
          if ('max_tokens' in payload) return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
          if ('temperature' in payload) return json(400, { error: { message: "Unsupported value: 'temperature' does not support this value." } });
          if ('response_format' in payload) return json(400, { error: { message: 'response_format is not supported' } });
        }
        const user = payload.messages[payload.messages.length - 1];
        const reply = (content) => json(200, { choices: [{ message: { role: 'assistant', content } }] });
        if (Array.isArray(user.content)) { // an image was sent
          log.vision.push({ images: user.content.filter(p => p.type === 'image_url').length, prompt: user.content.find(p => p.type === 'text').text });
          return reply(JSON.stringify(typeof vision === 'function' ? vision(log.vision.length) : vision));
        }
        log.chat.push(payload);
        let items = [];
        try { items = JSON.parse(user.content).items || []; } catch { /* a plain prompt */ }
        const t = items.map(it => ({ id: it.id, text: translate(it.text, it) }));
        return reply(strict ? '```json\n' + JSON.stringify({ t }) + '\n```' : JSON.stringify({ t }));
      }
      json(404, { error: { message: 'no such route' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, log, close: () => new Promise(r => server.close(r)) });
  }));
}

if (require.main === module) start().then(s => console.log(s.base));
module.exports = { start };
