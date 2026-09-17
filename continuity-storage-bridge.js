(() => {
  'use strict';

  const STORAGE_KEY = 'uaios.continuity.pendingRollover.bridge.v1';
  const MAIN_SOURCE = 'uaios-continuity-main-v1';
  const BRIDGE_SOURCE = 'uaios-continuity-bridge-v1';
  const TTL_MS = 30 * 60 * 1000;

  function isFresh(record) {
    const createdAt = Date.parse(record?.created_at || '');
    return Number.isFinite(createdAt) && Date.now() - createdAt <= TTL_MS;
  }

  function isProjectLanding(url) {
    return /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project(?:[?#].*)?$/i.test(String(url || ''));
  }

  async function readPending() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const record = data?.[STORAGE_KEY] || null;
    if (!record || !isFresh(record)) {
      if (record) await chrome.storage.local.remove(STORAGE_KEY);
      return null;
    }
    return record;
  }

  async function maybeRecoverProjectLanding() {
    const path = location.pathname || '/';
    if (path !== '/') return false;
    const record = await readPending();
    if (!record || !isProjectLanding(record.project_href)) return false;
    if (Number(record.bridge_redirect_attempts || 0) >= 1) return false;
    record.bridge_redirect_attempts = Number(record.bridge_redirect_attempts || 0) + 1;
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
    location.replace(record.project_href);
    return true;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== MAIN_SOURCE || !message.request_id) return;

    let ok = true;
    let record = null;
    try {
      if (message.type === 'savePending') {
        record = message.record;
        await chrome.storage.local.set({ [STORAGE_KEY]: record });
      } else if (message.type === 'getPending') {
        record = await readPending();
      } else if (message.type === 'clearPending') {
        await chrome.storage.local.remove(STORAGE_KEY);
      } else {
        ok = false;
      }
    } catch (_) {
      ok = false;
    }

    window.postMessage({
      source: BRIDGE_SOURCE,
      request_id: message.request_id,
      ok,
      record
    }, location.origin);
  });

  void maybeRecoverProjectLanding();
  window.addEventListener('pageshow', () => { void maybeRecoverProjectLanding(); });
})();
