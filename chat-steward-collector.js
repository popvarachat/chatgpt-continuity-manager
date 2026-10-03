(() => {
  'use strict';

  const REGISTRY_KEY = 'uaios.chatSteward.registry.v1';
  const CONFIG_KEY = 'uaios.chatSteward.config.v1';
  const META_KEY = 'uaios.chatSteward.meta.v1';
  const MAX_RECORDS = 10000;
  const SCAN_DEBOUNCE_MS = 1800;
  const URL_POLL_MS = 2500;
  const INVENTORY_POLL_MS = 15000;
  const INVENTORY_REFRESH_HOURS = 24;
  const LIST_LIMIT = 28;
  const FETCH_TIMEOUT_MS = 20000;
  const DETAIL_DELAY_MS = 1800;
  const INVENTORY_LOCK_STALE_MS = 120000;
  const BATCH_FLUSH_SIZE = 10;

  const engine = globalThis.ChatStewardEngine;
  if (!engine) return;

  let scanTimer = null;
  let lastUrl = location.href;
  let lastFingerprint = '';
  let inventoryRunning = false;
  let inventoryOwnerToken = '';
  let pendingInventoryUpdates = new Map();

  function nowIso() { return new Date().toISOString(); }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  class HttpError extends Error {
    constructor(status, message, retryAfterMs = 0) {
      super(message || `HTTP ${status}`);
      this.name = 'HttpError';
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  }

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
        autoScanVisitedChats: config.autoScanVisitedChats !== false,
        autoFullInventory: config.autoFullInventory !== false,
        includeArchived: config.includeArchived !== false,
        includeProjects: config.includeProjects !== false,
        inventoryRefreshHours: Number.isFinite(Number(config.inventoryRefreshHours))
          ? Math.max(1, Math.min(168, Number(config.inventoryRefreshHours)))
          : INVENTORY_REFRESH_HOURS
      };
    } catch (_) {
      return {
        enabled: true,
        projectProfiles: engine.DEFAULT_PROJECTS,
        autoScanVisitedChats: true,
        autoFullInventory: true,
        includeArchived: true,
        includeProjects: true,
        inventoryRefreshHours: INVENTORY_REFRESH_HOURS
      };
    }
  }

  async function readRegistry() {
    const data = await chrome.storage.local.get(REGISTRY_KEY);
    const payload = data?.[REGISTRY_KEY];
    if (!payload || typeof payload !== 'object') return { schema_version: 1, records: {} };
    if (!payload.records || typeof payload.records !== 'object') payload.records = {};
    return payload;
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

  function toIsoish(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      const ms = value > 1e12 ? value : value * 1000;
      try { return new Date(ms).toISOString(); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function normalizeListItem(item, extras = {}) {
    const raw = item?.conversation || item?.chat || item || {};
    const id = String(
      raw.id || raw.conversation_id || item?.conversation_id || item?.id || ''
    ).trim();
    if (!id) return null;
    const title = String(
      raw.title || item?.title || raw.name || item?.name || 'Untitled chat'
    ).trim().slice(0, 240) || 'Untitled chat';
    return {
      id,
      title,
      create_time: raw.create_time ?? item?.create_time ?? null,
      update_time: raw.update_time ?? item?.update_time ?? raw.updated_at ?? item?.updated_at ?? null,
      archived: extras.archived ?? raw.is_archived ?? item?.is_archived ?? null,
      project: extras.project || null
    };
  }

  function normalizeProject(item) {
    const outer = item?.gizmo || item || {};
    const raw = outer?.gizmo || outer;
    const id = String(raw?.id || outer?.id || item?.id || '').trim();
    if (!id || !id.startsWith('g-p-')) return null;
    const name = String(
      raw?.display?.name || outer?.display?.name || item?.display?.name ||
      raw?.name || outer?.name || item?.name || id
    ).trim().slice(0, 180);
    return { id, name: name || id };
  }

  function extractItems(data) {
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.conversations)) return data.conversations;
    if (Array.isArray(data?.gizmos)) return data.gizmos;
    if (Array.isArray(data?.data?.items)) return data.data.items;
    return [];
  }

  function extractNextCursor(data, currentCursor = null) {
    const page = data?.page_info || data?.pageInfo || {};
    if (page.has_next_page === true || page.hasNextPage === true) {
      return page.end_cursor || page.endCursor || data?.next_cursor || data?.cursor || null;
    }
    if (data?.has_more === true || data?.hasMore === true) {
      return data?.next_cursor || data?.cursor || null;
    }
    const candidate = data?.next_cursor ?? data?.nextCursor ?? null;
    if (candidate != null && String(candidate) !== String(currentCursor ?? '')) return candidate;
    return null;
  }

  async function getSessionHeaders() {
    const candidates = ['/api/auth/session?unstable_client=true', '/api/auth/session'];
    let session = null;
    let lastError = null;
    for (const path of candidates) {
      try {
        const res = await fetch(path, { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new HttpError(res.status, `Session request failed: ${res.status}`);
        session = await res.json();
        if (session) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!session && lastError) throw lastError;

    const headers = new Headers({ accept: 'application/json' });
    const token = session?.accessToken || session?.access_token || session?.token || null;
    if (token) headers.set('authorization', `Bearer ${token}`);
    const accountId =
      session?.account?.id ||
      session?.activeAccount?.id ||
      session?.active_account?.id ||
      session?.account_id ||
      session?.accountId ||
      null;
    if (accountId) headers.set('chatgpt-account-id', String(accountId));
    return headers;
  }

  function retryAfterMs(response) {
    const value = response.headers.get('retry-after');
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  function observedConversationListUrl(archived) {
    const entries = performance.getEntriesByType('resource').slice().reverse();
    for (const entry of entries) {
      try {
        const url = new URL(entry.name, location.origin);
        if (url.origin !== location.origin || url.pathname !== '/backend-api/conversations') continue;
        const value = url.searchParams.get('is_archived');
        if (archived === true && value !== 'true') continue;
        if (archived === false && value === 'true') continue;
        return url;
      } catch (_) {}
    }
    return null;
  }

  function buildConversationListPath(offset, archived) {
    const observed = observedConversationListUrl(archived);
    const url = observed
      ? new URL(observed.href)
      : new URL('/backend-api/conversations', location.origin);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(LIST_LIMIT));
    if (!url.searchParams.has('order')) url.searchParams.set('order', 'updated');
    if (archived === null) url.searchParams.delete('is_archived');
    else url.searchParams.set('is_archived', archived ? 'true' : 'false');
    return url.pathname + '?' + url.searchParams.toString();
  }

  async function fetchJson(path, headers, options = {}) {
    const maxAttempts = options.maxAttempts ?? 4;
    const allowStatuses = new Set(options.allowStatuses || []);
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(new URL(path, location.origin).href, {
          method: 'GET',
          headers,
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (allowStatuses.has(res.status)) {
          return { __allowed_status: res.status };
        }
        if (res.ok) return await res.json();

        const body = await res.text().catch(() => '');
        const error = new HttpError(
          res.status,
          `HTTP ${res.status} for ${path}${body ? `: ${body.slice(0, 180)}` : ''}`,
          retryAfterMs(res)
        );
        if (res.status === 429 && attempt + 1 < maxAttempts) {
          const wait = Math.max(error.retryAfterMs || 0, Math.min(120000, 60000 * Math.pow(2, attempt)));
          await patchInventoryProgress({
            status: 'backoff',
            last_error: `429 rate limit; retry in ${Math.round(wait / 1000)}s`,
            backoff_until: new Date(Date.now() + wait).toISOString()
          });
          await sleep(wait);
          continue;
        }
        if (res.status >= 500 && attempt + 1 < maxAttempts) {
          await sleep(Math.min(15000, 2000 * Math.pow(2, attempt)));
          continue;
        }
        throw error;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error?.name === 'AbortError') {
          lastError = new Error(`Timeout after ${timeoutMs}ms for ${path}`);
          await patchInventoryProgress({
            last_error: lastError.message,
            request_timeout_at: nowIso()
          });
        } else {
          lastError = error;
        }
        if (error instanceof HttpError) throw error;
        if (attempt + 1 < maxAttempts) {
          await sleep(Math.min(10000, 1500 * Math.pow(2, attempt)));
          continue;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastError || new Error(`Failed to fetch ${path}`);
  }

  async function listRootConversations(headers, archived = null) {
    const out = [];
    let offset = 0;
    for (let page = 0; page < 500; page++) {
      const phase = archived === true ? 'discover_archived' : 'discover_root';
      await patchInventoryProgress({
        phase,
        list_page: page + 1,
        list_scanned: out.length,
        current_request: buildConversationListPath(offset, archived)
      });

      let data = null;
      let path = buildConversationListPath(offset, archived);
      try {
        data = await fetchJson(path, headers);
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) {
          const url = new URL(path, location.origin);
          url.searchParams.set('order', 'updated_at');
          path = url.pathname + '?' + url.searchParams.toString();
          data = await fetchJson(path, headers);
        } else {
          throw error;
        }
      }

      const items = extractItems(data);
      for (const item of items) {
        const meta = normalizeListItem(item, { archived });
        if (meta) out.push(meta);
      }
      const total = Number(data?.total);
      offset += items.length;

      await patchInventoryProgress({
        phase,
        list_page: page + 1,
        list_scanned: out.length,
        list_total: Number.isFinite(total) ? total : null,
        current_request: null
      });

      if (!items.length) break;
      if (Number.isFinite(total) && offset >= total) break;
      if (items.length < LIST_LIMIT) break;
    }
    return out;
  }

  async function listProjects(headers) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({
        owned_only: 'true',
        conversations_per_gizmo: '0',
        limit: String(LIST_LIMIT)
      });
      if (cursor != null) params.set('cursor', String(cursor));
      const data = await fetchJson(`/backend-api/gizmos/snorlax/sidebar?${params.toString()}`, headers);
      const items = extractItems(data);
      for (const item of items) {
        const project = normalizeProject(item);
        if (project) out.push(project);
      }
      const next = extractNextCursor(data, cursor);
      if (next == null || !items.length) break;
      cursor = next;
    }
    return out;
  }

  async function listProjectConversations(headers, project) {
    const out = [];
    let cursor = '0';
    for (let page = 0; page < 500; page++) {
      const params = new URLSearchParams({ cursor: String(cursor), limit: String(LIST_LIMIT) });
      const data = await fetchJson(
        `/backend-api/gizmos/${encodeURIComponent(project.id)}/conversations?${params.toString()}`,
        headers
      );
      const items = extractItems(data);
      for (const item of items) {
        const meta = normalizeListItem(item, { project });
        if (meta) out.push(meta);
      }
      const next = extractNextCursor(data, cursor);
      if (next == null || !items.length) break;
      cursor = String(next);
    }
    return out;
  }

  async function fetchConversationDetail(headers, conversationId) {
    const encoded = encodeURIComponent(conversationId);
    const candidates = [
      `/backend-api/conversations/${encoded}?include_has_versions=true&num_turns=100`,
      `/backend-api/conversation/${encoded}`
    ];
    let lastError = null;
    for (const path of candidates) {
      try {
        return await fetchJson(path, headers, { maxAttempts: 3 });
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && [400, 404, 405].includes(error.status)) continue;
        throw error;
      }
    }
    throw lastError || new Error('Conversation detail unavailable.');
  }

  function mergeMeta(existing, incoming) {
    if (!existing) return incoming;
    return {
      ...existing,
      ...incoming,
      title: incoming.title || existing.title,
      create_time: incoming.create_time ?? existing.create_time,
      update_time: incoming.update_time ?? existing.update_time,
      archived: incoming.archived ?? existing.archived,
      project: incoming.project || existing.project || null
    };
  }

  async function discoverAll(headers, config) {
    const discovered = new Map();

    await patchInventoryProgress({ phase: 'discover_root', discovered: 0 });
    const root = await listRootConversations(headers, false);
    for (const meta of root) discovered.set(meta.id, mergeMeta(discovered.get(meta.id), meta));

    let archived = [];
    if (config.includeArchived) {
      await patchInventoryProgress({ phase: 'discover_archived', root_count: root.length });
      try {
        archived = await listRootConversations(headers, true);
        for (const meta of archived) discovered.set(meta.id, mergeMeta(discovered.get(meta.id), meta));
      } catch (error) {
        await patchInventoryProgress({ archived_error: String(error?.message || error) });
      }
    }

    let projects = [];
    let projectChats = [];
    if (config.includeProjects) {
      await patchInventoryProgress({
        phase: 'discover_projects',
        root_count: root.length,
        archived_count: archived.length
      });
      try {
        projects = await listProjects(headers);
        for (const project of projects) {
          await patchInventoryProgress({
            phase: 'discover_project_chats',
            current_project: project.name,
            project_count: projects.length,
            project_chat_count: projectChats.length
          });
          try {
            const chats = await listProjectConversations(headers, project);
            projectChats.push(...chats);
            for (const meta of chats) discovered.set(meta.id, mergeMeta(discovered.get(meta.id), meta));
          } catch (error) {
            await patchInventoryProgress({
              last_error: `Project ${project.name}: ${String(error?.message || error)}`
            });
          }
        }
      } catch (error) {
        await patchInventoryProgress({ projects_error: String(error?.message || error) });
      }
    }

    return {
      conversations: Array.from(discovered.values()),
      rootCount: root.length,
      archivedCount: archived.length,
      projectCount: projects.length,
      projectChatCount: projectChats.length
    };
  }

  async function flushInventoryUpdates(force = false) {
    if (!pendingInventoryUpdates.size) return;
    if (!force && pendingInventoryUpdates.size < BATCH_FLUSH_SIZE) return;
    const updates = Array.from(pendingInventoryUpdates.values());
    pendingInventoryUpdates = new Map();

    const registry = await readRegistry();
    for (const record of updates) registry.records[record.id] = record;
    registry.schema_version = 1;
    registry.engine_version = engine.ENGINE_VERSION;
    registry.updated_at = nowIso();
    registry.records = trimRegistry(registry.records);
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    await patchMeta({ record_count: Object.keys(registry.records).length });
  }

  function fallbackSuggestion(reason) {
    return {
      schema_version: 1,
      engine_version: engine.ENGINE_VERSION,
      suggested_status: 'REFERENCE',
      confidence: 10,
      scores: { value: 20, completion: 0, reuse: 20, duplicate_risk: 0, project_match: 0 },
      project_suggestion: null,
      open_loop: false,
      next_action: 'Retry content analysis when ChatGPT history access is available.',
      reasons: [reason || 'Content analysis pending.'],
      signals: {
        message_count: 0,
        assistant_turns: 0,
        reference_hits: 0,
        project_hits: 0,
        file_signal: false,
        code_signal: false,
        decision_signal: false
      }
    };
  }

  function conversationUrl(meta) {
    if (meta?.project?.id) {
      return `https://chatgpt.com/g/${encodeURIComponent(meta.project.id)}/c/${encodeURIComponent(meta.id)}`;
    }
    return `https://chatgpt.com/c/${encodeURIComponent(meta.id)}`;
  }

  async function buildInventoryRecord(meta, raw, config, existing, duplicatePool) {
    let analysis = null;
    let messageCount = 0;
    let state = 'DONE';
    let error = null;

    if (raw) {
      const input = {
        ...raw,
        title: meta.title || raw.title,
        conversation_id: meta.id,
        create_time: meta.create_time ?? raw.create_time,
        update_time: meta.update_time ?? raw.update_time,
        url: conversationUrl(meta)
      };
      const classified = engine.classifyConversation(input, { projectProfiles: config.projectProfiles });
      analysis = classified.analysis;
      messageCount = analysis?.signals?.message_count || 0;
      const duplicate = engine.duplicateRisk(meta.title, duplicatePool);
      analysis.scores.duplicate_risk = duplicate.score;
    } else {
      state = 'ERROR';
      error = 'Conversation detail could not be fetched.';
      analysis = fallbackSuggestion(error);
    }

    return {
      id: `chat:${meta.id}`,
      conversation_id: meta.id,
      title: meta.title,
      url: conversationUrl(meta),
      source: 'full-inventory',
      first_seen_at: existing?.first_seen_at || nowIso(),
      last_seen_at: nowIso(),
      remote_create_time: toIsoish(meta.create_time),
      remote_update_time: toIsoish(meta.update_time),
      archived: meta.archived === true,
      chatgpt_project: meta.project || null,
      message_count: messageCount,
      analysis_state: state,
      analysis_error: error,
      suggestion: analysis,
      duplicate_of: existing?.duplicate_of || null,
      decision: existing?.decision || {
        status: null,
        project: null,
        note: '',
        decided_at: null
      }
    };
  }

  async function patchInventoryProgress(patch) {
    const meta = await readMeta();
    const current = meta.inventory || {};
    if (
      current.owner_token &&
      inventoryOwnerToken &&
      current.owner_token !== inventoryOwnerToken &&
      current.status === 'running'
    ) {
      return meta;
    }
    return patchMeta({
      inventory: {
        ...patch,
        owner_token: inventoryOwnerToken || current.owner_token || null,
        updated_at: nowIso()
      }
    });
  }

  async function claimInventory(force = false) {
    const meta = await readMeta();
    const current = meta.inventory || {};
    const updatedAt = Date.parse(current.updated_at || current.started_at || '');
    const runningFresh =
      ['running', 'backoff'].includes(current.status) &&
      Number.isFinite(updatedAt) &&
      Date.now() - updatedAt < INVENTORY_LOCK_STALE_MS;

    if (runningFresh) return false;

    const token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    await patchMeta({
      inventory: {
        ...current,
        status: 'claiming',
        owner_token: token,
        force_requested: force,
        updated_at: nowIso()
      }
    });
    await sleep(250 + Math.floor(Math.random() * 350));
    const confirm = await readMeta();
    if (confirm?.inventory?.owner_token !== token) return false;

    inventoryOwnerToken = token;
    await patchMeta({
      inventory: {
        ...confirm.inventory,
        status: 'running',
        phase: 'auth',
        started_at: nowIso(),
        updated_at: nowIso(),
        completed_at: null,
        last_error: null,
        analyzed: 0,
        processed: 0,
        failed: 0,
        skipped_unchanged: 0
      }
    });
    return true;
  }

  async function runFullInventory(force = false) {
    if (inventoryRunning) return;
    const config = await getConfig();
    if (!config.enabled) return;
    if (!(await claimInventory(force))) return;

    inventoryRunning = true;
    let processed = 0;
    let analyzed = 0;
    let failed = 0;
    let skipped = 0;

    try {
      const headers = await getSessionHeaders();
      const discovery = await discoverAll(headers, config);
      const conversations = discovery.conversations;

      await patchInventoryProgress({
        status: 'running',
        phase: 'analyze',
        discovered: conversations.length,
        root_count: discovery.rootCount,
        archived_count: discovery.archivedCount,
        project_count: discovery.projectCount,
        project_chat_count: discovery.projectChatCount
      });

      const startingRegistry = await readRegistry();
      const duplicatePool = Object.values(startingRegistry.records || {});
      const existingById = startingRegistry.records || {};

      for (const meta of conversations) {
        processed++;
        const recordId = `chat:${meta.id}`;
        const existing = existingById[recordId] || null;
        const remoteUpdate = toIsoish(meta.update_time);
        const unchanged =
          !force &&
          existing?.analysis_state === 'DONE' &&
          existing?.remote_update_time &&
          remoteUpdate &&
          String(existing.remote_update_time) === String(remoteUpdate);

        if (unchanged) {
          skipped++;
          await patchInventoryProgress({
            phase: 'analyze',
            processed,
            analyzed,
            failed,
            skipped_unchanged: skipped,
            current_title: meta.title
          });
          continue;
        }

        let raw = null;
        let fetchError = null;
        try {
          raw = await fetchConversationDetail(headers, meta.id);
        } catch (error) {
          failed++;
          fetchError = error;
        }

        const record = await buildInventoryRecord(meta, raw, config, existing, duplicatePool);
        if (fetchError) {
          record.analysis_state = 'ERROR';
          record.analysis_error = String(fetchError?.message || fetchError);
          record.suggestion = fallbackSuggestion(
            `Content analysis pending: ${record.analysis_error.slice(0, 220)}`
          );
        } else {
          analyzed++;
        }

        pendingInventoryUpdates.set(record.id, record);
        existingById[record.id] = record;
        duplicatePool.push(record);
        await flushInventoryUpdates(false);

        await patchInventoryProgress({
          status: 'running',
          phase: 'analyze',
          processed,
          analyzed,
          failed,
          skipped_unchanged: skipped,
          current_title: meta.title
        });

        await sleep(DETAIL_DELAY_MS);
      }

      await flushInventoryUpdates(true);
      const registry = await readRegistry();
      await patchMeta({
        record_count: Object.keys(registry.records || {}).length,
        inventory: {
          status: 'completed',
          phase: 'done',
          owner_token: inventoryOwnerToken,
          discovered: conversations.length,
          processed,
          analyzed,
          failed,
          skipped_unchanged: skipped,
          root_count: discovery.rootCount,
          archived_count: discovery.archivedCount,
          project_count: discovery.projectCount,
          project_chat_count: discovery.projectChatCount,
          current_title: null,
          completed_at: nowIso(),
          updated_at: nowIso(),
          last_error: failed ? `${failed} conversation(s) need retry.` : null
        }
      });
    } catch (error) {
      await flushInventoryUpdates(true);
      await patchInventoryProgress({
        status: 'paused_error',
        phase: 'error',
        processed,
        analyzed,
        failed,
        skipped_unchanged: skipped,
        last_error: String(error?.message || error)
      });
    } finally {
      inventoryRunning = false;
      inventoryOwnerToken = '';
    }
  }

  async function shouldStartInventory() {
    const config = await getConfig();
    if (!config.enabled || !config.autoFullInventory) return { start: false, force: false };

    const meta = await readMeta();
    const inventory = meta.inventory || {};
    if (inventory.status === 'requested') {
      return { start: true, force: inventory.force_requested === true };
    }
    if (['running', 'backoff', 'claiming'].includes(inventory.status)) {
      const updated = Date.parse(inventory.updated_at || inventory.started_at || '');
      if (Number.isFinite(updated) && Date.now() - updated < INVENTORY_LOCK_STALE_MS) {
        return { start: false, force: false };
      }
    }

    if (!inventory.completed_at) return { start: true, force: false };

    const completed = Date.parse(inventory.completed_at);
    const refreshMs = config.inventoryRefreshHours * 60 * 60 * 1000;
    if (!Number.isFinite(completed) || Date.now() - completed >= refreshMs) {
      return { start: true, force: false };
    }
    return { start: false, force: false };
  }

  async function maybeStartInventory() {
    if (inventoryRunning) return;
    try {
      const decision = await shouldStartInventory();
      if (decision.start) void runFullInventory(decision.force);
    } catch (_) {}
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
      source: existing?.source === 'full-inventory' ? 'full-inventory+visited' : 'visited-chat-dom',
      first_seen_at: existing?.first_seen_at || nowIso(),
      last_seen_at: nowIso(),
      remote_create_time: existing?.remote_create_time || null,
      remote_update_time: existing?.remote_update_time || null,
      archived: existing?.archived || false,
      chatgpt_project: existing?.chatgpt_project || null,
      message_count: classified.analysis.signals.message_count,
      analysis_state: 'DONE',
      analysis_error: null,
      suggestion: classified.analysis,
      duplicate_of: duplicate.similar_record_id ? {
        id: duplicate.similar_record_id,
        title: duplicate.similar_title,
        score: duplicate.score
      } : existing?.duplicate_of || null,
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
    await chrome.storage.local.set({ [REGISTRY_KEY]: registry });
    await patchMeta({
      last_scan_at: nowIso(),
      last_scan_chat_id: id,
      record_count: Object.keys(registry.records).length
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { void scanCurrentChat(); }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
  window.addEventListener('pageshow', () => {
    scheduleScan();
    void maybeStartInventory();
  });
  window.addEventListener('focus', () => {
    scheduleScan();
    void maybeStartInventory();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleScan();
      void maybeStartInventory();
    }
  });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastFingerprint = '';
      scheduleScan();
    }
  }, URL_POLL_MS);

  setInterval(() => { void maybeStartInventory(); }, INVENTORY_POLL_MS);

  scheduleScan();
  setTimeout(() => { void maybeStartInventory(); }, 3500);
})();
