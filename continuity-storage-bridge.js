(() => {
  'use strict';

  const STORAGE_KEY = 'uaios.continuity.pendingRollover.bridge.v1';
  const ACTIVE_TAB_KEY = 'uaios.continuity.activeHandoffTab.v1';
  const MAIN_SOURCE = 'uaios-continuity-main-v1';
  const BRIDGE_SOURCE = 'uaios-continuity-bridge-v1';
  const REQUEST_EVENT = 'uaios-continuity-bridge-request';
  const REPLY_EVENT = 'uaios-continuity-bridge-reply';
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

  function emitReply(message) {
    try {
      window.postMessage(message, location.origin);
    } catch (_) {}
    try {
      document.dispatchEvent(new CustomEvent(REPLY_EVENT, {
        detail: JSON.stringify(message)
      }));
    } catch (_) {}
  }

  async function handleMessage(message) {
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
        await chrome.storage.local.remove([STORAGE_KEY, ACTIVE_TAB_KEY]);
      } else if (message.type === 'openHandoffTab') {
        record = message.record;
        const response = await chrome.runtime.sendMessage({
          type: 'uaios-open-handoff-tab',
          record
        });
        ok = Boolean(response?.ok);
        if (ok && response?.result) record = { ...record, ...response.result };
      } else {
        ok = false;
      }
    } catch (_) {
      ok = false;
    }
    emitReply({
      source: BRIDGE_SOURCE,
      request_id: message.request_id,
      ok,
      record
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    void handleMessage(event.data);
  });

  document.addEventListener(REQUEST_EVENT, (event) => {
    try {
      void handleMessage(JSON.parse(String(event.detail || '{}')));
    } catch (_) {}
  });

  void maybeRecoverProjectLanding();
  window.addEventListener('pageshow', () => { void maybeRecoverProjectLanding(); });
})();