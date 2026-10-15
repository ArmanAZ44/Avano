/**
 * offscreen.js — the real audio engine.
 *
 * Pipeline
 * ────────
 *   chrome tab audio ──▶ MediaStream ──▶ [ctxMain]  ──▶ origGain ──▶ destination
 *                                            │                    (original bed, user controlled)
 *                                            └──▶ [ctxCapture 16k] ──▶ PCM 16-bit ──▶ WebSocket
 *                                                                                     │
 *   Gemini 24 kHz PCM ◀── WebSocket ◀── [ctxPlayback 24k] ◀── pcm-playback worklet ◀─┘
 *                                            └──▶ dubGain ──▶ limiter ──▶ destination
 *
 * Because `chrome.tabCapture` redirects the tab's audio into the captured
 * MediaStream, the page itself goes silent; the only thing the user hears is
 * whatever we route to `destination`. That is exactly what a dub needs.
 *
 * Latency notes
 * ─────────────
 *  - capture frames are small (default 512 samples = 32 ms) and forwarded the
 *    instant they are produced, so input buffering stays minimal;
 *  - the playback worklet starts playing the very first chunk immediately
 *    (no artificial pre-buffer) and trims the queue if the backlog ever grows
 *    past `maxBacklogMs`, so the dub never drifts behind the video;
 *  - a warm WebSocket can be established before the user presses Start, which
 *    removes the handshake from the perceived start-up time.
 */

import {
  DEFAULT_SETTINGS,
  buildSetupMessage,
  buildWsUrl,
  sessionSignature
} from '../shared/config.js';

const CAPTURE_RATE = 16000;
const PLAYBACK_RATE = 24000;
const DEFAULT_CAPTURE_FRAME = 512;

const WS_OPEN = 1;
const MAX_RECONNECT_DELAY = 8000;
const WARM_TTL_MS = 120000;

/** Raw capture errors translated into something a normal user can act on. */
const FRIENDLY_ERRORS = {
  CAPTURE_UNSUPPORTED:
    'این مرورگر ضبط صدا را پشتیبانی نمی‌کند. از Chrome، Edge، Brave یا Opera استفاده کنید.',
  NO_AUDIO_TRACK:
    'صدایی از تب انتخاب‌شده دریافت نشد. در پنجره‌ی اشتراک‌گذاری، گزینه‌ی «اشتراک صدای تب» را هم تیک بزنید.',
  'Permission denied':
    'اجازه‌ی اشتراک‌گذاری داده نشد. صفحه را رفرش کنید و دوباره تلاش کنید.',
  'Permission dismissed':
    'پنجره‌ی اشتراک‌گذاری بسته شد. دوباره تلاش کنید و این بار تب را انتخاب کنید.'
};

/* ------------------------------------------------------------------ utils */

