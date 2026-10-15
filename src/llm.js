'use strict';
// Client for any OpenAI-compatible API (OpenAI, Groq, Azure-style gateways, Ollama, vLLM ...):
// chat completions (plain or JSON), the same with images attached, and speech-to-text with
// timestamps. Carried over from Cue and trimmed to what a translator needs.

function friendlyError(status, body, what) {
  let msg = '';
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { msg = String(body || '').slice(0, 200); }
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  if (status === 401 || status === 403) return `${what}: the API key was rejected. Check it in Settings.`;
  if (status === 404) return `${what}: model or endpoint not found. Check the model name and base URL in Settings. ${msg}`.trim();
  if (status === 429) return `${what}: rate limit reached. ${msg}`.trim();
  return `${what} failed (${status}). ${msg}`.trim();
}

class LLM {
  // getConfig() -> { llm:{baseUrl,apiKey,model,extra}, vision:{...}, stt:{...} }
  constructor(getConfig, fetchFn = fetch) { this.getConfig = getConfig; this.fetch = fetchFn; this.timeoutMs = 120000; }

  _endpoint(kind) {
    const cfg = this.getConfig();
    const own = cfg[kind] || {};
    const base = (own.baseUrl || cfg.llm.baseUrl || '').replace(/\/+$/, '');
    const key = own.baseUrl ? own.apiKey : (own.apiKey || cfg.llm.apiKey); // a custom endpoint never inherits the chat key
    if (!base) throw new Error('Add an API base URL in Settings.');
    const model = own.model || (kind === 'vision' ? cfg.llm.model : '');
    return { base, key, model, own };
  }

  _headers(key, extra = {}) {
    const h = { ...extra };
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  _signal(signal) {
    const t = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, t]) : t;
  }

  // One chat completion. messages: [{role, content}] where content is a string or an array of
  // parts ({type:'text', text} / {type:'image_url', image_url:{url}}). json=true asks for a JSON
  // object. kind: 'llm' or 'vision' (its own model and endpoint when set, else the chat model's).
  async chat(messages, { json = false, maxTokens = 4000, temperature = 0.2, signal, kind = 'llm' } = {}) {
    const { base, key, model } = this._endpoint(kind);
    if (!model) throw new Error('Add a chat model name in Settings.');
    const cfg = this.getConfig().llm;
    const extra = cfg.extra && typeof cfg.extra === 'object' ? cfg.extra : {};
    let body = { model, messages, temperature, max_tokens: maxTokens, ...extra };
    if (json) body.response_format = { type: 'json_object' };
    const post = (b) => this.fetch(`${base}/chat/completions`, {
      method: 'POST', signal: this._signal(signal), body: JSON.stringify(b),
      headers: this._headers(key, { 'Content-Type': 'application/json' }),
    });
    let res = await post(body);
    // Services differ in which parameters they accept. When a request is refused for one,
    // adjust it and try again: reasoning models want max_completion_tokens and no temperature;
    // some services know neither response_format nor the extra parameters.
    for (let attempt = 0; res.status === 400 && attempt < 5; attempt++) {
      const why = await res.text();
      const extras = Object.keys(extra).filter(k => k in body);
      if ('max_tokens' in body && /max_tokens/.test(why)) {
        const { max_tokens: limit, ...rest } = body; body = { ...rest, max_completion_tokens: limit };
      } else if ('temperature' in body && /temperature/.test(why)) {
        const { temperature: _t, ...rest } = body; body = rest;
      } else if ('response_format' in body && /response_format|json_object/.test(why)) {
        const { response_format: _f, ...rest } = body; body = rest;
      } else if (extras.length) {
        const named = extras.filter(k => why.includes(k));
        body = { ...body }; for (const k of (named.length ? named : extras)) delete body[k];
      } else throw new Error(friendlyError(400, why, 'Translation'));
      res = await post(body);
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(8000, (Number(res.headers.get('retry-after')) || 2) * 1000);
      await new Promise(r => setTimeout(r, this.retryDelayMs ?? wait));
      res = await post(body);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(friendlyError(res.status, text, 'Translation'));
    let data; try { data = JSON.parse(text); } catch { throw new Error('The model returned something that is not JSON.'); }
    if (data.error) throw new Error(data.error.message || 'The model returned an error.');
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const content = msg && (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('') : '');
    return content || '';
  }

  // The same, with PNG/JPEG images (Buffers or data URLs) shown to the image model.
  async see(images, prompt, { json = false, maxTokens = 2000, signal, system = '' } = {}) {
    const parts = [];
    for (const img of images) {
      const url = typeof img === 'string' ? img : `data:image/png;base64,${Buffer.from(img).toString('base64')}`;
      parts.push({ type: 'image_url', image_url: { url, detail: 'high' } });
    }
    parts.push({ type: 'text', text: prompt });
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: parts });
    return this.chat(messages, { json, maxTokens, signal, kind: 'vision', temperature: 0 });
  }

  // wav: Buffer (16 kHz mono PCM16). Returns { text, segments:[{start,end,text}], language } with
  // times in seconds from the start of the recording. Timestamps come with verbose_json; a
  // service without it gets the text back and the time is spread across it by length.
  async transcribe(wav, { language = '', prompt = '', signal, duration = 0 } = {}) {
    const { base, key, own } = this._endpoint('stt');
    const model = own.model || 'whisper-1';
    const send = async (format) => {
      const boundary = '----gl' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      const fields = { model, response_format: format, temperature: '0' };
      if (language && language !== 'auto') fields.language = language.split('-')[0];
      if (prompt) fields.prompt = prompt;
      if (format === 'verbose_json') fields['timestamp_granularities[]'] = 'segment';
      const parts = [];
      for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
      parts.push(Buffer.from(wav), Buffer.from(`\r\n--${boundary}--\r\n`));
      return this.fetch(`${base}/audio/transcriptions`, {
        method: 'POST', signal: this._signal(signal), body: Buffer.concat(parts),
        headers: this._headers(key, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
      });
    };
    this._sttFormat = this._sttFormat || {};
    const formatKey = `${base}|${model}`;
    let format = this._sttFormat[formatKey] || 'verbose_json';
    let res = await send(format);
    if (res.status === 400 && format === 'verbose_json') {
      res = await send((format = 'json'));
      if (res.ok) this._sttFormat[formatKey] = 'json';
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(6000, (Number(res.headers.get('retry-after')) || 1.5) * 1000);
      await new Promise(r => setTimeout(r, this.retryDelayMs ?? wait));
      res = await send(format);
    }
    const body = await res.text();
    if (!res.ok) throw new Error(friendlyError(res.status, body, 'Transcription'));
    let data; try { data = JSON.parse(body); } catch { data = { text: body }; }
    return segmentsOf(data, duration);
  }
}

