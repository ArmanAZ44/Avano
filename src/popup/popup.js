/**
 * popup.js — the quick control surface.
 *
 * Kept deliberately small and friendly: one big Start/Stop button, a language
 * picker, a speed preset, two volume sliders, a subtitle toggle and a
 * transcript export. Everything else lives in the full settings page, reachable
 * through the gear in the header.
 *
 * The popup is also where `chrome.tabCapture.getMediaStreamId` is most
 * reliable, because clicking the toolbar icon counts as invoking the extension
 * on the active tab. On Firefox, where tab capture does not exist, we simply
 * let the audio engine ask for the tab through the share dialog.
 */

import { DEFAULT_SETTINGS, LANGUAGES, LATENCY_PROFILES } from '../shared/config.js';
import { getMediaStreamId } from '../shared/platform.js';

const $ = (id) => document.getElementById(id);

const toFa = (v) => String(v).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

const STATUS_TEXT = {
  idle: 'آماده',
  connecting: 'در حال اتصال…',
  live: 'دوبله فعال',
  reconnecting: 'اتصال مجدد…',
  error: 'خطا'
};

const ui = {
  dot: $('dot'),
  statusText: $('statusText'),
  latencyChip: $('latencyChip'),
  err: $('err'),
  hint: $('hint'),
  cta: $('cta'),
  stats: $('stats'),
  statLatency: $('statLatency'),
  statBacklog: $('statBacklog'),
  statReconnects: $('statReconnects'),
  modeSeg: $('modeSeg'),
  lang: $('lang'),
  profile: $('profile'),
  dubVol: $('dubVol'),
  dubVolVal: $('dubVolVal'),
  origVol: $('origVol'),
  origVolVal: $('origVolVal'),
  showSubtitles: $('showSubtitles'),
  exportSubs: $('exportSubs'),
  clearSubs: $('clearSubs'),
  subsNote: $('subsNote'),
  openOptions: $('openOptions')
};

let settings = { ...DEFAULT_SETTINGS };
let state = { active: false, status: 'idle', detail: '', error: '', stats: null };
let busy = false;

/* ------------------------------------------------------------------ render */

function render() {
  const status = state.active ? state.status : 'idle';
  ui.dot.className = `dot ${status}`;
  ui.statusText.textContent = state.detail || STATUS_TEXT[status] || status;
  document.body.classList.toggle('live', state.active && status === 'live');

  ui.cta.textContent = state.active ? 'توقف دوبله' : 'شروع دوبله';
  ui.cta.classList.toggle('stop', state.active);
  ui.cta.disabled = busy || (state.active && status === 'connecting');

  const showError = !!state.error && (!state.active || state.status === 'error');
  ui.err.hidden = !showError;
  if (showError) ui.err.textContent = state.error;

  const stats = state.stats || {};
  ui.latencyChip.textContent = stats.latencyMs
    ? `${toFa((stats.latencyMs / 1000).toFixed(1))}s`
    : '—';

  ui.stats.hidden = !state.active;
  if (state.active) {
    ui.statLatency.textContent = stats.latencyMs
      ? `${toFa((stats.latencyMs / 1000).toFixed(1))}s`
      : '—';
    ui.statBacklog.textContent = stats.backlogMs ? `${toFa(stats.backlogMs)}ms` : '—';
    ui.statReconnects.textContent = toFa(stats.reconnects || 0);
  }

  const mode = settings.mode === 'dub' ? 'dub' : 'translate';
  for (const btn of ui.modeSeg.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

function renderVolumes() {
  ui.dubVol.value = String(Math.round(settings.dubVolume * 100));
  ui.dubVolVal.textContent = `${toFa(ui.dubVol.value)}%`;
  ui.origVol.value = String(Math.round(settings.originalVolume * 100));
  ui.origVolVal.textContent = `${toFa(ui.origVol.value)}%`;
}

function fillLanguages() {
  ui.lang.innerHTML = '';
  const known = LANGUAGES.some((l) => l.code === settings.targetLanguage);
  const list = known
    ? LANGUAGES
    : [{ code: settings.targetLanguage, label: settings.targetLanguage }, ...LANGUAGES];
  for (const l of list) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.label;
    ui.lang.appendChild(o);
  }
  ui.lang.value = settings.targetLanguage;
}

function fillProfiles() {
  ui.profile.innerHTML = '';
  for (const [key, p] of Object.entries(LATENCY_PROFILES)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = p.label;
    ui.profile.appendChild(o);
  }
  ui.profile.value = LATENCY_PROFILES[settings.latencyProfile]
    ? settings.latencyProfile
    : 'low';
}

function flashNote(text) {
  ui.subsNote.textContent = text;
  ui.subsNote.classList.add('show');
  setTimeout(() => ui.subsNote.classList.remove('show'), 2000);
}

/* ---------------------------------------------------------------- storage */

async function persist(patch) {
  settings = { ...settings, ...patch };
  try {
    const { settings: stored } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(stored || {}), ...patch } });
  } catch { /* ignore */ }
  try {
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: patch });
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------------- actions */