function bytesToBase64(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pcm16ToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function rmsInt16(buffer) {
  const view = new Int16Array(buffer);
  if (!view.length) return 0;
  let sum = 0;
  for (let i = 0; i < view.length; i++) {
    const v = view[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / view.length);
}

function rmsFloat32(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / arr.length);
}

/* ----------------------------------------------------------------- state */

const S = {
  running: false,
  warm: false,
  settings: { ...DEFAULT_SETTINGS },
  tabId: null,

  mediaStream: null,
  captureSource: null,
  ctxMain: null,
  ctxCapture: null,
  ctxPlayback: null,
  captureNode: null,
  captureSink: null,
  playbackNode: null,
  origGain: null,
  dubGain: null,
  limiter: null,
  captureFrame: DEFAULT_CAPTURE_FRAME,

  ws: null,
  wsOpen: false,
  wsSignature: '',
  intentionalClose: false,
  pendingReconnect: false,
  reconnectTimer: null,
  warmTimer: null,
  reconnectAttempts: 0,
  resumeHandle: null,
  lastServerError: '',

  videoPlaying: true,
  lastInterruptAt: 0,

  inputLevel: 0,
  outputLevel: 0,
  backlogMs: 0,
  trimmed: 0,

  stats: {
    startedAt: 0,
    bytesSent: 0,
    audioIn: 0,
    audioOut: 0,
    reconnects: 0,
    latencyMs: 0,
    backlogMs: 0
  },
  lastInputAt: 0,
  lastOutputAt: 0,

  transcript: { input: '', output: '' },
  transcriptTimer: null,
  statsTimer: null,
  levelTimer: null
};

/* --------------------------------------------------------------- reporting */

function report(status, detail = '', error = '') {
  chrome.runtime
    .sendMessage({ type: 'DUB_STATUS', status, detail, error })
    .catch(() => {});
}

function reportFatal(error) {
  console.error('[dub] fatal:', error);
  chrome.runtime.sendMessage({ type: 'DUB_FATAL', error: String(error) }).catch(() => {});
}

function scheduleTranscriptFlush() {
  if (S.transcriptTimer) return;
  S.transcriptTimer = setTimeout(() => {
    S.transcriptTimer = null;
    const { input, output } = S.transcript;
    if (!input && !output) return;
    S.transcript.input = '';
    S.transcript.output = '';
    chrome.runtime
      .sendMessage({ type: 'DUB_TRANSCRIPT', input, output })
      .catch(() => {});
  }, 120);
}

function startStatsTimer() {
  stopStatsTimer();
  S.statsTimer = setInterval(() => {
    S.stats.backlogMs = S.backlogMs;
    chrome.runtime
      .sendMessage({ type: 'DUB_STATS', stats: { ...S.stats } })
      .catch(() => {});
  }, 2000);
}

function stopStatsTimer() {
  if (S.statsTimer) clearInterval(S.statsTimer);
  S.statsTimer = null;
}

/**
 * A dedicated, lightweight level feed so the UI can render a responsive
 * VU meter without waiting for the 2 s stats tick.
 */
function startLevelTimer() {
  stopLevelTimer();
  S.levelTimer = setInterval(() => {
    chrome.runtime
      .sendMessage({
        type: 'DUB_LEVELS',
        levels: {
          input: Math.min(1, S.inputLevel),
          output: Math.min(1, S.outputLevel),
          backlogMs: S.backlogMs,
          trimmed: S.trimmed
        }
      })
      .catch(() => {});
    // Peak-hold decay so the bars fall back smoothly.
    S.inputLevel *= 0.55;
    S.outputLevel *= 0.55;
  }, 110);
}

function stopLevelTimer() {
  if (S.levelTimer) clearInterval(S.levelTimer);
  S.levelTimer = null;
}

/* ------------------------------------------------------------ audio graph */

function makeLimiter(ctx, enabled) {
  const limiter = ctx.createDynamicsCompressor();
  if (enabled) {
    limiter.threshold.value = -3;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
  } else {
    limiter.threshold.value = 0;
    limiter.knee.value = 0;
    limiter.ratio.value = 1;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
  }
  return limiter;
}

async function buildCaptureChain() {
  const frame = Number(S.settings.captureFrame) || DEFAULT_CAPTURE_FRAME;
  S.captureFrame = frame;

  S.ctxCapture = new AudioContext({ sampleRate: CAPTURE_RATE });
  await S.ctxCapture.audioWorklet.addModule(
    chrome.runtime.getURL('src/offscreen/audio-worklets.js')
  );

  S.captureSource = S.ctxCapture.createMediaStreamSource(S.mediaStream);
  S.captureNode = new AudioWorkletNode(S.ctxCapture, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: CAPTURE_RATE, frameSize: frame }
  });
  S.captureNode.port.onmessage = (event) => {
    const data = event.data;
    if (!data || data.type !== 'pcm') return;
    S.inputLevel = Math.max(S.inputLevel, rmsInt16(data.buffer));
    sendAudioChunk(data.buffer);
  };
  S.captureSource.connect(S.captureNode);

  // A worklet node whose output is not part of the render graph may not be
  // pulled by Chrome, so we terminate it into a muted gain node.
  S.captureSink = S.ctxCapture.createGain();
  S.captureSink.gain.value = 0;
  S.captureNode.connect(S.captureSink);
  S.captureSink.connect(S.ctxCapture.destination);

  await S.ctxCapture.resume().catch(() => {});
}

