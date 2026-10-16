'use strict';
// Captures the screen or window the user picked (the main process chooses which) and
// hands over its sound as one WAV per utterance and the bottom band of its picture once a
// second, for translating a video that plays in another app.
window.Capture = (() => {
  let stream = null, ctx = null, timer = 0, worklet = null;

  // A worklet that posts the raw samples; silence detection and chunking happen here.
  const WORKLET = `class G extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice());return true;}}registerProcessor('retold-tap',G);`;

  async function start({ band = 0.3, video, onAudio, onFrame }) {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: true });
    // Picture: the chosen source plays in a hidden element; its bottom band is sampled.
    video.srcObject = stream; await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    timer = setInterval(() => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const w = 960, bh = Math.round(vh * band), h = Math.round(bh * (w / vw));
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, vh - bh, vw, bh, 0, 0, w, h);
      canvas.toBlob((blob) => { if (blob) blob.arrayBuffer().then(buf => onFrame(buf, { width: vw, height: vh, band })); }, 'image/png');
    }, 1000);
    // Sound: 16 kHz mono; an utterance ends after 0.7 s of quiet, or at 12 s.
    if (stream.getAudioTracks().length) {
      ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
      const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      worklet = new AudioWorkletNode(ctx, 'retold-tap');
      src.connect(worklet);
      let buf = [], len = 0, quiet = 0, loud = 0;
      const flush = () => {
        if (loud < 16000 * 0.5) { buf = []; len = 0; loud = 0; quiet = 0; return; } // nothing said
        const samples = new Float32Array(len); let o = 0; for (const b of buf) { samples.set(b, o); o += b.length; }
        onAudio(toWav(samples), len / 16000);
        buf = []; len = 0; loud = 0; quiet = 0;
      };
      worklet.port.onmessage = (e) => {
        const chunk = e.data;
        let energy = 0; for (let i = 0; i < chunk.length; i++) energy += chunk[i] * chunk[i];
        const rms = Math.sqrt(energy / chunk.length);
        buf.push(chunk); len += chunk.length;
        if (rms > 0.01) { loud += chunk.length; quiet = 0; } else quiet += chunk.length;
        if ((quiet >= 16000 * 0.7 && loud > 0) || len >= 16000 * 12) flush();
        else if (quiet >= 16000 * 3 && !loud) { buf = []; len = 0; quiet = 0; } // drop long silence
      };
    }
    stream.getVideoTracks()[0].addEventListener('ended', stop);
  }

  function toWav(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
    return buf;
  }

  function stop() {
    clearInterval(timer); timer = 0;
    if (worklet) { try { worklet.disconnect(); } catch { /* gone */ } worklet = null; }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }

  return { start, stop };
})();
