/**
 * browser-api.js — cross-browser compatibility shim.
 *
 * Unifies the `chrome.*` and `browser.*` namespaces and fills in the APIs that
 * differ between Chromium (MV3) and Firefox (MV2).
 *
 * Important: Firefox exposes `browser` (promise based) and `chrome` (callback
 * based) as **two distinct objects**. The rest of the code consistently calls
 * `chrome.*`, so every shim has to be installed on both namespaces and the
 * callback namespace has to be promisified — writing to only one of them is a
 * classic reason cross-browser extensions work in Chromium and silently break
 * in Firefox.
 *
 * Load this as a classic script before any module that touches extension APIs.
 */

(function () {
  const g = globalThis;
  if (g.__avanoBrowserShim) return;
  g.__avanoBrowserShim = true;

  const hasBrowserNs = typeof browser !== 'undefined';
  const hasChromeNs = typeof chrome !== 'undefined';

  const targets = [];
  if (hasBrowserNs) targets.push(browser);
  if (hasChromeNs && chrome !== browser) targets.push(chrome);
  if (!targets.length) return;

  // Anything reading `chrome` should still find something in Firefox.
  if (!hasChromeNs) g.chrome = targets[0];

  // Firefox's `chrome` is the callback-based twin of `browser`.
  const callbackNs = hasBrowserNs && hasChromeNs && chrome !== browser ? chrome : null;

  /* --------------------------------------------------------------- shims */

  function installTabCapture(ns) {
    if (ns.tabCapture) {
      // Real tab capture: mark it so callers can tell it apart from the shim.
      ns.tabCapture.__avanoNative = true;
      return;
    }
    ns.tabCapture = {
      __avanoNative: false,
      getMediaStreamId() {
        // No tab capture here. The audio engine falls back to getDisplayMedia,
        // where the user picks the tab and enables "Share audio".
        return Promise.reject(new Error('BROWSER_CAPTURE_REQUIRED'));
      }
    };
  }

  function installOffscreen(ns) {
    if (ns.offscreen) return;
    ns.offscreen = {
      async createDocument({ url }) {
        // A persistent MV2 background page has DOM access, so the audio engine
        // can live in a hidden iframe instead of an offscreen document.
        if (typeof document === 'undefined') return;
        if (g.__avanoOffscreenFrame) return;
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.style.cssText =
          'position:fixed;width:0;height:0;border:0;visibility:hidden;';
        document.body.appendChild(frame);
        g.__avanoOffscreenFrame = frame;
      },
      async closeDocument() {
        const frame = g.__avanoOffscreenFrame;
        if (!frame) return;
        try {
          frame.remove();
        } catch {
          /* ignore */
        }
        g.__avanoOffscreenFrame = null;
      }
    };
  }

  function installScripting(ns) {
    if (ns.scripting) return;
    ns.scripting = {
      async executeScript({ target, files }) {
        for (const file of files || []) {
          await ns.tabs.executeScript(target.tabId, { file });
        }
      },
      async insertCSS({ target, files }) {
        for (const file of files || []) {
          await ns.tabs.insertCSS(target.tabId, { file });
        }
      }
    };
  }

  function installRuntime(ns) {
    if (ns.runtime && !ns.runtime.getContexts) {
      ns.runtime.getContexts = async () => [];
    }
  }

  function installStorage(ns) {
    if (ns.storage && !ns.storage.session) {
      // MV3 only; the local store is a fine fallback for the small state blob
      // we keep there.
      ns.storage.session = ns.storage.local;
    }
  }

  function installAction(ns) {
    if (!ns.action && ns.browserAction) ns.action = ns.browserAction;
  }

  for (const ns of targets) {
    installTabCapture(ns);
    installOffscreen(ns);
    installScripting(ns);
    installRuntime(ns);
    installStorage(ns);
    installAction(ns);
  }

  /* ---------------------------------------------------------- promisify */

  function promisify(ns, path) {
    const parts = path.split('.');
    let owner = ns;
    for (let i = 0; i < parts.length - 1; i++) {
      owner = owner && owner[parts[i]];
    }
    const method = parts[parts.length - 1];
    if (!owner || typeof owner[method] !== 'function' || owner[method].__avanoPromisified) {
      return;
    }
    const original = owner[method];
    const wrapped = function (...args) {
      return new Promise((resolve, reject) => {
        original.call(owner, ...args, (result) => {
          const err = ns.runtime && ns.runtime.lastError;
          if (err) reject(new Error(err.message || String(err)));
          else resolve(result);
        });
      });
    };
    wrapped.__avanoPromisified = true;
    owner[method] = wrapped;
  }

  if (callbackNs) {
    const CALLBACK_METHODS = [
      'storage.local.get',
      'storage.local.set',
      'storage.local.remove',
      'storage.session.get',
      'storage.session.set',
      'tabs.query',
      'tabs.get',
      'tabs.sendMessage',
      'tabs.executeScript',
      'tabs.insertCSS',
      'runtime.sendMessage'
    ];
    for (const path of CALLBACK_METHODS) promisify(callbackNs, path);
  }

  g.avano = { browser: targets[0] };
})();