function destroyCaptureChain() {
  try {
    if (S.captureNode) {
      S.captureNode.port.onmessage = null;
      S.captureNode.disconnect();
    }
  } catch { /* ignore */ }
  try {
    if (S.captureSource) S.captureSource.disconnect();
  } catch { /* ignore */ }
  try {
    if (S.captureSink) S.captureSink.disconnect();
  } catch { /* ignore */ }
  if (S.ctxCapture) {
    S.ctxCapture.close().catch(() => {});
  }
  S.captureNode = null;
  S.captureSource = null;
  S.captureSink = null;
  S.ctxCapture = null;
}

/** Rebuild only the capture side (used when the frame size changes live). */
async function rebuildCaptureChain() {
  if (!S.mediaStream) return;
  destroyCaptureChain();
  try {
    await buildCaptureChain();
  } catch (err) {
    console.warn('[dub] capture rebuild failed:', err);
  }
}

async function buildPlaybackChain() {
  S.ctxPlayback = new AudioContext({ sampleRate: PLAYBACK_RATE });
  await S.ctxPlayback.audioWorklet.addModule(
    chrome.runtime.getURL('src/offscreen/audio-worklets.js')
  );

  S.playbackNode = new AudioWorkletNode(S.ctxPlayback, 'pcm-playback', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  S.playbackNode.port.onmessage = (event) => {
    const d = event.data;
    if (d && d.type === 'backlog') {
      S.backlogMs = d.ms || 0;
      S.trimmed = d.trimmed || 0;
    }
  };
  S.playbackNode.port.postMessage({
    type: 'config',
    maxBacklogMs: Number(S.settings.maxBacklogMs) || 0
  });

  S.dubGain = S.ctxPlayback.createGain();
  S.dubGain.gain.value = Number(S.settings.dubVolume);

  S.limiter = makeLimiter(S.ctxPlayback, !!S.settings.softLimiter);

  S.playbackNode.connect(S.dubGain);
  S.dubGain.connect(S.limiter);
  S.limiter.connect(S.ctxPlayback.destination);

  await S.ctxPlayback.resume().catch(() => {});
}

/**
 * Obtain the audio stream to dub.
 *
 * Chromium exposes `chrome.tabCapture.getMediaStreamId`, which we consume with
 * a `chromeMediaSource: 'tab'` constraint. Browsers without native tab capture
 * (Firefox) fall back to `getDisplayMedia`, where the user picks the tab in the
 * share dialog and has to tick "Share audio". The fallback also kicks in if a
 * tab-constrained capture is rejected for any reason.
 */
async function acquireStream(streamId) {
  if (streamId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });
    } catch (err) {
      console.warn('[avano] tab capture failed, falling back to display capture:', err);
    }
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('CAPTURE_UNSUPPORTED');
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('NO_AUDIO_TRACK');
  }
  return stream;
}

async function buildGraph(streamId) {
  S.mediaStream = await acquireStream(streamId);

  // 1) original-audio bed, at the native rate so it keeps full quality
  S.ctxMain = new AudioContext();
  const srcMain = S.ctxMain.createMediaStreamSource(S.mediaStream);
  S.origGain = S.ctxMain.createGain();
  S.origGain.gain.value = Number(S.settings.originalVolume) || 0;
  srcMain.connect(S.origGain);
  S.origGain.connect(S.ctxMain.destination);

  // 2) capture chain (16 kHz, small frames)
  await buildCaptureChain();

  // 3) playback chain (24 kHz, exactly what Gemini returns)
  await buildPlaybackChain();

  await S.ctxMain.resume().catch(() => {});
}

function teardownGraph() {
  destroyCaptureChain();

  try {
    if (S.playbackNode) {
      S.playbackNode.port.onmessage = null;
      S.playbackNode.disconnect();
    }
  } catch { /* ignore */ }
  try {
    if (S.dubGain) S.dubGain.disconnect();
  } catch { /* ignore */ }
  try {
    if (S.limiter) S.limiter.disconnect();
  } catch { /* ignore */ }
  try {
    if (S.origGain) S.origGain.disconnect();
  } catch { /* ignore */ }

  S.playbackNode = null;
  S.dubGain = null;
  S.limiter = null;
  S.origGain = null;

  for (const key of ['ctxMain', 'ctxPlayback']) {
    const ctx = S[key];
    if (ctx) {
      ctx.close().catch(() => {});
      S[key] = null;
    }
  }

  if (S.mediaStream) {
    S.mediaStream.getTracks().forEach((t) => t.stop());
    S.mediaStream = null;
  }
}

