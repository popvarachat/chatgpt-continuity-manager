(() => {
  'use strict';

  const REGISTRY_KEY = 'uaios.chatSteward.registry.v1';
  const CONFIG_KEY = 'uaios.chatSteward.config.v1';
  const META_KEY = 'uaios.chatSteward.meta.v1';
  const REQUEST_ID = 'uaios-chat-steward-request-mailbox';
  const REPLY_ID = 'uaios-chat-steward-reply-mailbox';
  const PAGE_SOURCE = 'uaios-chat-steward-page-v1';
  const BRIDGE_SOURCE = 'uaios-chat-steward-bridge-v1';
  const MAX_RECORDS = 10000;
  const engine = globalThis.ChatStewardEngine;
  if (!engine) return;

  function nowIso() { return new Date().toISOString(); }

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

  async function readRegistry() {
    const data = await chrome.storage.local.get(REGISTRY_KEY);
    const payload = data?.[REGISTRY_KEY];
    if (!payload || typeof payload !== 'object') return { schema_version: 1, records: {}, updated_at: null };
    if (!payload.records || typeof payload.records !== 'object') payload.records = {};
    return payload;
  }

  async function readConfig() {
    const data = await chrome.storage.local.get(CONFIG_KEY);
    const raw = data?.[CONFIG_KEY] || {};
    return {
      enabled: raw.enabled !== false,
      autoScanVisitedChats: raw.autoScanVisitedChats !== false,
      autoFullInventory: raw.autoFullInventory !== false,
      includeArchived: raw.includeArchived !== false,
      includeProjects: raw.includeProjects !== false,
      inventoryRefreshHours: Number.isFinite(Number(raw.inventoryRefreshHours))
        ? Math.max(1, Math.min(168, Number(raw.inventoryRefreshHours)))
        : 24,
      projectProfiles: engine.normalizeProjectProfiles(raw.projectProfiles)
    };
  }

  async function readMeta() {
    const data = await chrome.storage.local.get(META_KEY);
    return data?.[META_KEY] && typeof data[META_KEY] === 'object' ? data[META_KEY] : {};
  }

  async function patchMeta(patch) {
    const current = await readMeta();
    const next = { ...current, ...patch };
    if (patch.inventory && typeof patch.inventory === 'object') {
      next.inventory = { ...(current.inventory || {}), ...patch.inventory };
    }
    await chrome.storage.local.set({ [META_KEY]: next });
    return next;
  }

  function trimRegistry(records) {
    const entries = Object.entries(records);
    if (entries.length <= MAX_RECORDS) return records;
    entries.sort((a, b) => Date.parse(b[1]?.last_seen_at || '') - Date.parse(a[1]?.last_seen_at || ''));
    return Object.fromEntries(entries.slice(0, MAX_RECORDS));
  }

  function safeStatus(value) {
    if (value == null || value === '') return null;
    return engine.STATUSES.includes(String(value)) ? String(value) : null;
  }

  function stableImportId(conv) {
    const cid = String(conv?.conversation_id || conv?.id || '').trim();
    if (cid) return `chat:${cid}`;
    const title = String(conv?.title || 'untitled').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80);
    const stamp = String(conv?.create_time || conv?.update_time || Date.now()).replace(/\D/g, '').slice(0, 14);
    return `import:${title || 'untitled'}:${stamp || Date.now()}`;
  }

  async function importConversation(raw) {
    const config = await readConfig();
    const registry = await readRegistry();
    const normalized = engine.normalizeConversation(raw || {});
    const id = stableImportId(normalized);
    const existing = registry.records[id] || null;
    const others = Object.values(registry.records).filter(r => r?.id !== id);
    const classified = engine.classifyConversation(raw || {}, { projectProfiles: config.projectProfiles });
    const duplicate = engine.duplicateRisk(classified.conversation.title, others);
    classified.analysis.scores.duplicate_risk = duplicate.score;

    const record = {
      id,
      conversation_id: classified.conversation.conversation_id || null,
      title: classified.conversation.title,
      url: classified.conversation.url || (classified.conversation.conversation_id ? `https://chatgpt.com/c/${classified.conversation.conversation_id}` : ''),
      source: 'json-import',
      first_seen_at: existing?.first_seen_at || nowIso(),
      last_seen_at: nowIso(),
      message_count: classified.analysis.signals.message_count,
      analysis_state: 'DONE',
      suggestion: classified.analysis,
      duplicate_of: duplicate.similar_record_id ? { id: duplicate.similar_record_id, title: duplicate.similar_title, score: duplicate.score } : null,
      decision: existing?.decision || { status: null, project: null, note: '', decided_at: null }
    };

    registry.schema_version = 1;
    registry.engine_version = engine.ENGINE_VERSION;
    registry.updated_at = nowIso();
    registry.records[id] = record;
    registry.records = trimRegistry(registry.records);
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    await patchMeta({ record_count: Object.keys(registry.records).length });
    return record;
  }

  async function updateDecision(id, patch = {}) {
    const registry = await readRegistry();
    const record = registry.records[id];
    if (!record) throw new Error('Record not found.');
    const status = Object.prototype.hasOwnProperty.call(patch, 'status')
      ? safeStatus(patch.status)
      : record?.decision?.status || null;
    const project = Object.prototype.hasOwnProperty.call(patch, 'project')
      ? String(patch.project || '').trim().slice(0, 160) || null
      : record?.decision?.project || null;
    const note = Object.prototype.hasOwnProperty.call(patch, 'note')
      ? String(patch.note || '').trim().slice(0, 1200)
      : String(record?.decision?.note || '');
    record.decision = { status, project, note, decided_at: nowIso() };
    registry.updated_at = nowIso();
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    return record;
  }

  async function resetDecision(id) {
    const registry = await readRegistry();
    const record = registry.records[id];
    if (!record) throw new Error('Record not found.');
    record.decision = { status: null, project: null, note: '', decided_at: null };
    registry.updated_at = nowIso();
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    return record;
  }

  async function removeRecord(id) {
    const registry = await readRegistry();
    const existed = Boolean(registry.records[id]);
    delete registry.records[id];
    registry.updated_at = nowIso();
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    await patchMeta({ record_count: Object.keys(registry.records).length });
    return { removed: existed };
  }

  async function saveConfig(config = {}) {
    const normalized = {
      enabled: config.enabled !== false,
      autoScanVisitedChats: config.autoScanVisitedChats !== false,
      autoFullInventory: config.autoFullInventory !== false,
      includeArchived: config.includeArchived !== false,
      includeProjects: config.includeProjects !== false,
      inventoryRefreshHours: Number.isFinite(Number(config.inventoryRefreshHours))
        ? Math.max(1, Math.min(168, Number(config.inventoryRefreshHours)))
        : 24,
      projectProfiles: engine.normalizeProjectProfiles(config.projectProfiles)
    };
    await chrome.storage.local.set({ [CONFIG_KEY]: normalized });
    return normalized;
  }

  async function startFullScan(force = false) {
    const requestedAt = nowIso();
    await patchMeta({
      inventory: {
        status: 'requested',
        phase: 'queued',
        force_requested: force === true,
        requested_at: requestedAt,
        updated_at: requestedAt,
        last_error: null
      }
    });
    return { requested: true, force: force === true, requested_at: requestedAt };
  }

  async function getDashboardState() {
    const [registry, config, meta] = await Promise.all([
      readRegistry(),
      readConfig(),
      readMeta()
    ]);
    return {
      engine_version: engine.ENGINE_VERSION,
      registry,
      config,
      meta
    };
  }

  async function handle(message) {
    switch (message.type) {
      case 'ping': return { ok: true, engine_version: engine.ENGINE_VERSION, at: nowIso() };
      case 'getState': return getDashboardState();
      case 'importConversation': return importConversation(message.conversation);
      case 'updateDecision': return updateDecision(String(message.id || ''), message.patch || {});
      case 'resetDecision': return resetDecision(String(message.id || ''));
      case 'removeRecord': return removeRecord(String(message.id || ''));
      case 'saveConfig': return saveConfig(message.config || {});
      case 'startFullScan': return startFullScan(message.force === true);
      default: throw new Error('Unsupported request.');
    }
  }

  function emitReply(payload) { mailbox(REPLY_ID).textContent = JSON.stringify(payload); }

  let lastRequestId = '';
  let observer = null;
  let observed = null;

  function processMailbox() {
    const node = mailbox(REQUEST_ID);
    try {
      const message = JSON.parse(String(node.textContent || '{}'));
      if (!message?.request_id || message.request_id === lastRequestId || message.source !== PAGE_SOURCE) return;
      lastRequestId = message.request_id;
      Promise.resolve(handle(message))
        .then(result => emitReply({ source: BRIDGE_SOURCE, request_id: message.request_id, ok: true, result }))
        .catch(error => emitReply({
          source: BRIDGE_SOURCE,
          request_id: message.request_id,
          ok: false,
          error: String(error?.message || error)
        }));
    } catch (_) {}
  }

  function bindMailbox() {
    const node = mailbox(REQUEST_ID);
    if (observed === node && node.isConnected && observer) { processMailbox(); return; }
    observer?.disconnect();
    observed = node;
    observer = new MutationObserver(processMailbox);
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    processMailbox();
  }

  const documentObserver = new MutationObserver(() => {
    const current = document.getElementById(REQUEST_ID);
    if (!observed?.isConnected || current !== observed) bindMailbox();
  });
  documentObserver.observe(document, { childList: true, subtree: true });
  bindMailbox();
  document.addEventListener('DOMContentLoaded', bindMailbox, { once: true });
})();
