/**
 * browser-api.js — cross-browser compatibility shim.
 *
 * Unifies chrome.* and browser.* namespaces and polyfills APIs that differ
 * between Chromium (MV3) and Firefox (MV2).
 *
 * Usage: import this module before any code that touches extension APIs.
 */

(function () {
  if (window.__avanoBrowserShim) return;
  window.__avanoBrowserShim = true;

  const root = typeof browser !== 'undefined' ? browser : chrome;

  // Expose a Chrome-compatible namespace for code that uses chrome.*.
  // Firefox provides browser.* first; this keeps the rest of the code small.
  if (typeof window.chrome === 'undefined') {
    window.chrome = root;
  }

  // --- tabCapture polyfill (Firefox does not have chrome.tabCapture) ---
  if (!root.tabCapture) {
    root.tabCapture = {
      async getMediaStreamId({ targetTabId } = {}) {
        // Firefox: use getDisplayMedia as a fallback. This requires user
        // interaction and will show a picker. Not ideal, but the closest
        // equivalent without native tabCapture.
        const tab = await root.tabs.get(targetTabId);
        if (!tab || !tab.url) {
          throw new Error('tabCapture is not available in this browser.');
        }
        // Signal to the caller that manual capture is required.
        throw new Error('BROWSER_CAPTURE_REQUIRED');
      }
    };
  }

  // --- offscreen polyfill (Firefox MV2 uses a background page instead) ---
  if (!root.offscreen) {
    root.offscreen = {
      async createDocument({ url }) {
        // In Firefox MV2 the background page is persistent and has DOM access,
        // so we load the offscreen HTML in a hidden iframe inside the background.
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;';
        document.body.appendChild(iframe);
        // Store reference for later cleanup.
        root.__avanoOffscreenFrame = iframe;
        return Promise.resolve();
      },
      async closeDocument() {
        if (root.__avanoOffscreenFrame) {
          try { root.__avanoOffscreenFrame.remove(); } catch { /* ignore */ }
          root.__avanoOffscreenFrame = null;
        }
        return Promise.resolve();
      }
    };
  }

  // --- scripting polyfill (Firefox MV2 uses tabs.executeScript) ---
  if (!root.scripting) {
    root.scripting = {
      async executeScript({ target, files }) {
        for (const f of files || []) {
          await root.tabs.executeScript(target.tabId, { file: f });
        }
      },
      async insertCSS({ target, files }) {
        for (const f of files || []) {
          await root.tabs.insertCSS(target.tabId, { file: f });
        }
      }
    };
  }

  // --- getContexts polyfill (MV3 only) ---
  if (!root.runtime.getContexts) {
    root.runtime.getContexts = async () => [];
  }

  // --- storage.session polyfill (MV3 only; fallback to local) ---
  if (!root.storage || !root.storage.session) {
    if (!root.storage) root.storage = {};
    root.storage.session = root.storage.local;
  }

  // --- action vs browserAction unification ---
  if (!root.action && root.browserAction) {
    root.action = root.browserAction;
  }

  // --- Promisify APIs that still use callbacks in some browsers ---
  function promisify(api, method) {
    const orig = api && api[method];
    if (!orig || orig.__promisified) return;
    api[method] = function (...args) {
      return new Promise((resolve, reject) => {
        orig.call(api, ...args, (res) => {
          if (root.runtime.lastError) {
            reject(new Error(root.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });
    };
    api[method].__promisified = true;
  }

  // Firefox still uses callbacks for some tabs APIs in MV2.
  if (root.tabs) {
    promisify(root.tabs, 'executeScript');
    promisify(root.tabs, 'insertCSS');
    promisify(root.tabs, 'sendMessage');
  }

  // Expose a unified namespace for convenience.
  window.avano = { browser: root };
})();