async function teardownAudio() {
  stopStatsTimer();
  stopLevelTimer();
  teardownGraph();
  if (S.transcriptTimer) {
    clearTimeout(S.transcriptTimer);
    S.transcriptTimer = null;
  }
  S.transcript = { input: '', output: '' };
  S.inputLevel = 0;
  S.outputLevel = 0;
  S.backlogMs = 0;
}

function flushPlayback() {
  if (S.playbackNode) S.playbackNode.port.postMessage('flush');
  S.backlogMs = 0;
}

function applySettings(settings) {
  const prev = S.settings;
  S.settings = { ...S.settings, ...settings };

  if (S.origGain) {
    S.origGain.gain.value = Number(S.settings.originalVolume) || 0;
  }
  if (S.dubGain) {
    S.dubGain.gain.value = Number(S.settings.dubVolume);
  }
  if (S.limiter && S.ctxPlayback) {
    const next = makeLimiter(S.ctxPlayback, !!S.settings.softLimiter);
    S.limiter.threshold.value = next.threshold.value;
    S.limiter.knee.value = next.knee.value;
    S.limiter.ratio.value = next.ratio.value;
    S.limiter.attack.value = next.attack.value;
    S.limiter.release.value = next.release.value;
  }
  if (S.playbackNode && Number(prev.maxBacklogMs) !== Number(S.settings.maxBacklogMs)) {
    S.playbackNode.port.postMessage({
      type: 'config',
      maxBacklogMs: Number(S.settings.maxBacklogMs) || 0
    });
  }
  if (
    S.running &&
    S.mediaStream &&
    Number(prev.captureFrame) !== Number(S.settings.captureFrame)
  ) {
    rebuildCaptureChain();
  }
}

/* ------------------------------------------------------------- websocket */

function closeSocket() {
  clearTimeout(S.warmTimer);
  S.warmTimer = null;
  if (S.ws) {
    S.ws.onopen = null;
    S.ws.onmessage = null;
    S.ws.onerror = null;
    S.ws.onclose = null;
    try {
      S.ws.close(1000, 'client stop');
    } catch { /* ignore */ }
  }
  S.ws = null;
  S.wsOpen = false;
  S.wsSignature = '';
}

function connect() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const url = buildWsUrl(S.settings);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(new Error('آدرس WebSocket نامعتبر است: ' + err.message));
      return;
    }
    ws.binaryType = 'arraybuffer';
    S.ws = ws;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    ws.onopen = () => {
      S.wsOpen = true;
      S.reconnectAttempts = 0;
      try {
        ws.send(JSON.stringify(buildSetupMessage(S.settings, S.resumeHandle)));
      } catch (err) {
        fail(err);
        return;
      }
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    ws.onmessage = async (event) => {
      let text;
      try {
        if (event.data instanceof Blob) text = await event.data.text();
        else if (event.data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(event.data);
        } else text = String(event.data);
      } catch {
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      handleServerMessage(msg);
    };

    ws.onerror = () => {
      fail(new Error('اتصال WebSocket برقرار نشد.'));
    };

    ws.onclose = (event) => {
      S.wsOpen = false;
      if (S.ws === ws) S.ws = null;
      if (!settled) {
        fail(new Error(describeClose(event)));
        return;
      }
      handleSocketClosed(event);
    };
  });
}

function describeClose(event) {
  const code = event && event.code;
  const reason = (event && event.reason) || '';
  if (S.lastServerError) return S.lastServerError;
  if (code === 1000 || code === 1005 || code === 1006) {
    return `اتصال بسته شد (${code}). ${reason}`.trim();
  }
  return `اتصال بسته شد (${code}) ${reason}`.trim();
}

