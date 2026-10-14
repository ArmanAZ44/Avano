import {
  DEFAULT_SETTINGS,
  LATENCY_PROFILES,
  LANGUAGES,
  VOICES,
  MODE_MODELS,
  SENSITIVITY,
  END_SENSITIVITY,
  ACTIVITY_HANDLING,
  buildSetupMessage,
  buildWsUrl,
  resolveModel
} from '../shared/config.js';

const $ = (id) => document.getElementById(id);

/** Plain text / select fields copied straight through. */
const TEXT_FIELDS = [
  'apiKey',
  'mode',
  'model',
  'dubModel',
  'targetLanguage',
  'voice',
  'proxyUrl',
  'systemInstructionOverride'
];

/** Select fields whose value is numeric. */
const NUMBER_SELECTS = ['captureFrame'];

const NUMBER_FIELDS = ['silenceMs', 'prefixMs', 'maxBacklogMs'];

const CHECK_FIELDS = [
  'showSubtitles',
  'showOriginalTranscript',
  'longSessionMode',
  'softLimiter',
  'prewarm'
];

const ENUM_SELECTS = ['startSensitivity', 'endSensitivity', 'activityHandling'];

const RANGES = [
  { id: 'temperature', scale: 100, def: DEFAULT_SETTINGS.temperature },
  { id: 'originalVolume', scale: 100, def: DEFAULT_SETTINGS.originalVolume },
  { id: 'dubVolume', scale: 100, def: DEFAULT_SETTINGS.dubVolume }
];

let settings = { ...DEFAULT_SETTINGS };

/* ------------------------------------------------------------------ setup */

function fillStaticOptions() {
  const lang = $('targetLanguage');
  for (const l of LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.label;
    lang.appendChild(o);
  }

  const voice = $('voice');
  for (const v of VOICES) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v === 'auto' ? 'خودکار (انتخاب مدل)' : v;
    voice.appendChild(o);
  }

  const profile = $('latencyProfile');
  for (const [key, p] of Object.entries(LATENCY_PROFILES)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = p.label;
    profile.appendChild(o);
  }

  const addOptions = (el, values, labels) => {
    values.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labels ? labels[i] : v;
      el.appendChild(o);
    });
  };

  addOptions($('startSensitivity'), SENSITIVITY, [
    'پیش‌فرض',
    'کم — فقط گفتار واضح',
    'زیاد — حساس به صدای کم'
  ]);
  addOptions($('endSensitivity'), END_SENSITIVITY, [
    'پیش‌فرض',
    'کم — صبر بیشتر',
    'زیاد — پایان سریع جمله'
  ]);
  addOptions($('activityHandling'), ACTIVITY_HANDLING, [
    'بدون قطع — مناسب دوبله',
    'قطع با شروع گفتار جدید',
    'پیش‌فرض'
  ]);

  const tl = $('translateModels');
  for (const m of MODE_MODELS.translate) {
    const o = document.createElement('option');
    o.value = m;
    tl.appendChild(o);
  }
  const dl = $('dubModels');
  for (const m of MODE_MODELS.dub) {
    const o = document.createElement('option');
    o.value = m;
    dl.appendChild(o);
  }
}

function updateRangeLabel(id) {
  const el = $(id);
  const out = $(`${id}Val`);
  if (!out) return;
  if (id === 'temperature') out.textContent = (Number(el.value) / 100).toFixed(2);
  else out.textContent = `${el.value}%`;
}

function updateLatencyHint() {
  const p = LATENCY_PROFILES[$('latencyProfile').value];
  $('latencyHint').textContent = p ? p.hint : '';
}

function renderSettings() {
  for (const id of TEXT_FIELDS) {
    const el = $(id);
    if (el) el.value = settings[id] ?? '';
  }
  for (const id of NUMBER_FIELDS) {
    const el = $(id);
    if (el) el.value = settings[id];
  }
  for (const id of CHECK_FIELDS) {
    const el = $(id);
    if (el) el.checked = !!settings[id];
  }
  for (const id of ENUM_SELECTS) {
    const el = $(id);
    if (el && settings[id]) el.value = settings[id];
  }
  for (const id of NUMBER_SELECTS) {
    const el = $(id);
    if (el) el.value = String(settings[id]);
  }

  if (![...$('targetLanguage').options].some((o) => o.value === settings.targetLanguage)) {
    const o = document.createElement('option');
    o.value = settings.targetLanguage;
    o.textContent = settings.targetLanguage;
    $('targetLanguage').appendChild(o);
  }
  $('targetLanguage').value = settings.targetLanguage;
  $('voice').value = settings.voice;

  $('latencyProfile').value = LATENCY_PROFILES[settings.latencyProfile]
    ? settings.latencyProfile
    : 'low';
  updateLatencyHint();

  for (const r of RANGES) {
    const el = $(r.id);
    const raw = Number(settings[r.id]);
    el.value = String(Math.round((isFinite(raw) ? raw : r.def) * r.scale));
    updateRangeLabel(r.id);
  }
}

