/**
 * service-worker.js (MV3 background)
 *
 * Responsibilities
 *  - own the lifecycle of the offscreen document that does the real work
 *  - relay messages between content script / offscreen document
 *  - keep a tiny session record so the UI can render the current state
 *  - handle toolbar icon click (opens settings when needed, otherwise toggles dubbing)
 *
 * The actual audio capture, WebSocket streaming and playback all happen in the
 * offscreen document, because a service worker has no DOM / Web Audio.
 */

import { DEFAULT_SETTINGS } from '../shared/config.js';
import {
  action,
  commands,
  scripting,
  offscreen,
  hasNativeTabCapture,
  getMediaStreamId
} from '../shared/platform.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const OFFSCREEN_REASONS = ['USER_MEDIA', 'AUDIO_PLAYBACK'];
const OFFSCREEN_JUSTIFICATION =
  'Capture the audio of the active tab and play back the live dubbed audio returned by Gemini.';

/** @type {Promise<void> | null} */
let creatingOffscreen = null;

const state = {
  active: false,
  tabId: null,
  status: 'idle', // idle | connecting | live | reconnecting | error | stopping
  detail: '',
  error: '',
  startedAt: 0,
  stats: null
};

/* ------------------------------------------------------------------ state */

async function readState() {
  try {
    const { dubState } = await chrome.storage.session.get('dubState');
    if (dubState) Object.assign(state, dubState);
  } catch {
    /* storage.session is unavailable in some contexts — ignore */
  }
  return state;
}

async function writeState(patch = {}) {
  Object.assign(state, patch);
  try {
    await chrome.storage.session.set({ dubState: state });
  } catch {
    /* ignore */
  }
  return state;
}

function publicState() {
  return {
    active: state.active,
    tabId: state.tabId,
    status: state.status,
    detail: state.detail,
    error: state.error,
    startedAt: state.startedAt,
    stats: state.stats
  };
}

async function broadcastState() {
  const payload = { type: 'CS_STATE', state: publicState() };
  if (state.tabId != null) {
    chrome.tabs.sendMessage(state.tabId, payload).catch(() => {});
  }
}

async function broadcastToTab(message) {
  if (state.tabId == null) await readState();
  if (state.tabId == null) return;
  try {
    await chrome.tabs.sendMessage(state.tabId, message);
  } catch {
    /* content script may not be present — that is fine */
  }
}

/* -------------------------------------------------------------- offscreen */

/**
 * Whether the audio engine document is up.
 *
 * Tracked locally rather than with `runtime.getContexts`, which is Manifest V3
 * only and therefore unavailable in the Firefox build. If the worker is
 * evicted while the document stays alive, `createDocument` reports that a
 * document already exists — we treat that as success, and the retry loop in
 * `sendToOffscreen` covers any remaining timing gap.
 */
let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION
    })
    .then(() => {
      offscreenReady = true;
    })
    .catch((err) => {
      const message = String(err && err.message);
      if (message.includes('Only a single offscreen') || message.includes('already exists')) {
        offscreenReady = true;
        return;
      }
      console.warn('[avano] createDocument failed:', err);
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function sendToOffscreen(message, { retries = 25, delayMs = 80 } = {}) {
  await ensureOffscreen();
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error('offscreen unreachable');
}

async function closeOffscreen() {
  if (!offscreenReady) return;
  try {
    await offscreen.closeDocument();
  } catch {
    /* ignore */
  }
  offscreenReady = false;
}

/* ------------------------------------------------------------------ flows */

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CS_PING' });
    return;
  } catch {
    /* not injected yet */
  }
  try {
    await scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content.css']
    });
    await scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js']
    });
  } catch (err) {
    console.warn('[avano] could not inject content script:', err);
  }
}

async function handleStart(msg) {
  const { tabId, streamId } = msg;

  if (!msg.settings || !msg.settings.apiKey) {
    await writeState({
      active: false,
      status: 'error',
      error: 'کلید API تنظیم نشده است.'
    });
    await broadcastState();
    return { ok: false, error: 'NO_API_KEY' };
  }
  // Browsers without native tab capture (Firefox) do not hand us a stream id;
  // the audio engine asks the user to share the tab instead.
  if (!streamId && hasNativeTabCapture()) {
    await writeState({
      active: false,
      status: 'error',
      error: 'دسترسی به صدای تب داده نشد.'
    });
    await broadcastState();
    return { ok: false, error: 'NO_STREAM_ID' };
  }

  if (state.active && state.tabId !== tabId) {
    await stopSession('switching-tab');
  }

  resetTranscript();
  await writeState({
    active: true,
    tabId,
    status: 'connecting',
    detail: 'در حال اتصال به Gemini…',
    error: '',
    startedAt: Date.now(),
    stats: null
  });
  await broadcastState();
  await ensureContentScript(tabId);
  await broadcastToTab({ type: 'CS_ACTIVE', active: true });

  const settings = { ...DEFAULT_SETTINGS, ...msg.settings };
  let res;
  try {
    res = await sendToOffscreen({
      type: 'OFFSCREEN_START',
      streamId,
      tabId,
      settings
    });
  } catch (err) {
    res = { ok: false, error: 'موتور صوتی در دسترس نیست: ' + String(err && err.message) };
  }

  if (res && res.ok === false) {
    await writeState({
      active: false,
      status: 'error',
      error: res.error || 'شروع نشد.'
    });
    await broadcastState();
    await broadcastToTab({ type: 'CS_ACTIVE', active: false });
    return res;
  }
  return { ok: true };
}

