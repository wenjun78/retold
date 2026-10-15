'use strict';
// Keeps the translation a minute ahead of the playhead. The video is cut into chunks; the
// chunk under the playhead and the ones after it are worked on in order, a couple at a
// time, until the required lead is covered. A seek simply moves the front; chunks already
// done are kept, so going back costs nothing and a chunk in flight is never thrown away.
const { EventEmitter } = require('events');

class Lookahead extends EventEmitter {
  // work(start, end, chunkIndex) -> Promise<result>; duration in seconds (0 = unknown, ask until work says it is past the end).
  constructor({ duration = 0, chunkSec = 20, aheadSec = 60, parallel = 2, work }) {
    super();
    this.duration = duration; this.chunkSec = chunkSec; this.aheadSec = aheadSec; this.parallel = parallel; this.work = work;
    this.done = new Map();      // chunk index -> result
    this.inflight = new Map();  // chunk index -> promise
    this.failed = new Map();    // chunk index -> error message
    this.playhead = 0; this.stopped = false; this.pastEnd = Infinity;
  }

  chunkOf(t) { return Math.max(0, Math.floor(t / this.chunkSec)); }
  lastChunk() {
    const end = this.duration ? Math.ceil(this.duration / this.chunkSec) - 1 : Infinity;
    return Math.min(end, this.pastEnd);
  }

  // Called as the video plays or after a seek.
  update(playhead) { this.playhead = Math.max(0, playhead); this._fill(); }

  // How many seconds past t are ready without a gap.
  readyFrom(t) {
    let i = this.chunkOf(t);
    if (!this.done.has(i)) return 0;
    while (this.done.has(i + 1)) i++;
    const end = Math.min((i + 1) * this.chunkSec, this.duration || Infinity);
    return Math.max(0, end - t);
  }

  _fill() {
    if (this.stopped) return;
    const first = this.chunkOf(this.playhead);
    const want = this.chunkOf(this.playhead + this.aheadSec);
    const last = this.lastChunk();
    for (let i = first; i <= Math.min(want, last) && this.inflight.size < this.parallel; i++) {
      if (this.done.has(i) || this.inflight.has(i) || this.failed.has(i)) continue;
      this._run(i);
    }
    this.emit('status', this.status());
  }

  _run(i) {
    const start = i * this.chunkSec;
    const end = this.duration ? Math.min(this.duration, start + this.chunkSec) : start + this.chunkSec;
    const p = Promise.resolve().then(() => this.work(start, end, i)).then((result) => {
      this.inflight.delete(i);
      if (this.stopped) return;
      if (result && result.pastEnd) { this.pastEnd = Math.min(this.pastEnd, i - 1); }
      else { this.done.set(i, result); this.emit('chunk', { index: i, start, end, result }); }
      this._fill();
    }, (err) => {
      this.inflight.delete(i);
      if (this.stopped) return;
      this.failed.set(i, err && err.message ? err.message : String(err));
      this.emit('error', { index: i, start, end, message: this.failed.get(i) });
      this._fill();
    });
    this.inflight.set(i, p);
  }

  // Forgets a failure so the chunk is tried again (after a key was fixed, say).
  retry() { this.failed.clear(); this._fill(); }

  status() {
    return { playhead: this.playhead, ready: this.readyFrom(this.playhead), done: this.done.size, inflight: [...this.inflight.keys()], failed: [...this.failed.values()] };
  }

  stop() { this.stopped = true; this.removeAllListeners(); }
}

module.exports = { Lookahead };
