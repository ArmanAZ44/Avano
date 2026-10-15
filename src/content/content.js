/**
 * content.js — the in-page overlay.
 *
 * Runs in every top-level frame. Finds the video that is actually being
 * watched, draws a floating glass control panel (inside a shadow root so page
 * CSS cannot touch it) and reports play/pause/seek events back to the service
 * worker so the audio pipeline stays in sync.
 *
 * Styling notes
 *  - all styles live in a constructable stylesheet adopted by the shadow root,
 *    which is immune to the page's Content-Security-Policy;
 *  - the UI uses the bundled Vazirmatn variable font (see assets/fonts).
 *
 * Note: starting a capture requires the extension to have been "invoked" on
 * the tab, which only happens after the user clicks the toolbar icon. The
 * overlay's start button therefore delegates to the service worker and falls
 * back to a hint if Chrome refuses.
 */

(() => {
  if (window.__avanoLoaded) return;
  window.__avanoLoaded = true;

  const HOST_ID = 'avano-dub-host';
  const PANEL_WIDTH = 340;
  const VERSION = '1.0.0';

  const LINKS = {
    github: 'https://github.com/ArmanAZ44/Avano',
    telegram: 'https://t.me/ArmanAZPC',
    reymit: 'https://reymit.ir/armanaz44'
  };

  const state = {
    active: false,
    status: 'idle',
    detail: '',
    error: '',
    stats: null,
    levels: { input: 0, output: 0, backlogMs: 0 },
    settings: {
      originalVolume: 0.08,
      dubVolume: 1.0,
      showSubtitles: true,
      showOriginalTranscript: true
    },
    collapsed: false,
    hidden: false,
    video: null
  };

  let host = null;
  let shadow = null;
  let ui = null;

  /* ------------------------------------------------------------ utilities */

  const toFa = (v) => String(v).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

  const STATUS_TEXT = {
    idle: 'آماده',
    connecting: 'در حال اتصال…',
    live: 'دوبله فعال',
    reconnecting: 'اتصال مجدد…',
    error: 'خطا'
  };

  function findPrimaryVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestScore = 0;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 40000) continue;
      let score = area;
      if (!v.paused && !v.ended) score *= 3;
      if (v.duration && isFinite(v.duration) && v.duration > 30) score *= 1.2;
      if (v.readyState < 1) score *= 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function reportVideoState(extra = {}) {
    const v = state.video;
    const payload = {
      playing: v ? !v.paused && !v.ended : false,
      muted: v ? v.muted : false,
      seeking: false,
      rate: v ? v.playbackRate : 1,
      currentTime: v ? v.currentTime : 0,
      ...extra
    };
    chrome.runtime.sendMessage({ type: 'CS_VIDEO_STATE', payload }).catch(() => {});
  }

  function attachVideoListeners(video) {
    if (!video || video.__avanoBound) return;
    video.__avanoBound = true;
    const onPlay = () => reportVideoState({ playing: true });
    const onPause = () => reportVideoState({ playing: false });
    const onSeeking = () => reportVideoState({ seeking: true });
    const onSeeked = () => reportVideoState({ seeking: false });
    const onRate = () => reportVideoState({});

    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ratechange', onRate);
  }

  /* ------------------------------------------------------------------- UI */

  const FONT_URL = chrome.runtime.getURL('assets/fonts/Vazirmatn.woff2');
  const ICON128 = chrome.runtime.getURL('assets/icon128.png');

  const CSS = `
    @font-face {
      font-family: "Vazirmatn";
      src: url("${FONT_URL}") format("woff2");
      font-weight: 100 900;
      font-style: normal;
      font-display: swap;
    }

    :host { all: initial; }
    * { box-sizing: border-box; }

    .panel {
      font-family: "Vazirmatn", "Segoe UI", Tahoma, system-ui, sans-serif;
      direction: rtl;
      width: ${PANEL_WIDTH}px;
      color: #f3f0ff;
      font-size: 13px;
      line-height: 1.85;
      position: relative;
      border-radius: 24px;
      overflow: hidden;
      user-select: none;

      background:
        radial-gradient(130% 90% at 100% 0%, rgba(168,85,247,.30) 0%, rgba(168,85,247,0) 58%),
        radial-gradient(110% 80% at 0% 100%, rgba(232,121,249,.20) 0%, rgba(232,121,249,0) 55%),
        linear-gradient(158deg, rgba(46,26,74,.86) 0%, rgba(24,15,42,.90) 45%, rgba(12,8,22,.93) 100%);
      -webkit-backdrop-filter: blur(26px) saturate(175%);
      backdrop-filter: blur(26px) saturate(175%);
      box-shadow:
        0 26px 64px -14px rgba(76,29,149,.72),
        0 10px 28px rgba(0,0,0,.48),
        inset 0 1px 0 rgba(255,255,255,.14);
      transition: box-shadow .35s ease, transform .25s cubic-bezier(.22,1,.36,1);
    }

    /* gradient hairline border */
    .panel::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(145deg,
        rgba(221,214,254,.62) 0%,
        rgba(232,121,249,.34) 28%,
        rgba(255,255,255,.06) 55%,
        rgba(167,139,250,.46) 100%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
      pointer-events: none;
      z-index: 3;
    }

    /* soft moving sheen */
    .panel::after {
      content: "";
      position: absolute;
      top: -60%;
      left: -30%;
      width: 80%;
      height: 220%;
      background: linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.07) 50%, rgba(255,255,255,0) 100%);
      transform: rotate(14deg);
      pointer-events: none;
      opacity: 0;
      transition: opacity .5s ease;
      z-index: 1;
    }
    .panel.live::after { opacity: 1; animation: sheen 5.5s linear infinite; }
    @keyframes sheen {
      0% { transform: translateX(-40%) rotate(14deg); }
      100% { transform: translateX(320%) rotate(14deg); }
    }

    .panel.live {
      box-shadow:
        0 26px 68px -14px rgba(147,51,234,.85),
        0 0 0 1px rgba(192,132,252,.28),
        0 10px 28px rgba(0,0,0,.5),
        inset 0 1px 0 rgba(255,255,255,.18);
    }

    /* ---------------------------------------------------------- header */

    .hdr {
      position: relative;
      z-index: 4;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px 11px;
      cursor: grab;
      border-bottom: 1px solid rgba(196,181,253,.13);
      background: linear-gradient(180deg, rgba(168,85,247,.16), rgba(168,85,247,0));
    }
    .hdr:active { cursor: grabbing; }

    .brand { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }

    .logo {
      position: relative;
      width: 30px; height: 30px; flex: none;
      border-radius: 10px;
      display: grid; place-items: center;
      background: linear-gradient(140deg, #8b5cf6 0%, #a855f7 45%, #e879f9 100%);
      box-shadow: 0 4px 14px rgba(168,85,247,.55), inset 0 1px 0 rgba(255,255,255,.35);
      overflow: hidden;
    }
    .logo img { width: 20px; height: 20px; object-fit: contain; filter: drop-shadow(0 1px 2px rgba(0,0,0,.2)); }
    .logo .bars { display: flex; align-items: center; gap: 1.5px; height: 13px; }
    .logo .bars i {
      display: block; width: 2px; border-radius: 2px;
      background: #fff; height: 40%;
      animation: bar 1.15s ease-in-out infinite;
    }
    .logo .bars i:nth-child(1) { animation-delay: 0s; }
    .logo .bars i:nth-child(2) { animation-delay: .14s; }
    .logo .bars i:nth-child(3) { animation-delay: .28s; }
    .logo .bars i:nth-child(4) { animation-delay: .42s; }
    .logo .bars i:nth-child(5) { animation-delay: .56s; }
    @keyframes bar { 0%,100% { height: 32% } 50% { height: 100% } }

    .panel.live .logo { box-shadow: 0 4px 18px rgba(232,121,249,.75), inset 0 1px 0 rgba(255,255,255,.4); }
    .panel.live .logo .bars i { animation-duration: .62s; }

    .title-wrap { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .title {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #faf5ff;
    }
    .subtitle {
      font-size: 10px;
      color: #c4b5fd;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hdr-btns { display: flex; gap: 5px; flex: none; }
    .icon-btn {
      width: 26px; height: 26px;
      border: 1px solid rgba(196,181,253,.16);
      border-radius: 8px;
      cursor: pointer;
      background: rgba(255,255,255,.05);
      color: #ddd6fe;
      display: grid; place-items: center;
      font-size: 14px; line-height: 1;
      font-family: inherit;
      transition: background .16s, color .16s, border-color .16s, transform .12s;
    }
    .icon-btn:hover {
      background: rgba(168,85,247,.28);
      border-color: rgba(216,180,254,.4);
      color: #fff;
      transform: translateY(-1px);
    }

    /* ------------------------------------------------------------ body */

    .body {
      position: relative;
      z-index: 2;
      padding: 12px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .panel.collapsed .body { display: none; }

    .status { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: #7c7a92;
      transition: background .2s;
    }
    .dot.connecting, .dot.reconnecting {
      background: #fbbf24;
      box-shadow: 0 0 0 0 rgba(251,191,36,.6);
      animation: ring 1.2s infinite;
    }
    .dot.live {
      background: #34d399;
      box-shadow: 0 0 9px rgba(52,211,153,.9);
      animation: ringLive 2s infinite;
    }
    .dot.error { background: #fb7185; box-shadow: 0 0 9px rgba(251,113,133,.8); }
    @keyframes ring {
      0% { box-shadow: 0 0 0 0 rgba(251,191,36,.55) }
      70% { box-shadow: 0 0 0 7px rgba(251,191,36,0) }
      100% { box-shadow: 0 0 0 0 rgba(251,191,36,0) }
    }
    @keyframes ringLive {
      0% { box-shadow: 0 0 0 0 rgba(52,211,153,.5) }
      70% { box-shadow: 0 0 0 8px rgba(52,211,153,0) }
      100% { box-shadow: 0 0 0 0 rgba(52,211,153,0) }
    }

    .status-text {
      flex: 1; min-width: 0;
      font-weight: 600;
      color: #ede9fe;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .chip {
      flex: none;
      font-size: 10.5px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(168,85,247,.18);
      border: 1px solid rgba(196,181,253,.24);
      color: #ddd6fe;
      font-variant-numeric: tabular-nums;
    }

    /* --------------------------------------------------------- VU meter */

    .vu {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 9px 11px 10px;
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015));
      border: 1px solid rgba(196,181,253,.12);
    }
    .vu-row { display: flex; align-items: center; gap: 8px; }
    .vu-label {
      width: 34px; flex: none;
      font-size: 10px; color: #a99fc4;
    }
    .vu-track {
      flex: 1;
      height: 6px;
      border-radius: 999px;
      background: rgba(255,255,255,.07);
      overflow: hidden;
      box-shadow: inset 0 1px 2px rgba(0,0,0,.4);
    }
    .vu-fill {
      height: 100%;
      width: 0%;
      border-radius: 999px;
      transition: width .11s linear;
      will-change: width;
    }
    .vu-fill.in {
      background: linear-gradient(90deg, #6d28d9, #a855f7 70%, #e9d5ff);
    }
    .vu-fill.out {
      background: linear-gradient(90deg, #7c3aed, #d946ef 70%, #f5d0fe);
    }
    .panel.live .vu-fill.out { box-shadow: 0 0 10px rgba(217,70,239,.55); }

    /* ------------------------------------------------------------- CTA */

    .cta {
      position: relative;
      width: 100%;
      border: 0;
      cursor: pointer;
      border-radius: 14px;
      padding: 11px 14px;
      font-family: inherit;
      font-size: 13.5px;
      font-weight: 700;
      color: #fff;
      letter-spacing: .1px;
      background: linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #d946ef 100%);
      box-shadow: 0 10px 26px -6px rgba(147,51,234,.75), inset 0 1px 0 rgba(255,255,255,.28);
      transition: transform .12s, filter .18s, box-shadow .2s;
      overflow: hidden;
    }
    .cta::after {
      content: "";
      position: absolute; inset: 0;
      background: linear-gradient(180deg, rgba(255,255,255,.22), rgba(255,255,255,0) 55%);
      pointer-events: none;
    }
    .cta:hover { filter: brightness(1.09); box-shadow: 0 12px 30px -6px rgba(168,85,247,.85), inset 0 1px 0 rgba(255,255,255,.3); }
    .cta:active { transform: translateY(1px) scale(.995); }
    .cta.stop {
      background: linear-gradient(135deg, #be123c 0%, #e11d48 50%, #f97316 100%);
      box-shadow: 0 10px 26px -6px rgba(225,29,72,.7), inset 0 1px 0 rgba(255,255,255,.26);
    }
    .cta[disabled] { opacity: .6; cursor: default; filter: none; }

    /* -------------------------------------------------------- sliders */

    .row { display: flex; align-items: center; gap: 9px; }
    .row .lbl { width: 62px; flex: none; font-size: 11px; color: #a99fc4; }
    .row input[type=range] {
      flex: 1;
      -webkit-appearance: none;
      appearance: none;
      height: 5px;
      border-radius: 999px;
      outline: none;
      background: rgba(255,255,255,.10);
      box-shadow: inset 0 1px 2px rgba(0,0,0,.35);
    }
    .row input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: linear-gradient(140deg, #c4b5fd, #a855f7);
      cursor: pointer;
      border: 1.5px solid rgba(255,255,255,.75);
      box-shadow: 0 0 0 3px rgba(168,85,247,.22), 0 2px 6px rgba(0,0,0,.45);
      transition: box-shadow .16s;
    }
    .row input[type=range]:hover::-webkit-slider-thumb { box-shadow: 0 0 0 5px rgba(168,85,247,.28), 0 2px 6px rgba(0,0,0,.45); }
    .row .val {
      width: 34px; flex: none;
      text-align: left;
      font-size: 11px;
      color: #e9d5ff;
      font-variant-numeric: tabular-nums;
    }

    /* ------------------------------------------------------ subtitles */

    .subs {
      border-radius: 14px;
      padding: 9px 11px;
      min-height: 56px;
      max-height: 138px;
      overflow-y: auto;
      background: linear-gradient(180deg, rgba(10,6,20,.55), rgba(10,6,20,.38));
      border: 1px solid rgba(196,181,253,.13);
      display: flex;
      flex-direction: column;
      gap: 5px;
      scrollbar-width: thin;
      scrollbar-color: rgba(196,181,253,.35) transparent;
    }
    .subs::-webkit-scrollbar { width: 5px; }
    .subs::-webkit-scrollbar-thumb { background: rgba(196,181,253,.3); border-radius: 3px; }
    .subs::-webkit-scrollbar-track { background: transparent; }

    .sub-line {
      font-size: 12.5px;
      color: #f5f3ff;
      direction: rtl;
      line-height: 1.75;
    }
    .sub-line.orig {
      font-size: 10.5px;
      color: #9d92b8;
      direction: ltr;
      text-align: left;
      line-height: 1.6;
    }
    .sub-empty {
      font-size: 11px;
      color: #6d6486;
      text-align: center;
      padding: 8px 0;
    }

    /* --------------------------------------------------------- footer */

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      color: #948aad;
      font-variant-numeric: tabular-nums;
    }
    .footer .f-chip {
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,.045);
      border: 1px solid rgba(196,181,253,.12);
      white-space: nowrap;
    }

    .err {
      font-size: 11px;
      line-height: 1.75;
      color: #fecdd3;
      background: rgba(225,29,72,.16);
      border: 1px solid rgba(251,113,133,.32);
      border-radius: 12px;
      padding: 7px 10px;
      word-break: break-word;
    }
    .hint {
      font-size: 10.5px;
      line-height: 1.7;
      color: #c4b5fd;
      text-align: center;
    }

    /* -------------------------------------------------------- links bar */

    .links {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding-top: 4px;
      border-top: 1px solid rgba(196,181,253,.10);
    }
    .links a {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10.5px;
      color: #a99fc4;
      text-decoration: none;
      padding: 4px 8px;
      border-radius: 8px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(196,181,253,.10);
      transition: all .18s ease;
    }
    .links a:hover {
      color: #e9d5ff;
      background: rgba(168,85,247,.18);
      border-color: rgba(196,181,253,.25);
      transform: translateY(-1px);
    }
    .links a svg {
      width: 13px; height: 13px; fill: currentColor; opacity: .75;
    }

    .made-with {
      text-align: center;
      font-size: 10px;
      color: #7a7094;
      padding-top: 2px;
    }
    .made-with a { color: #a99fc4; text-decoration: none; transition: color .15s; }
    .made-with a:hover { color: #e9d5ff; }
  `;

  function buildUI() {
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="hdr">
        <div class="brand">
          <div class="logo">
            <div class="bars"><i></i><i></i><i></i><i></i><i></i></div>
          </div>
          <div class="title-wrap">
            <div class="title">آوانو | Avano</div>
            <div class="subtitle">دوبله‌ی زنده‌ی ویدیو</div>
          </div>
        </div>
        <div class="hdr-btns">
          <button class="icon-btn" data-act="collapse" title="جمع/باز کردن">–</button>
          <button class="icon-btn" data-act="close" title="پنهان کردن پنل">×</button>
        </div>
      </div>
      <div class="body">
        <div class="status">
          <span class="dot" data-el="dot"></span>
          <span class="status-text" data-el="statusText">آماده</span>
          <span class="chip" data-el="latencyChip">—</span>
        </div>

        <div class="vu">
          <div class="vu-row">
            <span class="vu-label">ورودی</span>
            <div class="vu-track"><div class="vu-fill in" data-el="vuIn"></div></div>
          </div>
          <div class="vu-row">
            <span class="vu-label">دوبله</span>
            <div class="vu-track"><div class="vu-fill out" data-el="vuOut"></div></div>
          </div>
        </div>

        <div class="err" data-el="err" style="display:none"></div>

        <button class="cta" data-el="cta">شروع دوبله</button>
        <div class="hint" data-el="hint" style="display:none">
          برای شروع، روی آیکون افزونه در نوار ابزار کلیک کنید.
        </div>

        <div class="row">
          <span class="lbl">صدای اصلی</span>
          <input type="range" min="0" max="100" step="1" data-el="origVol" />
          <span class="val" data-el="origVolVal">۸%</span>
        </div>
        <div class="row">
          <span class="lbl">صدای دوبله</span>
          <input type="range" min="0" max="150" step="1" data-el="dubVol" />
          <span class="val" data-el="dubVolVal">۱۰۰%</span>
        </div>

        <div class="subs" data-el="subs">
          <div class="sub-empty">زیرنویس‌ها اینجا نمایش داده می‌شوند…</div>
        </div>

        <div class="footer">
          <span class="f-chip" data-el="backlog">بافر —</span>
          <span class="f-chip" data-el="reconnects">اتصال مجدد ۰</span>
        </div>

        <div class="links">
          <a href="${LINKS.github}" target="_blank" rel="noreferrer" title="گیت‌هاب">
            <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            گیت‌هاب
          </a>
          <a href="${LINKS.telegram}" target="_blank" rel="noreferrer" title="تلگرام">
            <svg viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM8.287 5.906c-.778.324-2.334.994-4.666 2.01-.378.15-.577.298-.595.442-.03.243.275.339.69.47l.175.055c.408.133.958.288 1.243.294.26.006.549-.1.868-.32 2.179-1.471 3.304-2.214 3.374-2.23.015-.003.028-.006.04.002a.5.5 0 0 1 .037.048c.04.051.065.106.065.16 0 .08-.03.16-.09.24-.27.33-.84.88-1.71 1.65-.176.153-.32.287-.43.4-.242.245-.548.537-.814.735-.34.255-.7.395-1.06.395-.23 0-.44-.06-.62-.18-.18-.12-.29-.29-.33-.5-.04-.21-.02-.46.06-.74.08-.28.2-.58.36-.9.16-.32.34-.64.54-.96.2-.32.4-.6.6-.84.2-.24.38-.42.54-.54.16-.12.3-.18.42-.18.12 0 .24.04.36.12.12.08.2.16.24.24.04.08.06.16.06.24 0 .08-.02.16-.06.24-.04.08-.1.16-.18.24-.08.08-.16.16-.24.24-.08.08-.14.16-.18.24-.04.08-.06.16-.06.24 0 .08.02.16.06.24.04.08.1.16.18.24.08.08.16.16.24.24.08.08.14.16.18.24.04.08.06.16.06.24 0 .08-.02.16-.06.24-.04.08-.1.16-.18.24-.08.08-.16.16-.24.24-.08.08-.14.16-.18.24-.04.08-.06.16-.06.24z"/></svg>
            تلگرام
          </a>
          <a href="${LINKS.reymit}" target="_blank" rel="noreferrer" title="حمایت مالی">
            <svg viewBox="0 0 16 16"><path d="M8 1.314C12.438-3.248 23.534 4.735 8 15-7.534 4.736 3.562-3.248 8 1.314z"/></svg>
            حمایت
          </a>
        </div>

        <div class="made-with">
          ساخته‌شده با <span style="color:#fb7185">♥</span> برای وب فارسی — نسخه ${toFa(VERSION)}
        </div>
      </div>
    `;
    shadow.appendChild(panel);

    ui = {
      panel,
      dot: shadow.querySelector('[data-el=dot]'),
      statusText: shadow.querySelector('[data-el=statusText]'),
      latencyChip: shadow.querySelector('[data-el=latencyChip]'),
      vuIn: shadow.querySelector('[data-el=vuIn]'),
      vuOut: shadow.querySelector('[data-el=vuOut]'),
      err: shadow.querySelector('[data-el=err]'),
      cta: shadow.querySelector('[data-el=cta]'),
      hint: shadow.querySelector('[data-el=hint]'),
      origVol: shadow.querySelector('[data-el=origVol]'),
      origVolVal: shadow.querySelector('[data-el=origVolVal]'),
      dubVol: shadow.querySelector('[data-el=dubVol]'),
      dubVolVal: shadow.querySelector('[data-el=dubVolVal]'),
      subs: shadow.querySelector('[data-el=subs]'),
      backlog: shadow.querySelector('[data-el=backlog]'),
      reconnects: shadow.querySelector('[data-el=reconnects]')
    };

    ui.origVol.value = String(Math.round(state.settings.originalVolume * 100));
    ui.origVolVal.textContent = `${toFa(ui.origVol.value)}%`;
    ui.dubVol.value = String(Math.round(state.settings.dubVolume * 100));
    ui.dubVolVal.textContent = `${toFa(ui.dubVol.value)}%`;

    wireEvents();
    document.documentElement.appendChild(host);
    render();
  }

  function wireEvents() {
    shadow.querySelector('[data-act=collapse]').addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      ui.panel.classList.toggle('collapsed', state.collapsed);
    });

    shadow.querySelector('[data-act=close]').addEventListener('click', () => {
      host.style.display = 'none';
      state.hidden = true;
      saveSettings();
    });

    ui.cta.addEventListener('click', async () => {
      if (state.active) {
        ui.cta.disabled = true;
        try {
          await chrome.runtime.sendMessage({ type: 'STOP' });
        } catch { /* ignore */ }
        ui.cta.disabled = false;
        return;
      }
      ui.cta.disabled = true;
      ui.hint.style.display = 'none';
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'START_FROM_OVERLAY' });
      } catch (err) {
        res = { ok: false, error: String(err && err.message) };
      }
      ui.cta.disabled = false;
      if (res && res.ok === false && res.error === 'NEED_TOOLBAR_CLICK') {
        ui.hint.style.display = 'block';
      } else if (res && res.ok === false) {
        state.error = res.error || 'شروع نشد.';
        render();
      }
    });

    const pushVolume = (which) => {
      if (which === 'orig') {
        state.settings.originalVolume = Number(ui.origVol.value) / 100;
        ui.origVolVal.textContent = `${toFa(ui.origVol.value)}%`;
      } else {
        state.settings.dubVolume = Number(ui.dubVol.value) / 100;
        ui.dubVolVal.textContent = `${toFa(ui.dubVol.value)}%`;
      }
      saveSettings();
    };
    ui.origVol.addEventListener('input', () => pushVolume('orig'));
    ui.dubVol.addEventListener('input', () => pushVolume('dub'));

    // Dragging the header.
    const hdr = shadow.querySelector('.hdr');
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    hdr.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.icon-btn')) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      host.style.right = 'auto';
      host.style.left = `${originLeft}px`;
      host.style.top = `${originTop}px`;
      hdr.setPointerCapture(e.pointerId);
    });
    hdr.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 40;
      host.style.left = `${Math.min(Math.max(0, originLeft + dx), maxLeft)}px`;
      host.style.top = `${Math.min(Math.max(0, originTop + dy), maxTop)}px`;
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { hdr.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      saveSettings();
    };
    hdr.addEventListener('pointerup', endDrag);
    hdr.addEventListener('pointercancel', endDrag);
  }

  async function saveSettings() {
    const rect = host ? host.getBoundingClientRect() : null;
    const patch = {
      originalVolume: state.settings.originalVolume,
      dubVolume: state.settings.dubVolume,
      showSubtitles: state.settings.showSubtitles,
      overlayVisible: host ? host.style.display !== 'none' : true,
      ...(rect
        ? { overlayPos: { left: Math.round(rect.left), top: Math.round(rect.top) } }
        : {})
    };
    try {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
    } catch { /* ignore */ }
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: patch }).catch(() => {});
  }

  /* --------------------------------------------------------------- render */

  function render() {
    if (!ui) return;
    const status = state.active ? state.status : 'idle';
    ui.dot.className = `dot ${status}`;
    ui.statusText.textContent = state.detail || STATUS_TEXT[status] || status;
    ui.panel.classList.toggle('live', state.active && status === 'live');

    ui.cta.textContent = state.active ? 'توقف دوبله' : 'شروع دوبله';
    ui.cta.classList.toggle('stop', state.active);
    ui.cta.disabled = state.active && state.status === 'connecting';

    const showError = !!state.error && (!state.active || state.status === 'error');
    ui.err.style.display = showError ? 'block' : 'none';
    if (showError) ui.err.textContent = state.error;

    const stats = state.stats || {};
    ui.latencyChip.textContent = stats.latencyMs
      ? `${toFa((stats.latencyMs / 1000).toFixed(1))}s`
      : '—';
    ui.reconnects.textContent = `اتصال مجدد ${toFa(stats.reconnects || 0)}`;

    const backlog = state.levels.backlogMs;
    ui.backlog.textContent =
      state.active && backlog ? `بافر ${toFa(backlog)}ms` : 'بافر —';

    ui.subs.style.display = state.settings.showSubtitles ? '' : 'none';
  }

  function renderLevels() {
    if (!ui) return;
    const lv = state.levels;
    ui.vuIn.style.width = `${Math.round(Math.min(1, lv.input || 0) * 100)}%`;
    ui.vuOut.style.width = `${Math.round(Math.min(1, lv.output || 0) * 100)}%`;
    if (state.active) {
      const backlog = lv.backlogMs || 0;
      ui.backlog.textContent = `بافر ${toFa(backlog)}ms`;
    }
  }

  function appendSubtitle(kind, text) {
    if (!ui || !text) return;
    const empty = ui.subs.querySelector('.sub-empty');
    if (empty) empty.remove();

    const last = ui.subs.lastElementChild;
    if (last && last.dataset.open === '1' && last.dataset.kind === kind) {
      last.textContent += text;
    } else {
      const div = document.createElement('div');
      div.className = `sub-line ${kind === 'orig' ? 'orig' : ''}`;
      div.dataset.kind = kind;
      div.dataset.open = '1';
      div.textContent = text;
      ui.subs.appendChild(div);
      Array.from(ui.subs.children).forEach((c) => {
        if (c !== div) c.dataset.open = '0';
      });
    }

    while (ui.subs.children.length > 40) ui.subs.removeChild(ui.subs.firstElementChild);
    ui.subs.scrollTop = ui.subs.scrollHeight;
  }

  /* ------------------------------------------------------------ messaging */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'CS_PING':
        sendResponse({ ok: true });
        return true;

      case 'CS_TOGGLE_OVERLAY':
        toggleOverlay();
        return;

      case 'CS_ACTIVE':
        state.active = !!msg.active;
        if (!state.active) {
          state.status = 'idle';
          state.detail = '';
          state.stats = null;
          state.levels = { input: 0, output: 0, backlogMs: 0 };
          if (ui) {
            ui.vuIn.style.width = '0%';
            ui.vuOut.style.width = '0%';
          }
        }
        render();
        return;

      case 'CS_STATE':
        state.active = !!msg.state.active;
        state.status = msg.state.status || 'idle';
        state.detail = msg.state.detail || '';
        state.error = msg.state.error || '';
        state.stats = msg.state.stats || null;
        if (state.active) refreshLocalSettings();
        render();
        return;

      case 'CS_LEVELS':
        if (msg.levels) {
          state.levels = msg.levels;
          renderLevels();
        }
        return;

      case 'CS_TRANSCRIPT':
        if (msg.input && state.settings.showOriginalTranscript !== false) {
          appendSubtitle('orig', msg.input);
        }
        if (msg.output) appendSubtitle('tr', msg.output);
        return;

      case 'CS_VIDEO_STATE':
        return;

      default:
        return;
    }
  });

  /* --------------------------------------------------------------- boot */

  function applyStoredSettings(stored) {
    if (!stored) return;
    if (typeof stored.originalVolume === 'number') {
      state.settings.originalVolume = stored.originalVolume;
    }
    if (typeof stored.dubVolume === 'number') {
      state.settings.dubVolume = stored.dubVolume;
    }
    if (typeof stored.showSubtitles === 'boolean') {
      state.settings.showSubtitles = stored.showSubtitles;
    }
    if (typeof stored.showOriginalTranscript === 'boolean') {
      state.settings.showOriginalTranscript = stored.showOriginalTranscript;
    }
    if (stored.overlayPos && host) {
      host.style.right = 'auto';
      host.style.left = `${stored.overlayPos.left}px`;
      host.style.top = `${stored.overlayPos.top}px`;
    }
    if (stored.overlayVisible === false) state.hidden = true;
    else if (stored.overlayVisible === true) state.hidden = false;
  }

  async function refreshLocalSettings() {
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      applyStoredSettings(stored);
      if (ui) {
        ui.origVol.value = String(Math.round(state.settings.originalVolume * 100));
        ui.origVolVal.textContent = `${toFa(ui.origVol.value)}%`;
        ui.dubVol.value = String(Math.round(state.settings.dubVolume * 100));
        ui.dubVolVal.textContent = `${toFa(ui.dubVol.value)}%`;
      }
      render();
    } catch { /* ignore */ }
  }

  async function loadSettings() {
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      applyStoredSettings(stored);
    } catch { /* ignore */ }
  }

  function ensureVideo() {
    const v = findPrimaryVideo();
    if (v !== state.video) {
      state.video = v;
      attachVideoListeners(v);
      if (v) reportVideoState({});
    }
  }

  function init() {
    buildUI();
    loadSettings().then(() => {
      ensureVideo();
      if (state.hidden) host.style.display = 'none';
      chrome.runtime
        .sendMessage({ type: 'CS_REQUEST_STATE' })
        .then((res) => {
          if (res && res.ok) {
            state.active = res.state.active;
            state.status = res.state.status;
            state.detail = res.state.detail;
            state.error = res.state.error;
            state.stats = res.state.stats;
            render();
          }
        })
        .catch(() => {});
    });

    setInterval(ensureVideo, 3000);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      applyStoredSettings(changes.settings.newValue);
      if (host) host.style.display = state.hidden ? 'none' : '';
      render();
    });

    document.addEventListener(
      'fullscreenchange',
      () => {
        const fsEl = document.fullscreenElement;
        if (fsEl && !fsEl.contains(host)) {
          try { fsEl.appendChild(host); } catch { /* ignore */ }
        } else if (!fsEl) {
          document.documentElement.appendChild(host);
        }
      },
      true
    );

  }

  /** Show/hide the panel. Triggered by the `Alt+Shift+O` command. */
  function toggleOverlay() {
    if (!host) return;
    state.hidden = host.style.display !== 'none';
    host.style.display = state.hidden ? 'none' : '';
    saveSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