// Turns a transcription reply into timed segments, dropping Whisper's silence hallucinations.
const ARTIFACTS = /^(thanks for watching|thank you for watching|please subscribe|subtitles by.*|.*amara\.org.*|字幕.*|ご視聴ありがとうございました|transcribed by.*|\[.*\]|\(.*\)|♪.*|\.+)$/i;
function segmentsOf(data, duration = 0) {
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  let segments = [];
  if (Array.isArray(data.segments) && data.segments.length) {
    for (const s of data.segments) {
      if (s.no_speech_prob > 0.6 || (s.no_speech_prob > 0.35 && s.avg_logprob < -1) || s.compression_ratio > 2.6) continue;
      const text = clean(s.text);
      if (!text || ARTIFACTS.test(text.replace(/[.!?,。！？…\s]+$/u, ''))) continue;
      segments.push({ start: Number(s.start) || 0, end: Number(s.end) || 0, text });
    }
  } else {
    const text = clean(data.text);
    if (text && !ARTIFACTS.test(text.replace(/[.!?,。！？…\s]+$/u, ''))) {
      // No timestamps: split into sentences and spread the recording's length across them by size.
      const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [text];
      const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
      let t = 0;
      for (const s of sentences) {
        const len = duration * (s.length / total);
        segments.push({ start: t, end: t + len, text: s.trim() });
        t += len;
      }
    }
  }
  // A phrase repeated many times in a row is a decoding loop, not speech.
  segments = segments.filter(s => !/(\b[\p{L}' ]{3,40}\b)(?:[,.!?]?\s+\1){4,}/iu.test(s.text));
  return { text: segments.map(s => s.text).join(' '), segments, language: String(data.language || '') };
}

module.exports = { LLM, segmentsOf, friendlyError };
