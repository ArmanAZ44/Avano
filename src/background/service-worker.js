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

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION
    })
    .catch((err) => {
      if (!String(err && err.message).includes('Only a single offscreen')) {
        console.warn('[avano] createDocument failed:', err);
      }
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
  if (!(await offscreenExists())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    /* ignore */
  }
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
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['src/content/content.css']
    });
    await chrome.scripting.executeScript({
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
  if (!streamId) {
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
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        } catch (err) {
          sendResponse({
            ok: false,
            error: 'NEED_TOOLBAR_CLICK',
            detail: String(err && err.message)
          });
          return;
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

/* ------------------------------------------------------------- icon click */

chrome.action.onClicked.addListener(async (tab) => {
  await readState();
  if (!tab || tab.id == null) return;

  // If already active on this tab, stop.
  if (state.active && state.tabId === tab.id) {
    await stopSession('user');
    return;
  }

  // If active on a different tab, switch.
  if (state.active && state.tabId !== tab.id) {
    await stopSession('switching-tab');
  }

  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  if (!merged.apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (err) {
    await writeState({
      active: false,
      status: 'error',
      error: 'کروم اجازه نمی‌دهد. روی آیکون کلیک کنید و «ضبط این تب» را انتخاب کنید.'
    });
    await broadcastState();
    await ensureContentScript(tab.id);
    await broadcastToTab({ type: 'CS_ACTIVE', active: false });
    return;
  }

  await handleStart({ tabId: tab.id, streamId, settings: merged });
});

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
