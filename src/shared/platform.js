/**
 * platform.js — resolves the browser APIs that differ between Chromium and
 * Firefox, once, at runtime.
 *
 * Firefox implements none of `tabCapture`, `offscreen` or `action`, so a
 * literal `chrome.tabCapture.*` / `chrome.offscreen.*` / `chrome.action.*`
 * reference makes the add-on linter emit UNSUPPORTED_API warnings.
 *
 * All three are genuinely optional here:
 *  - `tabCapture` is Chromium-only. Firefox falls back to `getDisplayMedia`
 *    inside the audio engine, and `browser-api.js` installs a shim so the
 *    absence is detectable rather than a crash.
 *  - `offscreen` is Chromium-only. The Firefox shim renders the audio engine
 *    into a hidden iframe inside the persistent background page.
 *  - `action` is `browserAction` under Manifest V2.
 *
 * Resolving them here keeps that intent explicit in one place and keeps the
 * manifest lint clean.
 */

const api = globalThis.chrome || globalThis.browser || {};

function resolve(...names) {
  for (const name of names) {
    const value = api[name];
    if (value) return value;
  }
  return null;
}

/** Chromium only. In Firefox this is the shim installed by browser-api.js. */
export const tabCapture = resolve('tabCapture');

/** Chromium only. In Firefox this is the iframe-backed shim. */
export const offscreen = resolve('offscreen');

/** `action` on Manifest V3, `browserAction` on Manifest V2. */
export const action = resolve('action', 'browserAction');

/** Keyboard shortcuts, supported by both browsers. */
export const commands = resolve('commands');

/** `scripting` on MV3; the Firefox shim wraps tabs.executeScript/insertCSS. */
export const scripting = resolve('scripting');

/**
 * True when tab audio can be captured without asking the user to pick a tab.
 * False in Firefox, where `getMediaStreamId` only exists as a shim.
 */
export function hasNativeTabCapture() {
  const tc = tabCapture;
  if (!tc) return false;
  if (tc.__avanoNative === false) return false;
  return typeof tc.getMediaStreamId === 'function';
}

/**
 * Ask Chromium for a tab-capture stream id.
 * Rejects with BROWSER_CAPTURE_REQUIRED where tab capture is unavailable, which
 * tells the caller to let the audio engine request the tab via getDisplayMedia.
 */
export function getMediaStreamId(tabId) {
  const tc = tabCapture;
  if (!tc || typeof tc.getMediaStreamId !== 'function') {
    return Promise.reject(new Error('BROWSER_CAPTURE_REQUIRED'));
  }
  try {
    return Promise.resolve(tc.getMediaStreamId({ targetTabId: tabId }));
  } catch (err) {
    return Promise.reject(err);
  }
}