function showHint(text) {
  ui.hint.hidden = !text;
  if (text) ui.hint.textContent = text;
}

async function start() {
  if (busy) return;
  busy = true;
  render();
  showHint('');

  try {
    if (!settings.apiKey) {
      throw new Error('کلید API تنظیم نشده است. با دکمه‌ی چرخ‌دنده آن را وارد کنید.');
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error('تب فعال پیدا نشد.');
    if (!/^https?:/.test(tab.url || '')) {
      throw new Error('این افزونه فقط روی صفحات وب (http/https) کار می‌کند.');
    }

    // Native tab capture hands us a stream id. Browsers without it fall through
    // with `null`, and the audio engine asks the user to share the tab instead.
    let streamId = null;
    try {
      streamId = await getMediaStreamId(tab.id);
    } catch (err) {
      const raw = String((err && err.message) || '');
      if (raw.includes('BROWSER_CAPTURE_REQUIRED')) {
        streamId = null;
        showHint(
          'در پنجره‌ی بعدی این تب را انتخاب کنید و گزینه‌ی «اشتراک صدای تب» را هم تیک بزنید.'
        );
      } else {
        throw new Error('دسترسی به صدای تب داده نشد. صفحه را رفرش کنید و دوباره تلاش کنید.');
      }
    }

    const res = await chrome.runtime.sendMessage({
      type: 'START',
      tabId: tab.id,
      streamId,
      settings
    });

    if (res && res.ok === false) {
      throw new Error(res.error || 'شروع نشد.');
    }
  } catch (err) {
    state.error = String((err && err.message) || err);
    state.active = false;
    state.status = 'error';
  } finally {
    busy = false;
    render();
  }
}

async function stop() {
  if (busy) return;
  busy = true;
  render();
  try {
    await chrome.runtime.sendMessage({ type: 'STOP' });
  } catch { /* ignore */ }
  busy = false;
  state.active = false;
  state.status = 'idle';
  state.error = '';
  render();
}

async function exportTranscript() {
  ui.exportSubs.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPT' });
    if (!res || !res.ok || !res.text) {
      flashNote('زیرنویسی ثبت نشده');
      return;
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `avano-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
      d.getHours()
    )}${pad(d.getMinutes())}.txt`;

    const blob = new Blob([res.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    flashNote('ذخیره شد');
  } catch {
    flashNote('ذخیره نشد');
  } finally {
    ui.exportSubs.disabled = false;
  }
}

/* ------------------------------------------------------------------ wiring */

ui.cta.addEventListener('click', () => (state.active ? stop() : start()));

ui.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

ui.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  persist({ mode: btn.dataset.mode });
  render();
});

ui.lang.addEventListener('change', () => {
  persist({ targetLanguage: ui.lang.value });
});

ui.profile.addEventListener('change', () => {
  const preset = LATENCY_PROFILES[ui.profile.value];
  if (!preset) return;
  persist({ latencyProfile: ui.profile.value, ...preset.values });
  flashNote(preset.label);
});

ui.dubVol.addEventListener('input', () => {
  ui.dubVolVal.textContent = `${toFa(ui.dubVol.value)}%`;
});
ui.dubVol.addEventListener('change', () => {
  persist({ dubVolume: Number(ui.dubVol.value) / 100 });
});

ui.origVol.addEventListener('input', () => {
  ui.origVolVal.textContent = `${toFa(ui.origVol.value)}%`;
});
ui.origVol.addEventListener('change', () => {
  persist({ originalVolume: Number(ui.origVol.value) / 100 });
});

ui.showSubtitles.addEventListener('change', () => {
  persist({ showSubtitles: ui.showSubtitles.checked });
});

ui.exportSubs.addEventListener('click', exportTranscript);

ui.clearSubs.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_TRANSCRIPT' });
  } catch { /* ignore */ }
  flashNote('پاک شد');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target === 'offscreen') return;
  if (msg.type === 'CS_STATE' && msg.state) {
    state = {
      active: !!msg.state.active,
      status: msg.state.status || 'idle',
      detail: msg.state.detail || '',
      error: msg.state.error || '',
      stats: msg.state.stats || null
    };
    render();
  }
});

/* -------------------------------------------------------------------- boot */

(async () => {
  try {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  } catch { /* ignore */ }

  fillLanguages();
  fillProfiles();
  renderVolumes();
  ui.showSubtitles.checked = !!settings.showSubtitles;
  render();

  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res && res.ok) {
      state = {
        active: !!res.state.active,
        status: res.state.status || 'idle',
        detail: res.state.detail || '',
        error: res.state.error || '',
        stats: res.state.stats || null
      };
      render();
    }
  } catch { /* ignore */ }

  // Warm the Gemini socket while the popup is open (skipped when disabled).
  chrome.runtime.sendMessage({ type: 'PRECONNECT' }).catch(() => {});
})();