function collect() {
  const next = { ...settings };
  for (const id of TEXT_FIELDS) {
    const el = $(id);
    if (el) next[id] = el.value.trim();
  }
  for (const id of NUMBER_FIELDS) {
    const el = $(id);
    if (el) next[id] = Number(el.value) || 0;
  }
  for (const id of NUMBER_SELECTS) {
    const el = $(id);
    if (el) next[id] = Number(el.value) || DEFAULT_SETTINGS[id];
  }
  for (const id of CHECK_FIELDS) {
    const el = $(id);
    if (el) next[id] = el.checked;
  }
  for (const id of ENUM_SELECTS) {
    const el = $(id);
    if (el) next[id] = el.value;
  }
  for (const r of RANGES) {
    const el = $(r.id);
    if (el) next[r.id] = Number(el.value) / r.scale;
  }
  return next;
}

/* ------------------------------------------------------------ test connect */

async function testConnection() {
  const btn = $('testConn');
  const out = $('testResult');
  const candidate = collect();

  if (!candidate.apiKey && !candidate.proxyUrl) {
    out.className = 'test-result bad';
    out.textContent = 'اول کلید API را وارد کنید.';
    return;
  }

  btn.disabled = true;
  out.className = 'test-result busy';
  out.textContent = 'در حال اتصال…';

  const model = resolveModel(candidate);
  let ws;
  let done = false;

  const finish = (ok, text) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { ws && ws.close(); } catch { /* ignore */ }
    out.className = `test-result ${ok ? 'ok' : 'bad'}`;
    out.textContent = text;
    btn.disabled = false;
  };

  const timer = setTimeout(
    () => finish(false, 'زمان انتظار تمام شد. شبکه یا کلید را بررسی کنید.'),
    15000
  );

  try {
    ws = new WebSocket(buildWsUrl(candidate));
    ws.binaryType = 'arraybuffer';
  } catch (err) {
    finish(false, `آدرس نامعتبر: ${err.message}`);
    return;
  }

  ws.onopen = () => {
    try {
      ws.send(JSON.stringify(buildSetupMessage(candidate, null)));
    } catch (err) {
      finish(false, String(err.message));
    }
  };

  ws.onmessage = async (event) => {
    let text;
    if (event.data instanceof Blob) text = await event.data.text();
    else if (event.data instanceof ArrayBuffer) text = new TextDecoder().decode(event.data);
    else text = String(event.data);

    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete) {
      finish(true, `اتصال موفق — مدل «${model}» آماده است.`);
      return;
    }
    if (msg.error) {
      const e = msg.error;
      finish(false, `${e.status || e.code || 'ERROR'}: ${e.message || ''}`);
    }
  };

  ws.onerror = () => finish(false, 'خطای اتصال WebSocket. دسترسی شبکه یا صحت کلید را بررسی کنید.');
  ws.onclose = (ev) => {
    if (!done) finish(false, `اتصال بسته شد (${ev.code}). ${ev.reason || ''}`);
  };
}

/* ----------------------------------------------------------------- wiring */

for (const r of RANGES) {
  const el = $(r.id);
  el.addEventListener('input', () => updateRangeLabel(r.id));
}

$('latencyProfile').addEventListener('change', () => {
  const preset = LATENCY_PROFILES[$('latencyProfile').value];
  if (!preset) return;
  const v = preset.values;
  if (v.captureFrame != null) $('captureFrame').value = String(v.captureFrame);
  if (v.silenceMs != null) $('silenceMs').value = v.silenceMs;
  if (v.prefixMs != null) $('prefixMs').value = v.prefixMs;
  if (v.maxBacklogMs != null) $('maxBacklogMs').value = v.maxBacklogMs;
  updateLatencyHint();
});

$('toggleKey').addEventListener('click', () => {
  const el = $('apiKey');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? 'پنهان' : 'نمایش';
});

$('testConn').addEventListener('click', testConnection);

$('resetPrompt').addEventListener('click', () => {
  $('systemInstructionOverride').value = '';
});

$('mode').addEventListener('change', () => {
  settings.mode = $('mode').value;
});

$('save').addEventListener('click', async () => {
  settings = collect();
  await chrome.storage.local.set({ settings });
  const msg = $('savedMsg');
  msg.classList.add('show');
  setTimeout(() => msg.classList.remove('show'), 1800);
  try {
    await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
  } catch { /* ignore */ }
});

$('reset').addEventListener('click', async () => {
  const keepKey = settings.apiKey;
  settings = { ...DEFAULT_SETTINGS, apiKey: keepKey };
  await chrome.storage.local.set({ settings });
  renderSettings();
  const msg = $('savedMsg');
  msg.textContent = 'بازگردانی شد';
  msg.classList.add('show');
  setTimeout(() => {
    msg.classList.remove('show');
    msg.textContent = 'ذخیره شد';
  }, 1800);
});

/* ------------------------------------------------------------------- boot */

(async () => {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  fillStaticOptions();
  renderSettings();
})();
