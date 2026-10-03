(() => {
  'use strict';

  const REGISTRY_KEY = 'uaios.chatSteward.registry.v1';
  const CONFIG_KEY = 'uaios.chatSteward.config.v1';
  const META_KEY = 'uaios.chatSteward.meta.v1';
  const MAX_RECORDS = 2500;
  const SCAN_DEBOUNCE_MS = 1800;
  const URL_POLL_MS = 2500;

  const engine = globalThis.ChatStewardEngine;
  if (!engine) return;

  let scanTimer = null;
  let lastUrl = location.href;
  let lastFingerprint = '';

  function nowIso() { return new Date().toISOString(); }

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([A-Za-z0-9-]+)/i);
    return match ? match[1] : '';
  }

  function isConversationPage() {
    return Boolean(currentConversationId());
  }

  function cleanTitle() {
    return String(document.title || 'Untitled chat')
      .replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, '')
      .trim()
      .slice(0, 240) || 'Untitled chat';
  }

  function collectVisibleMessages() {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const out = [];
    for (const node of nodes) {
      const role = String(node.getAttribute('data-message-author-role') || '').toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      const content = String(node.innerText || node.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 2400);
      if (!content) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === role && prev.content === content) continue;
      out.push({ role, content });
    }
    return out.slice(-40);
  }

  async function getConfig() {
    try {
      const data = await chrome.storage.local.get(CONFIG_KEY);
      const config = data?.[CONFIG_KEY] || {};
      return {
        enabled: config.enabled !== false,
        projectProfiles: engine.normalizeProjectProfiles(config.projectProfiles),
        autoScanVisitedChats: config.autoScanVisitedChats !== false
      };
    } catch (_) {
      return { enabled: true, projectProfiles: engine.DEFAULT_PROJECTS, autoScanVisitedChats: true };
    }
  }

  async function readRegistry() {
    const data = await chrome.storage.local.get(REGISTRY_KEY);
    const payload = data?.[REGISTRY_KEY];
    if (!payload || typeof payload !== 'object') return { schema_version: 1, records: {} };
    if (!payload.records || typeof payload.records !== 'object') payload.records = {};
    return payload;
  }

  function stableRecordId(conversationId) {
    return conversationId ? `chat:${conversationId}` : `url:${location.pathname}`;
  }

  function fingerprint(title, messages) {
    const last = messages.slice(-4).map(m => `${m.role}:${m.content.slice(0, 160)}`).join('|');
    return `${location.pathname}|${title}|${messages.length}|${last}`;
  }

  function trimRegistry(records) {
    const entries = Object.entries(records);
    if (entries.length <= MAX_RECORDS) return records;
    entries.sort((a, b) => Date.parse(b[1]?.last_seen_at || '') - Date.parse(a[1]?.last_seen_at || ''));
    return Object.fromEntries(entries.slice(0, MAX_RECORDS));
  }

  async function scanCurrentChat() {
    if (!isConversationPage()) return;
    const config = await getConfig();
    if (!config.enabled || !config.autoScanVisitedChats) return;

    const conversationId = currentConversationId();
    const messages = collectVisibleMessages();
    if (messages.length < 2) return;
    const title = cleanTitle();
    const fp = fingerprint(title, messages);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;

    const registry = await readRegistry();
    const id = stableRecordId(conversationId);
    const existing = registry.records[id] || null;
    const others = Object.values(registry.records).filter(r => r?.id !== id);
    const classified = engine.classifyConversation({
      title,
      conversation_id: conversationId,
      url: location.href,
      messages
    }, { projectProfiles: config.projectProfiles });
    const duplicate = engine.duplicateRisk(title, others);
    classified.analysis.scores.duplicate_risk = duplicate.score;

    const record = {
      id,
      conversation_id: conversationId,
      title,
      url: location.href,
      source: 'visited-chat-dom',
      first_seen_at: existing?.first_seen_at || nowIso(),
      last_seen_at: nowIso(),
      message_count: classified.analysis.signals.message_count,
      suggestion: classified.analysis,
      duplicate_of: duplicate.similar_record_id ? {
        id: duplicate.similar_record_id,
        title: duplicate.similar_title,
        score: duplicate.score
      } : null,
      decision: existing?.decision || {
        status: null,
        project: null,
        note: '',
        decided_at: null
      }
    };

    registry.schema_version = 1;
    registry.engine_version = engine.ENGINE_VERSION;
    registry.updated_at = nowIso();
    registry.records[id] = record;
    registry.records = trimRegistry(registry.records);
    await chrome.storage.local.set({
      [REGISTRY_KEY]: registry,
      [META_KEY]: {
        last_scan_at: nowIso(),
        last_scan_chat_id: id,
        record_count: Object.keys(registry.records).length
      }
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { void scanCurrentChat(); }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
  window.addEventListener('pageshow', scheduleScan);
  window.addEventListener('focus', scheduleScan);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastFingerprint = '';
      scheduleScan();
    }
  }, URL_POLL_MS);

  scheduleScan();
})();
