(() => {
  'use strict';

  const STORAGE_KEY = 'uaios.continuity.pendingRollover.bridge.v1';
  const ACTIVE_TAB_KEY = 'uaios.continuity.activeHandoffTab.v1';
  const MAIN_SOURCE = 'uaios-continuity-main-v1';
  const BRIDGE_SOURCE = 'uaios-continuity-bridge-v1';
  const REQUEST_MAILBOX_ID = 'uaios-continuity-bridge-request-mailbox';
  const REPLY_MAILBOX_ID = 'uaios-continuity-bridge-reply-mailbox';
  const TTL_MS = 30 * 60 * 1000;

  function isFresh(record) {
    const createdAt = Date.parse(record?.created_at || '');
    return Number.isFinite(createdAt) && Date.now() - createdAt <= TTL_MS;
  }

  function isProjectLanding(url) {
    return /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project(?:[?#].*)?$/i.test(String(url || ''));
  }

  function mailbox(id) {
    let node = document.getElementById(id);
    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.hidden = true;
      (document.documentElement || document).appendChild(node);
    }
    return node;
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
    const node = mailbox(REPLY_MAILBOX_ID);
    node.textContent = JSON.stringify(message);
  }

  async function handleMessage(message) {
    if (!message || message.source !== MAIN_SOURCE || !message.request_id) return;
    let ok = true;
    let record = null;
    try {
      if (message.type === 'ping') {
        record = { bridge: 'ok', at: new Date().toISOString() };
      } else if (message.type === 'savePending') {
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

  let lastRequestId = '';
  let observedRequestNode = null;
  let mailboxObserver = null;

  const processMailbox = () => {
    const requestNode = mailbox(REQUEST_MAILBOX_ID);
    try {
      const message = JSON.parse(String(requestNode.textContent || '{}'));
      if (!message?.request_id || message.request_id === lastRequestId) return;
      lastRequestId = message.request_id;
      void handleMessage(message);
    } catch (_) {}
  };

  const bindRequestMailbox = () => {
    const requestNode = mailbox(REQUEST_MAILBOX_ID);
    if (observedRequestNode === requestNode && requestNode.isConnected && mailboxObserver) {
      processMailbox();
      return;
    }
    mailboxObserver?.disconnect();
    observedRequestNode = requestNode;
    mailboxObserver = new MutationObserver(processMailbox);
    mailboxObserver.observe(requestNode, { childList: true, characterData: true, subtree: true });
    processMailbox();
  };

  // ChatGPT can rebuild the early document DOM after content scripts run at
  // document_start. Rebind if the shared mailbox node is replaced or detached.
  const documentObserver = new MutationObserver(() => {
    const current = document.getElementById(REQUEST_MAILBOX_ID);
    if (!observedRequestNode?.isConnected || current !== observedRequestNode) {
      bindRequestMailbox();
    }
  });
  documentObserver.observe(document, { childList: true, subtree: true });
  bindRequestMailbox();
  document.addEventListener('DOMContentLoaded', bindRequestMailbox, { once: true });

  // Keep postMessage only as a legacy fallback. Do not compare event.source
  // across Chrome execution worlds because the Window wrappers are distinct.
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.source !== MAIN_SOURCE) return;
    void handleMessage(message);
  });

  void maybeRecoverProjectLanding();
  window.addEventListener('pageshow', () => { void maybeRecoverProjectLanding(); });
})();