async function stopSession(reason = 'user') {
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP', target: 'offscreen' });
  } catch {
    /* offscreen may be gone */
  }
  const tabId = state.tabId;
  await writeState({
    active: false,
    status: 'idle',
    detail: '',
    error: '',
    tabId: null,
    stats: null
  });
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'CS_ACTIVE', active: false });
    } catch {
      /* ignore */
    }
  }
  await broadcastState();
  await closeOffscreen();
  return { ok: true, reason };
}

async function pushSettingsToOffscreen(settings) {
  try {
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SETTINGS',
      target: 'offscreen',
      settings
    });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- transcript */

/**
 * Rolling transcript kept in memory only, so the popup can export the session
 * as a text file. Bounded by character count to keep the worker light.
 */
const transcript = { lines: [], chars: 0 };
const TRANSCRIPT_MAX_CHARS = 200000;

function appendTranscript(input, output) {
  if (!input && !output) return;
  transcript.lines.push({ t: Date.now(), input, output });
  transcript.chars += input.length + output.length;
  while (transcript.chars > TRANSCRIPT_MAX_CHARS && transcript.lines.length > 1) {
    const dropped = transcript.lines.shift();
    transcript.chars -= dropped.input.length + dropped.output.length;
  }
}

function resetTranscript() {
  transcript.lines = [];
  transcript.chars = 0;
}

function transcriptText() {
  const pad = (n) => String(n).padStart(2, '0');
  return transcript.lines
    .map((line) => {
      const d = new Date(line.t);
      const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const parts = [];
      if (line.input) parts.push(line.input.trim());
      if (line.output) parts.push(line.output.trim());
      return `[${stamp}] ${parts.join('\n          ')}`;
    })
    .join('\n');
}

/* --------------------------------------------------------------- routing */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.target === 'offscreen') return;

  switch (msg.type) {
    case 'START':
      handleStart(msg).then(sendResponse).catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message) })
      );
      return true;

    case 'STOP':
      stopSession('user').then(sendResponse);
      return true;

    case 'START_FROM_OVERLAY': {
      (async () => {
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: 'تب شناسایی نشد.' });
          return;
        }
        const { settings } = await chrome.storage.local.get('settings');
        const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
        if (!merged.apiKey) {
          sendResponse({ ok: false, error: 'کلید API تنظیم نشده است. تنظیمات را باز کنید.' });
          return;
        }
        let streamId = null;
        try {
          streamId = await getMediaStreamId(tabId);
        } catch (err) {
          const raw = String((err && err.message) || '');
          if (!raw.includes('BROWSER_CAPTURE_REQUIRED')) {
            sendResponse({ ok: false, error: 'NEED_TOOLBAR_CLICK', detail: raw });
            return;
          }
          // Firefox: no tab capture, so the engine asks for tab sharing.
        }
        const res = await handleStart({ tabId, streamId, settings: merged });
        sendResponse(res);
      })().catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message) })
      );
      return true;
    }

    case 'GET_STATE':
      readState().then(() => sendResponse({ ok: true, state: publicState() }));
      return true;

    case 'PRECONNECT': {
      (async () => {
        const { settings } = await chrome.storage.local.get('settings');
        const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
        if (!merged.apiKey && !merged.proxyUrl) {
          sendResponse({ ok: false, error: 'NO_API_KEY' });
          return;
        }
        if (!merged.prewarm) {
          sendResponse({ ok: true, skipped: 'disabled' });
          return;
        }
        if (state.active) {
          sendResponse({ ok: true, skipped: 'running' });
          return;
        }
        try {
          const res = await sendToOffscreen({
            type: 'OFFSCREEN_PRECONNECT',
            settings: merged
          });
          sendResponse(res || { ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message) });
        }
      })().catch(() => sendResponse({ ok: false }));
      return true;
    }

    case 'UPDATE_SETTINGS':
      pushSettingsToOffscreen(msg.settings);
      sendResponse({ ok: true });
      return true;

    case 'GET_TRANSCRIPT':
      sendResponse({ ok: true, text: transcriptText(), lines: transcript.lines.length });
      return true;

    case 'CLEAR_TRANSCRIPT':
      resetTranscript();
      sendResponse({ ok: true });
      return true;

    case 'CS_VIDEO_STATE':
      chrome.runtime
        .sendMessage({
          type: 'OFFSCREEN_VIDEO_STATE',
          target: 'offscreen',
          payload: msg.payload
        })
        .catch(() => {});
      return;

    case 'CS_REQUEST_STATE':
      readState().then(() => sendResponse({ ok: true, state: publicState() }));
      return true;

    case 'DUB_STATUS': {
      const patch = {
        status: msg.status,
        detail: msg.detail || '',
        error: msg.error || state.error
      };
      if (msg.status === 'live' && !state.startedAt) patch.startedAt = Date.now();
      writeState(patch).then(broadcastState);
      return;
    }

    case 'DUB_STATS':
      writeState({ stats: msg.stats }).then(broadcastState);
      return;

    case 'DUB_TRANSCRIPT':
      appendTranscript(msg.input || '', msg.output || '');
      broadcastToTab({
        type: 'CS_TRANSCRIPT',
        input: msg.input || '',
        output: msg.output || ''
      });
      return;

    case 'DUB_LEVELS': {
      const payload = { type: 'CS_LEVELS', levels: msg.levels || null };
      broadcastToTab(payload);
      return;
    }

    case 'DUB_FATAL':
      writeState({
        active: false,
        status: 'error',
        error: msg.error || 'خطای نامشخص',
        stats: null
      })
        .then(broadcastState)
        .then(() => broadcastToTab({ type: 'CS_ACTIVE', active: false }))
        .then(() => closeOffscreen());
      return;

    default:
      return;
  }
});

