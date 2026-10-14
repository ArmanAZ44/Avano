/**
 * config.js — shared configuration, defaults and Gemini Live payload builders.
 * Imported by the background script, options page and offscreen document.
 * (The content script is a classic script and keeps its own small copy of
 *  the few constants it needs.)
 */

export const DEFAULT_SETTINGS = {
  apiKey: '',

  /** 'translate' = purpose-built real-time translation model (best quality/latency)
   *  'dub'       = general native-audio Live model driven by a dubbing system prompt */
  mode: 'translate',
  model: 'gemini-3.5-live-translate-preview',
  dubModel: 'gemini-2.5-flash-native-audio-preview-12-2025',

  targetLanguage: 'fa-IR',
  voice: 'auto',
  temperature: 0.7,

  /** How much of the original audio is mixed back in under the dub (0..1). */
  originalVolume: 0.08,
  /** Dubbed audio volume (0..1+). */
  dubVolume: 1.0,

  showSubtitles: true,
  showOriginalTranscript: true,
  overlayVisible: true,

  /* ------------------------------------------------------------------
   *  Latency / quality tuning
   * ------------------------------------------------------------------ */

  /** Preset name — see LATENCY_PROFILES. Selecting one writes the values below. */
  latencyProfile: 'low',

  /** Capture frame in samples at 16 kHz. 512 = 32 ms, 1024 = 64 ms.
   *  Smaller = less input buffering, at the cost of more WebSocket messages. */
  captureFrame: 512,

  /** Voice activity detection (dub mode only). */
  silenceMs: 200,
  prefixMs: 100,
  startSensitivity: 'START_SENSITIVITY_HIGH',
  endSensitivity: 'END_SENSITIVITY_HIGH',
  activityHandling: 'NO_INTERRUPTION',

  /** Playback jitter-buffer ceiling. When the dub backlog grows past this the
   *  engine trims the oldest audio so the dub stays locked to the video. */
  maxBacklogMs: 700,

  /** Soft-knee limiter on the dub bus: prevents harsh clipping above 100 %
   *  volume and evens out loudness between sentences. */
  softLimiter: true,

  /** Warm up the Gemini socket from the settings/background flow so pressing
   *  Start is near-instant instead of paying the full handshake. */
  prewarm: true,

  /** Keep long videos alive: sliding context window + session resumption. */
  longSessionMode: true,

  /** Optional custom WebSocket relay (leave empty to talk to Google directly). */
  proxyUrl: '',

  /** Optional advanced system-prompt override for dub mode. */
  systemInstructionOverride: ''
};

/**
 * Latency presets. Applying one writes its values into the settings so the
 * individual controls stay in sync and remain manually editable afterwards.
 */
export const LATENCY_PROFILES = {
  ultra: {
    label: 'حداکثر سرعت',
    hint: 'کم‌ترین تأخیر ممکن. برای گفت‌وگو و پادکست عالی است، ولی ممکن است جمله‌ها را کمی تکه‌تکه کند.',
    values: { captureFrame: 512, silenceMs: 120, prefixMs: 60, maxBacklogMs: 450 }
  },
  low: {
    label: 'کم‌تأخیر (پیشنهادی)',
    hint: 'تعادل بهینه بین سرعت و روانی جمله‌ها؛ برای تماشای عمومی بهترین انتخاب است.',
    values: { captureFrame: 512, silenceMs: 200, prefixMs: 100, maxBacklogMs: 700 }
  },
  balanced: {
    label: 'متعادل',
    hint: 'جمله‌ها کامل‌تر گفته می‌شوند و دوبله یکنواخت‌تر است، به قیمت کمی تأخیر بیشتر.',
    values: { captureFrame: 768, silenceMs: 350, prefixMs: 180, maxBacklogMs: 1100 }
  },
  quality: {
    label: 'حداکثر کیفیت',
    hint: 'برای محتوای فنی و سخنرانی دقیق. تأخیر بیشتر است ولی جمله‌ها کامل‌تر ترجمه می‌شوند.',
    values: { captureFrame: 1024, silenceMs: 500, prefixMs: 250, maxBacklogMs: 1600 }
  }
};