function handleSocketClosed(event) {
  if (S.intentionalClose) return;
  if (S.warm && !S.running) {
    // A pre-warmed socket that went stale is simply discarded; Start will
    // open a fresh one.
    S.warm = false;
    return;
  }
  if (!S.running || S.pendingReconnect) return;

  const reason = describeClose(event);
  S.pendingReconnect = true;
  const delay = Math.min(500 * Math.pow(2, S.reconnectAttempts), MAX_RECONNECT_DELAY);
  S.reconnectAttempts += 1;

  report(
    'reconnecting',
    `اتصال قطع شد؛ تلاش مجدد در ${(delay / 1000).toFixed(1)} ثانیه…`,
    reason
  );

  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(async () => {
    S.pendingReconnect = false;
    if (!S.running) return;
    flushPlayback();
    try {
      await connect();
      S.wsSignature = sessionSignature(S.settings);
      S.stats.reconnects += 1;
      report('live', 'دوبله فعال است (اتصال دوباره برقرار شد).');
    } catch (err) {
      handleSocketClosed({ code: 1006, reason: String(err && err.message) });
    }
  }, delay);
}

function handleServerMessage(msg) {
  if (msg.setupComplete) {
    report('live', 'دوبله فعال است.');
    return;
  }

  if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) {
    S.resumeHandle = msg.sessionResumptionUpdate.newHandle;
  }

  if (msg.goAway) {
    report('reconnecting', 'سرور در حال بستن نشست است؛ اتصال تازه گرفته می‌شود…');
    try {
      S.ws && S.ws.close();
    } catch { /* ignore */ }
    return;
  }

  if (msg.error) {
    const err = msg.error;
    S.lastServerError = `${err.status || err.code || 'ERROR'}: ${err.message || ''}`;
    report('error', '', S.lastServerError);
    return;
  }

  const sc = msg.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    S.lastInterruptAt = Date.now();
    flushPlayback();
  }

  const parts = sc.modelTurn && sc.modelTurn.parts;
  if (parts && parts.length) {
    for (const part of parts) {
      const inline = part.inlineData;
      if (inline && inline.data && S.playbackNode) {
        const floats = pcm16ToFloat32(base64ToBytes(inline.data));
        if (floats.length) {
          S.playbackNode.port.postMessage(
            { type: 'pcm', buffer: floats.buffer },
            [floats.buffer]
          );
          S.stats.audioOut += floats.length;
          S.outputLevel = Math.max(S.outputLevel, rmsFloat32(floats));

          // Rough end-to-end latency: measured at the start of each utterance.
          const now = Date.now();
          if (!S.lastOutputAt || now - S.lastOutputAt > 400) {
            if (S.lastInputAt) S.stats.latencyMs = Math.max(0, now - S.lastInputAt);
          }
          S.lastOutputAt = now;
        }
      }
    }
  }

  if (sc.inputTranscription && sc.inputTranscription.text) {
    S.transcript.input += sc.inputTranscription.text;
    if (sc.inputTranscription.finished) S.transcript.input += '\n';
    scheduleTranscriptFlush();
  }

  if (sc.outputTranscription && sc.outputTranscription.text) {
    S.transcript.output += sc.outputTranscription.text;
    if (sc.outputTranscription.finished) S.transcript.output += '\n';
    scheduleTranscriptFlush();
  }

  if (sc.turnComplete) scheduleTranscriptFlush();
}

