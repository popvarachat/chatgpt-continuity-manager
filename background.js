const STORAGE_KEY = 'uaios.continuity.pendingRollover.bridge.v1';
const ACTIVE_TAB_KEY = 'uaios.continuity.activeHandoffTab.v1';
const TTL_MS = 30 * 60 * 1000;

function isFresh(record) {
  const createdAt = Date.parse(record?.created_at || '');
  return Number.isFinite(createdAt) && Date.now() - createdAt <= TTL_MS;
}

function isProjectLandingUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === 'https://chatgpt.com'
      && /^\/g\/g-p-[^/]+\/project\/?$/i.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function isHomeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === 'https://chatgpt.com' && url.pathname === '/';
  } catch (_) {
    return false;
  }
}

function projectScopeFromLanding(value) {
  try {
    return new URL(value).pathname.replace(/\/project\/?$/i, '');
  } catch (_) {
    return '';
  }
}
async function openHandoffTab(record) {
  if (!record || !isFresh(record) || !isProjectLandingUrl(record.project_href)) {
    throw new Error('Invalid or stale handoff record.');
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: record });
  const tab = await chrome.tabs.create({ url: record.project_href, active: true });
  await chrome.storage.local.set({
    [ACTIVE_TAB_KEY]: {
      tab_id: tab.id,
      project_href: record.project_href,
      scope: record.scope,
      created_at: record.created_at,
      recovery_attempts: 0
    }
  });
  return { tab_id: tab.id, project_href: record.project_href };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'uaios-open-handoff-tab') return false;
  openHandoffTab(message.record)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.local.get(ACTIVE_TAB_KEY);
  const active = data?.[ACTIVE_TAB_KEY];
  if (active?.tab_id === tabId) await chrome.storage.local.remove(ACTIVE_TAB_KEY);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const data = await chrome.storage.local.get(ACTIVE_TAB_KEY);
  const active = data?.[ACTIVE_TAB_KEY];
  if (!active || active.tab_id !== tabId || !isFresh(active)) return;

  const currentUrl = changeInfo.url || tab.url || '';
  const scope = projectScopeFromLanding(active.project_href);
  let currentPath = '';
  try { currentPath = new URL(currentUrl).pathname; } catch (_) {}

  if (scope && (currentPath === `${scope}/project` || currentPath.startsWith(`${scope}/c/`))) {
    return;
  }

  if (isHomeUrl(currentUrl) && Number(active.recovery_attempts || 0) < 2) {
    active.recovery_attempts = Number(active.recovery_attempts || 0) + 1;
    await chrome.storage.local.set({ [ACTIVE_TAB_KEY]: active });
    await chrome.tabs.update(tabId, { url: active.project_href, active: true });
  }
});