/* ------------------------------------------------------- start from a tab */

/**
 * Start dubbing the given tab, or stop it when that tab is already live.
 * Shared by the toolbar icon, the keyboard shortcut and the in-page overlay.
 */
async function toggleDubbingOnTab(tab) {
  await readState();
  if (!tab || tab.id == null) return { ok: false, error: 'NO_TAB' };

  if (state.active && state.tabId === tab.id) {
    return stopSession('user');
  }
  if (state.active && state.tabId !== tab.id) {
    await stopSession('switching-tab');
  }

  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  if (!merged.apiKey) {
    chrome.runtime.openOptionsPage();
    return { ok: false, error: 'NO_API_KEY' };
  }

  let streamId = null;
  if (hasNativeTabCapture()) {
    try {
      streamId = await getMediaStreamId(tab.id);
    } catch (err) {
      await ensureContentScript(tab.id);
      await writeState({
        active: false,
        status: 'error',
        error: 'اجازه‌ی ضبط صدا داده نشد. صفحه را رفرش کنید و دوباره تلاش کنید.'
      });
      await broadcastState();
      await broadcastToTab({ type: 'CS_ACTIVE', active: false });
      return { ok: false, error: 'NO_STREAM_ID' };
    }
  }

  return handleStart({ tabId: tab.id, streamId, settings: merged });
}

/* ------------------------------------------------------------- icon click */

/**
 * Fallback for builds where the toolbar popup is unavailable (for example if
 * `default_popup` is removed from the manifest). When the popup is present this
 * listener never fires, because the popup owns the click.
 */
if (action) {
  action.onClicked.addListener((tab) => {
    toggleDubbingOnTab(tab);
  });
}

/* ---------------------------------------------------------- shortcuts */

/**
 * Keyboard shortcuts. `_execute_action` / `_execute_browser_action` are handled
 * by the browser itself (they open the popup), so only the custom commands
 * arrive here.
 */
if (commands && commands.onCommand) {
  commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-dubbing') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await toggleDubbingOnTab(tab);
      return;
    }
    if (command === 'toggle-overlay') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'CS_TOGGLE_OVERLAY' }).catch(() => {});
      }
    }
  });
}

/* -------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(async () => {
  await readState();
  if (state.active) await writeState({ active: false, status: 'idle', tabId: null });
});

chrome.runtime.onStartup.addListener(() => {
  writeState({ active: false, status: 'idle', tabId: null, error: '' });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await readState();
  if (state.active && state.tabId === tabId) stopSession('tab-closed');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await readState();
  if (
    state.active &&
    state.tabId === tabId &&
    changeInfo.status === 'loading' &&
    changeInfo.url
  ) {
    stopSession('navigation');
  }
});

readState();