function sendAudioChunk(arrayBuffer) {
  if (!S.ws || !S.wsOpen || S.ws.readyState !== WS_OPEN) return;
  if (!S.running) return;

  const bytes = new Uint8Array(arrayBuffer);
  try {
    S.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${CAPTURE_RATE}`,
            data: bytesToBase64(bytes)
          }
        }
      })
    );
    S.stats.bytesSent += bytes.length;
    S.stats.audioIn += bytes.length >> 1;
    S.lastInputAt = Date.now();
  } catch (err) {
    console.warn('[dub] send failed', err);
  }
}

/* ------------------------------------------------------------- lifecycle */

/**
 * Open the Gemini socket ahead of time so pressing Start skips the handshake.
 * Safe to call repeatedly; it is a no-op when a matching socket is open.
 */
async function preconnect(settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  if (!next.apiKey && !next.proxyUrl) return { ok: false, error: 'NO_API_KEY' };

  const sig = sessionSignature(next);
  if (S.ws && S.ws.readyState === WS_OPEN && S.wsSignature === sig) {
    return { ok: true, reused: true };
  }
  if (S.running) return { ok: true, skipped: 'running' };

  closeSocket();
  S.settings = next;
  S.warm = true;
  S.intentionalClose = false;
  S.pendingReconnect = false;
  S.resumeHandle = null;
  S.lastServerError = '';

  try {
    await connect();
    S.wsSignature = sig;
    clearTimeout(S.warmTimer);
    S.warmTimer = setTimeout(() => {
      if (S.warm && !S.running) {
        S.warm = false;
        closeSocket();
      }
    }, WARM_TTL_MS);
    return { ok: true, warmed: true };
  } catch (err) {
    S.warm = false;
    return { ok: false, error: String(err && err.message) };
  }
}

async function start(streamId, tabId, settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  const sig = sessionSignature(next);
  const reusable = !!(S.ws && S.ws.readyState === WS_OPEN && S.wsSignature === sig);

  await teardownAudio();

  S.settings = next;
  S.tabId = tabId;
  S.running = true;
  S.warm = false;
  S.intentionalClose = false;
  S.pendingReconnect = false;
  S.lastServerError = '';
  clearTimeout(S.warmTimer);
  S.warmTimer = null;
  if (!reusable) S.resumeHandle = null;

  S.stats = {
    startedAt: Date.now(),
    bytesSent: 0,
    audioIn: 0,
    audioOut: 0,
    reconnects: 0,
    latencyMs: 0,
    backlogMs: 0
  };

  try {
    report('connecting', 'در حال دسترسی به صدای تب…');
    await buildGraph(streamId);

    if (!reusable) {
      closeSocket();
      S.intentionalClose = false;
      report('connecting', 'در حال اتصال به Gemini Live…');
      await connect();
      S.wsSignature = sig;
    } else {
      report('live', 'دوبله فعال است.');
    }

    startStatsTimer();
    startLevelTimer();
    return { ok: true, reused: reusable };
  } catch (err) {
    const raw = err && err.message ? err.message : String(err);
    const message = FRIENDLY_ERRORS[raw] || raw;
    await stop({ silent: true });
    reportFatal(message);
    return { ok: false, error: message };
  }
}

async function stop({ silent = false } = {}) {
  S.running = false;
  S.warm = false;
  S.intentionalClose = true;
  S.pendingReconnect = false;
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = null;
  clearTimeout(S.warmTimer);
  S.warmTimer = null;

  await teardownAudio();
  closeSocket();

  if (!silent) report('idle', '');
  return { ok: true };
}

/* ---------------------------------------------------------------- wiring */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'OFFSCREEN_START':
      start(msg.streamId, msg.tabId, msg.settings).then(sendResponse);
      return true;

    case 'OFFSCREEN_PRECONNECT':
      preconnect(msg.settings).then(sendResponse);
      return true;

    case 'OFFSCREEN_STOP':
      stop().then(sendResponse);
      return true;

    case 'OFFSCREEN_SETTINGS': {
      const prevSig = sessionSignature(S.settings);
      applySettings(msg.settings);
      const nextSig = sessionSignature(S.settings);
      if (S.running && prevSig !== nextSig) {
        report('reconnecting', 'اعمال تنظیمات جدید…');
        try {
          S.ws && S.ws.close();
        } catch { /* ignore */ }
      } else if (!S.running && S.ws && nextSig !== S.wsSignature) {
        // A warm socket no longer matches the settings — drop it.
        closeSocket();
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'OFFSCREEN_VIDEO_STATE': {
      const p = msg.payload || {};
      S.videoPlaying = !!p.playing;
      if (p.seeking) flushPlayback();
      if (!p.playing) {
        // Let the last sentence finish, then drop anything still queued.
        setTimeout(() => {
          if (!S.videoPlaying) flushPlayback();
        }, 2000);
      }
      sendResponse({ ok: true });
      return true;
    }

    default:
      return;
  }
});