export const MODE_MODELS = {
  translate: [
    'gemini-3.5-live-translate-preview',
    'gemini-3.5-transcribe-live'
  ],
  dub: [
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-3.8-live',
    'gemini-2.5-flash-preview-native-audio-dialog',
    'gemini-2.0-flash-live-001'
  ]
};

/** BCP-47 codes accepted by translationConfig.targetLanguageCode. */
export const LANGUAGES = [
  { code: 'fa-IR', label: 'فارسی (Persian)' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'ar-XA', label: 'العربية (Arabic)' },
  { code: 'tr-TR', label: 'Türkçe (Turkish)' },
  { code: 'az-AZ', label: 'Azərbaycan (Azerbaijani)' },
  { code: 'ku', label: 'Kurdî (Kurdish)' },
  { code: 'he-IL', label: 'עברית (Hebrew)' },
  { code: 'fr-FR', label: 'Français (French)' },
  { code: 'de-DE', label: 'Deutsch (German)' },
  { code: 'es-ES', label: 'Español (Spain)' },
  { code: 'es-US', label: 'Español (Latin America)' },
  { code: 'it-IT', label: 'Italiano (Italian)' },
  { code: 'pt-BR', label: 'Português (Brazil)' },
  { code: 'ru-RU', label: 'Русский (Russian)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'ur-PK', label: 'اردو (Urdu)' },
  { code: 'zh-Hans', label: '中文 (简体)' },
  { code: 'zh-Hant', label: '中文 (繁體)' },
  { code: 'ja-JP', label: '日本語 (Japanese)' },
  { code: 'ko-KR', label: '한국어 (Korean)' },
  { code: 'id-ID', label: 'Bahasa Indonesia' },
  { code: 'nl-NL', label: 'Nederlands (Dutch)' },
  { code: 'pl-PL', label: 'Polski (Polish)' },
  { code: 'uk-UA', label: 'Українська (Ukrainian)' },
  { code: 'sv-SE', label: 'Svenska (Swedish)' },
  { code: 'th-TH', label: 'ไทย (Thai)' },
  { code: 'vi-VN', label: 'Tiếng Việt (Vietnamese)' },
  { code: 'fil-PH', label: 'Filipino' }
];

/** Prebuilt Gemini Live voices. 'auto' lets the model pick. */
export const VOICES = [
  'auto',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Aoede',
  'Leda',
  'Orus',
  'Zephyr',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat'
];

export const SENSITIVITY = [
  'START_SENSITIVITY_UNSPECIFIED',
  'START_SENSITIVITY_LOW',
  'START_SENSITIVITY_HIGH'
];

export const END_SENSITIVITY = [
  'END_SENSITIVITY_UNSPECIFIED',
  'END_SENSITIVITY_LOW',
  'END_SENSITIVITY_HIGH'
];

export const ACTIVITY_HANDLING = [
  'NO_INTERRUPTION',
  'START_OF_ACTIVITY_INTERRUPTS',
  'ACTIVITY_HANDLING_UNSPECIFIED'
];

export function languageLabel(code) {
  const hit = LANGUAGES.find((l) => l.code === code);
  return hit ? hit.label : code;
}

/** Resolve the model name for the currently selected mode. */
export function resolveModel(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const raw = s.mode === 'translate' ? s.model : s.dubModel;
  return String(raw || '').replace(/^models\//, '').trim();
}

/**
 * Everything that affects the Gemini session handshake. When this string
 * changes, a warm socket can no longer be reused.
 */
export function sessionSignature(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return [
    s.mode,
    resolveModel(s),
    s.targetLanguage,
    s.voice,
    s.longSessionMode ? 1 : 0,
    s.silenceMs,
    s.prefixMs,
    s.activityHandling,
    s.proxyUrl || ''
  ].join('|');
}

/**
 * System instruction used in 'dub' mode. Drives a general native-audio Live
 * model to behave like a simultaneous interpreter / dubbing artist.
 */
export function buildDubInstruction(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (s.systemInstructionOverride && s.systemInstructionOverride.trim()) {
    return s.systemInstructionOverride.trim();
  }
  const langName = languageLabel(s.targetLanguage);
  return [
    'You are a professional real-time dubbing engine running inside a web video player.',
    'Audio arrives continuously from a video that is currently playing. Your ONLY job is simultaneous interpretation.',
    '',
    'PROCEDURE',
    '1. Listen to the incoming audio and recognise the speech.',
    `2. Translate it into ${langName} (${s.targetLanguage}).`,
    '3. Begin speaking the translation as soon as you have the first few words - do not wait for the sentence to end.',
    '4. Speak with a natural, expressive voice that mirrors the original speaker\'s emotion, energy, pacing and emphasis.',
    '',
    'HARD RULES',
    '- Output ONLY the spoken translation. Never add greetings, intros, conclusions, commentary, summaries or apologies.',
    '- Never address the listener. Never say things like "I", "here is the translation", "the speaker says".',
    '- If the audio contains a question, translate the question. Never answer it.',
    `- Keep the dub roughly as long as the original speech so it stays in sync. Prefer fluent, idiomatic ${langName} over literal word-for-word translation.`,
    '- Preserve proper nouns, brand names, numbers, units and technical terms accurately.',
    '- If the audio contains only music, ambient noise, silence or unintelligible speech, produce no audio at all.',
    '- Match the register: keep jokes funny, keep drama dramatic, keep technical content precise.',
    '- Translate faithfully. Do not censor, soften or sanitise the content.',
    `- If the speech is already in ${langName}, simply repeat it so the dub track stays continuous.`
  ].join('\n');
}

/**
 * Build the first message sent over the WebSocket ("setup").
 * See: https://ai.google.dev/api/live  (BidiGenerateContentSetup)
 */
export function buildSetupMessage(settings, resumeHandle = null) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const model = resolveModel(s);

  const generationConfig = { responseModalities: ['AUDIO'] };
  if (s.voice && s.voice !== 'auto') {
    generationConfig.speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } }
    };
  }
  if (s.mode === 'dub') {
    generationConfig.temperature = Number(s.temperature) || 0.7;
  }

  const setup = {
    model: `models/${model}`,
    generationConfig,
    inputAudioTranscription: {},
    outputAudioTranscription: {}
  };

  if (s.mode === 'translate') {
    // Purpose-built streaming translation model. It handles turn detection
    // itself, so realtimeInputConfig is deliberately left at the server default.
    setup.translationConfig = {
      targetLanguageCode: s.targetLanguage,
      echoTargetLanguage: true
    };
  } else {
    setup.systemInstruction = { parts: [{ text: buildDubInstruction(s) }] };
    setup.realtimeInputConfig = {
      automaticActivityDetection: {
        disabled: false,
        silenceDurationMs: Number(s.silenceMs) || 200,
        prefixPaddingMs: Number(s.prefixMs) || 100,
        startOfSpeechSensitivity: s.startSensitivity,
        endOfSpeechSensitivity: s.endSensitivity
      },
      activityHandling: s.activityHandling,
      // TURN_INCLUDES_ALL_INPUT keeps long stretches of speech inside one turn,
      // which is what simultaneous dubbing needs (silence is not a turn break).
      turnCoverage: 'TURN_INCLUDES_ALL_INPUT'
    };
  }

  if (s.longSessionMode) {
    // Lets a single session survive long videos instead of hitting the
    // context window / session duration limit.
    setup.contextWindowCompression = { slidingWindow: {} };
    setup.sessionResumption = resumeHandle ? { handle: resumeHandle } : {};
  }

  return { setup };
}

const WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.';

/** Direct-to-Google WebSocket URL (API key or ephemeral access token). */
export function buildWsUrl(settings) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (s.proxyUrl && s.proxyUrl.trim()) {
    return s.proxyUrl.trim();
  }
  return `${WS_BASE}BidiGenerateContent?key=${encodeURIComponent(s.apiKey || '')}`;
}

export function redactKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
