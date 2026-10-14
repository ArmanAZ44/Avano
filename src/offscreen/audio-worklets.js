/**
 * audio-worklets.js — AudioWorklet processors used by the offscreen document.
 *
 *  "pcm-capture"  converts captured float samples into little-endian 16-bit PCM
 *                 frames and posts them to the main thread. If the AudioContext
 *                 sample rate is not the target rate it also resamples with
 *                 linear interpolation.
 *
 *  "pcm-playback" is a jitter-free ring of float buffers fed by the main thread
 *                 with the 24 kHz PCM returned by Gemini. It also:
 *                   - tracks how much audio is still queued (the "backlog"),
 *                   - trims the oldest audio when the backlog grows past a
 *                     ceiling, so the dub never drifts behind the video,
 *                   - cross-fades after a trim so the cut is inaudible.
 */

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameSize = opts.frameSize || 512;
    // `sampleRate` is a global provided by the AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate;
    this.needsResample = Math.abs(this.ratio - 1) > 1e-6;

    this.frame = new Float32Array(this.frameSize);
    this.n = 0;
    this.pos = 0;
  }

  _emit(sample) {
    this.frame[this.n++] = sample;
    if (this.n >= this.frameSize) this._flush();
  }

  _flush() {
    const pcm = new Int16Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i++) {
      let s = this.frame[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const a = input[0];
    const b = input.length > 1 ? input[1] : null;
    const len = a.length;

    if (!this.needsResample) {
      for (let i = 0; i < len; i++) {
        this._emit(b ? (a[i] + b[i]) * 0.5 : a[i]);
      }
      return true;
    }

    let pos = this.pos;
    while (pos < len) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const i1 = i0 + 1 < len ? i0 + 1 : len - 1;
      const s0 = b ? (a[i0] + b[i0]) * 0.5 : a[i0];
      const s1 = b ? (a[i1] + b[i1]) * 0.5 : a[i1];
      this._emit(s0 + (s1 - s0) * frac);
      pos += this.ratio;
    }
    this.pos = pos - len;
    return true;
  }
}

class PCMPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    /** Samples still waiting to be played (current buffer included). */
    this.queued = 0;
    /** 0 disables catch-up trimming. */
    this.maxBacklog = 0;
    /** Cross-fade state used right after a trim. */
    this.fade = 0;
    this.fadeLen = 0;
    this.fadeFrom = 0;
    this.reportIn = 1;
    this.trimmed = 0;

    this.port.onmessage = (event) => {
      const d = event.data;
      if (!d) return;

      if (d === 'flush') {
        this.queue.length = 0;
        this.offset = 0;
        this.queued = 0;
        this.fade = 0;
        return;
      }

      if (d.type === 'pcm' && d.buffer) {
        const f = new Float32Array(d.buffer);
        if (f.length) {
          this.queue.push(f);
          this.queued += f.length;
        }
        return;
      }

      if (d.type === 'config') {
        if (typeof d.maxBacklogMs === 'number') {
          this.maxBacklog =
            d.maxBacklogMs > 0
              ? Math.round((d.maxBacklogMs * sampleRate) / 1000)
              : 0;
        }
        return;
      }
    };
  }

  /** Drop whole head buffers until the backlog fits the budget. */
  _catchUp() {
    let droppedAny = false;
    while (this.queue.length > 1 && this.queued > this.maxBacklog) {
      const dropped = this.queue.shift();
      this.queued -= dropped.length - this.offset;
      this.offset = 0;
      droppedAny = true;
      // Remember the sample we cut on so we can fade back in smoothly.
      this.fadeFrom = dropped.length ? dropped[dropped.length - 1] : 0;
    }
    if (droppedAny) {
      const head = this.queue[0];
      const len = head ? Math.min(head.length, 128) : 0;
      this.fadeLen = len;
      this.fade = len;
      this.trimmed += 1;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const channel = output[0];

    if (this.maxBacklog > 0) this._catchUp();

    let outIndex = 0;
    while (outIndex < channel.length && this.queue.length > 0) {
      const current = this.queue[0];
      if (!current || current.length === 0) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }

      const copyLen = Math.min(channel.length - outIndex, current.length - this.offset);
      for (let i = 0; i < copyLen; i++) {
        let v = current[this.offset + i];
        if (this.fade > 0 && this.fadeLen > 0) {
          const t = 1 - this.fade / this.fadeLen;
          v = this.fadeFrom * (1 - t) + v * t;
          this.fade--;
        }
        channel[outIndex + i] = v;
      }
      outIndex += copyLen;
      this.offset += copyLen;
      this.queued -= copyLen;

      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    while (outIndex < channel.length) channel[outIndex++] = 0;

    // Mirror to any extra channels so a stereo output never goes half-silent.
    for (let c = 1; c < output.length; c++) output[c].set(channel);

    if (--this.reportIn <= 0) {
      this.reportIn = 24; // roughly every 128 ms of audio
      this.port.postMessage({
        type: 'backlog',
        ms: Math.round((this.queued / sampleRate) * 1000),
        trimmed: this.trimmed
      });
    }

    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
registerProcessor('pcm-playback', PCMPlaybackProcessor);
