// ==UserScript==
// @name         ChatGPT 對話 JSON 與交接檔匯出工具
// @name:en      ChatGPT Continuity Manager (UAIOS fork)
// @namespace    https://github.com/popvarachat/chatgpt-continuity-manager
// @version      1.8.5
// @description  在 ChatGPT 對話頁匯出目前對話的 raw / handoff JSON，並支援雙區域獨立 session、可追加佇列、移除項目與延後打包。
// @description:en Export ChatGPT conversations as raw/handoff JSON and optionally recover Retry/Continue interruptions with a local rate-limited watchdog.
// @author       SunnyLeu
// @license      MIT
// @homepageURL  https://github.com/popvarachat/chatgpt-continuity-manager
// @supportURL   https://github.com/popvarachat/chatgpt-continuity-manager/issues
// @updateURL    https://raw.githubusercontent.com/popvarachat/chatgpt-continuity-manager/main/chatgpt-conversation-handoff-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/popvarachat/chatgpt-continuity-manager/main/chatgpt-conversation-handoff-exporter.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/*
 * ChatGPT 對話 JSON 與交接檔匯出工具
 * ============================================================
 *
 * 這是一個 Tampermonkey / Userscript 腳本。
 *
 * 主要用途：
 *   1. 在 ChatGPT 對話頁右上角新增兩個按鈕：
 *      -「下載原始 JSON」
 *      -「下載交接 JSON」
 *
 *   2.「下載原始 JSON」會匯出目前對話的 raw conversation JSON。
 *
 *   3.「下載交接 JSON」會把 raw conversation JSON 轉成較精簡、
 *      適合上傳到新 ChatGPT 對話接續前情的 handoff JSON。
 *
 *   4. 一般聊天側邊欄與專案聊天列表提供受控批次 raw / handoff 功能：
 *      使用者可在同一個批次 session 中多次選取並追加 conversation 到佇列；
 *      資料取得完成後仍保留在目前頁面記憶體，只有使用者按下「打包」時，
 *      才以 ZIP STORE（不壓縮）封裝並下載。
 *
 * 設計原則：
 *   - 單一匯出只處理目前使用者正在看的對話。
 *   - 批次選取只處理使用者在 ChatGPT UI 中直接點選的一般對話，
 *     或單一專案內直接點選的專案對話；不列舉或掃描帳號其他對話。
 *   - 批次模式只處理使用者直接選取並確認加入目前 session 的 conversation ID；
 *     不列舉帳號其他對話，也不在背景定時主動抓取 conversation / textdocs。
 *   - 一般聊天與專案聊天各自維持獨立 batch session；兩者可同時存在、各自追加與打包。
 *   - 底層主動資料 request 共用全域 round-robin scheduler，任何時間最多只處理一筆。
 *   - 同一個批次 session 鎖定 raw 或 handoff 類型，可在既有 queue 執行期間繼續追加。
 *   - 批次資料只暫存在目前頁面記憶體；按下「打包」後才建立 ZIP STORE
 *     （compression method 0），不壓縮、不載入第三方 ZIP library。
 *   - 從出現第一個批次選取起，到所有相關 session 打包完成前，使用 beforeunload 防止誤關閉／重新整理。
 *   - 「取消批次下載作業」需再次確認；確認後以一次性 bypass 直接重新整理頁面，以清除整個 session。
 *   - raw 批次沿用單一 raw 匯出語意：封裝 conversation JSON，若有 textdocs 則一併封裝
 *     正規化 `.textdocs.json`；handoff 批次每筆輸出既有 schema 的 `.handoff.json`。
 *   - 不上傳任何資料到第三方伺服器。
 *   - 不把 token、cookie、header、raw JSON 印到 Console。
 *   - 不把驗證資訊寫死在程式碼。
 *   - 所有暫存資料只放在瀏覽器頁面的記憶體中。
 *
 * 注意事項：
 *   - 本腳本依賴 ChatGPT 網頁版目前的內部請求與 DOM 結構。
 *   - ChatGPT 前端或內部 endpoint 若改版，腳本可能需要更新。
 *   - 本腳本不是 OpenAI 官方 API，也不是官方匯出功能。
 */
(function () {
  'use strict';
  // ============================================================
  // 一、全域常數與狀態
  // ============================================================
  /*
   * INSTALL_FLAG 用來避免腳本在同一頁面被重複安裝。
   *
   * ChatGPT 是 SPA（Single Page Application），頁面可能不完整重新載入，
   * Tampermonkey 或瀏覽器也可能因為導航行為導致腳本重複初始化。
   *
   * 若不防重，可能會出現：
   *   - 多個相同按鈕
   *   - 多次包裝 window.fetch
   *   - 重複的 timer / listener
   */
  const INSTALL_FLAG = '__chatgptConversationHandoffExporterInstalled_v120';
  /*
   * 匯出按鈕事件綁定標記。
   *
   * ChatGPT SPA 可能保留既有按鈕節點；此標記用於判斷節點上的
   * click listener 是否屬於目前腳本，必要時重建按鈕以避免殘留
   * listener 或 conversation 狀態。
   */
  const EXPORT_BUTTON_LISTENER_VERSION = '1.2.0';
  const EXPORT_HEADER_BUTTONS_ENABLED = false;
  /*
   * 兩個按鈕的 DOM id。
   *
   * raw button：
   *   下載 ChatGPT 原始 conversation JSON。
   *
   * handoff button：
   *   將原始 conversation JSON 轉換成 handoff JSON 後下載。
   */
  const RAW_BUTTON_ID = 'cgpt-export-raw-json-button';
  const HANDOFF_BUTTON_ID = 'cgpt-export-handoff-json-button';
  /*
   * Header action 共用 selector 與幾何量測容差。
   *
   * HEADER_LAYOUT_TOLERANCE：
   *   只用來吸收 getBoundingClientRect()、clientWidth / scrollWidth 的
   *   次像素與整數取整差異，不作為 viewport / Header 固定寬度門檻。
   *
   * compact / expanded 的決策改由實際版面壓力驅動：
   *   - 右側 action 發生 overflow 或越界。
   *   - 左右 Header 區塊實際重疊。
   *   - expanded 相較 compact 新增左側文字裁切 / 截斷。
   */
  const SHARE_BUTTON_SELECTOR = '[data-testid="share-chat-button"]';
  const HEADER_ACTIONS_SELECTOR = '#conversation-header-actions';
  const HEADER_LAYOUT_TOLERANCE = 1;
  /*
   * backend JSON response 完整性驗證用容差。
   *
   * PerformanceResourceTiming.decodedBodySize 是瀏覽器網路層解碼後的 body bytes；
   * TextEncoder 則計算 JavaScript 實際拿到的 JSON UTF-8 bytes。
   *
   * 正常同源 JSON 兩者應非常接近。保留少量比例與固定 bytes 容差，
   * 避免 BOM、瀏覽器實作細節或極小 response 的微小差異被誤判。
   */
  const RESOURCE_TIMING_BYTE_TOLERANCE_RATIO = 0.01;
  const RESOURCE_TIMING_BYTE_TOLERANCE_MIN = 64;
  const RESOURCE_TIMING_START_SLOP_MS = 5;
  /*
   * 若目前頁面已經安裝過本腳本，就直接結束。
   */
  if (window[INSTALL_FLAG]) {
    return;
  }
  window[INSTALL_FLAG] = true;
  /*
   * capturedRawByConversationId：
   *   暫存被動觀察到或已驗證通過的 conversation JSON。
   *
   *   key：conversation_id
   *   value：
   *     {
   *       rawText: string,     // 原始 JSON 字串
   *       capturedAt: number   // 捕捉時間，Date.now()
   *     }
   *
   * 注意：
   *   這些資料只存在目前頁面的記憶體中，不會寫入 localStorage、
   *   IndexedDB、cookie 或任何永久儲存區。
   */
  const capturedRawByConversationId = new Map();
  /*
   * replayRequestByConversationId：
   *   暫存可重新抓取目前對話 JSON 的請求資訊。
   *
   * 目的：
   *   使用者可能新增訊息、編輯訊息、重新產生回答。
   *   若只下載一開始捕捉到的 raw JSON，可能不是最新狀態。
   *
   *   因此腳本會在 ChatGPT 自己成功請求 conversation JSON 時，
   *   記住必要且安全可重用的請求資訊。
   *
   * 注意：
   *   - 不主動讀取 document.cookie。
   *   - 不把 cookie 寫進 headers。
   *   - 不把 headers 印到 Console。
   *   - 實際重抓時使用 credentials: 'include'，讓瀏覽器自行處理同源驗證。
   */
  const replayRequestByConversationId = new Map();
  /*
   * latestReplayRequestTemplate：
   *   保存最近一次可用的 ChatGPT backend API 請求樣板。
   *
   * 用途：
   *   新對話剛建立完成時，ChatGPT 不一定會立刻發出
   *   /backend-api/conversation/{conversation_id} 這個完整對話 JSON 請求。
   *
   *   但新對話送出訊息或接收回覆時，通常仍會呼叫其他 /backend-api/...
   *   endpoint。這些同源請求可提供匯出時重新抓取 JSON 所需的安全
   *   headers 樣板。
   *
   * 注意：
   *   - 這不是背景補抓。
   *   - 不會主動定時打 API。
   *   - 只有使用者按下匯出按鈕時才會用它抓最新 JSON。
   *   - 不保存 cookie。
   *   - 不輸出 headers。
   */
  let latestReplayRequestTemplate = null;
  /*
   * SPA 導航與 UI 插入控制用狀態。
   *
   * lastPathname：記錄上一個路徑，用來偵測 ChatGPT SPA 內部換頁。
   * ensureTimer：避免短時間內重複排程 UI 插入。
   * uiStarted：避免重複啟動 UI 觀察與輪詢。
   * activeExportState：匯出進行中時保留目前進度文字，避免被週期性 UI refresh 覆蓋。
   */
  let lastPathname = location.pathname;
  let ensureTimer = null;
  let uiStarted = false;
  let activeExportState = null;
  /*
   * ChatGPT 回覆中的內嵌引用標記，例如：
   *   citeturn0search0
   *   fileciteturn1file3
   *
   * handoff JSON 主要要給新對話閱讀，因此這類 UI 內嵌標記會移除。
   */
  const INLINE_MARK_PATTERN = /.*?/gs;
  /*
   * handoff JSON 只保留 user / assistant。
   *
   * system、tool 等內部訊息通常會讓新對話失焦，因此不輸出。
   */
  const ALLOWED_ROLES = new Set(['user', 'assistant']);
  /*
   * 這些 content_type 不輸出到 handoff：
   *
   * thoughts：
   *   模型思考過程。
   *
   * reasoning_recap：
   *   推理摘要或內部推理資訊。
   *
   * user_editable_context：
   *   使用者設定 / 個人化上下文，不屬於實際對話訊息。
   */
  const EXCLUDED_CONTENT_TYPES = new Set([
    'thoughts',
    'reasoning_recap',
    'user_editable_context'
  ]);
  /*
   * 某些 assistant 訊息其實是工具操作內容，而不是一般可讀回覆。
   *
   * 這裡先處理較明顯的非 canmore 工具 payload，例如 web 搜尋、
   * 商品查詢、天氣、計算器等工具呼叫。畫布 / textdocs 相關工具
   * 會另外透過 recipient 與 JSON payload 結構判斷。
   */
  const ASSISTANT_TOOL_OPERATION_PATTERN =
    /(^|\n)\s*\{?\s*\"?(search_query|open|find|click|image_query|product_query|sports|finance|weather|calculator|time)\"?\s*:/i;
  /*
   * 兩個按鈕使用的 inline SVG。
   *
   * 使用 inline SVG 的理由：
   *   - 不需要額外載入圖片。
   *   - 不依賴外部 CDN。
   *   - 顏色會跟著 currentColor，自動配合 ChatGPT UI 主題。
   */
  const RAW_JSON_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" class="-ms-0.5 icon" fill="none">
          <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14 2v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M10 12l-2 2 2 2M14 12l2 2-2 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
  `;
  const HANDOFF_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" class="-ms-0.5 icon" fill="none">
          <path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M14 4v5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 15h8M8 18h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
  `;
  // ============================================================
  // 二、安全 Log 與錯誤處理輔助函式
  // ============================================================
  /*
   * 本腳本會處理對話 JSON 與請求上下文。
   *
   * 為了避免使用者不小心截圖或複製 Console 時外洩敏感資訊，
   * log 設計採取「最小揭露」原則：
   *
   *   - 不輸出 raw JSON。
   *   - 不輸出 headers。
   *   - 不輸出 cookie。
   *   - 不輸出 bearer token。
   *   - 不輸出完整 response body。
   *
   * 只輸出事件名稱、conversation ID、狀態碼、訊息摘要。
   */
  const LOG_PREFIX = '[ChatGPT 對話匯出工具]';
  /*
   * 建立 Console log 使用的本機時間戳記。
   *
   * 格式：
   *   [yyyy/MM/dd HH:mm:ss]
   *
   * 這裡使用瀏覽器本機時間，方便使用者直接對照操作時間與頁面事件。
   */
  function getLogTimestampPrefix(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `[${year}/${month}/${day} ${hour}:${minute}:${second}]`;
  }
  /*
   * 建立 Console log 前綴。
   *
   * 每次輸出時即時計算時間，避免長時間頁面停留後仍使用過期時間。
   */
  function getLogPrefix() {
    return `${getLogTimestampPrefix()} ${LOG_PREFIX}`;
  }
  /*
   * 輸出一般狀態訊息。
   *
   * 只允許輸出安全摘要，不應傳入 raw JSON、headers、cookie 或 token。
   */
  function logInfo(message, data = null) {
    const prefix = getLogPrefix();
    if (data === null || data === undefined) {
      console.info(prefix, message);
      return;
    }
    console.info(prefix, message, data);
  }
  /*
   * 輸出可恢復的警告訊息。
   *
   * 例如 textdocs 取得失敗但主要匯出仍可繼續時，使用 warning 而不是 error。
   */
  function logWarn(message, data = null) {
    const prefix = getLogPrefix();
    if (data === null || data === undefined) {
      console.warn(prefix, message);
      return;
    }
    console.warn(prefix, message, data);
  }
  /*
   * 輸出需要使用者注意的錯誤摘要。
   *
   * 只保留錯誤名稱與訊息，避免把 response body 或請求內容印到 Console。
   */
  function logError(message, error = null) {
    const prefix = getLogPrefix();
    if (!error) {
      console.error(prefix, message);
      return;
    }
    console.error(prefix, message, {
      name: error.name || 'Error',
      message: error.message || String(error)
    });
  }
  /*
   * 將任意錯誤值轉成可顯示文字。
   *
   * JavaScript throw 的值不一定是 Error 物件，因此這裡統一轉字串。
   */
  function toErrorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  /*
   * 依 HTTP 狀態碼補上使用者可採取的處理建議。
   *
   * 這些訊息只顯示在錯誤提示中，不會改變匯出流程本身。
   */
  function getHttpStatusSuggestion(status) {
    if (status === 401 || status === 403) {
      return '建議：重新整理頁面確認登入狀態仍有效；若仍失敗，請重新登入 ChatGPT 後再試。';
    }
    if (status === 404) {
      return '建議：確認目前頁面仍是同一個對話，或重新整理此對話頁後再試。';
    }
    if (status === 408 || status === 425 || status === 429) {
      return '建議：稍候片刻再試，避免在短時間內連續重複匯出。';
    }
    if (status >= 500) {
      return '建議：ChatGPT 後端可能暫時異常，請稍後再試。';
    }
    return '建議：重新整理頁面，等待對話內容載入完成後再試。';
  }
  /*
   * 建立缺少 request context 時的錯誤訊息。
   *
   * 常見原因是腳本尚未攔截到 ChatGPT 自己發出的 backend API 請求。
   */
  function buildMissingRequestContextMessage(dataName) {
    return (
      `目前無法取得此對話的 ${dataName} 請求資訊。\n\n` +
      '建議：先等待對話內容完全載入，再按一次匯出按鈕。\n' +
      '如果仍然失敗，請重新整理頁面，或重新進入這段對話後再試。'
    );
  }
  /*
   * 顯示使用者可理解的錯誤訊息。
   *
   * 使用 alert 的好處是簡單、明確，而且不需要額外建立提示元件。
   */
  function showErrorAlert(error) {
    alert(toErrorMessage(error));
  }
  // ============================================================
  // 三、網址、標題、時間與檔名處理
  // ============================================================
  /*
   * 檢查字串是否符合 ChatGPT conversation ID 常見的 UUID 格式。
   *
   * 這只是格式檢查，不代表該 ID 一定存在或可存取。
   */
  function looksLikeUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      String(value || '')
    );
  }
  /*
   * 從目前網址取得 /c/ 後方的原始 ID。
   *
   * 這個值可能是正式 conversation UUID，也可能是 ChatGPT 前端在
   * 建立分支對話前使用的暫存 ID。呼叫端必須再檢查是否可匯出。
   */
  function getRawConversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
  /*
   * 判斷 ID 是否可作為匯出用 conversation ID。
   *
   * 只有正式 UUID 會對應可重新抓取的 backend conversation JSON。
   * 例如 WEB: 開頭的前端暫存 ID 不應顯示匯出按鈕，也不應送往
   * /backend-api/conversation/{conversation_id}。
   */
  function isExportableConversationId(value) {
    return looksLikeUuid(value);
  }
  /*
   * 從目前網址取得可匯出的 conversation ID。
   */
  function getConversationIdFromUrl() {
    const conversationId = getRawConversationIdFromUrl();
    return isExportableConversationId(conversationId) ? conversationId : null;
  }
  /*
   * 判斷目前頁面是否是可匯出的 ChatGPT 對話頁。
   *
   * 支援：
   *   https://chatgpt.com/c/{conversation_id}
   *   https://chatgpt.com/g/.../c/{conversation_id}
   *
   * 不支援尚未建立完成的前端暫存對話 ID。
   */
  function isConversationPage() {
    return Boolean(getConversationIdFromUrl());
  }
  /*
   * 從 ChatGPT 原始 conversation endpoint 取得 conversation ID。
   *
   * 只接受精確 endpoint：
   *   /backend-api/conversation/{conversation_id}
   *
   * 不接受：
   *   /backend-api/conversation/{conversation_id}/...
   *
   * 這樣可以避免把 stream_status、textdocs 等子路徑回應誤認為 raw conversation JSON。
   */
  function getConversationIdFromExactApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/?$/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return looksLikeUuid(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }
  /*
   * 從 conversation 相關子路徑取得 conversation ID。
   *
   * 新對話完成後，ChatGPT 常見請求可能是：
   *   /backend-api/conversation/{conversation_id}/stream_status
   *   /backend-api/conversation/{conversation_id}/textdocs
   *
   * 這些不是 raw conversation JSON，但它們帶有目前 conversation ID，
   * 可以作為重新抓取 raw JSON 時的 request context 來源。
   */
  function getConversationIdFromScopedApiUrl(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      const match = parsedUrl.pathname.match(/^\/backend-api\/conversation\/([^/]+)(?:\/|$)/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return looksLikeUuid(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }
  /*
   * 判斷是否為可用來建立請求樣板的 ChatGPT backend API 請求。
   *
   * 這個判斷刻意比 conversation endpoint 寬：
   *   - 新對話送出訊息時，不一定會打完整 conversation JSON endpoint。
   *   - 但只要有其他 /backend-api/... 請求，就可能帶有重新抓取 JSON 需要的 headers。
   *
   * 這裡只保存安全篩選後的 headers，不保存 body、cookie 或回應內容。
   */
  function isReusableBackendApiRequest(url) {
    try {
      const parsedUrl = new URL(url, location.origin);
      if (parsedUrl.origin !== location.origin) {
        return false;
      }
      if (!parsedUrl.pathname.startsWith('/backend-api/')) {
        return false;
      }
      /*
       * estuary/public_content 之類資產請求與匯出 conversation JSON 關聯較低，
       * 不拿來當 request template。
       */
      if (parsedUrl.pathname.includes('/public_content/')) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  /*
   * 從 fetch 的 input 參數中取出 URL。
   *
   * fetch 可能被呼叫成：
   *   fetch("...")
   *   fetch(new URL(...))
   *   fetch(new Request(...))
   */
  function getRequestUrl(input) {
    if (typeof input === 'string') {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    if (input && typeof input.url === 'string') {
      return input.url;
    }
    return '';
  }
  /*
   * 將日期時間欄位補成兩位數。
   *
   * 主要用於檔名時間戳與 tooltip 顯示時間。
   */
  function pad2(value) {
    return String(value).padStart(2, '0');
  }
  /*
   * 產生檔名用時間戳。
   *
   * 格式：
   *   yyyyMMddHHmmss
   */
  function getTimestampString(date = new Date()) {
    return [
      date.getFullYear(),
      pad2(date.getMonth() + 1),
      pad2(date.getDate()),
      pad2(date.getHours()),
      pad2(date.getMinutes()),
      pad2(date.getSeconds())
    ].join('');
  }
  /*
   * tooltip 顯示用時間。
   */
  function getDisplayDateTime(date = new Date()) {
    return [
      `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    ].join(' ');
  }
  /*
   * 將 Unix timestamp 轉成 UTC ISO 字串。
   *
   * 輸出使用 +00:00 後綴，讓時間格式更直觀。
   */
  function toUtcIsoString(date) {
    return date.toISOString().replace('Z', '+00:00');
  }
  /*
   * 正規化 ISO 時間字串。
   *
   * 目標是統一輸出毫秒 3 位與明確的 UTC offset，讓 handoff JSON 的時間格式穩定。
   */
  function normalizeIsoTimeString(value) {
    const stripped = String(value || '').trim();
    const match = stripped.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i
    );
    if (!match) {
      return stripped;
    }
    const base = match[1];
    const milliseconds = String(match[2] || '000').slice(0, 3).padEnd(3, '0');
    const offset = match[3].toUpperCase() === 'Z' ? '+00:00' : match[3];
    return `${base}.${milliseconds}${offset}`;
  }
  /*
   * 取得可排序的時間數值。
   *
   * 無法解析的時間會排到最後，避免影響已知建立時間的 textdocs 排序。
   */
  function getTimeSortValue(value) {
    const normalized = toReadableTime(value);
    if (!normalized) {
      return Number.POSITIVE_INFINITY;
    }
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }
  /*
   * 將 conversation JSON 裡的時間值轉成可讀字串。
   *
   * 支援：
   *   - number：視為 Unix timestamp 秒數。
   *   - numeric string：同上。
   *   - 一般 string：原樣保留。
   */
  function toReadableTime(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return toUtcIsoString(new Date(value * 1000));
    }
    if (typeof value === 'string') {
      const stripped = value.trim();
      if (!stripped) {
        return null;
      }
      if (/^[+-]?\d+(?:\.\d+)?$/.test(stripped)) {
        const numeric = Number(stripped);
        if (Number.isFinite(numeric)) {
          return toUtcIsoString(new Date(numeric * 1000));
        }
      }
      return normalizeIsoTimeString(stripped);
    }
    return null;
  }
  /*
   * 清理檔名片段。
   *
   * Windows 不允許的字元：
   *   \ / : * ? " < > |
   *
   * 另外也會移除控制字元、尾端句點與空白。
   */
  function sanitizeFilenamePart(value) {
    const sanitized = String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 120);
    return sanitized || 'chatgpt-conversation';
  }
  /*
   * 從 conversation 物件取得標題。
   */
  function getConversationTitle(conversation, fallback = 'chatgpt-conversation') {
    if (conversation && typeof conversation.title === 'string' && conversation.title.trim()) {
      return conversation.title.trim();
    }
    return fallback;
  }
  /*
   * 清理瀏覽器 document.title。
   *
   * 僅移除明確以空白分隔的 ChatGPT 品牌前綴或後綴，例如：
   *   ChatGPT - My Title
   *   ChatGPT | My Title
   *   My Title - ChatGPT
   *
   * 不移除沒有空白分隔的標題，例如：
   *   ChatGPT-Conversation-Handoff-Exporter
   */
  function cleanBrowserTitle(value) {
    let title = String(value || '').trim();
    if (!title || /^chatgpt$/i.test(title)) {
      return '';
    }
    title = title
      .replace(/^ChatGPT\s+[-–—|]\s+/i, '')
      .replace(/\s+[-–—|]\s+ChatGPT$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || /^chatgpt$/i.test(title)) {
      return '';
    }
    return title;
  }
  /*
   * CSS attribute selector 簡易跳脫。
   *
   * 用於查找目前對話在側邊欄中的連結文字。
   */
  function cssAttributeEscape(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }
  /*
   * 從側邊欄或目前頁面連結取得 conversation 標題。
   *
   * 專案對話中 document.title 可能是專案名稱，而不是目前對話名稱；
   * 因此 tooltip 標題會優先使用連到目前 conversation ID 的頁面連結文字。
   */
  function getTitleFromConversationLink(conversationId) {
    if (!conversationId) {
      return '';
    }
    try {
      const escapedId = cssAttributeEscape(conversationId);
      const links = document.querySelectorAll(`a[href*="/c/${escapedId}"]`);
      for (const link of links) {
        const text = String(link.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          text &&
          text.length <= 160 &&
          !/^ChatGPT$/i.test(text) &&
          !text.includes('下載原始 JSON') &&
          !text.includes('下載交接 JSON')
        ) {
          return text;
        }
      }
    } catch {
      // DOM 查找只是輔助，不成功也不影響匯出。
    }
    return '';
  }
  /*
   * 從已捕捉的 raw conversation JSON 取得對話標題。
   *
   * 這個來源通常比 document.title 更準，尤其是在 project 對話頁中。
   */
  function getTitleFromCapturedRawJson(conversationId) {
    const capture = capturedRawByConversationId.get(conversationId);
    if (!capture || !capture.rawText) {
      return '';
    }
    if (typeof capture.title === 'string' && capture.title.trim()) {
      return capture.title.trim();
    }
    try {
      const conversation = JSON.parse(capture.rawText);
      const title = getConversationTitle(conversation, '');
      capture.title = title;
      return title;
    } catch {
      return '';
    }
  }
  /*
   * tooltip 顯示用標題。
   *
   * 取值順序：
   *   1. 連到目前 conversation ID 的頁面連結文字
   *   2. 已捕捉 raw JSON 中的 title
   *   3. document.title
   *
   * 這樣可避免專案對話中 tooltip 誤顯示專案名稱。
   */
  function getKnownConversationTitle(conversationId) {
    const linkTitle = getTitleFromConversationLink(conversationId);
    if (linkTitle) {
      return linkTitle;
    }
    const capturedTitle = getTitleFromCapturedRawJson(conversationId);
    if (capturedTitle) {
      return capturedTitle;
    }
    return cleanBrowserTitle(document.title);
  }
  /*
   * 從 raw JSON 取得下載檔名用標題。
   *
   * 若 raw JSON 無法解析，退回 conversation ID，避免檔名產生流程中斷。
   */
  function tryGetTitleFromRawJson(rawText, conversationId) {
    try {
      const data = JSON.parse(rawText);
      return getConversationTitle(data, conversationId || 'chatgpt-conversation');
    } catch {
      return conversationId || 'chatgpt-conversation';
    }
  }
  /*
   * 建立 raw conversation JSON 的下載檔名。
   */
  function buildRawFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.json`;
  }
  /*
   * 建立 textdocs 原始 JSON 的下載檔名。
   */
  function buildTextdocsFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.textdocs.json`;
  }
  /*
   * 建立 handoff JSON 的下載檔名。
   */
  function buildHandoffFilename(rawText, conversationId, timestamp = getTimestampString()) {
    const title = sanitizeFilenamePart(tryGetTitleFromRawJson(rawText, conversationId));
    return `${title}-${timestamp}.handoff.json`;
  }
  /*
   * 下載文字檔。
   */
  function downloadTextFile(text, filename, mimeType = 'application/json;charset=utf-8') {
    const blob = new Blob([text], {
      type: mimeType
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  // ============================================================
  // 四、捕捉與重新抓取 ChatGPT 原始 conversation JSON
  // ============================================================
  /*
   * 不適合手動重用的 request headers。
   *
   * 這個集合固定不變，放在函式外可避免每次複製 headers 時重複建立 Set。
   */
  const FORBIDDEN_REPLAY_HEADERS = new Set([
    'accept-encoding',
    'access-control-request-headers',
    'access-control-request-method',
    'connection',
    'content-length',
    'cookie',
    'cookie2',
    'date',
    'expect',
    'host',
    'keep-alive',
    'origin',
    'permissions-policy',
    'priority',
    'referer',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'user-agent',
    'via'
  ]);
  /*
   * 判斷哪些 header 適合重用。
   *
   * 不重用的 header 類型：
   *   - 瀏覽器禁止手動設定的 header。
   *   - cookie / user-agent / referer 等敏感或不必要 header。
   *   - sec-* 系列瀏覽器安全 header。
   *
   * cookie 不需要也不應該手動複製。
   * 重抓時會使用 credentials: 'include'，讓瀏覽器自行處理同源 cookie。
   */
  function shouldReplayHeader(name) {
    const lowerName = String(name || '').toLowerCase();
    if (!lowerName) {
      return false;
    }
    if (lowerName.startsWith('sec-')) {
      return false;
    }
    return !FORBIDDEN_REPLAY_HEADERS.has(lowerName);
  }
  /*
   * 複製可安全重用的 request headers。
   *
   * 這裡會套用 shouldReplayHeader()，避免手動保存 cookie 或瀏覽器管理的安全 headers。
   */
  function copyHeadersFrom(headersLike, targetHeaders) {
    if (!headersLike) {
      return;
    }
    try {
      const sourceHeaders = new Headers(headersLike);
      sourceHeaders.forEach((value, key) => {
        if (shouldReplayHeader(key)) {
          targetHeaders.set(key, value);
        }
      });
    } catch {
      // 某些非標準 headers 物件可能無法被 Headers 建構式處理，忽略即可。
    }
  }
  /*
   * 從原始 fetch 呼叫中取出可安全重用的 headers。
   */
  function getReplayHeaders(input, init) {
    const headers = new Headers();
    if (input && typeof input === 'object' && 'headers' in input) {
      copyHeadersFrom(input.headers, headers);
    }
    if (init && init.headers) {
      copyHeadersFrom(init.headers, headers);
    }
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    return headers;
  }
  /*
   * 判斷 headers 是否足以作為重新抓取 ChatGPT backend API 的樣板。
   *
   * Authorization 是重抓必要條件；ChatGPT client context header 用於
   * 確認這是同源前端 API 請求樣板。x-oai-is 只是可用信號之一，
   * 不作唯一條件。實際重抓後仍會驗證 conversation_id。
   */
  function hasReusableAuthHeaders(headers) {
    if (!headers || !headers.has('authorization')) {
      return false;
    }
    return (
      headers.has('x-oai-is') ||
      headers.has('oai-session-id') ||
      headers.has('oai-device-id') ||
      headers.has('oai-client-version') ||
      headers.has('oai-client-build-number')
    );
  }
  /*
   * 保存最近一次 backend API 請求樣板。
   *
   * 這個樣板只在使用者按下匯出按鈕時使用，
   * 用來補足目前對話尚未產生專屬 raw JSON request context 的情況。
   */
  function captureReplayTemplate(input, init) {
    const headers = getReplayHeaders(input, init);
    if (!hasReusableAuthHeaders(headers)) {
      return;
    }
    latestReplayRequestTemplate = {
      headers,
      capturedAt: Date.now()
    };
  }
  /*
   * 記住某個 conversation_id 的重抓請求資訊。
   */
  function captureReplayRequest(conversationId, input, init) {
    if (!conversationId) {
      return;
    }
    const requestUrl = getRequestUrl(input);
    if (!requestUrl) {
      return;
    }
    const headers = getReplayHeaders(input, init);
    if (!hasReusableAuthHeaders(headers)) {
      return;
    }
    const replayRequest = {
      url: new URL(requestUrl, location.origin).href,
      headers,
      capturedAt: Date.now()
    };
    replayRequestByConversationId.set(conversationId, replayRequest);
    latestReplayRequestTemplate = {
      headers: new Headers(replayRequest.headers),
      capturedAt: replayRequest.capturedAt
    };
  }
  /*
   * 把 raw JSON 暫存到記憶體。
   *
   * title 會一併快取，避免 tooltip 更新時重複解析大型 raw JSON。
   */
  function rememberRawConversation(conversationId, rawText, conversation = null, source = 'observed') {
    const title = conversation ? getConversationTitle(conversation, '') : '';
    capturedRawByConversationId.set(conversationId, {
      rawText,
      capturedAt: Date.now(),
      title,
      source
    });
    logInfo(
      source.startsWith('authoritative')
        ? '已更新可信 conversation JSON。'
        : '已捕捉 conversation JSON。',
      {
        conversationId,
        length: rawText.length,
        source
      }
    );
    ensureButtonsSoon();
  }
  /*
   * 快速判斷一段文字是否像完整 conversation JSON。
   *
   * 只接受包含：
   *   - mapping
   *   - current_node
   *
   * 的 JSON 物件。
   */
  function looksLikeConversationObject(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed.startsWith('{')) {
      return false;
    }
    try {
      const data = JSON.parse(trimmed);
      return Boolean(
        data &&
        typeof data === 'object' &&
        typeof data.mapping === 'object' &&
        typeof data.current_node === 'string'
      );
    } catch {
      return false;
    }
  }
  /*
   * 解析並驗證 raw conversation JSON。
   *
   * 這裡會比對：
   *   目前網址上的 conversation ID
   *   raw JSON 內的 conversation_id
   *
   * 若不一致就停止下載，避免 SPA 切換對話時誤抓上一個對話。
   */
  function parseAndValidateRawConversation(rawText, expectedConversationId) {
    let conversation;
    try {
      conversation = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`raw JSON 解析失敗：${toErrorMessage(error)}`);
    }
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
      throw new Error('raw JSON 不是有效的 conversation 物件。');
    }
    if (!conversation.mapping || typeof conversation.mapping !== 'object' || Array.isArray(conversation.mapping)) {
      throw new Error('raw JSON 不包含有效的 mapping 物件。');
    }
    if (typeof conversation.current_node !== 'string' || !conversation.current_node) {
      throw new Error('raw JSON 不包含有效的 current_node。');
    }
    if (!Object.prototype.hasOwnProperty.call(conversation.mapping, conversation.current_node)) {
      throw new Error('raw JSON 的 current_node 不存在於 mapping 中。');
    }
    if (typeof conversation.conversation_id !== 'string' || !conversation.conversation_id) {
      throw new Error('raw JSON 不包含有效的 conversation_id。');
    }
    if (expectedConversationId && conversation.conversation_id !== expectedConversationId) {
      throw new Error(
        '下載中止：目前網址的 conversation ID 與 raw JSON 內的 conversation_id 不一致。\n\n' +
        `目前網址 ID：${expectedConversationId}\n` +
        `raw JSON ID：${conversation.conversation_id}\n\n` +
        '這通常表示頁面剛切換對話，或捕捉到上一段對話資料。\n' +
        '建議：確認目前仍停留在要匯出的對話，等待內容載入完成後再按一次。'
      );
    }
    return conversation;
  }
  /*
   * 從 ChatGPT 自己成功取得的 response 複製一份 raw JSON。
   *
   * 使用 response.clone() 的理由：
   *   原頁面仍要使用原本 response。
   *   clone 後讀取副本，不會破壞 ChatGPT 本身的流程。
   */
  function captureConversationResponse(conversationId, response) {
    if (!conversationId || !response || !response.ok) {
      return;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return;
    }
    const clonedResponse = response.clone();
    window.setTimeout(() => {
      clonedResponse
        .text()
        .then((rawText) => {
          if (!looksLikeConversationObject(rawText)) {
            return;
          }
          let conversation;
          try {
            conversation = parseAndValidateRawConversation(rawText, conversationId);
          } catch {
            return;
          }
          rememberRawConversation(conversationId, rawText, conversation, 'observed-fetch');
        })
        .catch((error) => {
          logWarn('捕捉 conversation JSON 失敗。', {
            message: toErrorMessage(error)
          });
        });
    }, 0);
  }
  /*
   * 包裝 window.fetch。
   *
   * 用途：
   *   - 觀察 ChatGPT 頁面自己發出的 conversation JSON 請求。
   *   - 記住可重抓的請求資訊。
   *   - 捕捉成功回應作為 observed JSON，供標題 / 狀態與輔助比較使用。
   *
   * 注意：被動 response 可能已被其他 page script / userscript / extension 改寫，
   * 因此正式 raw / handoff 匯出不會直接把這份 capture 視為 authoritative JSON。
   *
   * 這裡不會：
   *   - 修改 ChatGPT 的請求內容。
   *   - 阻擋原始請求。
   *   - 把敏感資訊印出來。
   */
  function installFetchInterceptor() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== 'function') {
      return;
    }
    if (originalFetch.__chatgptConversationHandoffExporterWrapped) {
      return;
    }
    function interceptedFetch(input, init) {
      const requestUrl = getRequestUrl(input);
      const exactConversationId = getConversationIdFromExactApiUrl(requestUrl);
      const scopedConversationId = getConversationIdFromScopedApiUrl(requestUrl);
      if (isReusableBackendApiRequest(requestUrl)) {
        captureReplayTemplate(input, init);
      }
      if (scopedConversationId) {
        captureReplayRequest(scopedConversationId, input, init);
      }
      return originalFetch.apply(this, arguments).then((response) => {
        if (exactConversationId) {
          captureConversationResponse(exactConversationId, response);
        }
        return response;
      });
    }
    interceptedFetch.__chatgptConversationHandoffExporterWrapped = true;
    window.fetch = interceptedFetch;
  }
  /*
   * 建立目前 conversation ID 專用的 conversation endpoint。
   *
   * 只負責組出同源 URL；驗證資訊由先前捕捉到的 request context 與瀏覽器 cookie 處理。
   */
  function buildConversationApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
      location.origin
    ).href;
  }
  /*
   * 建立目前 conversation ID 專用的 textdocs endpoint。
   */
  function buildTextdocsApiUrl(conversationId) {
    return new URL(
      `/backend-api/conversation/${encodeURIComponent(conversationId)}/textdocs`,
      location.origin
    ).href;
  }
  /*
   * 將可重用 headers 調整成指定 ChatGPT backend endpoint 專用。
   *
   * 某些 ChatGPT backend 請求會帶有 x-openai-target-path /
   * x-openai-target-route 這類路由提示 header。
   *
   * 若直接重用其他 endpoint 的 request template，這些 header 可能仍指向
   * 原本的 API 路徑，導致實際請求 URL 與 target headers 不一致。
   *
   * 因此在按下匯出按鈕、準備抓目前資料時，需要把它們改成目標 endpoint。
   */
  function applyTargetHeaders(headers, targetPath, targetRoute) {
    headers.set('accept', 'application/json');
    headers.set('x-openai-target-path', targetPath);
    headers.set('x-openai-target-route', targetRoute);
    /*
     * GET 請求不需要 content-type。
     * 若 request template 來自 POST endpoint，留下 content-type 可能造成誤導。
     */
    headers.delete('content-type');
    return headers;
  }
  /*
   * 將重用 headers 調整為 conversation JSON endpoint 使用。
   */
  function applyConversationTargetHeaders(headers, conversationId) {
    const targetPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}`;
    return applyTargetHeaders(
      headers,
      targetPath,
      '/backend-api/conversation/{conversation_id}'
    );
  }
  /*
   * 將重用 headers 調整為 textdocs endpoint 使用。
   */
  function applyTextdocsTargetHeaders(headers, conversationId) {
    const targetPath = `/backend-api/conversation/${encodeURIComponent(conversationId)}/textdocs`;
    return applyTargetHeaders(
      headers,
      targetPath,
      '/backend-api/conversation/{conversation_id}/textdocs'
    );
  }
  /*
   * 取得目前 conversation ID 可用的重抓請求資訊。
   *
   * 優先使用此 conversation ID 專屬 request context。
   * 若沒有，改用最近一次 ChatGPT backend API 請求樣板。
   *
   * 回傳的 headers 會被調整為 conversation endpoint 專用，避免重用其他 API 的 target headers。
   * 這個函式只在使用者按下匯出按鈕後的抓取流程中使用。
   */
  function getReplayRequestForConversation(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    if (replayRequest) {
      return {
        url: buildConversationApiUrl(conversationId),
        headers: applyConversationTargetHeaders(new Headers(replayRequest.headers), conversationId),
        capturedAt: replayRequest.capturedAt
      };
    }
    if (!latestReplayRequestTemplate) {
      return null;
    }
    return {
      url: buildConversationApiUrl(conversationId),
      headers: applyConversationTargetHeaders(new Headers(latestReplayRequestTemplate.headers), conversationId),
      capturedAt: latestReplayRequestTemplate.capturedAt
    };
  }
  /*
   * 取得目前 conversation ID 的 textdocs endpoint 請求資訊。
   *
   * textdocs 使用同一套 request context，但 target path / route 必須改成
   * /backend-api/conversation/{conversation_id}/textdocs。
   *
   * 如果沒有可重用 context，呼叫端會把 textdocs 視為不可取得，而不是中斷主要匯出。
   */
  function getReplayRequestForTextdocs(conversationId) {
    const replayRequest = replayRequestByConversationId.get(conversationId);
    if (replayRequest) {
      return {
        url: buildTextdocsApiUrl(conversationId),
        headers: applyTextdocsTargetHeaders(new Headers(replayRequest.headers), conversationId),
        capturedAt: replayRequest.capturedAt
      };
    }
    if (!latestReplayRequestTemplate) {
      return null;
    }
    return {
      url: buildTextdocsApiUrl(conversationId),
      headers: applyTextdocsTargetHeaders(new Headers(latestReplayRequestTemplate.headers), conversationId),
      capturedAt: latestReplayRequestTemplate.capturedAt
    };
  }
  /*
   * 計算字串以 UTF-8 編碼後的實際 bytes。
   *
   * JSON 完整性判定只記錄長度，不輸出內容。
   */
  function getUtf8ByteLength(value) {
    return new TextEncoder().encode(String(value || '')).byteLength;
  }
  /*
   * 判斷 JavaScript 收到的 body bytes 是否與瀏覽器網路層 decodedBodySize 一致。
   */
  function isBodyByteLengthConsistent(rawByteLength, decodedBodySize) {
    if (!Number.isFinite(rawByteLength) || !Number.isFinite(decodedBodySize) || decodedBodySize <= 0) {
      return false;
    }
    const tolerance = Math.max(
      RESOURCE_TIMING_BYTE_TOLERANCE_MIN,
      Math.ceil(decodedBodySize * RESOURCE_TIMING_BYTE_TOLERANCE_RATIO)
    );
    return Math.abs(rawByteLength - decodedBodySize) <= tolerance;
  }
  /*
   * 建立單次 Resource Timing 探針。
   *
   * 優先使用 PerformanceObserver 只觀察「探針建立後」的新 resource entry，
   * 避免同一 URL 先前已有大量歷史 entry 時配錯 request。
   * 若 observer 不可用，再退回 performance.getEntriesByName()。
   *
   * 這裡不 clear 全域 Resource Timing buffer，也不修改 ChatGPT 自己的 performance 狀態。
   */
  function createResourceTimingProbe(url, initiatorType) {
    const normalizedUrl = new URL(url, location.origin).href;
    const startedAt = performance.now();
    const observedEntries = [];
    let observer = null;
    if (typeof PerformanceObserver === 'function') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (
              entry &&
              entry.entryType === 'resource' &&
              entry.name === normalizedUrl &&
              entry.initiatorType === initiatorType &&
              entry.startTime >= startedAt - RESOURCE_TIMING_START_SLOP_MS
            ) {
              observedEntries.push(entry);
            }
          }
        });
        observer.observe({ type: 'resource', buffered: false });
      } catch {
        observer = null;
      }
    }
    return {
      startedAt,
      cancel() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      },
      async finish(rawText) {
        /* 讓 PerformanceObserver 有一個 task 的時間送出最後一批 entry。 */
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        let candidates = observedEntries;
        if (candidates.length === 0) {
          try {
            candidates = performance
              .getEntriesByName(normalizedUrl, 'resource')
              .filter((entry) => {
                return (
                  entry &&
                  entry.initiatorType === initiatorType &&
                  entry.startTime >= startedAt - RESOURCE_TIMING_START_SLOP_MS
                );
              });
          } catch {
            candidates = [];
          }
        }
        const entry = candidates.length > 0
          ? candidates.reduce((latest, current) => {
            return !latest || current.startTime > latest.startTime ? current : latest;
          }, null)
          : null;
        const rawByteLength = getUtf8ByteLength(rawText);
        const decodedBodySize = entry && Number.isFinite(entry.decodedBodySize)
          ? entry.decodedBodySize
          : 0;
        const encodedBodySize = entry && Number.isFinite(entry.encodedBodySize)
          ? entry.encodedBodySize
          : 0;
        const transferSize = entry && Number.isFinite(entry.transferSize)
          ? entry.transferSize
          : 0;
        if (!entry || decodedBodySize <= 0) {
          return {
            status: 'unavailable',
            rawByteLength,
            decodedBodySize,
            encodedBodySize,
            transferSize
          };
        }
        return {
          status: isBodyByteLengthConsistent(rawByteLength, decodedBodySize)
            ? 'match'
            : 'mismatch',
          rawByteLength,
          decodedBodySize,
          encodedBodySize,
          transferSize
        };
      }
    };
  }
  /*
   * 從 current_node 沿 parent 鏈回溯，建立 conversation 主路徑摘要。
   *
   * 只回傳 node ID 與結構狀態，不讀取或輸出訊息內容。
   */
  function analyzeConversationMainPath(conversation) {
    const mapping = conversation && conversation.mapping && typeof conversation.mapping === 'object'
      ? conversation.mapping
      : {};
    const pathNodeIds = [];
    const seen = new Set();
    let currentId = conversation ? conversation.current_node : null;
    let hasCycle = false;
    let missingNodeId = null;
    while (typeof currentId === 'string' && currentId) {
      if (seen.has(currentId)) {
        hasCycle = true;
        break;
      }
      seen.add(currentId);
      const node = mapping[currentId];
      if (!node || typeof node !== 'object') {
        missingNodeId = currentId;
        break;
      }
      pathNodeIds.push(currentId);
      currentId = typeof node.parent === 'string' && node.parent ? node.parent : null;
    }
    return {
      pathNodeIds,
      hasCycle,
      missingNodeId
    };
  }
  /*
   * 建立 conversation 的非敏感完整性摘要。
   *
   * 這些數值只用來比較不同取得通道，不會把 message content、headers、
   * token、cookie 或 raw JSON 寫入 log / 檔案。
   */
  function analyzeConversationIntegrity(conversation, rawText) {
    const mapping = conversation.mapping;
    const mappingNodeIds = Object.keys(mapping);
    const mainPath = analyzeConversationMainPath(conversation);
    let branchCount = 0;
    for (const nodeId of mappingNodeIds) {
      const node = mapping[nodeId];
      if (node && Array.isArray(node.children) && node.children.length > 1) {
        branchCount += 1;
      }
    }
    let visibleRoleTransitionCount = 0;
    let previousVisibleRole = null;
    const chronologicalPath = [...mainPath.pathNodeIds].reverse();
    for (const nodeId of chronologicalPath) {
      const role = mapping[nodeId]?.message?.author?.role;
      if (role !== 'user' && role !== 'assistant') {
        continue;
      }
      if (role !== previousVisibleRole) {
        visibleRoleTransitionCount += 1;
        previousVisibleRole = role;
      }
    }
    return {
      rawByteLength: getUtf8ByteLength(rawText),
      mappingNodeCount: mappingNodeIds.length,
      mainPathNodeCount: mainPath.pathNodeIds.length,
      offMainPathNodeCount: Math.max(0, mappingNodeIds.length - mainPath.pathNodeIds.length),
      branchCount,
      visibleRoleTransitionCount,
      hasMainPathCycle: mainPath.hasCycle,
      missingMainPathNode: mainPath.missingNodeId,
      isLinearMapping:
        !mainPath.hasCycle &&
        !mainPath.missingNodeId &&
        mappingNodeIds.length === mainPath.pathNodeIds.length &&
        branchCount === 0
    };
  }
  /*
   * 判斷兩份 conversation 是否可視為同一個 revision。
   *
   * current_node 必須一致；若兩邊都有 update_time，也必須一致。
   * 這可避免使用者剛好在雙通道驗證期間新增訊息時，把不同 revision 誤判成裁切。
   */
  function isSameConversationRevision(candidateA, candidateB) {
    if (!candidateA || !candidateB) {
      return false;
    }
    const a = candidateA.conversation;
    const b = candidateB.conversation;
    if (
      a.conversation_id !== b.conversation_id ||
      a.current_node !== b.current_node
    ) {
      return false;
    }
    const aUpdateTime = a.update_time ?? null;
    const bUpdateTime = b.update_time ?? null;
    if (aUpdateTime !== null && bUpdateTime !== null && String(aUpdateTime) !== String(bUpdateTime)) {
      return false;
    }
    return true;
  }
  /*
   * 比較 mapping key 集合。
   */
  function isMappingKeySubset(smallerCandidate, largerCandidate) {
    const smallerKeys = Object.keys(smallerCandidate.conversation.mapping);
    const largerMapping = largerCandidate.conversation.mapping;
    return smallerKeys.every((nodeId) => Object.prototype.hasOwnProperty.call(largerMapping, nodeId));
  }
  function compareConversationCandidates(candidateA, candidateB) {
    if (!isSameConversationRevision(candidateA, candidateB)) {
      return 'different-revision';
    }
    const aCount = candidateA.integrity.mappingNodeCount;
    const bCount = candidateB.integrity.mappingNodeCount;
    if (aCount === bCount) {
      return isMappingKeySubset(candidateA, candidateB) && isMappingKeySubset(candidateB, candidateA)
        ? 'equivalent'
        : 'diverged';
    }
    if (aCount > bCount && isMappingKeySubset(candidateB, candidateA)) {
      return 'a-superset';
    }
    if (bCount > aCount && isMappingKeySubset(candidateA, candidateB)) {
      return 'b-superset';
    }
    return 'diverged';
  }
  /*
   * 將安全可重用 headers 套用到 XMLHttpRequest。
   *
   * 若瀏覽器拒絕某個 header，錯誤只顯示 header 名稱，不輸出值。
   */
  function applyReplayHeadersToXhr(xhr, headers) {
    headers.forEach((value, key) => {
      try {
        xhr.setRequestHeader(key, value);
      } catch (error) {
        throw new Error(
          `XHR 無法套用必要 request header「${key}」：${toErrorMessage(error)}`
        );
      }
    });
  }
  /*
   * conversation 正式重抓通道 A：XMLHttpRequest。
   *
   * 這條通道不使用 window.fetch，可避開只攔截 fetch 的第三方修改器。
   * 但 XHR 本身仍可能被其他頁面程式包裝，因此結果仍必須通過 Resource Timing 驗證。
   */
  async function requestConversationViaXhr(replayRequest, onProgress = null) {
    return new Promise((resolve, reject) => {
      let xhr;
      let probe = null;
      try {
        xhr = new XMLHttpRequest();
        xhr.open('GET', replayRequest.url, true);
        xhr.withCredentials = true;
        const xhrHeaders = new Headers(replayRequest.headers);
        xhrHeaders.set('cache-control', 'no-cache');
        applyReplayHeadersToXhr(xhr, xhrHeaders);
        probe = createResourceTimingProbe(replayRequest.url, 'xmlhttprequest');
      } catch (error) {
        probe?.cancel();
        reject(error);
        return;
      }
      try {
        xhr.addEventListener('progress', (event) => {
          if (typeof onProgress !== 'function') {
            return;
          }
          try {
            onProgress({
              loaded: Number.isFinite(event.loaded) ? event.loaded : 0,
              total: Number.isFinite(event.total) ? event.total : 0,
              lengthComputable: Boolean(event.lengthComputable)
            });
          } catch {
            // UI 進度 callback 不得影響 authoritative transport。
          }
        });
        xhr.addEventListener('load', async () => {
          try {
            const rawText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
            const timing = await probe.finish(rawText);
            resolve({
              transport: 'xhr',
              status: xhr.status,
              statusText: xhr.statusText || '',
              contentType: xhr.getResponseHeader('content-type') || '',
              rawText,
              timing
            });
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        xhr.addEventListener('error', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 conversation JSON 時發生網路錯誤。'));
        }, { once: true });
        xhr.addEventListener('abort', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 conversation JSON 已被中止。'));
        }, { once: true });
        xhr.send();
      } catch (error) {
        probe?.cancel();
        reject(error);
      }
    });
  }
  /*
   * conversation 正式重抓通道 B：目前頁面的 window.fetch。
   *
   * 這條通道只在 XHR 無法被 Resource Timing 直接驗證，或偵測到大小不一致時啟用。
   * 它不是預設可信來源，而是第二個獨立比較訊號。
   */
  async function requestConversationViaFetch(replayRequest) {
    const probe = createResourceTimingProbe(replayRequest.url, 'fetch');
    let response;
    let rawText;
    try {
      response = await window.fetch(replayRequest.url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(replayRequest.headers)
      });
      rawText = await response.text();
    } catch (error) {
      probe.cancel();
      throw error;
    }
    const timing = await probe.finish(rawText);
    return {
      transport: 'fetch',
      status: response.status,
      statusText: response.statusText || '',
      contentType: response.headers.get('content-type') || '',
      rawText,
      timing
    };
  }
  /*
   * 將 transport response 解析成可比較的 conversation candidate。
   */
  function validateConversationTransportResult(result, conversationId) {
    if (!result || !Number.isFinite(result.status) || result.status < 200 || result.status >= 300) {
      const status = result && Number.isFinite(result.status) ? result.status : 0;
      const statusText = result?.statusText || '';
      throw new Error(
        `重新抓取 conversation JSON 失敗：HTTP ${status || '未知'} ${statusText}\n\n` +
        getHttpStatusSuggestion(status)
      );
    }
    if (!String(result.contentType || '').includes('application/json')) {
      throw new Error(
        '重新抓取 conversation JSON 失敗：回應不是 JSON。\n\n' +
        `Content-Type: ${result.contentType || '未知'}\n\n` +
        '建議：重新整理頁面並確認對話已正常載入。若仍持續發生，可能是 ChatGPT 前端或內部 endpoint 格式已變更。'
      );
    }
    if (!String(result.rawText || '').trim()) {
      throw new Error('重新抓取 conversation JSON 失敗：response body 為空。');
    }
    const conversation = parseAndValidateRawConversation(result.rawText, conversationId);
    return {
      ...result,
      conversation,
      integrity: analyzeConversationIntegrity(conversation, result.rawText)
    };
  }
  async function tryConversationTransport(transportName, replayRequest, conversationId, onProgress = null) {
    try {
      const rawResult = transportName === 'xhr'
        ? await requestConversationViaXhr(replayRequest, onProgress)
        : await requestConversationViaFetch(replayRequest);
      return {
        candidate: validateConversationTransportResult(rawResult, conversationId),
        error: null
      };
    } catch (error) {
      return {
        candidate: null,
        error
      };
    }
  }
  /*
   * 使用另一個 request 的 network decodedBodySize 驗證 candidate。
   *
   * 只有兩份 response 屬於同一個 conversation revision 時才允許交叉驗證，
   * 避免對話剛好更新時拿舊的 network size 套到新 revision。
   */
  function isCandidateSupportedByOtherTiming(candidate, timingSourceCandidate) {
    if (
      !candidate ||
      !timingSourceCandidate ||
      !isSameConversationRevision(candidate, timingSourceCandidate)
    ) {
      return false;
    }
    const decodedBodySize = timingSourceCandidate.timing?.decodedBodySize || 0;
    return isBodyByteLengthConsistent(candidate.integrity.rawByteLength, decodedBodySize);
  }
  function formatCandidateIntegritySummary(candidate) {
    if (!candidate) {
      return '無有效 response';
    }
    const timing = candidate.timing || {};
    return [
      `${candidate.transport.toUpperCase()} response=${candidate.integrity.rawByteLength} bytes`,
      `network=${timing.decodedBodySize > 0 ? `${timing.decodedBodySize} bytes` : '無法取得'}`,
      `timing=${timing.status || 'unavailable'}`,
      `mapping=${candidate.integrity.mappingNodeCount}`,
      `mainPath=${candidate.integrity.mainPathNodeCount}`,
      `branches=${candidate.integrity.branchCount}`
    ].join('，');
  }
  function buildConversationIntegrityFailureMessage(xhrAttempt, fetchAttempt, reason) {
    const lines = [
      '下載中止：無法確認 conversation JSON 的完整性。',
      '',
      reason,
      ''
    ];
    if (xhrAttempt?.candidate) {
      lines.push(formatCandidateIntegritySummary(xhrAttempt.candidate));
    } else if (xhrAttempt?.error) {
      lines.push(`XHR：${toErrorMessage(xhrAttempt.error)}`);
    }
    if (fetchAttempt?.candidate) {
      lines.push(formatCandidateIntegritySummary(fetchAttempt.candidate));
    } else if (fetchAttempt?.error) {
      lines.push(`Fetch：${toErrorMessage(fetchAttempt.error)}`);
    }
    lines.push(
      '',
      '這可能表示頁面腳本、userscript 或瀏覽器擴充功能修改了 conversation API 回應，',
      '也可能是對話剛好仍在更新，導致兩次請求取得不同 revision。',
      '',
      '為避免產生不完整的 raw / handoff JSON，本次未下載檔案。',
      '建議：等待對話停止更新後再試；若持續發生，請重新整理頁面後重新匯出。'
    );
    return lines.join('\n');
  }
  /*
   * 從 XHR / fetch 候選中選出可被網路大小或雙通道結構支持的可信 response。
   *
   * 原則：
   *   1. 任一通道自身 Resource Timing 明確 match → 直接可信。
   *   2. 某通道 timing mismatch，但另一份同 revision body bytes 能吻合該 network size → 採另一份。
   *   3. 兩邊都沒有 timing 證據時，只接受同 revision 且 mapping 完全一致或一方為嚴格 superset。
   *   4. 已知 mismatch、不同 revision 或無法判斷 → fail closed。
   */
  function selectTrustedConversationCandidate(xhrAttempt, fetchAttempt) {
    const xhrCandidate = xhrAttempt?.candidate || null;
    const fetchCandidate = fetchAttempt?.candidate || null;
    if (xhrCandidate?.timing?.status === 'match') {
      return xhrCandidate;
    }
    if (fetchCandidate?.timing?.status === 'match') {
      return fetchCandidate;
    }
    if (!xhrCandidate && !fetchCandidate) {
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個 conversation 取得通道都失敗。'
        )
      );
    }
    if (xhrCandidate && fetchCandidate) {
      const xhrSupportedByFetchTiming = isCandidateSupportedByOtherTiming(xhrCandidate, fetchCandidate);
      const fetchSupportedByXhrTiming = isCandidateSupportedByOtherTiming(fetchCandidate, xhrCandidate);
      if (xhrSupportedByFetchTiming && !fetchSupportedByXhrTiming) {
        return xhrCandidate;
      }
      if (fetchSupportedByXhrTiming && !xhrSupportedByFetchTiming) {
        return fetchCandidate;
      }
      if (
        xhrCandidate.timing?.status === 'mismatch' ||
        fetchCandidate.timing?.status === 'mismatch'
      ) {
        throw new Error(
          buildConversationIntegrityFailureMessage(
            xhrAttempt,
            fetchAttempt,
            '至少一個 JavaScript response body 與瀏覽器實際網路 response 大小明顯不一致。'
          )
        );
      }
      const comparison = compareConversationCandidates(xhrCandidate, fetchCandidate);
      if (comparison === 'equivalent') {
        return xhrCandidate;
      }
      if (comparison === 'a-superset') {
        return xhrCandidate;
      }
      if (comparison === 'b-superset') {
        return fetchCandidate;
      }
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          comparison === 'different-revision'
            ? '兩個取得通道拿到不同 conversation revision，無法安全判定哪一份是目前完整資料。'
            : '兩個取得通道的 mapping 結構不一致，且不存在可確認的完整 superset。'
        )
      );
    }
    const onlyCandidate = xhrCandidate || fetchCandidate;
    const onlyAttemptName = xhrCandidate ? 'XHR' : 'Fetch';
    if (onlyCandidate.timing?.status === 'mismatch') {
      throw new Error(
        buildConversationIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          `${onlyAttemptName} response 與瀏覽器實際網路 response 大小不一致，另一通道又無法提供有效驗證。`
        )
      );
    }
    throw new Error(
      buildConversationIntegrityFailureMessage(
        xhrAttempt,
        fetchAttempt,
        `${onlyAttemptName} 雖取得合法 JSON，但缺少可獨立驗證的 Resource Timing，另一通道也無法確認，因此不將它視為原始 authoritative JSON。`
      )
    );
  }
  /*
   * 使用先前被動捕捉的 request context，即時重新抓取目前 conversation。
   *
   * 正式匯出不再直接信任被動 capture，也不再把 window.fetch 的單一路徑
   * 當成 authoritative source。預設先走 XHR；只有無法直接驗證或發現異常時，
   * 才追加 fetch 第二通道，最後由完整性判定挑選可信 snapshot。
   */
  async function refetchLatestConversationSnapshot(conversationId, { onProgress = null } = {}) {
    const replayRequest = getReplayRequestForConversation(conversationId);
    if (!replayRequest) {
      throw new Error(buildMissingRequestContextMessage('conversation JSON'));
    }
    replayRequestByConversationId.set(conversationId, replayRequest);
    const xhrAttempt = await tryConversationTransport('xhr', replayRequest, conversationId, onProgress);
    let fetchAttempt = null;
    if (!xhrAttempt.candidate || xhrAttempt.candidate.timing?.status !== 'match') {
      fetchAttempt = await tryConversationTransport('fetch', replayRequest, conversationId);
    }
    const trustedCandidate = selectTrustedConversationCandidate(xhrAttempt, fetchAttempt);
    rememberRawConversation(
      conversationId,
      trustedCandidate.rawText,
      trustedCandidate.conversation,
      `authoritative-${trustedCandidate.transport}`
    );
    logInfo('conversation JSON 完整性驗證通過。', {
      conversationId,
      transport: trustedCandidate.transport,
      responseBytes: trustedCandidate.integrity.rawByteLength,
      networkBytes: trustedCandidate.timing?.decodedBodySize || null,
      timingStatus: trustedCandidate.timing?.status || 'unavailable',
      mappingNodeCount: trustedCandidate.integrity.mappingNodeCount,
      mainPathNodeCount: trustedCandidate.integrity.mainPathNodeCount,
      branchCount: trustedCandidate.integrity.branchCount
    });
    return {
      rawText: trustedCandidate.rawText,
      conversation: trustedCandidate.conversation,
      integrity: trustedCandidate.integrity,
      transport: trustedCandidate.transport,
      timing: trustedCandidate.timing
    };
  }
  /*
   * 判斷值是否為一般物件。
   *
   * textdocs endpoint 可能回傳不同外層格式，因此需要先排除 null 與陣列。
   */
  function isObjectRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }
  /*
   * 從 textdocs endpoint 回應中取出 textdocs 陣列。
   *
   * 目前支援直接回傳陣列，也支援包在 textdocs、items、data、documents 欄位中的陣列。
   */
  function getTextdocsArrayFromParsedJson(parsed) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (!isObjectRecord(parsed)) {
      return [];
    }
    const candidateKeys = ['textdocs', 'items', 'data', 'documents'];
    for (const key of candidateKeys) {
      if (Array.isArray(parsed[key])) {
        return parsed[key];
      }
    }
    return [];
  }
  /*
   * 正規化單一 textdoc comment。
   *
   * 缺少位置或內容時使用 null / 空字串，避免因部分欄位缺失導致整體匯出失敗。
   */
  function normalizeTextdocComment(comment) {
    if (!isObjectRecord(comment)) {
      return null;
    }
    return {
      ...comment,
      content: typeof comment.content === 'string' ? comment.content : ''
    };
  }
  /*
   * 正規化單一 textdoc。
   *
   * textdocs endpoint 格式若有小幅變動，這裡會盡量轉成 handoff builder 可處理的穩定形狀。
   */
  function normalizeTextdoc(textdoc, index) {
    if (!isObjectRecord(textdoc)) {
      logWarn('略過格式不支援的 textdoc 項目。', {
        index: index + 1
      });
      return null;
    }
    const normalized = {
      ...textdoc,
      id: typeof textdoc.id === 'string' && textdoc.id.trim() ? textdoc.id : null,
      content: typeof textdoc.content === 'string' ? textdoc.content : ''
    };
    if (!Array.isArray(textdoc.comments)) {
      normalized.comments = [];
      return normalized;
    }
    normalized.comments = textdoc.comments
      .map(normalizeTextdocComment)
      .filter(Boolean);
    return normalized;
  }
  /*
   * 解析 textdocs 原始 JSON，並轉成可用的 textdocs 陣列。
   *
   * 這裡採寬鬆策略：能保留的項目盡量保留，無法辨識的項目略過。
   */
  function parseAndValidateTextdocsRaw(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`textdocs JSON 解析失敗：${toErrorMessage(error)}`);
    }
    const textdocs = getTextdocsArrayFromParsedJson(parsed);
    return textdocs
      .map(normalizeTextdoc)
      .filter(Boolean);
  }
  /*
   * textdocs 取得、解析或完整性驗證失敗時的共同退路。
   *
   * textdocs 是附加資料；失敗時改用空陣列，避免阻斷主要 conversation 匯出。
   */
  function warnAndReturnEmptyTextdocs(message, data = null) {
    logWarn(message, data);
    return [];
  }
  /*
   * textdocs 正式重抓通道 A：XMLHttpRequest。
   *
   * 和 conversation 一樣，預設先使用不經 window.fetch 的 XHR，
   * 再用 Resource Timing 比對 JavaScript body bytes 與瀏覽器網路層 decodedBodySize。
   */
  async function requestTextdocsViaXhr(replayRequest, onProgress = null) {
    return new Promise((resolve, reject) => {
      let xhr;
      let probe = null;
      try {
        xhr = new XMLHttpRequest();
        xhr.open('GET', replayRequest.url, true);
        xhr.withCredentials = true;
        const xhrHeaders = new Headers(replayRequest.headers);
        xhrHeaders.set('cache-control', 'no-cache');
        applyReplayHeadersToXhr(xhr, xhrHeaders);
        probe = createResourceTimingProbe(replayRequest.url, 'xmlhttprequest');
      } catch (error) {
        probe?.cancel();
        reject(error);
        return;
      }
      try {
        xhr.addEventListener('progress', (event) => {
          if (typeof onProgress !== 'function') {
            return;
          }
          try {
            onProgress({
              loaded: Number.isFinite(event.loaded) ? event.loaded : 0,
              total: Number.isFinite(event.total) ? event.total : 0,
              lengthComputable: Boolean(event.lengthComputable)
            });
          } catch {
            // UI 進度 callback 不得影響 textdocs transport。
          }
        });
        xhr.addEventListener('load', async () => {
          try {
            const rawText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
            const timing = await probe.finish(rawText);
            resolve({
              transport: 'xhr',
              status: xhr.status,
              statusText: xhr.statusText || '',
              contentType: xhr.getResponseHeader('content-type') || '',
              rawText,
              timing
            });
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        xhr.addEventListener('error', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 textdocs JSON 時發生網路錯誤。'));
        }, { once: true });
        xhr.addEventListener('abort', () => {
          probe?.cancel();
          reject(new Error('XHR 重新抓取 textdocs JSON 已被中止。'));
        }, { once: true });
        xhr.send();
      } catch (error) {
        probe?.cancel();
        reject(error);
      }
    });
  }
  /*
   * textdocs 正式重抓通道 B：目前頁面的 window.fetch。
   *
   * 只有 XHR 無法由 Resource Timing 直接驗證、或 XHR 取得失敗時才啟用。
   * 這條通道只作第二個比較訊號，不會因為 JSON 可解析就直接視為可信來源。
   */
  async function requestTextdocsViaFetch(replayRequest) {
    const probe = createResourceTimingProbe(replayRequest.url, 'fetch');
    let response;
    let rawText;
    try {
      response = await window.fetch(replayRequest.url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(replayRequest.headers)
      });
      rawText = await response.text();
    } catch (error) {
      probe.cancel();
      throw error;
    }
    const timing = await probe.finish(rawText);
    return {
      transport: 'fetch',
      status: response.status,
      statusText: response.statusText || '',
      contentType: response.headers.get('content-type') || '',
      rawText,
      timing
    };
  }
  /*
   * 建立 textdocs 的非敏感完整性摘要。
   *
   * 只記錄 response bytes 與正規化後的 textdoc 數量，不輸出內容、comment、
   * request headers、token、cookie 或 raw JSON。
   */
  function analyzeTextdocsIntegrity(textdocs, rawText) {
    return {
      rawByteLength: getUtf8ByteLength(rawText),
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0
    };
  }
  /*
   * 將 transport response 解析成可比較的 textdocs candidate。
   *
   * 204 / 205 / 404 與空 2xx body 沿用既有容錯語意，視為「目前沒有 textdocs」。
   */
  function validateTextdocsTransportResult(result) {
    if (!result || !Number.isFinite(result.status)) {
      throw new Error('重新抓取 textdocs JSON 失敗：無法取得有效 HTTP 狀態。');
    }
    const status = result.status;
    const rawText = String(result.rawText || '');
    if (status === 204 || status === 205 || status === 404) {
      const textdocs = [];
      return {
        ...result,
        textdocs,
        integrity: analyzeTextdocsIntegrity(textdocs, rawText)
      };
    }
    if (status < 200 || status >= 300) {
      throw new Error(
        `重新抓取 textdocs JSON 失敗：HTTP ${status || '未知'} ${result.statusText || ''}`
      );
    }
    if (!rawText.trim()) {
      const textdocs = [];
      return {
        ...result,
        textdocs,
        integrity: analyzeTextdocsIntegrity(textdocs, rawText)
      };
    }
    if (!String(result.contentType || '').includes('application/json')) {
      throw new Error(
        '重新抓取 textdocs JSON 失敗：回應不是 JSON。' +
        ` Content-Type: ${result.contentType || '未知'}`
      );
    }
    const textdocs = parseAndValidateTextdocsRaw(rawText);
    return {
      ...result,
      textdocs,
      integrity: analyzeTextdocsIntegrity(textdocs, rawText)
    };
  }
  async function tryTextdocsTransport(transportName, replayRequest, onProgress = null) {
    try {
      const rawResult = transportName === 'xhr'
        ? await requestTextdocsViaXhr(replayRequest, onProgress)
        : await requestTextdocsViaFetch(replayRequest);
      return {
        candidate: validateTextdocsTransportResult(rawResult),
        error: null
      };
    } catch (error) {
      return {
        candidate: null,
        error
      };
    }
  }
  /*
   * 比較兩個 textdocs candidate 的正規化內容是否完全一致。
   *
   * 只有雙通道 fallback 被啟動時才進行一次序列化比較；平常 XHR timing match
   * 的 fast path 不會額外轉換大型 textdocs。
   */
  function areTextdocsCandidatesEquivalent(candidateA, candidateB) {
    if (!candidateA || !candidateB) {
      return false;
    }
    if (candidateA.integrity.textdocCount !== candidateB.integrity.textdocCount) {
      return false;
    }
    return JSON.stringify(candidateA.textdocs) === JSON.stringify(candidateB.textdocs);
  }
  /*
   * 使用另一個 request 的 network decodedBodySize 交叉驗證 textdocs candidate。
   */
  function isTextdocsCandidateSupportedByOtherTiming(candidate, timingSourceCandidate) {
    if (!candidate || !timingSourceCandidate) {
      return false;
    }
    const decodedBodySize = timingSourceCandidate.timing?.decodedBodySize || 0;
    return isBodyByteLengthConsistent(candidate.integrity.rawByteLength, decodedBodySize);
  }
  function formatTextdocsIntegritySummary(candidate) {
    if (!candidate) {
      return '無有效 response';
    }
    const timing = candidate.timing || {};
    return [
      `${candidate.transport.toUpperCase()} response=${candidate.integrity.rawByteLength} bytes`,
      `network=${timing.decodedBodySize > 0 ? `${timing.decodedBodySize} bytes` : '無法取得'}`,
      `timing=${timing.status || 'unavailable'}`,
      `textdocs=${candidate.integrity.textdocCount}`
    ].join('，');
  }
  function buildTextdocsIntegrityFailureMessage(xhrAttempt, fetchAttempt, reason) {
    const lines = [
      '無法確認 textdocs JSON 的完整性。',
      '',
      reason,
      ''
    ];
    if (xhrAttempt?.candidate) {
      lines.push(formatTextdocsIntegritySummary(xhrAttempt.candidate));
    } else if (xhrAttempt?.error) {
      lines.push(`XHR：${toErrorMessage(xhrAttempt.error)}`);
    }
    if (fetchAttempt?.candidate) {
      lines.push(formatTextdocsIntegritySummary(fetchAttempt.candidate));
    } else if (fetchAttempt?.error) {
      lines.push(`Fetch：${toErrorMessage(fetchAttempt.error)}`);
    }
    lines.push(
      '',
      '這可能表示頁面腳本、userscript 或瀏覽器擴充功能修改了 textdocs API 回應，',
      '也可能是 textdocs 剛好在兩次請求之間更新。',
      '',
      'textdocs 屬於附加資料；為避免把不完整 Canvas / textdoc 內容寫入匯出檔，',
      '本次會略過 textdocs，但不阻斷主要 conversation raw JSON。'
    );
    return lines.join('\n');
  }
  /*
   * 從 XHR / fetch 候選中選出可信 textdocs response。
   *
   * 原則與 conversation 保持一致，但不對 textdocs 做「較大即較完整」的猜測：
   *   1. 任一通道自身 Resource Timing 明確 match → 直接可信。
   *   2. 某通道 body bytes 能吻合另一 request 的 network size → 採該通道。
   *   3. 兩邊都沒有 timing 證據時，只接受正規化 textdocs 完全一致。
   *   4. 已知 mismatch 或兩通道內容不同 → 不猜測哪份較完整，改為略過 textdocs。
   */
  function selectTrustedTextdocsCandidate(xhrAttempt, fetchAttempt) {
    const xhrCandidate = xhrAttempt?.candidate || null;
    const fetchCandidate = fetchAttempt?.candidate || null;
    if (xhrCandidate?.timing?.status === 'match') {
      return xhrCandidate;
    }
    if (fetchCandidate?.timing?.status === 'match') {
      return fetchCandidate;
    }
    if (!xhrCandidate && !fetchCandidate) {
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個 textdocs 取得通道都失敗。'
        )
      );
    }
    if (xhrCandidate && fetchCandidate) {
      const xhrSupportedByFetchTiming = isTextdocsCandidateSupportedByOtherTiming(xhrCandidate, fetchCandidate);
      const fetchSupportedByXhrTiming = isTextdocsCandidateSupportedByOtherTiming(fetchCandidate, xhrCandidate);
      if (xhrSupportedByFetchTiming && !fetchSupportedByXhrTiming) {
        return xhrCandidate;
      }
      if (fetchSupportedByXhrTiming && !xhrSupportedByFetchTiming) {
        return fetchCandidate;
      }
      if (
        xhrCandidate.timing?.status === 'mismatch' ||
        fetchCandidate.timing?.status === 'mismatch'
      ) {
        throw new Error(
          buildTextdocsIntegrityFailureMessage(
            xhrAttempt,
            fetchAttempt,
            '至少一個 JavaScript response body 與瀏覽器實際網路 response 大小明顯不一致。'
          )
        );
      }
      if (areTextdocsCandidatesEquivalent(xhrCandidate, fetchCandidate)) {
        return xhrCandidate;
      }
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          '兩個取得通道的 textdocs 內容不同，且沒有足夠的網路層證據判定哪一份可信。'
        )
      );
    }
    const onlyCandidate = xhrCandidate || fetchCandidate;
    const onlyAttemptName = xhrCandidate ? 'XHR' : 'Fetch';
    if (onlyCandidate.timing?.status === 'mismatch') {
      throw new Error(
        buildTextdocsIntegrityFailureMessage(
          xhrAttempt,
          fetchAttempt,
          `${onlyAttemptName} response 與瀏覽器實際網路 response 大小不一致，另一通道又無法提供有效驗證。`
        )
      );
    }
    throw new Error(
      buildTextdocsIntegrityFailureMessage(
        xhrAttempt,
        fetchAttempt,
        `${onlyAttemptName} 雖取得可解析的 textdocs，但缺少可獨立驗證的 Resource Timing，另一通道也無法確認。`
      )
    );
  }
  /*
   * 使用先前被動捕捉的 request context，即時重新抓取目前 textdocs。
   *
   * textdocs 現在與 conversation 使用相同的 transport / Resource Timing 原則：
   * 預設 XHR，必要時追加 window.fetch 作第二通道；只有通過完整性判定的
   * candidate 才會進入 .textdocs.json 或 handoff。
   */
  async function refetchLatestTextdocsSnapshot(conversationId, { onProgress = null } = {}) {
    const replayRequest = getReplayRequestForTextdocs(conversationId);
    if (!replayRequest) {
      throw new Error(buildMissingRequestContextMessage('textdocs JSON'));
    }
    const xhrAttempt = await tryTextdocsTransport('xhr', replayRequest, onProgress);
    let fetchAttempt = null;
    if (!xhrAttempt.candidate || xhrAttempt.candidate.timing?.status !== 'match') {
      fetchAttempt = await tryTextdocsTransport('fetch', replayRequest);
    }
    const trustedCandidate = selectTrustedTextdocsCandidate(xhrAttempt, fetchAttempt);
    logInfo('textdocs JSON 完整性驗證通過。', {
      conversationId,
      transport: trustedCandidate.transport,
      responseBytes: trustedCandidate.integrity.rawByteLength,
      networkBytes: trustedCandidate.timing?.decodedBodySize || null,
      timingStatus: trustedCandidate.timing?.status || 'unavailable',
      textdocCount: trustedCandidate.integrity.textdocCount
    });
    return {
      rawText: trustedCandidate.rawText,
      textdocs: trustedCandidate.textdocs,
      integrity: trustedCandidate.integrity,
      transport: trustedCandidate.transport,
      timing: trustedCandidate.timing
    };
  }
  /*
   * 確認匯出流程仍停留在觸發匯出時的 conversation。
   *
   * ChatGPT 是 SPA，路由可能在匯出期間切換。若目前 URL 已不是
   * 觸發匯出時的 conversation ID，應立即中止，避免下載非目標對話。
   */
  function assertConversationStillCurrent(expectedConversationId, stageName = '匯出流程') {
    const currentConversationId = getConversationIdFromUrl();
    if (!expectedConversationId || !currentConversationId) {
      throw new Error(
        `${stageName}中止：目前頁面不是有效的 ChatGPT 對話頁。\n\n` +
        '建議：等待對話頁載入完成後再按一次匯出按鈕。'
      );
    }
    if (currentConversationId !== expectedConversationId) {
      throw new Error(
        `${stageName}中止：目前網址的 conversation ID 已變更。\n\n` +
        `匯出開始時 ID：${expectedConversationId}\n` +
        `目前網址 ID：${currentConversationId}\n\n` +
        '這通常表示 ChatGPT 正在切換對話或頁面尚未載入完成。\n' +
        '建議：等待目前對話完全載入後，再按一次匯出按鈕。'
      );
    }
  }
  /*
   * 確認匯出按鈕記錄的 conversation ID 與目前 URL 一致。
   *
   * SPA 切換後，既有按鈕節點可能保留前一段對話的 ID。
   * 在 click handler 一開始即檢查，可阻止殘留 listener 或 UI 狀態觸發下載。
   */
  function assertButtonConversationMatchesCurrent(button) {
    if (!button || typeof button.getAttribute !== 'function') {
      return;
    }
    const buttonConversationId = button.getAttribute('data-cgpt-export-conversation-id');
    const currentConversationId = getConversationIdFromUrl();
    if (!buttonConversationId || !currentConversationId) {
      return;
    }
    if (buttonConversationId !== currentConversationId) {
      throw new Error(
        '匯出中止：匯出按鈕仍指向上一個對話。\n\n' +
        `按鈕記錄 ID：${buttonConversationId}\n` +
        `目前網址 ID：${currentConversationId}\n\n` +
        '這通常表示 ChatGPT 剛完成 SPA 切換，但匯出按鈕尚未同步更新。\n' +
        '建議：等待頁面穩定後再按一次；若持續發生，請重新整理此對話頁。'
      );
    }
  }
  /*
   * 確認已取得的 conversation snapshot 對應目前匯出的 conversation ID。
   */
  function assertSnapshotConversationMatches(snapshot, expectedConversationId, stageName = '匯出流程') {
    const actualConversationId = snapshot && snapshot.conversation
      ? snapshot.conversation.conversation_id
      : null;
    if (actualConversationId !== expectedConversationId) {
      throw new Error(
        `${stageName}中止：取得的 raw JSON 不屬於目前對話。\n\n` +
        `預期 ID：${expectedConversationId}\n` +
        `raw JSON ID：${actualConversationId || '未知'}\n\n` +
        '為避免匯出舊資料，已停止下載。請重新整理或重新進入目前對話後再試。'
      );
    }
  }
  /*
   * 取得目前對話的 authoritative conversation snapshot。
   *
   * 被動 capture 只保留給 tooltip / 標題與 request context 輔助用途；
   * 正式 raw / handoff 匯出必須重新抓取並通過 transport + Resource Timing 完整性驗證。
   */
  async function getLatestConversationSnapshot(conversationId) {
    assertConversationStillCurrent(conversationId, '取得 raw JSON 前');
    const snapshot = await refetchLatestConversationSnapshot(conversationId);
    assertConversationStillCurrent(conversationId, '重新抓取 raw JSON 後');
    return snapshot;
  }
  /*
   * 取得目前對話的 textdocs 陣列。
   *
   * textdocs 是附加資料，因此這個 helper 採容錯策略：
   * 若 endpoint 無法取得、回應格式異常或解析失敗，會回傳空陣列，
   * 讓 raw JSON 與 handoff 主體仍可完成匯出。
   */
  async function getLatestTextdocs(conversationId, { onProgress = null } = {}) {
    try {
      const snapshot = await refetchLatestTextdocsSnapshot(conversationId, { onProgress });
      return snapshot.textdocs;
    } catch (error) {
      return warnAndReturnEmptyTextdocs(
        'textdocs 無法通過取得或完整性驗證，改以空 textdocs 繼續。',
        {
          conversationId,
          message: toErrorMessage(error)
        }
      );
    }
  }
  /*
   * 下載已驗證的 raw conversation JSON。
   *
   * 這裡只負責格式化與下載，不重新解析或重抓資料。
   */
  function downloadRawConversation({ rawText, conversation }, conversationId, exportTimestamp) {
    const prettyRawText = JSON.stringify(conversation, null, 4);
    const filename = buildRawFilename(rawText, conversationId, exportTimestamp);
    downloadTextFile(prettyRawText, filename);
  }
  /*
   * 若目前對話有 textdocs，下載正規化後的 textdocs JSON。
   *
   * 沒有 textdocs 時不下載額外檔案，避免產生無意義的空 JSON 檔。
   */
  function downloadTextdocsIfPresent(textdocs, rawText, conversationId, exportTimestamp) {
    if (!Array.isArray(textdocs) || textdocs.length === 0) {
      return;
    }
    const prettyTextdocsText = JSON.stringify(textdocs, null, 4);
    const textdocsFilename = buildTextdocsFilename(rawText, conversationId, exportTimestamp);
    downloadTextFile(prettyTextdocsText, textdocsFilename);
  }
  /*
   * 建立 handoff JSON 下載內容。
   *
   * 這個 helper 只處理 handoff 轉換、結果檢查與序列化，
   * 實際下載由上層流程負責，方便在下載前更新 UI 進度文字。
   */
  function buildHandoffDownloadPayload({ rawText, conversation }, textdocs, conversationId, exportTimestamp) {
    const handoff = buildHandoff(conversation, textdocs);
    validateHandoffOrThrow(handoff, conversation);
    return {
      text: JSON.stringify(handoff, null, 4),
      filename: buildHandoffFilename(rawText, conversationId, exportTimestamp)
    };
  }
  /*
   * 以指定 conversation ID 建立一份已驗證 handoff payload。
   *
   * enforceCurrentPage=true 供既有單一對話匯出使用，保留 URL / conversation 安全斷言。
   * enforceCurrentPage=false 供使用者確認後的受控批次流程使用；批次目標由 immutable snapshot 決定。
   * 這個 helper 只建立 payload，不下載檔案。
   */
  async function createHandoffPayloadForConversationId(
    conversationId,
    {
      enforceCurrentPage = false,
      onStage = null,
      onConversationProgress = null,
      onTextdocsProgress = null
    } = {}
  ) {
    const reportStage = (stage) => {
      if (typeof onStage !== 'function') {
        return;
      }
      try {
        onStage(stage);
      } catch {
        // UI callback 不得影響 handoff 建置。
      }
    };
    const exportTimestamp = getTimestampString();
    reportStage('conversation-start');
    const snapshot = enforceCurrentPage
      ? await getLatestConversationSnapshot(conversationId)
      : await refetchLatestConversationSnapshot(conversationId, {
        onProgress: onConversationProgress
      });
    assertSnapshotConversationMatches(snapshot, conversationId, '產出交接 JSON 前');
    reportStage('conversation-ready');
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '擷取 textdocs 前');
    }
    reportStage('textdocs-start');
    const textdocs = await getLatestTextdocs(conversationId, {
      onProgress: onTextdocsProgress
    });
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '擷取 textdocs 後');
    }
    reportStage('textdocs-ready');
    reportStage('handoff-build');
    const handoffPayload = buildHandoffDownloadPayload(
      snapshot,
      textdocs,
      conversationId,
      exportTimestamp
    );
    reportStage('handoff-ready');
    if (enforceCurrentPage) {
      assertConversationStillCurrent(conversationId, '下載交接 JSON 前');
    }
    return {
      handoffPayload,
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0,
      conversationIntegrity: snapshot.integrity || null,
      transport: snapshot.transport || null
    };
  }

  /*
   * 建立已驗證 raw conversation 的文字 payload。
   *
   * 與既有單一 raw 下載相同，輸出 4 空白縮排的 conversation JSON。
   */
  function buildRawDownloadPayload({ rawText, conversation }, conversationId, exportTimestamp) {
    return {
      text: JSON.stringify(conversation, null, 4),
      filename: buildRawFilename(rawText, conversationId, exportTimestamp)
    };
  }
  /*
   * 建立正規化 textdocs 的文字 payload。
   *
   * 沒有 textdocs 時回傳 null；raw 批次會因此只封裝 conversation JSON。
   */
  function buildTextdocsDownloadPayload(textdocs, rawText, conversationId, exportTimestamp) {
    if (!Array.isArray(textdocs) || textdocs.length === 0) {
      return null;
    }
    return {
      text: JSON.stringify(textdocs, null, 4),
      filename: buildTextdocsFilename(rawText, conversationId, exportTimestamp)
    };
  }
  /*
   * 以指定 conversation ID 建立 raw 批次需要的 payload。
   *
   * conversation 仍必須通過 authoritative transport / Resource Timing；
   * textdocs 採既有容錯，無法取得時以空陣列繼續。
   */
  async function createRawPayloadForConversationId(
    conversationId,
    {
      onStage = null,
      onConversationProgress = null,
      onTextdocsProgress = null
    } = {}
  ) {
    const reportStage = (stage) => {
      if (typeof onStage !== 'function') {
        return;
      }
      try {
        onStage(stage);
      } catch {
        // UI callback 不得影響正式資料取得。
      }
    };
    const exportTimestamp = getTimestampString();
    reportStage('conversation-start');
    const snapshot = await refetchLatestConversationSnapshot(conversationId, {
      onProgress: onConversationProgress
    });
    assertSnapshotConversationMatches(snapshot, conversationId, '產出批次原始 JSON 前');
    reportStage('conversation-ready');
    reportStage('textdocs-start');
    const textdocs = await getLatestTextdocs(conversationId, {
      onProgress: onTextdocsProgress
    });
    reportStage('textdocs-ready');
    reportStage('raw-build');
    const rawPayload = buildRawDownloadPayload(snapshot, conversationId, exportTimestamp);
    const textdocsPayload = buildTextdocsDownloadPayload(
      textdocs,
      snapshot.rawText,
      conversationId,
      exportTimestamp
    );
    reportStage('raw-ready');
    return {
      rawPayload,
      textdocsPayload,
      textdocCount: Array.isArray(textdocs) ? textdocs.length : 0,
      conversationIntegrity: snapshot.integrity || null,
      transport: snapshot.transport || null
    };
  }
  /*
   * 下載 Blob 檔案。
   */
  function downloadBlobFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }
  /*
   * ZIP32 / STORE 純封裝 writer。
   *
   * - compression method 固定為 0（STORE），不壓縮。
   * - UTF-8 filename flag 固定開啟。
   * - 不載入 CDN / 第三方套件，也不上傳資料。
   * - 以 Blob parts 累積 local file records，避免建立一個同等大小的連續 ArrayBuffer。
   * - 使用標準 ZIP32；單檔、offset、central directory 或整體結構超過 4 GiB 時停止，
   *   不偷偷改用未實作的 ZIP64。
   */
  let storedZipCrc32Table = null;
  function getStoredZipCrc32Table() {
    if (storedZipCrc32Table) {
      return storedZipCrc32Table;
    }
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1)
          ? (0xedb88320 ^ (value >>> 1))
          : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    storedZipCrc32Table = table;
    return table;
  }
  function calculateStoredZipCrc32(bytes) {
    const table = getStoredZipCrc32Table();
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
      crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function writeZipUint16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }
  function writeZipUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }
  function getStoredZipDosDateTime(date = new Date()) {
    const year = Math.min(2107, Math.max(1980, date.getFullYear()));
    const dosTime =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate =
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return {
      time: dosTime,
      date: dosDate
    };
  }
  function splitZipFilenameForSuffix(filename) {
    for (const suffix of ['.handoff.json', '.textdocs.json', '.json']) {
      if (filename.toLowerCase().endsWith(suffix)) {
        return {
          base: filename.slice(0, -suffix.length),
          extension: filename.slice(-suffix.length)
        };
      }
    }
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex > 0) {
      return {
        base: filename.slice(0, dotIndex),
        extension: filename.slice(dotIndex)
      };
    }
    return {
      base: filename,
      extension: ''
    };
  }
  function createUniqueStoredZipFilename(filename, usedNames) {
    let candidate = String(filename || 'file');
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    const { base, extension } = splitZipFilenameForSuffix(candidate);
    let suffixIndex = 2;
    while (usedNames.has(`${base} (${suffixIndex})${extension}`)) {
      suffixIndex += 1;
    }
    candidate = `${base} (${suffixIndex})${extension}`;
    usedNames.add(candidate);
    return candidate;
  }
  function createStoredZipBuilder() {
    const encoder = new TextEncoder();
    const parts = [];
    const centralEntries = [];
    const usedNames = new Set();
    let offset = 0;
    let fileCount = 0;
    const ZIP32_MAX = 0xffffffff;
    const ZIP32_MAX_FILES = 0xffff;
    const ensureZip32 = (value, label) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX) {
        throw new Error(`ZIP32 限制：${label} 超過 4 GiB 可表示範圍。`);
      }
    };
    const addTextFile = (requestedFilename, text, date = new Date()) => {
      if (fileCount >= ZIP32_MAX_FILES) {
        throw new Error('ZIP32 限制：檔案數量超過 65535。');
      }
      const safeRequestedFilename = String(requestedFilename || 'file')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 240) || 'file';
      const filename = createUniqueStoredZipFilename(
        safeRequestedFilename,
        usedNames
      );
      const filenameBytes = encoder.encode(filename);
      if (filenameBytes.length > 0xffff) {
        throw new Error('ZIP32 限制：ZIP 內檔名過長。');
      }
      const dataBytes = encoder.encode(String(text));
      const dataSize = dataBytes.byteLength;
      ensureZip32(dataSize, `檔案 ${filename}`);
      const crc32 = calculateStoredZipCrc32(dataBytes);
      const { time, date: dosDate } = getStoredZipDosDateTime(date);
      const flags = 0x0800; // UTF-8 filenames
      const method = 0; // STORE
      const localHeader = new ArrayBuffer(30 + filenameBytes.length);
      const localView = new DataView(localHeader);
      writeZipUint32(localView, 0, 0x04034b50);
      writeZipUint16(localView, 4, 20);
      writeZipUint16(localView, 6, flags);
      writeZipUint16(localView, 8, method);
      writeZipUint16(localView, 10, time);
      writeZipUint16(localView, 12, dosDate);
      writeZipUint32(localView, 14, crc32);
      writeZipUint32(localView, 18, dataSize);
      writeZipUint32(localView, 22, dataSize);
      writeZipUint16(localView, 26, filenameBytes.length);
      writeZipUint16(localView, 28, 0);
      new Uint8Array(localHeader, 30).set(filenameBytes);
      const localRecordSize = localHeader.byteLength + dataSize;
      ensureZip32(offset, 'local header offset');
      ensureZip32(offset + localRecordSize, 'archive data');
      parts.push(localHeader, dataBytes);
      centralEntries.push({
        filenameBytes,
        crc32,
        dataSize,
        time,
        dosDate,
        flags,
        method,
        localHeaderOffset: offset
      });
      offset += localRecordSize;
      fileCount += 1;
      return {
        filename,
        bytes: dataSize,
        crc32
      };
    };
    const finalize = () => {
      const centralOffset = offset;
      const centralParts = [];
      let centralSize = 0;
      for (const entry of centralEntries) {
        const header = new ArrayBuffer(46 + entry.filenameBytes.length);
        const view = new DataView(header);
        writeZipUint32(view, 0, 0x02014b50);
        writeZipUint16(view, 4, 20);
        writeZipUint16(view, 6, 20);
        writeZipUint16(view, 8, entry.flags);
        writeZipUint16(view, 10, entry.method);
        writeZipUint16(view, 12, entry.time);
        writeZipUint16(view, 14, entry.dosDate);
        writeZipUint32(view, 16, entry.crc32);
        writeZipUint32(view, 20, entry.dataSize);
        writeZipUint32(view, 24, entry.dataSize);
        writeZipUint16(view, 28, entry.filenameBytes.length);
        writeZipUint16(view, 30, 0);
        writeZipUint16(view, 32, 0);
        writeZipUint16(view, 34, 0);
        writeZipUint16(view, 36, 0);
        writeZipUint32(view, 38, 0);
        writeZipUint32(view, 42, entry.localHeaderOffset);
        new Uint8Array(header, 46).set(entry.filenameBytes);
        centralParts.push(header);
        centralSize += header.byteLength;
      }
      ensureZip32(centralOffset, 'central directory offset');
      ensureZip32(centralSize, 'central directory size');
      ensureZip32(centralOffset + centralSize + 22, 'archive size');
      const endRecord = new ArrayBuffer(22);
      const endView = new DataView(endRecord);
      writeZipUint32(endView, 0, 0x06054b50);
      writeZipUint16(endView, 4, 0);
      writeZipUint16(endView, 6, 0);
      writeZipUint16(endView, 8, fileCount);
      writeZipUint16(endView, 10, fileCount);
      writeZipUint32(endView, 12, centralSize);
      writeZipUint32(endView, 16, centralOffset);
      writeZipUint16(endView, 20, 0);
      return new Blob(
        [...parts, ...centralParts, endRecord],
        { type: 'application/zip' }
      );
    };
    const createCheckpoint = () => ({
      partsLength: parts.length,
      centralEntriesLength: centralEntries.length,
      offset,
      fileCount,
      usedNames: new Set(usedNames)
    });
    const rollback = (checkpoint) => {
      if (!checkpoint) {
        return;
      }
      parts.length = checkpoint.partsLength;
      centralEntries.length = checkpoint.centralEntriesLength;
      offset = checkpoint.offset;
      fileCount = checkpoint.fileCount;
      usedNames.clear();
      for (const name of checkpoint.usedNames) {
        usedNames.add(name);
      }
    };
    return {
      addTextFile,
      createCheckpoint,
      rollback,
      finalize,
      getFileCount: () => fileCount
    };
  }
  /*
   * 下載已建立好的 handoff JSON。
   */
  function downloadHandoffPayload({ text, filename }) {
    downloadTextFile(text, filename);
  }
  /*
   * 取得目前頁面的 conversation 狀態。
   */
  function getCurrentState() {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) {
      return {
        conversationId: null,
        capture: null,
        replayRequest: null
      };
    }
    return {
      conversationId,
      capture: capturedRawByConversationId.get(conversationId) || null,
      replayRequest: replayRequestByConversationId.get(conversationId) || null
    };
  }
  // ============================================================
  // 五、handoff JSON 轉換邏輯
  // ============================================================
  /*
   * 將 ChatGPT content.parts 中的文字片段合併。
   *
   * 會排除：
   *   - image_asset_pointer
   *   - asset_pointer
   *
   * 避免把圖片 / 檔案資產指標塞進 handoff content。
   */
  function flattenTextLikeParts(parts) {
    if (!Array.isArray(parts)) {
      return '';
    }
    const texts = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        if (part.trim()) {
          texts.push(part);
        }
        continue;
      }
      if (!part || typeof part !== 'object') {
        continue;
      }
      const partContentType = part.content_type;
      if (partContentType === 'image_asset_pointer' || partContentType === 'asset_pointer') {
        continue;
      }
      if (typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text);
        continue;
      }
      if (typeof part.content === 'string' && part.content.trim()) {
        texts.push(part.content);
        continue;
      }
    }
    return texts.join('\n');
  }
  /*
   * 將 ChatGPT message.content 正規化成純文字。
   */
  function normalizeContentToText(content, role) {
    if (!content || typeof content !== 'object') {
      if (typeof content === 'string' && content.trim()) {
        return content.trim();
      }
      return null;
    }
    const contentType = content.content_type;
    if (EXCLUDED_CONTENT_TYPES.has(contentType)) {
      return null;
    }
    /*
     * assistant 的 code / execution_output / tether_browsing_display
     * 通常是工具呼叫、中間輸出或瀏覽工具顯示資料。
     */
    if (
      role === 'assistant' &&
      ['code', 'execution_output', 'tether_browsing_display'].includes(contentType)
    ) {
      return null;
    }
    if (contentType === 'text' || contentType === 'multimodal_text') {
      const text = flattenTextLikeParts(content.parts);
      return text.trim() || null;
    }
    if (contentType === 'code' || contentType === 'execution_output') {
      if (typeof content.text === 'string' && content.text.trim()) {
        return content.text.trim();
      }
      return null;
    }
    if (contentType === 'tether_browsing_display') {
      if (typeof content.summary === 'string' && content.summary.trim()) {
        return content.summary.trim();
      }
      return null;
    }
    return null;
  }
  /*
   * 移除 ChatGPT 內嵌引用標記。
   */
  function removeInlineMarks(text) {
    return String(text || '')
      .replace(INLINE_MARK_PATTERN, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  /*
   * 判斷 assistant 訊息是否送往工具 recipient。
   *
   * 真正顯示給使用者看的 assistant 訊息通常會送往 all；
   * canmore.create_textdoc、canmore.update_textdoc、web.run 等 recipient
   * 代表這則訊息是工具呼叫，不應輸出到 handoff messages。
   */
  function hasAssistantToolRecipient(message) {
    const recipient = message && typeof message.recipient === 'string'
      ? message.recipient.trim()
      : '';
    return Boolean(recipient && recipient !== 'all');
  }
  /*
   * 判斷 JSON 物件是否像 canmore / textdoc 工具 payload。
   *
   * 這裡只檢查整段 assistant 內容能被解析成 JSON 物件的情況，
   * 避免誤刪一般回覆中夾帶的 JSON 範例。
   */
  function looksLikeCanmoreToolPayloadObject(value) {
    if (!isObjectRecord(value)) {
      return false;
    }
    if (Array.isArray(value.updates) || Array.isArray(value.comments)) {
      return true;
    }
    if (
      typeof value.name === 'string' &&
      typeof value.type === 'string' &&
      typeof value.content === 'string'
    ) {
      return value.type === 'document' || value.type.startsWith('code/');
    }
    return false;
  }
  /*
   * 判斷 assistant 文字內容是否像工具操作 payload。
   *
   * 這類內容不是給使用者閱讀的自然語言回覆，因此不輸出到 handoff。
   */
  function looksLikeAssistantToolOperation(text) {
    const stripped = String(text || '').trim();
    if (!stripped) {
      return false;
    }
    if (ASSISTANT_TOOL_OPERATION_PATTERN.test(stripped)) {
      return true;
    }
    if (!stripped.startsWith('{') || !stripped.endsWith('}')) {
      return false;
    }
    try {
      return looksLikeCanmoreToolPayloadObject(JSON.parse(stripped));
    } catch {
      return false;
    }
  }
  /*
   * 引用來源 attribution 可能是字串，也可能是物件。
   */
  function normalizeAttribution(attribution) {
    if (attribution && typeof attribution === 'object') {
      return attribution.name || attribution.display_name || attribution.url || null;
    }
    return typeof attribution === 'string' && attribution.trim() ? attribution : null;
  }
  /*
   * 從 citation metadata 建立 handoff 用的引用來源物件。
   *
   * 僅保留 URL、標題、摘要、發布時間與歸屬資訊。
   */
  function buildCiteSource(source) {
    const rawPubDate =
      typeof source.pub_date === 'string' && source.pub_date.trim()
        ? source.pub_date
        : typeof source.published_at === 'string' && source.published_at.trim()
          ? source.published_at
          : source.time;
    return {
      url: typeof source.url === 'string' ? source.url : null,
      title: typeof source.title === 'string' ? source.title : null,
      snippet: typeof source.snippet === 'string' ? source.snippet : null,
      pub_date: toReadableTime(rawPubDate),
      attribution: normalizeAttribution(source.attribution)
    };
  }
  /*
   * 建立引用來源去重用 key。
   *
   * 優先用 URL；若沒有 URL，改用其他欄位組合降低重複輸出。
   */
  function citeSourceKey(source) {
    return JSON.stringify([
      source.url,
      source.title,
      source.snippet,
      source.pub_date,
      source.attribution
    ]);
  }
  /*
   * 去除重複引用來源。
   */
  function dedupeCiteSources(values) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const normalized = {
        url: typeof value.url === 'string' && value.url.trim() ? value.url : null,
        title: typeof value.title === 'string' && value.title.trim() ? value.title : null,
        snippet: typeof value.snippet === 'string' && value.snippet.trim() ? value.snippet : null,
        pub_date: toReadableTime(value.pub_date),
        attribution:
          typeof value.attribution === 'string' && value.attribution.trim()
            ? value.attribution
            : null
      };
      if (
        normalized.url === null &&
        normalized.title === null &&
        normalized.snippet === null &&
        normalized.pub_date === null &&
        normalized.attribution === null
      ) {
        continue;
      }
      const key = citeSourceKey(normalized);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }
  /*
   * 從 assistant 訊息 metadata 中抽出引用來源。
   *
   * 支援多種可能位置：
   *   - metadata.content_references[].items
   *   - metadata.content_references[].safe_urls
   *   - metadata.search_result_groups[].entries
   *   - metadata.citations
   *   - metadata.safe_urls
   */
  function extractAssistantCiteSources(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
    if (!metadata) {
      return [];
    }
    const sources = [];
    if (Array.isArray(metadata.content_references)) {
      for (const ref of metadata.content_references) {
        if (!ref || typeof ref !== 'object') {
          continue;
        }
        if (Array.isArray(ref.items)) {
          for (const item of ref.items) {
            if (item && typeof item === 'object') {
              sources.push(buildCiteSource(item));
            }
          }
        }
        if (Array.isArray(ref.safe_urls)) {
          for (const url of ref.safe_urls) {
            if (typeof url === 'string') {
              sources.push(buildCiteSource({ url }));
            }
          }
        }
      }
    }
    if (Array.isArray(metadata.search_result_groups)) {
      for (const group of metadata.search_result_groups) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.entries)) {
          continue;
        }
        for (const entry of group.entries) {
          if (entry && typeof entry === 'object') {
            sources.push(buildCiteSource(entry));
          }
        }
      }
    }
    if (Array.isArray(metadata.citations)) {
      for (const citation of metadata.citations) {
        if (citation && typeof citation === 'object') {
          sources.push(buildCiteSource(citation));
        }
      }
    }
    if (Array.isArray(metadata.safe_urls)) {
      for (const url of metadata.safe_urls) {
        if (typeof url === 'string') {
          sources.push(buildCiteSource({ url }));
        }
      }
    }
    return dedupeCiteSources(sources);
  }
  /*
   * 取得 conversation mapping。
   *
   * mapping 是 ChatGPT 對話樹的核心資料，後續會用 current_node 回推主分支。
   */
  function getMapping(conversation) {
    const mapping = conversation.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new Error('conversation JSON 不包含有效的 mapping 物件。');
    }
    return mapping;
  }
  /*
   * ChatGPT 原始 conversation JSON 是樹狀結構。
   *
   * current_node 表示目前 UI 採用的最後節點。
   * 沿 parent 一路往上追，即可取得目前主分支。
   */
  function resolveMainPath(mapping, currentNode) {
    if (!currentNode) {
      return [];
    }
    const path = [];
    const seen = new Set();
    let nodeId = currentNode;
    while (nodeId) {
      if (seen.has(nodeId)) {
        throw new Error(`偵測到循環 parent chain：${nodeId}`);
      }
      seen.add(nodeId);
      path.push(nodeId);
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        break;
      }
      nodeId = typeof node.parent === 'string' && node.parent ? node.parent : null;
    }
    path.reverse();
    return path;
  }
  /*
   * 從一個 mapping node 中抽出 handoff message。
   */
  function extractMessageItem(node) {
    const message = node && typeof node.message === 'object' ? node.message : null;
    if (!message) {
      return null;
    }
    const author = message.author && typeof message.author === 'object' ? message.author : null;
    if (!author) {
      return null;
    }
    const role = author.role;
    if (!ALLOWED_ROLES.has(role)) {
      return null;
    }
    if (role === 'assistant' && hasAssistantToolRecipient(message)) {
      return null;
    }
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    if (metadata && metadata.is_visually_hidden_from_conversation === true) {
      return null;
    }
    const text = normalizeContentToText(message.content, role);
    if (!text) {
      return null;
    }
    const item = {
      role,
      content: text
    };
    if (role === 'assistant') {
      item.content = removeInlineMarks(text);
      if (!item.content) {
        return null;
      }
      if (looksLikeAssistantToolOperation(item.content)) {
        return null;
      }
      const citeSources = extractAssistantCiteSources(message);
      if (citeSources.length > 0) {
        item.cite_sources = citeSources;
      }
    }
    return item;
  }
  /*
   * 根據 comment start / end 取出對應的畫布文字片段。
   *
   * 如果位置資訊無效，回傳 null，避免產生錯誤的 target_text。
   */
  function getTextdocCommentTargetText(textdocContent, start, end) {
    if (
      typeof textdocContent !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > textdocContent.length
    ) {
      return null;
    }
    return textdocContent.slice(start, end);
  }
  /*
   * 從 canvas tool message 判斷 canmore 指令名稱。
   *
   * 優先讀 metadata.command；若沒有，再從 author.name 的 canmore.* 格式推得。
   */
  function getCanvasCommand(message) {
    const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
    if (metadata && typeof metadata.command === 'string' && metadata.command.trim()) {
      return metadata.command.trim();
    }
    const author = message && typeof message.author === 'object' ? message.author : null;
    if (author && typeof author.name === 'string' && author.name.startsWith('canmore.')) {
      return author.name.slice('canmore.'.length);
    }
    return null;
  }
  /*
   * 從 raw conversation JSON 中整理畫布生命週期資訊。
   *
   * 這裡只整理對 handoff 有幫助的摘要：
   *   - 建立時間
   *   - 建立來源
   *   - 建立版本
   *   - 更新次數
   *   - 加註解事件次數
   *   - 最後一次 canvas tool event 時間
   *
   * 不輸出 request_id、turn_exchange_id、async_source 等內部追蹤欄位。
   */
  function extractTextdocLifecycle(conversation, pathNodeIds) {
    const mapping = getMapping(conversation);
    const lifecycleById = new Map();
    for (const nodeId of pathNodeIds) {
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        continue;
      }
      const message = node.message && typeof node.message === 'object' ? node.message : null;
      const metadata = message && typeof message.metadata === 'object' ? message.metadata : null;
      const canvas = metadata && typeof metadata.canvas === 'object' ? metadata.canvas : null;
      if (!canvas || typeof canvas.textdoc_id !== 'string' || !canvas.textdoc_id) {
        continue;
      }
      const textdocId = canvas.textdoc_id;
      const command = getCanvasCommand(message);
      const eventTime = toReadableTime(message.create_time);
      const eventTimeValue =
        typeof message.create_time === 'number' && Number.isFinite(message.create_time)
          ? message.create_time
          : null;
      let lifecycle = lifecycleById.get(textdocId);
      if (!lifecycle) {
        lifecycle = {
          created_at: null,
          create_source: null,
          created_version: null,
          latest_observed_version: null,
          update_count: 0,
          comment_event_count: 0,
          last_canvas_event_at: null,
          last_canvas_event_time_value: null
        };
        lifecycleById.set(textdocId, lifecycle);
      }
      if (Number.isFinite(canvas.version)) {
        lifecycle.latest_observed_version =
          lifecycle.latest_observed_version === null
            ? canvas.version
            : Math.max(lifecycle.latest_observed_version, canvas.version);
      }
      if (
        eventTime &&
        (
          lifecycle.last_canvas_event_time_value === null ||
          eventTimeValue === null ||
          eventTimeValue >= lifecycle.last_canvas_event_time_value
        )
      ) {
        lifecycle.last_canvas_event_at = eventTime;
        if (eventTimeValue !== null) {
          lifecycle.last_canvas_event_time_value = eventTimeValue;
        }
      }
      if (command === 'create_textdoc') {
        if (!lifecycle.created_at && eventTime) {
          lifecycle.created_at = eventTime;
        }
        if (typeof canvas.create_source === 'string' && canvas.create_source.trim()) {
          lifecycle.create_source = canvas.create_source;
        }
        if (Number.isFinite(canvas.version)) {
          lifecycle.created_version = canvas.version;
        }
      } else if (command === 'update_textdoc') {
        lifecycle.update_count += 1;
      } else if (command === 'comment_textdoc') {
        lifecycle.comment_event_count += 1;
      }
    }
    return lifecycleById;
  }
  /*
   * 建立單一 textdoc 的生命週期摘要。
   *
   * 只輸出對接續對話有幫助的統計資訊，不輸出內部追蹤欄位。
   */
  function buildTextdocLifecycleSummary(textdoc, lifecycle) {
    const summary = {};
    if (Number.isFinite(textdoc.version)) {
      summary.latest_version = textdoc.version;
    } else if (lifecycle && Number.isFinite(lifecycle.latest_observed_version)) {
      summary.latest_version = lifecycle.latest_observed_version;
    }
    if (lifecycle && Number.isFinite(lifecycle.created_version)) {
      summary.created_version = lifecycle.created_version;
    }
    if (lifecycle && lifecycle.update_count > 0) {
      summary.update_count = lifecycle.update_count;
    }
    if (lifecycle && lifecycle.comment_event_count > 0) {
      summary.comment_event_count = lifecycle.comment_event_count;
    }
    if (lifecycle && lifecycle.last_canvas_event_at) {
      summary.last_canvas_event_at = lifecycle.last_canvas_event_at;
    }
    return summary;
  }
  /*
   * 判斷是否為非空的一般物件。
   *
   * 用於 metadata 等選填欄位，避免在 handoff JSON 中輸出沒有資訊量的空物件。
   */
  function isNonEmptyObject(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  }
  /*
   * 建立 handoff JSON 中的 textdocs 陣列。
   *
   * 會依建立時間排序、重新編號，並整合 textdocs endpoint 與 conversation canvas event 的資訊。
   */
  function buildHandoffTextdocs(textdocs, lifecycleById = new Map()) {
    if (!Array.isArray(textdocs)) {
      return [];
    }
    const orderedTextdocs = textdocs
      .map((textdoc, originalIndex) => {
        const sourceId = typeof textdoc.id === 'string' ? textdoc.id : null;
        const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
        const sortValue =
          lifecycle && lifecycle.created_at
            ? getTimeSortValue(lifecycle.created_at)
            : getTimeSortValue(textdoc && textdoc.updated_at);
        return {
          textdoc,
          originalIndex,
          sortValue
        };
      })
      .sort((left, right) => {
        if (left.sortValue !== right.sortValue) {
          return left.sortValue - right.sortValue;
        }
        return left.originalIndex - right.originalIndex;
      });
    return orderedTextdocs.map(({ textdoc }, index) => {
      const sourceId = typeof textdoc.id === 'string' ? textdoc.id : null;
      const lifecycle = sourceId ? lifecycleById.get(sourceId) : null;
      const result = {
        id: `td${String(index + 1).padStart(2, '0')}`,
        version: Number.isFinite(textdoc.version) ? textdoc.version : null,
        title: typeof textdoc.title === 'string' ? textdoc.title : null,
        textdoc_type: typeof textdoc.textdoc_type === 'string' ? textdoc.textdoc_type : null
      };
      if (lifecycle && lifecycle.created_at) {
        result.created_at = lifecycle.created_at;
      }
      if (typeof textdoc.updated_at === 'string' && textdoc.updated_at.trim()) {
        result.updated_at = toReadableTime(textdoc.updated_at);
      }
      if (lifecycle && lifecycle.create_source) {
        result.create_source = lifecycle.create_source;
      }
      const lifecycleSummary = buildTextdocLifecycleSummary(textdoc, lifecycle);
      if (Object.keys(lifecycleSummary).length > 0) {
        result.lifecycle = lifecycleSummary;
      }
      result.content = typeof textdoc.content === 'string' ? textdoc.content : '';
      if (isNonEmptyObject(textdoc.metadata)) {
        result.metadata = textdoc.metadata;
      }
      const comments = Array.isArray(textdoc.comments) ? textdoc.comments : [];
      result.comments = comments.map((comment, commentIndex) => {
        const start = Number.isInteger(comment && comment.start) ? comment.start : null;
        const end = Number.isInteger(comment && comment.end) ? comment.end : null;
        return {
          id: `tdc${String(commentIndex + 1).padStart(2, '0')}`,
          start,
          end,
          target_text: getTextdocCommentTargetText(result.content, start, end),
          content: comment && typeof comment.content === 'string' ? comment.content : ''
        };
      });
      return result;
    });
  }
  /*
   * 建立 handoff JSON。
   *
   * 輸出格式：
   *   {
   *     title,
   *     create_time,
   *     update_time,
   *     conversation_id,
   *     messages: [
   *       { id: "u01", role: "user", content: "..." },
   *       { id: "a01", role: "assistant", content: "...", cite_sources: [...] }
   *     ]
   *   }
   */
  function buildHandoff(conversation, textdocs = []) {
    const mapping = getMapping(conversation);
    const currentNode = conversation.current_node;
    const pathNodeIds = resolveMainPath(mapping, currentNode);
    const textdocLifecycleById = extractTextdocLifecycle(conversation, pathNodeIds);
    const messages = [];
    let userIndex = 0;
    let assistantIndex = 0;
    for (const nodeId of pathNodeIds) {
      const node = mapping[nodeId];
      if (!node || typeof node !== 'object') {
        continue;
      }
      const item = extractMessageItem(node);
      if (!item) {
        continue;
      }
      let messageId;
      if (item.role === 'user') {
        userIndex += 1;
        messageId = `u${String(userIndex).padStart(2, '0')}`;
      } else if (item.role === 'assistant') {
        assistantIndex += 1;
        messageId = `a${String(assistantIndex).padStart(2, '0')}`;
      } else {
        continue;
      }
      messages.push({
        id: messageId,
        ...item
      });
    }
    return {
      title: conversation.title ?? null,
      create_time: toReadableTime(conversation.create_time),
      update_time: toReadableTime(conversation.update_time),
      conversation_id: conversation.conversation_id ?? null,
      messages,
      textdocs: buildHandoffTextdocs(textdocs, textdocLifecycleById)
    };
  }
  /*
   * 檢查 handoff 轉換結果是否合理。
   *
   * 若檢查失敗，代表不應該下載，避免使用者拿到空或錯誤的 handoff。
   */
  function validateHandoffOrThrow(handoff, sourceConversation) {
    const problems = [];
    if (!handoff || typeof handoff !== 'object') {
      problems.push('handoff 不是有效物件。');
    }
    if (!Array.isArray(handoff.messages)) {
      problems.push('handoff.messages 不是陣列。');
    } else {
      if (handoff.messages.length === 0) {
        problems.push('handoff.messages 為空。');
      }
      for (const [index, message] of handoff.messages.entries()) {
        if (!message || typeof message !== 'object') {
          problems.push(`第 ${index + 1} 則訊息不是有效物件。`);
          continue;
        }
        if (typeof message.id !== 'string' || !message.id) {
          problems.push(`第 ${index + 1} 則訊息缺少 id。`);
        }
        if (message.role !== 'user' && message.role !== 'assistant') {
          problems.push(`第 ${index + 1} 則訊息 role 不合法：${String(message.role)}`);
        }
        if (typeof message.content !== 'string' || !message.content.trim()) {
          problems.push(`第 ${index + 1} 則訊息 content 為空。`);
        }
      }
    }
    if (!Array.isArray(handoff.textdocs)) {
      problems.push('handoff.textdocs 不是陣列。');
    }
    if (!handoff.conversation_id) {
      problems.push('handoff 缺少 conversation_id。');
    }
    if (
      sourceConversation &&
      sourceConversation.conversation_id &&
      handoff.conversation_id !== sourceConversation.conversation_id
    ) {
      problems.push(
        `handoff.conversation_id 與 raw JSON 不一致：${handoff.conversation_id} !== ${sourceConversation.conversation_id}`
      );
    }
    if (problems.length > 0) {
      throw new Error(`交接 JSON 轉換結果檢查失敗：\n\n- ${problems.join('\n- ')}`);
    }
  }
  // ============================================================
  // 六、按鈕 UI、tooltip 與頁面導航處理
  // ============================================================
  /*
   * 更新指定匯出按鈕上的可見文字。
   */
  function setButtonText(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    const label = button.querySelector('[data-export-label]');
    if (label && label.textContent !== text) {
      label.textContent = text;
    }
  }
  /*
   * 更新指定匯出按鈕的 title tooltip。
   */
  function setButtonTooltip(buttonId, text) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    if (button.title !== text) {
      button.title = text;
    }
  }
  /*
   * 將目前 conversation ID 寫到按鈕上，供 click handler 防止 SPA 切換後
   * 殘留的按鈕狀態或 listener 觸發匯出。
   */
  function setButtonConversationId(buttonId, conversationId) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    if (conversationId) {
      if (button.getAttribute('data-cgpt-export-conversation-id') !== conversationId) {
        button.setAttribute('data-cgpt-export-conversation-id', conversationId);
      }
      return;
    }
    button.removeAttribute('data-cgpt-export-conversation-id');
  }
  /*
   * 設定單一按鈕的 busy 狀態。
   *
   * busy 時會停用點擊並調整外觀，避免使用者重複觸發同一個匯出流程。
   */
  function setButtonBusy(buttonId, isBusy) {
    const button = document.querySelector(`#${buttonId}`);
    if (!button) {
      return;
    }
    const opacity = isBusy ? '0.65' : '';
    const cursor = isBusy ? 'wait' : '';
    if (button.disabled !== isBusy) {
      button.disabled = isBusy;
    }
    if (button.style.opacity !== opacity) {
      button.style.opacity = opacity;
    }
    if (button.style.cursor !== cursor) {
      button.style.cursor = cursor;
    }
  }
  /*
   * 同步設定兩個匯出按鈕的 busy 狀態。
   */
  function setAllButtonsBusy(isBusy) {
    setButtonBusy(RAW_BUTTON_ID, isBusy);
    setButtonBusy(HANDOFF_BUTTON_ID, isBusy);
  }
  /*
   * 標記目前有匯出流程正在進行。
   *
   * 這個狀態會讓週期性 UI 更新保留目前進度文字，
   * 例如「正在擷取原始 JSON…」或「正在下載交接 JSON…」。
   */
  function setExportInProgress(buttonId, text) {
    activeExportState = {
      buttonId,
      text
    };
    setAllButtonsBusy(true);
    setButtonText(buttonId, text);
  }
  /*
   * 更新目前匯出流程的進度文字。
   *
   * 匯出流程會分階段呼叫這個 helper，讓使用者知道目前正在擷取、產出或下載哪一種資料。
   */
  function setExportProgress(buttonId, text) {
    if (!activeExportState || activeExportState.buttonId !== buttonId) {
      return;
    }
    activeExportState.text = text;
    setButtonText(buttonId, text);
  }
  /*
   * 若目前正在匯出，重新套用匯出中的按鈕狀態。
   *
   * 回傳 true 代表已接管 UI 狀態，呼叫端不應再覆蓋按鈕文字。
   */
  function applyExportInProgressState() {
    if (!activeExportState) {
      return false;
    }
    setAllButtonsBusy(true);
    setButtonText(activeExportState.buttonId, activeExportState.text);
    return true;
  }
  /*
   * 清除匯出中狀態，並恢復一般按鈕文字與 tooltip。
   */
  function clearExportInProgress() {
    activeExportState = null;
    setAllButtonsBusy(false);
    updateButtonState();
  }
  /*
   * 執行單一匯出流程。
   *
   * 這裡集中處理：
   *   - conversation ID 檢查
   *   - 匯出中進度文字
   *   - busy 狀態
   *   - 錯誤 log 與 alert
   *   - 流程結束後恢復 UI
   *
   * 實際的 raw / handoff 匯出邏輯由 operation callback 提供，
   * callback 可透過 updateProgress() 更新目前階段，讓兩個按鈕共用相同的 UI 狀態管理。
   */
  async function runExportFlow({ buttonId, initialProgressText, errorLogMessage, operation, triggerEvent = null }) {
    const triggerButton = triggerEvent && triggerEvent.currentTarget
      ? triggerEvent.currentTarget
      : document.querySelector(`#${buttonId}`);
    try {
      assertButtonConversationMatchesCurrent(triggerButton);
    } catch (error) {
      logError(errorLogMessage, error);
      showErrorAlert(error);
      updateButtonState();
      return;
    }
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) {
      const rawConversationId = getRawConversationIdFromUrl();
      const temporaryIdMessage = rawConversationId && !isExportableConversationId(rawConversationId)
        ? `目前網址中的 ID「${rawConversationId}」尚不是可匯出的正式 conversation ID。\n\n`
        : '';
      alert(
        '目前不是可匯出的 ChatGPT 對話頁。\n\n' +
        temporaryIdMessage +
        '請確認目前頁面是已建立完成的 ChatGPT 對話，且網址包含正式 UUID 格式的 /c/{conversation_id}。\n' +
        '如果你剛點選「在新聊天中分支」，請先等待新聊天建立完成後再試。'
      );
      return;
    }
    const updateProgress = (text) => {
      setExportProgress(buttonId, text);
    };
    try {
      setExportInProgress(buttonId, initialProgressText);
      assertConversationStillCurrent(conversationId, '匯出開始前');
      await operation(conversationId, updateProgress);
      assertConversationStillCurrent(conversationId, '匯出完成前');
    } catch (error) {
      logError(errorLogMessage, error);
      showErrorAlert(error);
    } finally {
      clearExportInProgress();
    }
  }
  /*
   * 建立按鈕 tooltip。
   *
   * 兩個按鈕會使用不同 actionName，避免 title 看起來像共用同一段說明。
   * tooltip 只顯示對話標題、conversation ID 與捕捉時間，不顯示 headers 或 raw JSON。
   */
  function buildBaseTooltip({ actionName, conversationId, capture, replayRequest }) {
    const title = conversationId ? getKnownConversationTitle(conversationId) : '';
    const lines = [actionName];
    if (title) {
      lines.push(`對話標題：${title}`);
    }
    if (conversationId) {
      lines.push(`Conversation ID：${conversationId}`);
    }
    if (replayRequest) {
      lines.push(`最近一次捕捉請求資訊：${getDisplayDateTime(new Date(replayRequest.capturedAt))}`);
    }
    if (capture) {
      lines.push(`最近一次捕捉 JSON：${getDisplayDateTime(new Date(capture.capturedAt))}`);
    }
    return lines.join('\n');
  }
  /*
   * 根據目前頁面狀態更新按鈕文字與 tooltip。
   *
   * 按鈕文字維持動作名稱，避免在 SPA 導航或新對話頁面中殘留暫時狀態。
   * 詳細狀態放在 tooltip 與錯誤訊息中呈現。
   */
  function updateButtonState() {
    const { conversationId, capture, replayRequest } = getCurrentState();
    const isExporting = applyExportInProgressState();
    if (!isConversationPage() || !conversationId) {
      setButtonConversationId(RAW_BUTTON_ID, null);
      setButtonConversationId(HANDOFF_BUTTON_ID, null);
      if (!isExporting) {
        setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
        setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');
        setButtonTooltip(RAW_BUTTON_ID, '');
        setButtonTooltip(HANDOFF_BUTTON_ID, '');
        setAllButtonsBusy(false);
      }
      return;
    }
    setButtonConversationId(RAW_BUTTON_ID, conversationId);
    setButtonConversationId(HANDOFF_BUTTON_ID, conversationId);
    if (!isExporting) {
      setButtonText(RAW_BUTTON_ID, '下載原始 JSON');
      setButtonText(HANDOFF_BUTTON_ID, '下載交接 JSON');
      setAllButtonsBusy(false);
    }
    const rawActionName = '下載目前對話的原始 raw conversation JSON';
    const handoffActionName = '產出並下載目前對話的交接 handoff JSON';
    setButtonTooltip(
      RAW_BUTTON_ID,
      buildBaseTooltip({
        actionName: rawActionName,
        conversationId,
        capture,
        replayRequest
      })
    );
    setButtonTooltip(
      HANDOFF_BUTTON_ID,
      buildBaseTooltip({
        actionName: handoffActionName,
        conversationId,
        capture,
        replayRequest
      })
    );
  }
  /*
   * 離開對話頁時移除匯出按鈕。
   *
   * ChatGPT 是 SPA，網址切換時不一定重新載入頁面，因此需要主動清理既有 UI 狀態。
   */
  function removeButtonsIfNeeded() {
    stopObservingHeaderActionLayout();
    const rawButton = document.querySelector(`#${RAW_BUTTON_ID}`);
    const handoffButton = document.querySelector(`#${HANDOFF_BUTTON_ID}`);
    if (rawButton) {
      rawButton.remove();
    }
    if (handoffButton) {
      handoffButton.remove();
    }
  }
  /*
   * 建立和 ChatGPT header action 風格接近的按鈕。
   */
  function createHeaderButton({ id, label, ariaLabel, testId, iconSvg, onClick }) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    button.setAttribute('data-testid', testId);
    button.setAttribute('data-cgpt-export-button', 'true');
    /*
     * 這裡沿用 ChatGPT 既有按鈕 class，讓樣式與「分享」按鈕一致。
     * 若 ChatGPT 未來改 class，按鈕可能仍存在，但外觀可能需要調整。
     */
    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      'btn-ghost',
      'text-token-text-primary',
      'hover:bg-token-surface-hover',
      'keyboard-focused:bg-token-surface-hover',
      'rounded-lg',
      'max-sm:hidden'
    ].join(' ');
    button.innerHTML = `
      <div class="flex w-full items-center justify-center gap-1.5">
        ${iconSvg || ''}
        <span data-export-label>${label}</span>
      </div>
    `;
    /*
     * 滑鼠移入或鍵盤 focus 時重新整理 tooltip。
     * 這能讓剛改名的對話標題較快反映到 title。
     */
    button.addEventListener('mouseenter', () => {
      updateButtonState();
    });
    button.addEventListener('focus', () => {
      updateButtonState();
    });
    button.addEventListener('click', onClick);
    button.setAttribute('data-cgpt-export-listener-version', EXPORT_BUTTON_LISTENER_VERSION);
    return button;
  }
  /*
   * 執行「下載原始 JSON」的實際匯出工作。
   *
   * 流程刻意拆成三步：
   *   1. 取得並驗證 conversation raw JSON。
   *   2. 立即下載 raw JSON。
   *   3. 再嘗試下載 textdocs。
   *
   * 這樣即使 textdocs 取得失敗，也不會影響最重要的 raw JSON。
   */
  async function exportRawConversationFiles(conversationId, updateProgress) {
    const exportTimestamp = getTimestampString();
    updateProgress('正在擷取原始 JSON…');
    const snapshot = await getLatestConversationSnapshot(conversationId);
    assertSnapshotConversationMatches(snapshot, conversationId, '下載原始 JSON 前');
    assertConversationStillCurrent(conversationId, '下載原始 JSON 前');
    updateProgress('正在下載原始 JSON…');
    downloadRawConversation(snapshot, conversationId, exportTimestamp);
    updateProgress('正在擷取 textdocs…');
    assertConversationStillCurrent(conversationId, '擷取 textdocs 前');
    const textdocs = await getLatestTextdocs(conversationId);
    assertConversationStillCurrent(conversationId, '擷取 textdocs 後');
    if (Array.isArray(textdocs) && textdocs.length > 0) {
      updateProgress('正在下載 textdocs…');
      downloadTextdocsIfPresent(textdocs, snapshot.rawText, conversationId, exportTimestamp);
    }
  }
  /*
   * 執行「下載交接 JSON」的實際匯出工作。
   *
   * handoff 需要同時整合對話主分支與 textdocs。
   * textdocs 若不可取得會被視為空陣列，讓主要對話脈絡仍可交接。
   */
  async function exportHandoffFile(conversationId, updateProgress) {
    const result = await createHandoffPayloadForConversationId(conversationId, {
      enforceCurrentPage: true,
      onStage(stage) {
        if (stage === 'conversation-start') {
          updateProgress('正在擷取原始 JSON…');
        } else if (stage === 'textdocs-start') {
          updateProgress('正在擷取 textdocs…');
        } else if (stage === 'handoff-build') {
          updateProgress('正在產出交接 JSON…');
        } else if (stage === 'handoff-ready') {
          updateProgress('正在下載交接 JSON…');
        }
      }
    });
    downloadHandoffPayload(result.handoffPayload);
  }
  /*
   * 點擊「下載原始 JSON」。
   *
   * raw JSON 會輸出為 4 空白縮排，方便閱讀與版本管理。
   */
  async function handleDownloadRawClick(event) {
    await runExportFlow({
      buttonId: RAW_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載原始 JSON 失敗。',
      operation: exportRawConversationFiles,
      triggerEvent: event
    });
  }
  /*
   * 點擊「下載交接 JSON」。
   *
   * UI 狀態與錯誤處理由 runExportFlow() 統一處理，
   * 實際轉換與下載工作交給 exportHandoffFile()。
   */
  async function handleDownloadHandoffClick(event) {
    await runExportFlow({
      buttonId: HANDOFF_BUTTON_ID,
      initialProgressText: '正在擷取原始 JSON…',
      errorLogMessage: '下載交接 JSON 失敗。',
      operation: exportHandoffFile,
      triggerEvent: event
    });
  }
  /*
   * 移除同一個按鈕 ID 的重複節點。
   *
   * ChatGPT SPA 重繪或 userscript 重複初始化異常時，可能留下重複按鈕；
   * 保留第一個節點並移除其餘節點，可避免 UI 上出現多組匯出按鈕。
   */
  function removeDuplicateButtons(buttonId) {
    const buttons = Array.from(document.querySelectorAll(`#${buttonId}`));
    for (const duplicateButton of buttons.slice(1)) {
      duplicateButton.remove();
    }
  }
  /*
   * 取得匯出按鈕應插入的 header action 容器。
   *
   * 優先使用目前最精準的 #conversation-header-actions；
   * 若 ChatGPT 前端調整 DOM，則依序退回 thread header 右側 action 區與 page header。
   */
  function findHeaderActionsContainer() {
    const selectors = [
      '#conversation-header-actions',
      '[data-testid="thread-header-right-actions"]',
      '[data-testid="thread-header-right-actions-container"]',
      '#page-header'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return null;
  }
  /*
   * 取得或建立指定匯出按鈕。
   *
   * 若按鈕已存在，會檢查節點的 listener 標記；標記不一致時重建按鈕，
   * 以避免殘留的 click listener 或 conversation 狀態。
   */
  function getOrCreateExportButton(config) {
    const existingButton = document.querySelector(`#${config.id}`);
    if (existingButton) {
      if (existingButton.getAttribute('data-cgpt-export-listener-version') !== EXPORT_BUTTON_LISTENER_VERSION) {
        const replacementButton = createHeaderButton(config);
        const existingCompact = existingButton.getAttribute('data-cgpt-export-compact');
        const existingConversationId = existingButton.getAttribute('data-cgpt-export-conversation-id');
        if (existingCompact) {
          replacementButton.setAttribute('data-cgpt-export-compact', existingCompact);
        }
        if (existingConversationId) {
          replacementButton.setAttribute('data-cgpt-export-conversation-id', existingConversationId);
        }
        existingButton.replaceWith(replacementButton);
        return replacementButton;
      }
      /*
       * 補上 CSS 相依的識別屬性。
       * 這可避免 SPA 頁面中按鈕被重用時，CSS selector 無法命中。
       */
      existingButton.setAttribute('data-cgpt-export-button', 'true');
      existingButton.setAttribute('data-testid', config.testId);
      existingButton.setAttribute('aria-label', config.ariaLabel);
      return existingButton;
    }
    return createHeaderButton(config);
  }
  /*
   * 找出 element 在 parent 底下對應的直接子元素。
   *
   * ChatGPT header 的 action 可能包在多層 div 裡，例如更多選單按鈕通常
   * 不會直接掛在 #conversation-header-actions 底下。
   *
   * 插入匯出按鈕時，若直接對深層 button 操作，可能會把按鈕塞進錯誤 wrapper。
   * 因此這裡先往上找到 action 容器底下的直接子元素，再用該節點決定插入位置。
   */
  function getDirectChildWithin(parent, element) {
    if (!parent || !element) {
      return null;
    }
    let current = element;
    while (current && current.parentElement && current.parentElement !== parent) {
      current = current.parentElement;
    }
    return current && current.parentElement === parent ? current : null;
  }
  /*
   * 將匯出按鈕放到 ChatGPT header 的適當位置。
   *
   * 目標順序：
   *   分享 → 下載原始 JSON → 下載交接 JSON → 更多選單
   *
   * 使用 header action 的直接子元素作為插入錨點，避免匯出按鈕被放到
   * ChatGPT 原生按鈕的內層 wrapper 裡。
   *
   * 若找不到分享按鈕或更多選單，仍會把兩顆匯出按鈕插入 action 容器中，
   * 避免 ChatGPT DOM 結構小幅變動時按鈕直接消失。
   */
  function placeExportButtons(headerActions, rawButton, handoffButton) {
    const shareButton = headerActions.querySelector(SHARE_BUTTON_SELECTOR);
    const optionsButton = headerActions.querySelector('[data-testid="conversation-options-button"]');
    const shareAction = getDirectChildWithin(headerActions, shareButton);
    const optionsAction = getDirectChildWithin(headerActions, optionsButton);
    if (shareAction) {
      if (shareAction.nextElementSibling !== rawButton) {
        shareAction.insertAdjacentElement('afterend', rawButton);
      }
    } else if (optionsAction) {
      if (optionsAction.previousElementSibling !== rawButton) {
        optionsAction.insertAdjacentElement('beforebegin', rawButton);
      }
    } else if (rawButton.parentElement !== headerActions) {
      headerActions.append(rawButton);
    }
    if (rawButton.nextElementSibling !== handoffButton) {
      rawButton.insertAdjacentElement('afterend', handoffButton);
    }
  }
  /*
   * Header action 版面同步用的暫存資源。
   *
   * MutationObserver：監看 ChatGPT React 重建分享按鈕、文字節點或 wrapper。
   * ResizeObserver：監看 page header 與右側 action 區實際寬度。
   * window resize：作為舊環境與瀏覽器縮放的輕量備援。
   */
  let headerActionLayoutTimer = null;
  let headerActionLayoutObserver = null;
  let headerActionLayoutResizeObserver = null;
  let headerActionLayoutResizeHandler = null;
  let observedHeaderActionLayoutTargets = null;
  /*
   * 將 compact 狀態同步寫入 action 容器與兩顆匯出按鈕。
   *
   * data-cgpt-header-compact：三顆主要按鈕共用的版面狀態。
   * data-cgpt-export-compact：保留既有 CSS 相依介面，避免舊規則失效。
   */
  function setHeaderActionsCompact(headerActions, rawButton, handoffButton, isCompact) {
    const value = isCompact ? 'true' : 'false';
    if (headerActions.getAttribute('data-cgpt-header-compact') !== value) {
      headerActions.setAttribute('data-cgpt-header-compact', value);
    }
    if (rawButton.getAttribute('data-cgpt-export-compact') !== value) {
      rawButton.setAttribute('data-cgpt-export-compact', value);
    }
    if (handoffButton.getAttribute('data-cgpt-export-compact') !== value) {
      handoffButton.setAttribute('data-cgpt-export-compact', value);
    }
  }
  /*
   * 正規化文字，供原生分享標籤比對使用。
   */
  function normalizeUiText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  /*
   * 判斷 element 是否為可接管顯示狀態的原生分享文字元素。
   *
   * 只接受 span / div / p 等文字容器，不把 button、SVG、aria-hidden 或
   * sr-only 輔助文字當成可見標籤，避免誤改圖示或無障礙節點。
   */
  function isUsableNativeShareLabelElement(element, shareButton) {
    if (!element || !shareButton || !shareButton.contains(element)) {
      return false;
    }
    if (element.matches('[data-cgpt-share-label="fallback"]')) {
      return false;
    }
    if (element.closest('svg, [aria-hidden="true"]')) {
      return false;
    }
    if (element.matches('.sr-only, [hidden]') || element.closest('.sr-only, [hidden]')) {
      return false;
    }
    if (!element.matches('span, div, p, strong, em')) {
      return false;
    }
    if (element.querySelector('svg')) {
      return false;
    }
    return normalizeUiText(element.textContent) !== '';
  }
  /*
   * 尋找 ChatGPT 原生分享文字容器。
   *
   * 優先沿用先前已標記的 native 節點，再搜尋常見文字容器。若 ChatGPT
   * 日後重新加入「分享」文字，這裡會找到它並撤回 userscript fallback。
   */
  function findNativeShareLabelElement(shareButton, expectedText) {
    const candidates = [
      ...shareButton.querySelectorAll('[data-cgpt-share-label="native"]'),
      ...shareButton.querySelectorAll('span, div, p, strong, em')
    ];
    const seen = new Set();
    const usableCandidates = [];
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (!isUsableNativeShareLabelElement(candidate, shareButton)) {
        continue;
      }
      const candidateText = normalizeUiText(candidate.textContent);
      if (
        candidateText === expectedText ||
        expectedText.includes(candidateText) ||
        candidateText.includes(expectedText)
      ) {
        return candidate;
      }
      usableCandidates.push(candidate);
    }
    return usableCandidates.length === 1 ? usableCandidates[0] : null;
  }
  /*
   * 尋找分享按鈕 subtree 中的原生可見文字節點，並只包住文字本身。
   *
   * ChatGPT 目前可能把 SVG 與「分享」裸文字放在同一個內層 div；
   * 若直接標記整個 div，compact CSS 會連 SVG 一起隱藏。因此這裡使用
   * TreeWalker 找實際 Text node，不依賴固定 DOM 深度，也不複製文字內容。
   */
  function wrapNativeShareTextNode(shareButton, expectedText) {
    const walker = document.createTreeWalker(shareButton, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode) {
      const candidateText = normalizeUiText(textNode.nodeValue);
      const parentElement = textNode.parentElement;
      const matchesExpectedText = Boolean(
        candidateText &&
        (
          candidateText === expectedText ||
          expectedText.includes(candidateText) ||
          candidateText.includes(expectedText)
        )
      );
      const excluded = !parentElement || Boolean(
        parentElement.closest(
          '[data-cgpt-share-label="fallback"], svg, [aria-hidden="true"], .sr-only, [hidden]'
        )
      );
      if (matchesExpectedText && !excluded) {
        const existingNative = parentElement.closest('[data-cgpt-share-label="native"]');
        if (existingNative && shareButton.contains(existingNative)) {
          return existingNative;
        }
        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-cgpt-share-label', 'native');
        wrapper.setAttribute('data-cgpt-share-label-wrapper', 'true');
        textNode.replaceWith(wrapper);
        wrapper.append(textNode);
        return wrapper;
      }
      textNode = walker.nextNode();
    }
    return null;
  }
  /*
   * 讓分享按鈕永遠只有一個可控制的文字標籤。
   *
   * - 原生文字存在：標記為 native，移除所有 fallback。
   * - 原生文字不存在：建立或重用唯一 fallback。
   * - 重複 fallback：只保留第一個，其餘移除。
   *
   * fallback 使用 aria-hidden，因為按鈕本身已有 aria-label；這可避免
   * 螢幕閱讀器把可見文字與 aria-label 重複朗讀。
   */
  function reconcileShareButtonLabel(headerActions) {
    const shareButton = headerActions?.querySelector(SHARE_BUTTON_SELECTOR);
    if (!shareButton) {
      return null;
    }
    const expectedText = normalizeUiText(shareButton.getAttribute('aria-label')) || '分享';
    const fallbackLabels = Array.from(
      shareButton.querySelectorAll('[data-cgpt-share-label="fallback"]')
    );
    for (const duplicateFallback of fallbackLabels.slice(1)) {
      duplicateFallback.remove();
    }
    const nativeLabel =
      findNativeShareLabelElement(shareButton, expectedText) ||
      wrapNativeShareTextNode(shareButton, expectedText);
    for (const markedNative of shareButton.querySelectorAll('[data-cgpt-share-label="native"]')) {
      if (markedNative !== nativeLabel) {
        markedNative.removeAttribute('data-cgpt-share-label');
      }
    }
    if (nativeLabel) {
      nativeLabel.setAttribute('data-cgpt-share-label', 'native');
      fallbackLabels[0]?.remove();
      return nativeLabel;
    }
    let fallbackLabel = fallbackLabels[0];
    if (!fallbackLabel) {
      fallbackLabel = document.createElement('span');
      fallbackLabel.setAttribute('data-cgpt-share-label', 'fallback');
      fallbackLabel.setAttribute('aria-hidden', 'true');
      shareButton.append(fallbackLabel);
    }
    if (fallbackLabel.textContent !== expectedText) {
      fallbackLabel.textContent = expectedText;
    }
    return fallbackLabel;
  }
  /*
   * 移除 userscript 自己加入的分享 fallback 與共用 compact 狀態。
   *
   * 只刪除帶有 fallback marker 的節點，不碰 ChatGPT 原生文字。
   */
  function cleanupHeaderActionLayoutDom() {
    for (const fallbackLabel of document.querySelectorAll('[data-cgpt-share-label="fallback"]')) {
      fallbackLabel.remove();
    }
    for (const wrapper of document.querySelectorAll('[data-cgpt-share-label-wrapper="true"]')) {
      wrapper.replaceWith(...wrapper.childNodes);
    }
    for (const nativeLabel of document.querySelectorAll('[data-cgpt-share-label="native"]')) {
      nativeLabel.removeAttribute('data-cgpt-share-label');
    }
    for (const headerActions of document.querySelectorAll(`${HEADER_ACTIONS_SELECTOR}[data-cgpt-header-compact]`)) {
      headerActions.removeAttribute('data-cgpt-header-compact');
    }
  }
  /*
   * 取得 page header 左右主要區塊，供 expanded 狀態的實際碰撞檢查使用。
   */
  function getHeaderLayoutParts(headerActions) {
    const pageHeader = headerActions?.closest('header#page-header');
    if (!pageHeader) {
      return null;
    }
    const rightActions = headerActions.closest('[data-testid="thread-header-right-actions"]');
    const rightActionsContainer = headerActions.closest(
      '[data-testid="thread-header-right-actions-container"]'
    );
    const rightRegion = getDirectChildWithin(
      pageHeader,
      rightActionsContainer || rightActions || headerActions
    );
    const leftRegion = Array.from(pageHeader.children).find((child) => {
      if (child === rightRegion) {
        return false;
      }
      const style = getComputedStyle(child);
      const rect = child.getBoundingClientRect();
      return style.position !== 'absolute' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }) || null;
    return {
      pageHeader,
      rightActions,
      rightActionsContainer,
      rightRegion,
      leftRegion
    };
  }
  /*
   * 量測 Header 左側文字在目前 clone 狀態下的裁切壓力。
   *
   * 不依賴專案名稱文案或特定 class；只掃描左側 region 中實際含文字的
   * DOM 節點，記錄 scrollWidth / clientWidth 與 scrollHeight / clientHeight。
   * compact 與 expanded 使用同一份 clone DOM，因此可用節點順序穩定比對。
   */
  function measureLeftHeaderTextPressure(leftRegion) {
    if (!leftRegion) {
      return [];
    }
    const elements = [leftRegion, ...leftRegion.querySelectorAll('*')];
    const samples = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      if (!normalizeUiText(element.textContent)) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.display === 'none') {
        continue;
      }
      const clientWidth = element.clientWidth;
      const clientHeight = element.clientHeight;
      const scrollWidth = element.scrollWidth;
      const scrollHeight = element.scrollHeight;
      samples.push({
        index,
        horizontalOverflow: Math.max(0, scrollWidth - clientWidth),
        verticalOverflow: Math.max(0, scrollHeight - clientHeight)
      });
    }
    return samples;
  }
  /*
   * 判斷 expanded 是否比 compact 額外擠壓左側 Header 文字。
   *
   * 左側內容若在 compact 本來就因自身 max-width 或視窗極窄而截斷，
   * 不會單憑「已截斷」就永遠維持 compact；只有 expanded 讓裁切量進一步
   * 增加超過量測容差時，才視為右側文字造成的版面壓力。
   */
  function hasExpandedLeftHeaderPressure(compactPressure, expandedPressure) {
    if (!compactPressure?.length || !expandedPressure?.length) {
      return false;
    }
    const compactByIndex = new Map(
      compactPressure.map((sample) => [sample.index, sample])
    );
    for (const expandedSample of expandedPressure) {
      const compactSample = compactByIndex.get(expandedSample.index);
      if (!compactSample) {
        continue;
      }
      if (
        expandedSample.horizontalOverflow > compactSample.horizontalOverflow + HEADER_LAYOUT_TOLERANCE ||
        expandedSample.verticalOverflow > compactSample.verticalOverflow + HEADER_LAYOUT_TOLERANCE
      ) {
        return true;
      }
    }
    return false;
  }
  /*
   * 將離屏 clone 的三顆主要 Header action 切成指定版面狀態。
   *
   * 只修改 clone 上既有的 data attribute；正式頁面的 DOM 不會在量測過程
   * 中切換，因此不會造成可見閃動或 ResizeObserver 回授迴圈。
   */
  function setClonedHeaderActionsCompact(headerActions, isCompact) {
    const value = isCompact ? 'true' : 'false';
    headerActions.setAttribute('data-cgpt-header-compact', value);
    for (const cloneExportButton of headerActions.querySelectorAll('[data-cgpt-export-button="true"]')) {
      cloneExportButton.setAttribute('data-cgpt-export-compact', value);
    }
  }
  /*
   * 判斷離屏 expanded clone 是否造成實際版面壓力。
   *
   * 判定來源：
   *   1. 右側 action 容器實際 overflow。
   *   2. 右側 region 超出 Header 合法邊界（含原生負 margin 補償）。
   *   3. 左右 Header region 實際重疊。
   *   4. expanded 相較 compact 新增左側文字裁切 / 截斷。
   */
  function isExpandedHeaderLayoutConflicting(parts, headerActions, compactLeftPressure) {
    const measurableContainers = [
      headerActions,
      parts.rightActions,
      parts.rightActionsContainer
    ].filter(Boolean);
    if (
      measurableContainers.some(
        (element) =>
          element.clientWidth > 0 &&
          element.scrollWidth > element.clientWidth + HEADER_LAYOUT_TOLERANCE
      )
    ) {
      return true;
    }
    const headerRect = parts.pageHeader.getBoundingClientRect();
    const rightTarget = parts.rightRegion || headerActions;
    const rightRect = rightTarget.getBoundingClientRect();
    const headerStyle = getComputedStyle(parts.pageHeader);
    const rightStyle = getComputedStyle(rightTarget);
    const paddingStart = Number.parseFloat(headerStyle.paddingInlineStart) || 0;
    const paddingEnd = Number.parseFloat(headerStyle.paddingInlineEnd) || 0;
    const negativeMarginLeft = Math.min(0, Number.parseFloat(rightStyle.marginLeft) || 0);
    const negativeMarginRight = Math.min(0, Number.parseFloat(rightStyle.marginRight) || 0);
    /*
     * ChatGPT 原生 Header action wrapper 可能用負 margin 抵銷自身 padding。
     * 這類合法外延不應被視為 expanded 版面越界；邊界只額外放寬實際的負 margin。
     */
    const allowedLeft =
      headerRect.left + paddingStart + negativeMarginLeft - HEADER_LAYOUT_TOLERANCE;
    const allowedRight =
      headerRect.right - paddingEnd - negativeMarginRight + HEADER_LAYOUT_TOLERANCE;
    if (rightRect.left < allowedLeft || rightRect.right > allowedRight) {
      return true;
    }
    if (parts.leftRegion && parts.rightRegion) {
      const leftRect = parts.leftRegion.getBoundingClientRect();
      const directRightRect = parts.rightRegion.getBoundingClientRect();
      if (leftRect.right > directRightRect.left + HEADER_LAYOUT_TOLERANCE) {
        return true;
      }
    }
    const expandedLeftPressure = measureLeftHeaderTextPressure(parts.leftRegion);
    return hasExpandedLeftHeaderPressure(compactLeftPressure, expandedLeftPressure);
  }
  /*
   * 依 Header 實際版面壓力決定 compact 狀態，不使用固定 viewport / Header 寬度門檻。
   *
   * 先在同一份離屏 clone 量測 compact 基準，再切成 expanded 量測候選狀態。
   * 只要 expanded 沒有造成 overflow、越界、左右重疊或新增左側文字裁切，
   * 就維持文字顯示；即使視窗較窄也不會因固定 breakpoint 強制 compact。
   */
  function shouldUseCompactHeaderLayout(headerActions) {
    const parts = getHeaderLayoutParts(headerActions);
    if (!parts) {
      return true;
    }
    const headerRect = parts.pageHeader.getBoundingClientRect();
    if (headerRect.width <= 0 || headerRect.height <= 0) {
      return true;
    }
    /*
     * 使用離屏 clone 量測 compact / expanded，避免在原始 Header 上暫時切換尺寸。
     */
    const headerClone = parts.pageHeader.cloneNode(true);
    headerClone.setAttribute('aria-hidden', 'true');
    headerClone.setAttribute('inert', '');
    headerClone.style.setProperty('position', 'fixed', 'important');
    headerClone.style.setProperty('left', '-100000px', 'important');
    headerClone.style.setProperty('top', '0', 'important');
    headerClone.style.setProperty('width', `${headerRect.width}px`, 'important');
    headerClone.style.setProperty('height', `${Math.max(headerRect.height, 1)}px`, 'important');
    headerClone.style.setProperty('visibility', 'hidden', 'important');
    headerClone.style.setProperty('pointer-events', 'none', 'important');
    headerClone.style.setProperty('contain', 'layout paint', 'important');
    const cloneHeaderActions = headerClone.querySelector(HEADER_ACTIONS_SELECTOR);
    if (!cloneHeaderActions) {
      return true;
    }
    document.body.append(headerClone);
    try {
      const cloneParts = getHeaderLayoutParts(cloneHeaderActions);
      if (!cloneParts) {
        return true;
      }
      setClonedHeaderActionsCompact(cloneHeaderActions, true);
      const compactLeftPressure = measureLeftHeaderTextPressure(cloneParts.leftRegion);
      setClonedHeaderActionsCompact(cloneHeaderActions, false);
      return isExpandedHeaderLayoutConflicting(
        cloneParts,
        cloneHeaderActions,
        compactLeftPressure
      );
    } finally {
      headerClone.remove();
    }
  }
  /*
   * 排程分享 fallback reconciliation 與三顆按鈕的共用版面狀態同步。
   */
  function syncHeaderActionLayout(headerActions, rawButton, handoffButton) {
    if (!headerActions || !rawButton || !handoffButton) {
      return;
    }
    if (headerActionLayoutTimer !== null) {
      cancelAnimationFrame(headerActionLayoutTimer);
    }
    headerActionLayoutTimer = requestAnimationFrame(() => {
      headerActionLayoutTimer = null;
      if (!headerActions.isConnected || !rawButton.isConnected || !handoffButton.isConnected) {
        return;
      }
      reconcileShareButtonLabel(headerActions);
      const isCompact = shouldUseCompactHeaderLayout(headerActions);
      setHeaderActionsCompact(headerActions, rawButton, handoffButton, isCompact);
    });
  }
  /*
   * 停止 Header action 同步，清除 observer、listener、pending frame 與 fallback。
   */
  function stopObservingHeaderActionLayout() {
    if (headerActionLayoutTimer !== null) {
      cancelAnimationFrame(headerActionLayoutTimer);
      headerActionLayoutTimer = null;
    }
    if (headerActionLayoutObserver) {
      headerActionLayoutObserver.disconnect();
      headerActionLayoutObserver = null;
    }
    if (headerActionLayoutResizeObserver) {
      headerActionLayoutResizeObserver.disconnect();
      headerActionLayoutResizeObserver = null;
    }
    if (headerActionLayoutResizeHandler) {
      window.removeEventListener('resize', headerActionLayoutResizeHandler);
      headerActionLayoutResizeHandler = null;
    }
    observedHeaderActionLayoutTargets = null;
    cleanupHeaderActionLayoutDom();
  }
  /*
   * 開始觀察 Header action DOM 與寬度。
   *
   * 若 insertButtonsOnce() 的低頻補救再次命中同一組節點，直接沿用既有
   * observer；DOM 與尺寸變化會由 MutationObserver / ResizeObserver 觸發同步，
   * 避免每秒重建 observer 或重做離屏寬度測量。
   */
  function observeHeaderActionLayout(headerActions, rawButton, handoffButton) {
    if (!headerActions || !rawButton || !handoffButton) {
      return;
    }
    if (
      observedHeaderActionLayoutTargets &&
      observedHeaderActionLayoutTargets.headerActions === headerActions &&
      observedHeaderActionLayoutTargets.rawButton === rawButton &&
      observedHeaderActionLayoutTargets.handoffButton === handoffButton
    ) {
      return;
    }
    stopObservingHeaderActionLayout();
    observedHeaderActionLayoutTargets = {
      headerActions,
      rawButton,
      handoffButton
    };
    const parts = getHeaderLayoutParts(headerActions);
    const mutationRoot = parts?.pageHeader || headerActions;
    headerActionLayoutObserver = new MutationObserver(() => {
      syncHeaderActionLayout(headerActions, rawButton, handoffButton);
    });
    headerActionLayoutObserver.observe(mutationRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'aria-hidden',
        'aria-label',
        'data-state',
        'data-fixed-header'
      ]
    });
    if (typeof ResizeObserver === 'function') {
      headerActionLayoutResizeObserver = new ResizeObserver(() => {
        syncHeaderActionLayout(headerActions, rawButton, handoffButton);
      });
      const resizeTargets = new Set([
        parts?.pageHeader,
        parts?.leftRegion,
        parts?.rightRegion,
        parts?.rightActionsContainer,
        parts?.rightActions,
        headerActions
      ]);
      for (const target of resizeTargets) {
        if (target) {
          headerActionLayoutResizeObserver.observe(target);
        }
      }
    }
    headerActionLayoutResizeHandler = () => {
      syncHeaderActionLayout(headerActions, rawButton, handoffButton);
    };
    window.addEventListener('resize', headerActionLayoutResizeHandler, {
      passive: true
    });
    syncHeaderActionLayout(headerActions, rawButton, handoffButton);
  }
  /*
   * 將兩個按鈕插入 ChatGPT 對話頁 header。
   *
   * 這個函式同時負責建立、去重、搬移與狀態更新。
   * ChatGPT header 若因 SPA 導航或 React 重繪被重建，下一次 ensureButtonsSoon() 會把按鈕放回正確位置。
   */
  function insertButtonsOnce() {
    if (!EXPORT_HEADER_BUTTONS_ENABLED) {
      removeButtonsIfNeeded();
      return;
    }
    if (!isConversationPage()) {
      removeButtonsIfNeeded();
      return;
    }
    removeDuplicateButtons(RAW_BUTTON_ID);
    removeDuplicateButtons(HANDOFF_BUTTON_ID);
    const headerActions = findHeaderActionsContainer();
    if (!headerActions) {
      return;
    }
    const rawButton = getOrCreateExportButton({
      id: RAW_BUTTON_ID,
      label: '下載原始 JSON',
      ariaLabel: '下載目前對話原始 JSON',
      testId: 'raw-json-export-button',
      iconSvg: RAW_JSON_ICON_SVG,
      onClick: handleDownloadRawClick
    });
    const handoffButton = getOrCreateExportButton({
      id: HANDOFF_BUTTON_ID,
      label: '下載交接 JSON',
      ariaLabel: '產出並下載目前對話交接 JSON',
      testId: 'handoff-json-export-button',
      iconSvg: HANDOFF_ICON_SVG,
      onClick: handleDownloadHandoffClick
    });
    placeExportButtons(headerActions, rawButton, handoffButton);
    updateButtonState();
    observeHeaderActionLayout(headerActions, rawButton, handoffButton);
  }
  /*
   * 節流插入按鈕。
   *
   * 避免 ChatGPT DOM 頻繁變動時，每次都立即查 DOM。
   */
  function ensureButtonsSoon() {
    if (ensureTimer !== null) {
      return;
    }
    ensureTimer = window.setTimeout(() => {
      ensureTimer = null;
      insertButtonsOnce();
    }, 300);
  }

  // ============================================================
  // 六-A、批次匯出 UI、可追加佇列與延後打包
  // ============================================================
  /*
   * selectedConversations 是尚未加入 session 的 draft selection。
   * sessionTargets / pendingQueue / completedPayloads 則是已由使用者明確確認加入的項目。
   * 同一個 session 鎖定 raw 或 handoff，concurrency 固定為 1。
   * 已完成 payload 只暫存在目前頁面記憶體；使用者按「打包」才建立 STORE ZIP。
   */
  const BATCH_SCOPE_GENERAL = 'general';
  const BATCH_SCOPE_PROJECT = 'project';
  const BATCH_EXPORT_RAW = 'raw';
  const BATCH_EXPORT_HANDOFF = 'handoff';

  const BATCH_PHASE_IDLE = 'idle';
  const BATCH_PHASE_SELECTING = 'selecting';
  const BATCH_PHASE_CONFIRMING = 'confirming';
  const BATCH_PHASE_SESSION = 'session';
  const BATCH_PHASE_PACKAGING = 'packaging';

  const BATCH_ITEM_PENDING = 'pending';
  const BATCH_ITEM_EXPORTING = 'exporting';
  const BATCH_ITEM_SUCCESS = 'success';
  const BATCH_ITEM_FAILED = 'failed';
  const BATCH_ITEM_SKIPPED = 'skipped';

  const BATCH_STYLE_ID = 'cgpt-batch-export-selection-style';
  const BATCH_GENERAL_CONTROLS_ID = 'cgpt-batch-export-general-controls';
  const BATCH_PROJECT_CONTROLS_ID = 'cgpt-batch-export-project-controls';
  const BATCH_DIALOG_ID = 'cgpt-batch-export-confirmation-dialog';
  const BATCH_CANCEL_JOB_DIALOG_ID = 'cgpt-batch-cancel-job-confirmation-dialog';

  const BATCH_SELECTED_COLOR = 'rgba(96, 165, 250, 0.24)';
  const BATCH_SELECTED_HOVER_COLOR = 'rgba(96, 165, 250, 0.32)';
  const BATCH_PROGRESS_FILL_COLOR = 'rgba(59, 130, 246, 0.42)';
  const BATCH_SUCCESS_COLOR = 'rgba(34, 197, 94, 0.28)';
  const BATCH_FAILED_COLOR = 'rgba(127, 29, 29, 0.76)';
  const BATCH_SKIPPED_COLOR = 'rgba(107, 114, 128, 0.28)';

  const BATCH_ROW_COLOR_TRANSITION_MS = 180;
  const BATCH_MOTION_TRANSITION_MS = 160;
  const BATCH_PROGRESS_CONVERSATION_START = 0.03;
  const BATCH_PROGRESS_CONVERSATION_END = 0.76;
  const BATCH_PROGRESS_TEXTDOCS_START = 0.82;
  const BATCH_PROGRESS_TEXTDOCS_END = 0.93;
  const BATCH_PROGRESS_HANDOFF_BUILD = 0.96;
  const BATCH_PROGRESS_HANDOFF_READY = 0.99;

  function createBatchSelectionState(scope) {
    return {
      scope,
      phase: BATCH_PHASE_IDLE,

      selectedConversations: new Map(),
      manuallyExcludedIds: new Set(),
      selectAllMode: false,
      rangeAnchorConversationId: null,
      selectionOrder: 0,
      routePathname: null,

      exportKind: null,
      sessionStartedAt: null,
      sessionUpdatedAt: null,
      sessionBlockedReason: '',
      sessionTargets: [],
      sessionConversationIds: new Set(),
      pendingQueue: [],
      workerRunning: false,
      currentConversationId: null,
      removedWhileProcessingIds: new Set(),
      itemRuntime: new Map(),
      completedPayloads: new Map(),
      sessionResults: new Map(),
      zipFilename: null,
      lastBatchResults: null,

      listRoot: null,
      listObserver: null,
      listClickHandler: null,
      listDblclickHandler: null,
      listKeydownHandler: null,
      listDragstartHandler: null,
      originalDraggableByLink: new Map(),
      closingMode: false
    };
  }

  const batchSelectionStates = new Map([
    [BATCH_SCOPE_GENERAL, createBatchSelectionState(BATCH_SCOPE_GENERAL)],
    [BATCH_SCOPE_PROJECT, createBatchSelectionState(BATCH_SCOPE_PROJECT)]
  ]);

  function getBatchSelectionState(scope) {
    return batchSelectionStates.get(scope) || null;
  }

  const batchRowDecorationCleanupTimers = new Map();
  let batchRequestSchedulerRunning = false;
  let batchRequestSchedulerLastScope = null;
  const batchMotionLifecycles = new WeakMap();
  let batchBeforeUnloadGuardAttached = false;
  let allowBatchUnloadOnce = false;
  let batchProjectTabObserver = null;
  let batchProjectObservedTablist = null;

  const BATCH_ENTRY_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/>
          <path d="M6.5 7.25h4.25M6.5 10h7M6.5 12.75h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M13.5 6.25l1 1 1.75-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
  `;
  const BATCH_CANCEL_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M5.25 5.25l9.5 9.5M14.75 5.25l-9.5 9.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_EXPORT_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M10 3.25v8.5M6.75 8.75L10 12l3.25-3.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 13.25v1.5A1.25 1.25 0 0 0 5.25 16h9.5A1.25 1.25 0 0 0 16 14.75v-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_SELECT_ALL_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <rect x="5.25" y="5.25" width="10.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.75 10.25l1.6 1.6 3.15-3.35" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3.25 12V5A1.75 1.75 0 0 1 5 3.25h7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
        </svg>
  `;
  const BATCH_PACKAGE_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <path d="M4 6.25 10 3l6 3.25v7.5L10 17l-6-3.25z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="m4.35 6.45 5.65 3.1 5.65-3.1M10 9.55V17" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
  `;
  const BATCH_STOP_ICON_SVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" data-icon-shape="non-circular" focusable="false" aria-hidden="true" class="icon-sm" fill="none">
          <circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/>
          <path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
  `;

  function hasActiveBatchSession(state) {
    return Boolean(state && state.exportKind && state.sessionStartedAt);
  }

  /*
   * 只要一般聊天或專案聊天任一 scope 還有尚未安全結束的批次狀態，
   * 就視為離頁可能造成資料遺失：
   *   - 尚未加入 queue 的目前選取；
   *   - 已建立且尚未打包完成的 batch session；
   *   - 正在 packaging 的 session。
   *
   * 單純開啟批次面板但尚未選任何 conversation，不需要攔截離頁。
   */
  function hasUnsafeBatchUnloadState() {
    return [
      BATCH_SCOPE_GENERAL,
      BATCH_SCOPE_PROJECT
    ].some((scope) => {
      const state = getBatchSelectionState(scope);
      if (!state) {
        return false;
      }
      return (
        state.selectedConversations.size > 0 ||
        hasActiveBatchSession(state) ||
        state.phase === BATCH_PHASE_PACKAGING
      );
    });
  }

  function handleBatchBeforeUnload(event) {
    if (
      allowBatchUnloadOnce ||
      !hasUnsafeBatchUnloadState()
    ) {
      return;
    }

    /*
     * Chromium 目前只允許顯示瀏覽器提供的通用離頁警告文案；
     * event.returnValue 的具體文字不會呈現在 UI 中。
     */
    event.preventDefault();
    event.returnValue = '';
    return '';
  }

  function syncBatchBeforeUnloadGuard() {
    const shouldAttach = hasUnsafeBatchUnloadState();

    if (shouldAttach && !batchBeforeUnloadGuardAttached) {
      window.addEventListener(
        'beforeunload',
        handleBatchBeforeUnload
      );
      batchBeforeUnloadGuardAttached = true;
      return;
    }

    if (!shouldAttach && batchBeforeUnloadGuardAttached) {
      window.removeEventListener(
        'beforeunload',
        handleBatchBeforeUnload
      );
      batchBeforeUnloadGuardAttached = false;
      allowBatchUnloadOnce = false;
    }
  }

  function isBatchListLockedPhase(phase) {
    return [
      BATCH_PHASE_SELECTING,
      BATCH_PHASE_CONFIRMING,
      BATCH_PHASE_SESSION,
      BATCH_PHASE_PACKAGING
    ].includes(phase);
  }

  function isBatchSelectionEditableState(state) {
    if (
      !state ||
      state.closingMode ||
      state.phase === BATCH_PHASE_CONFIRMING ||
      state.phase === BATCH_PHASE_PACKAGING
    ) {
      return false;
    }
    if (state.phase === BATCH_PHASE_SELECTING) {
      return true;
    }
    return state.phase === BATCH_PHASE_SESSION && !state.sessionBlockedReason;
  }

  function getBatchExportKindLabel(exportKind) {
    return exportKind === BATCH_EXPORT_RAW ? '原始 JSON' : '交接 JSON';
  }

  function countBatchStatus(state, status) {
    let count = 0;
    for (const runtime of state?.itemRuntime.values() || []) {
      if (runtime.status === status) {
        count += 1;
      }
    }
    return count;
  }

  function getBatchSessionResultArray(state) {
    return state.sessionTargets
      .map((target) => state.sessionResults.get(target.conversationId))
      .filter(Boolean);
  }

  function canPackageBatchSession(state) {
    return Boolean(
      hasActiveBatchSession(state) &&
      state.phase === BATCH_PHASE_SESSION &&
      !state.workerRunning &&
      state.pendingQueue.length === 0 &&
      state.selectedConversations.size === 0 &&
      state.sessionTargets.length > 0
    );
  }

  function ensureBatchSelectionStyles() {
    if (document.getElementById(BATCH_STYLE_ID)) {
      return;
    }
    const style = document.createElement('style');
    style.id = BATCH_STYLE_ID;
    style.textContent = `
      @property --cgpt-batch-progress {
        syntax: '<percentage>';
        inherits: false;
        initial-value: 0%;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="selected"] {
        background-color: ${BATCH_SELECTED_COLOR} !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="selected"]:hover {
        background-color: ${BATCH_SELECTED_HOVER_COLOR} !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="queued"] {
        position: relative !important;
        background-color: ${BATCH_SELECTED_COLOR} !important;
        background-image:
          repeating-linear-gradient(
            135deg,
            rgba(255,255,255,0.14) 0 8px,
            rgba(255,255,255,0.035) 8px 16px
          ),
          linear-gradient(
            to right,
            transparent 0 100%
          ) !important;
        background-size: 28px 28px, 100% 100% !important;
        background-repeat: repeat, no-repeat !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="exporting"] {
        position: relative !important;
        --cgpt-batch-progress: 0%;
        background-color: ${BATCH_SELECTED_COLOR} !important;
        background-image:
          repeating-linear-gradient(135deg, rgba(255,255,255,0.14) 0 8px, rgba(255,255,255,0.035) 8px 16px),
          linear-gradient(to right, ${BATCH_PROGRESS_FILL_COLOR} 0 var(--cgpt-batch-progress), transparent var(--cgpt-batch-progress) 100%) !important;
        background-size: 28px 28px, 100% 100% !important;
        background-repeat: repeat, no-repeat !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="success"] {
        background-color: ${BATCH_SUCCESS_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="failed"] {
        background-color: ${BATCH_FAILED_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-selection-row="true"][data-cgpt-batch-row-state="skipped"] {
        background-color: ${BATCH_SKIPPED_COLOR} !important;
        background-image: none !important;
      }
      [data-cgpt-batch-row-spinner] {
        position: absolute;
        inset-inline-end: 0.65rem;
        top: 50%;
        z-index: 3;
        width: 0.9rem;
        height: 0.9rem;
        margin-top: -0.45rem;
        border: 2px solid rgba(255,255,255,0.34);
        border-top-color: currentColor;
        border-radius: 9999px;
        pointer-events: none;
      }
      [data-cgpt-batch-selection-header="true"] [data-trailing-button] {
        opacity: 1 !important;
      }
      [data-cgpt-batch-selection-header="true"] [data-trailing-button]:not([data-cgpt-batch-action]) {
        transition-property: none !important;
        transition-duration: 0ms !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="general"]
        a[data-sidebar-item="true"][href^="/c/"] > .trailing {
        display: none !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="project"]
        [data-testid="project-conversation-overflow-menu"] {
        display: none !important;
      }
      [data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="project"]
        [data-testid="project-conversation-overflow-date"] {
        opacity: 1 !important;
      }

      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"] {
        max-height: 24rem;
        margin: 0.35rem 0.5rem 0.55rem;
        padding: 0.4rem;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        border-radius: var(--custom-large-radius, 12px);
        background: color-mix(in srgb, currentColor 4%, transparent);
        opacity: 1;
        transform: translateY(0);
        overflow: hidden;
        transition:
          max-height ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-block ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          padding-block ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          border-color ${BATCH_MOTION_TRANSITION_MS}ms ease,
          background-color ${BATCH_MOTION_TRANSITION_MS}ms ease;
      }
      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"][data-cgpt-motion-state="open"] {
        animation:
          cgpt-batch-general-panel-enter
          ${BATCH_MOTION_TRANSITION_MS}ms
          cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"][data-cgpt-motion-state="closed"] {
        max-height: 0;
        margin-block: 0;
        padding-block: 0;
        border-color: transparent;
        background-color: transparent;
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
      }
      [data-cgpt-batch-general-panel-header] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-width: 0;
        padding: 0.35rem 0.45rem 0.45rem 0.6rem;
      }
      [data-cgpt-batch-general-panel-title] {
        min-width: 0;
        font-size: 1rem;
        line-height: 1.35;
        font-weight: 600;
        color: var(--text-primary);
      }
      [data-cgpt-batch-general-panel-status-list] {
        margin-top: 0.28rem;
        padding-inline-start: 1.1rem;
        list-style: disc;
        font-size: 0.75rem;
        line-height: 1.45;
        font-weight: 400;
        color: var(--text-tertiary);
      }
      [data-cgpt-batch-general-panel-status-list] > li {
        padding-block: 0.03rem;
      }
      [data-cgpt-batch-general-panel-actions] {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      [data-cgpt-batch-action-slot] {
        min-width: 0;
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"] {
        overflow: hidden;
        max-height: 3rem;
        margin-top: 0.15rem;
        opacity: 1;
        transform: translateY(0);
        transition:
          max-height ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-top ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"][data-cgpt-motion-state="closed"] {
        max-height: 0;
        margin-top: 0;
        opacity: 0;
        transform: translateY(-3px);
        pointer-events: none;
      }
      [data-cgpt-batch-general-action] {
        display: flex;
        width: 100%;
        min-height: 2.3rem;
        align-items: center;
        gap: 0.7rem;
        padding: 0.42rem 0.65rem;
        border-radius: var(--custom-large-radius, 12px);
        color: var(--text-primary);
        font-size: 0.8125rem;
        line-height: 1.3;
        text-align: start;
        transition: background-color 120ms ease, opacity 120ms ease;
      }
      [data-cgpt-batch-general-action]:not(:disabled):hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
      }
      [data-cgpt-batch-general-action] svg {
        flex: 0 0 auto;
      }
      [data-cgpt-batch-general-action-label] {
        min-width: 0;
        flex: 1 1 auto;
      }
      [data-cgpt-batch-action="cancel-job"]:not(:disabled) {
        color: rgb(239 68 68);
      }
      [data-cgpt-batch-general-panel-close] {
        display: inline-flex;
        width: 2rem;
        height: 2rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.5rem;
        color: var(--text-secondary);
        opacity: 1;
        scale: 1;
        transition:
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          scale ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-general-panel-close][data-cgpt-motion-state="closed"] {
        opacity: 0;
        scale: 0.92;
        pointer-events: none;
      }
      [data-cgpt-batch-general-panel-close]:hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
        color: var(--text-primary);
      }

      [data-cgpt-batch-controls="project"] {
        display: flex;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 52rem;
        align-items: center;
        gap: 0;
        margin-inline: 0.125rem;
        overflow: hidden;
        opacity: 1;
        transform: translateX(0);
        white-space: nowrap;
        transition:
          max-width ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-inline ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-controls="project"][data-cgpt-motion-state="closed"] {
        max-width: 0;
        margin-inline: 0;
        opacity: 0;
        transform: translateX(-4px);
        pointer-events: none;
      }
      [data-cgpt-batch-controls="project"] [data-cgpt-batch-action] > div {
        gap: 0.4rem;
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"] {
        display: inline-flex;
        flex: 0 0 auto;
        overflow: hidden;
        max-width: 18rem;
        margin-inline-end: 0.35rem;
        opacity: 1;
        transform: translateX(0);
        transition:
          max-width ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          margin-inline-end ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1),
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          transform ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"][data-cgpt-motion-state="closed"] {
        max-width: 0;
        margin-inline-end: 0;
        opacity: 0;
        transform: translateX(-4px);
        pointer-events: none;
      }

      [data-cgpt-batch-dialog-download="true"] {
        background-color: #ffffff !important;
        color: #000000 !important;
        border-color: rgba(0,0,0,0.14) !important;
      }
      [data-cgpt-batch-dialog-download="true"]:is(:hover,:focus-visible) {
        background-color: #f2f2f2 !important;
        color: #000000 !important;
      }
      [data-cgpt-batch-dialog-download="true"]:active {
        background-color: #e8e8e8 !important;
        color: #000000 !important;
      }
      [data-cgpt-batch-dialog-download="true"] :is(svg,path,span,div) {
        color: inherit !important;
      }
      [data-cgpt-batch-dialog-danger="true"] {
        background-color: rgb(220 38 38) !important;
        color: #fff !important;
        border-color: rgb(220 38 38) !important;
      }
      [data-cgpt-batch-dialog-danger="true"]:hover {
        background-color: rgb(185 28 28) !important;
      }
      [data-cgpt-batch-dialog-list] {
        max-height: min(50vh,420px);
        overflow-y: auto;
        scrollbar-width: thin;
      }
      [data-cgpt-batch-dialog-shell] [data-cgpt-batch-dialog-backdrop]::before {
        opacity: 1;
        transition: opacity ${BATCH_MOTION_TRANSITION_MS}ms ease;
      }
      [data-cgpt-batch-dialog-shell] [data-cgpt-batch-dialog-surface] {
        opacity: 1;
        scale: 1;
        transition:
          opacity ${BATCH_MOTION_TRANSITION_MS}ms ease,
          scale ${BATCH_MOTION_TRANSITION_MS}ms cubic-bezier(0.2,0,0,1);
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] {
        pointer-events: none;
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] [data-cgpt-batch-dialog-backdrop]::before {
        opacity: 0;
      }
      [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="closed"] [data-cgpt-batch-dialog-surface] {
        opacity: 0;
        scale: 0.985;
      }

      /*
       * 新建立 finite-motion UI 的 entry 起始值。
       * 由 Chromium @starting-style 建立 before-change style，
       * 避免 JS 在 click handler 中同步讀取 layout。
       */
      @starting-style {
        [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="general-panel"][data-cgpt-motion-state="open"] {
          max-height: 0;
          margin-top: 0;
          opacity: 0;
          transform: translateY(-3px);
        }
        [data-cgpt-batch-general-panel-close][data-cgpt-motion-state="open"] {
          opacity: 0;
          scale: 0.92;
        }
        [data-cgpt-batch-controls="project"][data-cgpt-motion-state="open"] {
          max-width: 0;
          margin-inline: 0;
          opacity: 0;
          transform: translateX(-4px);
        }
        [data-cgpt-batch-action-slot][data-cgpt-batch-action-placement="project"][data-cgpt-motion-state="open"] {
          max-width: 0;
          margin-inline-end: 0;
          opacity: 0;
          transform: translateX(-4px);
        }
        [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="open"] [data-cgpt-batch-dialog-backdrop]::before {
          opacity: 0;
        }
        [data-cgpt-batch-dialog-shell][data-cgpt-motion-state="open"] [data-cgpt-batch-dialog-surface] {
          opacity: 0;
          scale: 0.985;
        }
      }

      @keyframes cgpt-batch-general-panel-enter {
        from {
          max-height: 0;
          margin-block: 0;
          padding-block: 0;
          border-color: transparent;
          background-color: transparent;
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          max-height: 24rem;
          margin-block: 0.35rem 0.55rem;
          padding-block: 0.4rem;
          border-color: color-mix(in srgb, currentColor 20%, transparent);
          background-color: color-mix(in srgb, currentColor 4%, transparent);
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes cgpt-batch-progress-stripes {
        from { background-position: 0 0, 0 0; }
        to { background-position: 28px 0, 0 0; }
      }
      @keyframes cgpt-batch-row-spinner {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: no-preference) {
        [data-cgpt-batch-selection-row="true"] {
          transition:
            --cgpt-batch-progress 120ms linear,
            background-color ${BATCH_ROW_COLOR_TRANSITION_MS}ms ease;
        }
        [data-cgpt-batch-selection-row="true"]:is(
          [data-cgpt-batch-row-state="queued"],
          [data-cgpt-batch-row-state="exporting"]
        ) {
          animation: cgpt-batch-progress-stripes 620ms linear infinite;
        }
        [data-cgpt-batch-row-spinner] {
          animation: cgpt-batch-row-spinner 720ms linear infinite;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"],
        [data-cgpt-batch-general-panel-close],
        [data-cgpt-batch-action-slot],
        [data-cgpt-batch-controls="project"],
        [data-cgpt-batch-dialog-backdrop]::before,
        [data-cgpt-batch-dialog-surface] {
          transition: none !important;
        }
        [data-cgpt-batch-controls="general"][data-cgpt-batch-general-mode="panel"] {
          animation: none !important;
        }
      }
    `;
    document.head.append(style);
  }

  function getConversationIdFromHref(href) {
    try {
      const parsedUrl = new URL(href, location.origin);
      if (parsedUrl.origin !== location.origin) {
        return null;
      }
      const match = parsedUrl.pathname.match(/\/c\/([^/?#]+)\/?$/);
      if (!match) {
        return null;
      }
      const conversationId = decodeURIComponent(match[1]);
      return isExportableConversationId(conversationId) ? conversationId : null;
    } catch {
      return null;
    }
  }

  function findGeneralBatchUiContext() {
    const history = document.getElementById('history');
    if (!history || !history.parentElement) {
      return null;
    }
    let header = history.previousElementSibling;
    if (header?.id === BATCH_GENERAL_CONTROLS_ID) {
      header = header.previousElementSibling;
    }
    if (!header || !header.parentElement) {
      return null;
    }
    const actionHost = header.lastElementChild;
    if (!actionHost || actionHost === header.firstElementChild) {
      return null;
    }
    return {
      scope: BATCH_SCOPE_GENERAL,
      active: true,
      controlsHost: actionHost,
      panelHost: history.parentElement,
      header,
      listRoot: history
    };
  }

  function findProjectBatchUiContext() {
    const tablist = document.querySelector('[role="tablist"][id^="project-home-tabs-"]');
    if (!tablist) {
      return null;
    }
    const chatTab = tablist.querySelector('[role="tab"][id$="-chats"]');
    const sourcesTab = tablist.querySelector('[role="tab"][id$="-sources"]');
    if (!chatTab || !sourcesTab) {
      return null;
    }
    const panelId = chatTab.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    const listRoot = panel ? panel.querySelector('section > ol') : null;
    return {
      scope: BATCH_SCOPE_PROJECT,
      active: chatTab.getAttribute('data-state') === 'active' && Boolean(listRoot),
      controlsHost: tablist,
      tablist,
      chatTab,
      sourcesTab,
      listRoot
    };
  }

  function getBatchUiContext(scope) {
    return scope === BATCH_SCOPE_GENERAL
      ? findGeneralBatchUiContext()
      : scope === BATCH_SCOPE_PROJECT
        ? findProjectBatchUiContext()
        : null;
  }

  function getBatchConversationRows(context) {
    if (!context?.listRoot) {
      return [];
    }
    if (context.scope === BATCH_SCOPE_GENERAL) {
      return Array.from(
        context.listRoot.querySelectorAll('a[data-sidebar-item="true"][href^="/c/"]')
      );
    }
    return Array.from(context.listRoot.querySelectorAll('li')).filter((row) => {
      return Boolean(row.querySelector('a[href*="/c/"]'));
    });
  }

  function getBatchConversationInfo(row, scope) {
    if (!row) {
      return null;
    }
    const link = scope === BATCH_SCOPE_GENERAL
      ? row
      : row.querySelector('a[href*="/c/"]');
    if (!link) {
      return null;
    }
    const conversationId = getConversationIdFromHref(
      link.getAttribute('href') || link.href || ''
    );
    if (!conversationId) {
      return null;
    }
    let title = '';
    if (scope === BATCH_SCOPE_GENERAL) {
      title = String(link.getAttribute('aria-label') || '').trim();
    } else {
      title = String(
        link.querySelector('.text-sm.font-medium')?.textContent || ''
      ).replace(/\s+/g, ' ').trim();
    }
    if (!title) {
      title = getKnownConversationTitle(conversationId) || conversationId;
    }
    return {
      conversationId,
      title,
      hrefPath: new URL(
        link.getAttribute('href') || link.href || '',
        location.origin
      ).pathname
    };
  }

  function rememberBatchConversation(state, info) {
    if (
      !state ||
      !info ||
      state.sessionConversationIds.has(info.conversationId) ||
      state.removedWhileProcessingIds.has(info.conversationId) ||
      state.selectedConversations.has(info.conversationId)
    ) {
      return;
    }
    state.selectionOrder += 1;
    state.selectedConversations.set(info.conversationId, {
      ...info,
      selectionOrder: state.selectionOrder
    });
  }

  function forgetBatchConversation(state, conversationId) {
    state?.selectedConversations.delete(conversationId);
  }

  function clearPendingBatchRowDecorationCleanup(scope) {
    const timer = batchRowDecorationCleanupTimers.get(scope);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      batchRowDecorationCleanupTimers.delete(scope);
    }
  }

  function removeBatchRowSpinner(row) {
    row?.querySelector(':scope > [data-cgpt-batch-row-spinner]')?.remove();
  }

  function ensureBatchRowSpinner(row) {
    if (!row || row.querySelector(':scope > [data-cgpt-batch-row-spinner]')) {
      return;
    }
    const spinner = document.createElement('span');
    spinner.setAttribute('data-cgpt-batch-row-spinner', 'true');
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner);
  }

  function clearBatchRowVisualAttributes(row) {
    if (!row) {
      return;
    }
    row.removeAttribute('data-cgpt-batch-row-state');
    row.removeAttribute('data-cgpt-batch-progress-mode');
    row.removeAttribute('data-cgpt-batch-progress-stage');
    row.style.removeProperty('--cgpt-batch-progress');
    removeBatchRowSpinner(row);
  }

  function finalizeBatchConversationRowDecorations(scope) {
    clearPendingBatchRowDecorationCleanup(scope);
    const selector =
      `[data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    for (const row of document.querySelectorAll(selector)) {
      clearBatchRowVisualAttributes(row);
      row.removeAttribute('data-cgpt-batch-selection-row');
      row.removeAttribute('data-cgpt-batch-selection-scope');
    }
  }

  function applyBatchSelectionContextMarkers(context) {
    if (!context?.listRoot) {
      return;
    }
    context.listRoot.setAttribute('data-cgpt-batch-selection-list', 'true');
    context.listRoot.setAttribute('data-cgpt-batch-selection-scope', context.scope);
    if (context.scope === BATCH_SCOPE_GENERAL && context.header) {
      context.header.setAttribute('data-cgpt-batch-selection-header', 'true');
    }
  }

  function clearBatchSelectionContextMarkers(scope) {
    if (scope === BATCH_SCOPE_GENERAL) {
      for (const header of document.querySelectorAll('[data-cgpt-batch-selection-header="true"]')) {
        header.removeAttribute('data-cgpt-batch-selection-header');
      }
    }
    const selector =
      `[data-cgpt-batch-selection-list="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    for (const list of document.querySelectorAll(selector)) {
      list.removeAttribute('data-cgpt-batch-selection-list');
      list.removeAttribute('data-cgpt-batch-selection-scope');
    }
  }

  function disableGeneralBatchRowDragging(state, row) {
    if (!state || state.scope !== BATCH_SCOPE_GENERAL || !row) {
      return;
    }
    if (!state.originalDraggableByLink.has(row)) {
      state.originalDraggableByLink.set(row, {
        hadAttribute: row.hasAttribute('draggable'),
        value: row.getAttribute('draggable')
      });
    }
    row.setAttribute('draggable', 'false');
    row.setAttribute('data-cgpt-batch-drag-disabled', 'true');
  }

  function restoreGeneralBatchRowDragging(state) {
    if (!state) {
      return;
    }
    for (const [link, original] of state.originalDraggableByLink.entries()) {
      try {
        if (original.hadAttribute) {
          link.setAttribute('draggable', original.value ?? '');
        } else {
          link.removeAttribute('draggable');
        }
        link.removeAttribute('data-cgpt-batch-drag-disabled');
      } catch { }
    }
    state.originalDraggableByLink.clear();
  }

  function getBatchConversationVisualState(state, conversationId) {
    const runtime = state?.itemRuntime.get(conversationId);
    if (runtime) {
      if (runtime.status === BATCH_ITEM_EXPORTING) return BATCH_ITEM_EXPORTING;
      if (runtime.status === BATCH_ITEM_SUCCESS) return BATCH_ITEM_SUCCESS;
      if (runtime.status === BATCH_ITEM_FAILED) return BATCH_ITEM_FAILED;
      if (runtime.status === BATCH_ITEM_SKIPPED) return BATCH_ITEM_SKIPPED;
      if (runtime.status === BATCH_ITEM_PENDING) return 'queued';
    }
    return state?.selectedConversations.has(conversationId) ? 'selected' : null;
  }

  function applyBatchConversationRowVisualState(row, info, state) {
    if (!row || !info || !state) {
      return;
    }
    row.setAttribute('data-cgpt-batch-selection-row', 'true');
    row.setAttribute('data-cgpt-batch-selection-scope', state.scope);

    if (state.scope === BATCH_SCOPE_GENERAL && isBatchListLockedPhase(state.phase)) {
      disableGeneralBatchRowDragging(state, row);
    }

    const visualState = getBatchConversationVisualState(state, info.conversationId);
    if (!visualState) {
      clearBatchRowVisualAttributes(row);
      return;
    }

    row.setAttribute('data-cgpt-batch-row-state', visualState);
    const runtime = state.itemRuntime.get(info.conversationId);
    if (visualState === BATCH_ITEM_EXPORTING && runtime) {
      const progress = Math.min(1, Math.max(0, Number(runtime.progress) || 0));
      row.style.setProperty('--cgpt-batch-progress', `${(progress * 100).toFixed(2)}%`);
      row.setAttribute(
        'data-cgpt-batch-progress-mode',
        runtime.progressMode === 'determinate' ? 'determinate' : 'indeterminate'
      );
      row.setAttribute('data-cgpt-batch-progress-stage', runtime.stage || 'working');
      ensureBatchRowSpinner(row);
    } else if (visualState === 'queued') {
      row.style.removeProperty('--cgpt-batch-progress');
      row.setAttribute('data-cgpt-batch-progress-mode', 'indeterminate');
      row.setAttribute('data-cgpt-batch-progress-stage', 'queued');
      removeBatchRowSpinner(row);
    } else {
      row.style.removeProperty('--cgpt-batch-progress');
      row.removeAttribute('data-cgpt-batch-progress-mode');
      row.removeAttribute('data-cgpt-batch-progress-stage');
      removeBatchRowSpinner(row);
    }
  }

  function syncBatchConversationRows(scope, { autoSelectNew = false } = {}) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!context?.listRoot) {
      return;
    }
    for (const row of getBatchConversationRows(context)) {
      const info = getBatchConversationInfo(row, context.scope);
      if (!info) {
        continue;
      }
      if (
        isBatchSelectionEditableState(state) &&
        autoSelectNew &&
        state.selectAllMode &&
        !state.manuallyExcludedIds.has(info.conversationId) &&
        !state.sessionConversationIds.has(info.conversationId)
      ) {
        rememberBatchConversation(state, info);
      }
      applyBatchConversationRowVisualState(row, info, state);
    }
    renderBatchControls();
  }

  function syncSingleBatchConversationRow(scope, conversationId) {
    const state = getBatchSelectionState(scope);
    const context = getBatchUiContext(scope);
    if (!state || !context?.listRoot) {
      return;
    }
    for (const row of getBatchConversationRows(context)) {
      const info = getBatchConversationInfo(row, context.scope);
      if (info?.conversationId === conversationId) {
        applyBatchConversationRowVisualState(row, info, state);
        return;
      }
    }
  }

  function clearBatchConversationRowDecorations(scope, { animate = true } = {}) {
    clearPendingBatchRowDecorationCleanup(scope);
    const selector =
      `[data-cgpt-batch-selection-row="true"][data-cgpt-batch-selection-scope="${scope}"]`;
    const rows = Array.from(document.querySelectorAll(selector));
    for (const row of rows) {
      clearBatchRowVisualAttributes(row);
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced || rows.length === 0) {
      finalizeBatchConversationRowDecorations(scope);
      return;
    }
    const timer = window.setTimeout(() => {
      batchRowDecorationCleanupTimers.delete(scope);
      finalizeBatchConversationRowDecorations(scope);
    }, BATCH_ROW_COLOR_TRANSITION_MS + 30);
    batchRowDecorationCleanupTimers.set(scope, timer);
  }

  function getBatchConversationRowFromEventTarget(target, context) {
    if (!(target instanceof Element) || !context?.listRoot) {
      return null;
    }
    if (context.scope === BATCH_SCOPE_GENERAL) {
      const row = target.closest('a[data-sidebar-item="true"][href^="/c/"]');
      return row && context.listRoot.contains(row) ? row : null;
    }
    const row = target.closest('li');
    return row && context.listRoot.contains(row) && row.querySelector('a[href*="/c/"]')
      ? row
      : null;
  }

  function removeConversationFromBatchSession(scope, conversationId) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !hasActiveBatchSession(state) ||
      !state.sessionConversationIds.has(conversationId)
    ) {
      return false;
    }

    const isCurrentlyProcessing =
      state.workerRunning &&
      state.currentConversationId === conversationId;

    state.sessionConversationIds.delete(conversationId);
    state.sessionTargets = state.sessionTargets.filter(
      (target) => target.conversationId !== conversationId
    );
    state.pendingQueue = state.pendingQueue.filter(
      (target) => target.conversationId !== conversationId
    );
    state.completedPayloads.delete(conversationId);
    state.sessionResults.delete(conversationId);
    state.itemRuntime.delete(conversationId);
    state.manuallyExcludedIds.add(conversationId);

    if (isCurrentlyProcessing) {
      state.removedWhileProcessingIds.add(conversationId);
    }
    if (state.rangeAnchorConversationId === conversationId) {
      state.rangeAnchorConversationId = null;
    }

    state.sessionUpdatedAt = Date.now();
    syncSingleBatchConversationRow(scope, conversationId);
    renderBatchControls();
    return true;
  }

  function toggleBatchConversationRow(scope, row, context) {
    const state = getBatchSelectionState(scope);
    const info = getBatchConversationInfo(row, context.scope);
    if (!state || !info) {
      return;
    }

    if (state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }
    if (state.removedWhileProcessingIds.has(info.conversationId)) {
      return;
    }

    if (state.selectedConversations.has(info.conversationId)) {
      forgetBatchConversation(state, info.conversationId);
      if (state.selectAllMode) {
        state.manuallyExcludedIds.add(info.conversationId);
      }
    } else {
      state.manuallyExcludedIds.delete(info.conversationId);
      rememberBatchConversation(state, info);
    }
    state.rangeAnchorConversationId = info.conversationId;
    syncBatchConversationRows(scope);
  }

  function selectBatchConversationRange(scope, row, context) {
    const state = getBatchSelectionState(scope);
    const targetInfo = getBatchConversationInfo(row, context.scope);
    if (
      !state ||
      !targetInfo ||
      state.sessionConversationIds.has(targetInfo.conversationId) ||
      state.removedWhileProcessingIds.has(targetInfo.conversationId)
    ) {
      return;
    }
    const anchorId = state.rangeAnchorConversationId;
    if (!anchorId) {
      toggleBatchConversationRow(scope, row, context);
      return;
    }
    const items = getBatchConversationRows(context)
      .map((candidateRow) => ({
        info: getBatchConversationInfo(candidateRow, context.scope)
      }))
      .filter((item) => Boolean(item.info));
    const anchorIndex = items.findIndex((item) => item.info.conversationId === anchorId);
    const targetIndex = items.findIndex(
      (item) => item.info.conversationId === targetInfo.conversationId
    );
    if (anchorIndex < 0 || targetIndex < 0) {
      toggleBatchConversationRow(scope, row, context);
      return;
    }
    const from = Math.min(anchorIndex, targetIndex);
    const to = Math.max(anchorIndex, targetIndex);
    for (let index = from; index <= to; index += 1) {
      const info = items[index].info;
      if (
        state.sessionConversationIds.has(info.conversationId) ||
        state.removedWhileProcessingIds.has(info.conversationId)
      ) {
        continue;
      }
      state.manuallyExcludedIds.delete(info.conversationId);
      rememberBatchConversation(state, info);
    }
    syncBatchConversationRows(scope);
  }

  function handleBatchListClick(scope, event) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const info = getBatchConversationInfo(row, context.scope);
    if (info && state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }

    if (!isBatchSelectionEditableState(state)) {
      return;
    }
    if (event.shiftKey) {
      selectBatchConversationRange(scope, row, context);
    } else {
      toggleBatchConversationRow(scope, row, context);
    }
  }

  function handleBatchListDblClick(scope, event) {
    if (scope !== BATCH_SCOPE_GENERAL) {
      return;
    }
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function handleBatchListKeydown(scope, event) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !isBatchListLockedPhase(state.phase) ||
      (event.key !== 'Enter' && event.key !== ' ')
    ) {
      return;
    }
    const context = getBatchUiContext(scope);
    const row = getBatchConversationRowFromEventTarget(event.target, context);
    if (!row) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const info = getBatchConversationInfo(row, context.scope);
    if (info && state.sessionConversationIds.has(info.conversationId)) {
      removeConversationFromBatchSession(scope, info.conversationId);
      return;
    }

    if (!isBatchSelectionEditableState(state)) {
      return;
    }
    if (event.shiftKey) {
      selectBatchConversationRange(scope, row, context);
    } else {
      toggleBatchConversationRow(scope, row, context);
    }
  }

  function handleBatchListDragStart(scope, event) {
    const state = getBatchSelectionState(scope);
    if (scope !== BATCH_SCOPE_GENERAL || !state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!getBatchConversationRowFromEventTarget(event.target, context)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function detachBatchSelectionListBinding(scope) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    clearBatchSelectionContextMarkers(scope);
    if (state.listRoot && state.listClickHandler) {
      state.listRoot.removeEventListener('click', state.listClickHandler, true);
    }
    if (state.listRoot && state.listDblclickHandler) {
      state.listRoot.removeEventListener('dblclick', state.listDblclickHandler, true);
    }
    if (state.listRoot && state.listKeydownHandler) {
      state.listRoot.removeEventListener('keydown', state.listKeydownHandler, true);
    }
    if (state.listRoot && state.listDragstartHandler) {
      state.listRoot.removeEventListener('dragstart', state.listDragstartHandler, true);
    }
    if (state.listObserver) {
      state.listObserver.disconnect();
    }
    restoreGeneralBatchRowDragging(state);
    state.listRoot = null;
    state.listObserver = null;
    state.listClickHandler = null;
    state.listDblclickHandler = null;
    state.listKeydownHandler = null;
    state.listDragstartHandler = null;
  }

  function bindBatchSelectionList(context) {
    const state = getBatchSelectionState(context?.scope);
    if (!context?.listRoot || !state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    if (state.listRoot === context.listRoot) {
      applyBatchSelectionContextMarkers(context);
      syncBatchConversationRows(context.scope, {
        autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
      });
      return;
    }

    detachBatchSelectionListBinding(context.scope);
    applyBatchSelectionContextMarkers(context);
    state.listRoot = context.listRoot;
    state.listClickHandler = (event) => handleBatchListClick(context.scope, event);
    state.listDblclickHandler = (event) => handleBatchListDblClick(context.scope, event);
    state.listKeydownHandler = (event) => handleBatchListKeydown(context.scope, event);
    state.listDragstartHandler = (event) => handleBatchListDragStart(context.scope, event);

    context.listRoot.addEventListener('click', state.listClickHandler, true);
    if (context.scope === BATCH_SCOPE_GENERAL) {
      context.listRoot.addEventListener('dblclick', state.listDblclickHandler, true);
    }
    context.listRoot.addEventListener('keydown', state.listKeydownHandler, true);
    if (context.scope === BATCH_SCOPE_GENERAL) {
      context.listRoot.addEventListener('dragstart', state.listDragstartHandler, true);
    }

    state.listObserver = new MutationObserver(() => {
      syncBatchConversationRows(context.scope, {
        autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
      });
    });
    state.listObserver.observe(context.listRoot, { childList: true, subtree: true });
    syncBatchConversationRows(context.scope, {
      autoSelectNew: isBatchSelectionEditableState(state) && state.selectAllMode
    });
  }

  function createBatchActionButton({
    scope,
    action,
    label,
    iconSvg,
    disabled = false,
    placement = 'auto'
  }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-cgpt-batch-action', action);
    button.disabled = disabled;

    const actualPlacement = placement === 'auto'
      ? (scope === BATCH_SCOPE_GENERAL ? 'header' : 'project')
      : placement;

    if (actualPlacement === 'header') {
      button.className = [
        'disabled:text-token-text-tertiary',
        'pointer-events-auto',
        'disabled:pointer-events-none',
        'touch:min-h-10',
        'keyboard-focused:*:focus-ring',
        'relative',
        'isolate',
        'flex',
        'min-h-9',
        'items-center',
        'self-stretch',
        'rounded-e-[10px]',
        'focus:outline-none',
        '-my-2',
        '-ms-1',
        'ps-1',
        '-me-2.5',
        'pe-1.5',
        'text-inherit',
        'interactive-label-secondary',
        'data-[state=open]:text-(--interactive-label-hover-secondary)',
        'transition-opacity',
        'focus-visible:opacity-100',
        'can-hover:opacity-0',
        'can-hover:group-hover/sidebar-expando-section-header:opacity-100',
        'cant-hover:opacity-100'
      ].join(' ');
      button.setAttribute('data-trailing-button', '');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML =
        `<div class="flex items-center justify-center rounded-lg p-1">${iconSvg}</div>`;
      return button;
    }

    if (actualPlacement === 'general-panel') {
      button.className = 'focus:outline-none';
      button.setAttribute('data-cgpt-batch-general-action', 'true');
      button.setAttribute('aria-label', label);
      button.title = label;
      button.innerHTML =
        `${iconSvg}<span data-cgpt-batch-general-action-label>${label}</span>`;
      return button;
    }

    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      'btn-secondary',
      'touch:h-10',
      'h-9',
      'px-3'
    ].join(' ');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML =
      `<div class="flex items-center justify-center">${iconSvg}<span>${label}</span></div>`;
    return button;
  }

  function getOrCreateBatchControls(scope) {
    const id = scope === BATCH_SCOPE_GENERAL
      ? BATCH_GENERAL_CONTROLS_ID
      : BATCH_PROJECT_CONTROLS_ID;
    let controls = document.getElementById(id);
    if (!controls) {
      controls = document.createElement('div');
      controls.id = id;
      controls.setAttribute('data-cgpt-batch-controls', scope);
    }
    return controls;
  }

  function placeBatchControls(
    scope,
    controls,
    context,
    state
  ) {
    if (scope === BATCH_SCOPE_GENERAL) {
      if (state.phase === BATCH_PHASE_IDLE) {
        clearBatchMotionLifecycle(controls);
        controls.removeAttribute(
          'data-cgpt-motion-state'
        );
        controls.removeAttribute('inert');
        controls.removeAttribute('aria-hidden');
        controls.setAttribute(
          'data-cgpt-batch-general-mode',
          'header'
        );
        controls.className = 'contents';
        if (
          controls.parentElement !==
          context.controlsHost ||
          context.controlsHost.firstElementChild !==
          controls
        ) {
          context.controlsHost.insertBefore(
            controls,
            context.controlsHost.firstElementChild
          );
        }
      } else {
        const enteringPanel =
          controls.getAttribute(
            'data-cgpt-batch-general-mode'
          ) !== 'panel';

        controls.setAttribute(
          'data-cgpt-batch-general-mode',
          'panel'
        );
        controls.className = '';

        if (enteringPanel) {
          setBatchMotionStateImmediately(
            controls,
            false
          );
        }

        if (
          controls.parentElement !==
          context.panelHost ||
          controls.nextElementSibling !==
          context.listRoot
        ) {
          context.panelHost.insertBefore(
            controls,
            context.listRoot
          );
        }

        if (enteringPanel) {
          transitionBatchMotionState(
            controls,
            true
          );
        }
      }
      return;
    }

    controls.className = '';
    controls.setAttribute('role', 'presentation');
    controls.removeAttribute(
      'data-cgpt-batch-general-mode'
    );

    if (
      !controls.hasAttribute(
        'data-cgpt-motion-state'
      )
    ) {
      setBatchMotionStateImmediately(
        controls,
        false
      );
    }

    if (
      controls.parentElement !== context.tablist ||
      controls.nextElementSibling !==
      context.sourcesTab
    ) {
      context.tablist.insertBefore(
        controls,
        context.sourcesTab
      );
    }
  }

  function removeBatchControlsIfContextMissing(scope) {
    const state = getBatchSelectionState(scope);
    if (hasActiveBatchSession(state)) {
      return;
    }
    const id = scope === BATCH_SCOPE_GENERAL
      ? BATCH_GENERAL_CONTROLS_ID
      : BATCH_PROJECT_CONTROLS_ID;
    document.getElementById(id)?.remove();
  }

  function getBatchPanelStatusItems(state) {
    const draftCount = state.selectedConversations.size;
    if (!hasActiveBatchSession(state)) {
      return [`目前選取：${draftCount}`];
    }

    const items = [`類型：${getBatchExportKindLabel(state.exportKind)}`];
    const success = countBatchStatus(state, BATCH_ITEM_SUCCESS);
    const failed = countBatchStatus(state, BATCH_ITEM_FAILED);

    if (success > 0) items.push(`成功：${success}`);
    if (failed > 0) items.push(`失敗：${failed}`);
    if (state.workerRunning) items.push('處理中：1');
    if (state.pendingQueue.length > 0) items.push(`佇列：${state.pendingQueue.length}`);
    if (draftCount > 0) items.push(`目前選取：${draftCount}`);
    if (
      !state.workerRunning &&
      state.pendingQueue.length === 0 &&
      draftCount === 0 &&
      state.sessionTargets.length > 0
    ) {
      items.push('狀態：可打包');
    }
    return items;
  }

  function prefersReducedBatchMotion() {
    return Boolean(
      window.matchMedia?.(
        '(prefers-reduced-motion: reduce)'
      ).matches
    );
  }

  function clearBatchMotionLifecycle(element) {
    const lifecycle = batchMotionLifecycles.get(element);
    if (!lifecycle) {
      return;
    }

    if (lifecycle.timer !== null) {
      window.clearTimeout(lifecycle.timer);
    }
    if (
      lifecycle.transitionElement &&
      lifecycle.transitionHandler
    ) {
      lifecycle.transitionElement.removeEventListener(
        'transitionend',
        lifecycle.transitionHandler
      );
    }

    batchMotionLifecycles.delete(element);
  }

  function applyBatchMotionAccessibility(
    element,
    open
  ) {
    const isOpen = Boolean(open);
    element.toggleAttribute('inert', !isOpen);
    if (isOpen) {
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('aria-hidden', 'true');
    }
  }

  function setBatchMotionStateImmediately(
    element,
    open
  ) {
    if (!element) {
      return;
    }
    clearBatchMotionLifecycle(element);
    element.setAttribute(
      'data-cgpt-motion-state',
      open ? 'open' : 'closed'
    );
    applyBatchMotionAccessibility(
      element,
      open
    );
  }

  /*
   * 統一有限狀態動畫 lifecycle：
   *
   *   初次 mount：
   *     JS 直接切到目標 state；CSS @starting-style 提供 before-change style。
   *
   *   已存在 DOM：
   *     JS 直接切換 open / closed，交由既有 CSS transition 自然反向。
   *
   * 一般側邊欄 controls 從 header 變成 panel 時，元素本身不是新 DOM，
   * 因此 entry 由 CSS keyframe 處理。整個 lifecycle 不再同步讀取
   * getBoundingClientRect / offsetWidth，不強迫瀏覽器在 click handler 中
   * 立即結算全頁 style / layout。
   *
   * 退場仍保留 DOM 到 transitionend 後才 cleanup。
   * JS 只管理 state / accessibility / cleanup，不使用 WAAPI。
   * setTimeout 只作 transitionend 未送達時的保險 fallback。
   */
  function transitionBatchMotionState(
    element,
    open,
    {
      transitionElement = element,
      transitionProperty = null,
      onSettled = null
    } = {}
  ) {
    if (!element) {
      if (typeof onSettled === 'function') {
        onSettled();
      }
      return;
    }

    const targetState = open ? 'open' : 'closed';
    const existing = batchMotionLifecycles.get(element);
    if (existing?.targetState === targetState) {
      return;
    }

    clearBatchMotionLifecycle(element);

    let currentState = element.getAttribute(
      'data-cgpt-motion-state'
    );

    if (currentState === targetState) {
      applyBatchMotionAccessibility(
        element,
        open
      );
      if (typeof onSettled === 'function') {
        window.queueMicrotask(onSettled);
      }
      return;
    }

    /*
     * 若是剛建立、尚未有 motion state 的 DOM，先標記與目標相反的
     * 邏輯 state；若同一 task 內隨即切 open，初次 render 的視覺起始值
     * 由 CSS @starting-style 接手，不需要同步 layout flush。
     */
    if (!currentState) {
      currentState = open ? 'closed' : 'open';
      element.setAttribute(
        'data-cgpt-motion-state',
        currentState
      );
      applyBatchMotionAccessibility(
        element,
        !open
      );
    }

    /*
     * 退場一開始就停止新的互動，但 DOM / layout 仍保留到 transition 完成。
     */
    if (!open) {
      applyBatchMotionAccessibility(
        element,
        false
      );
    }

    if (
      prefersReducedBatchMotion() ||
      !element.isConnected
    ) {
      element.setAttribute(
        'data-cgpt-motion-state',
        targetState
      );
      applyBatchMotionAccessibility(
        element,
        open
      );
      if (typeof onSettled === 'function') {
        onSettled();
      }
      return;
    }

    const lifecycle = {
      targetState,
      timer: null,
      transitionElement: null,
      transitionHandler: null
    };

    batchMotionLifecycles.set(
      element,
      lifecycle
    );

    const settle = () => {
      if (
        batchMotionLifecycles.get(element) !==
        lifecycle
      ) {
        return;
      }

      clearBatchMotionLifecycle(element);

      if (typeof onSettled === 'function') {
        onSettled();
      }
    };

    if (
      typeof onSettled === 'function' &&
      transitionElement
    ) {
      lifecycle.transitionElement =
        transitionElement;

      lifecycle.transitionHandler = (event) => {
        if (event.target !== transitionElement) {
          return;
        }

        if (
          transitionProperty &&
          event.propertyName !== transitionProperty
        ) {
          return;
        }

        settle();
      };

      transitionElement.addEventListener(
        'transitionend',
        lifecycle.transitionHandler
      );
    }

    element.setAttribute(
      'data-cgpt-motion-state',
      targetState
    );

    if (open) {
      applyBatchMotionAccessibility(
        element,
        true
      );
    }

    if (typeof onSettled === 'function') {
      lifecycle.timer = window.setTimeout(
        settle,
        BATCH_MOTION_TRANSITION_MS + 120
      );
    } else {
      batchMotionLifecycles.delete(element);
    }
  }

  function getOrCreateBatchActionSlot(
    target,
    action,
    placement
  ) {
    let slot = Array.from(target.children).find(
      (candidate) =>
        candidate instanceof HTMLElement &&
        candidate.getAttribute(
          'data-cgpt-batch-action-slot'
        ) === action
    );

    if (!slot) {
      slot = document.createElement('div');
      slot.setAttribute(
        'data-cgpt-batch-action-slot',
        action
      );
      slot.setAttribute(
        'data-cgpt-batch-action-placement',
        placement
      );
      setBatchMotionStateImmediately(
        slot,
        false
      );
      target.append(slot);
    }

    return slot;
  }

  function syncBatchActionSlots(
    target,
    definitions,
    placement
  ) {
    const expectedActions = new Set(
      definitions.map(
        (definition) => definition.action
      )
    );

    definitions.forEach(
      (definition, definitionIndex) => {
        const slot = getOrCreateBatchActionSlot(
          target,
          definition.action,
          placement
        );

        const currentAtIndex =
          target.children[definitionIndex] || null;
        if (currentAtIndex !== slot) {
          target.insertBefore(
            slot,
            currentAtIndex
          );
        }

        const shouldShow = Boolean(
          definition.visible
        );

        let button = slot.querySelector(
          ':scope > [data-cgpt-batch-action]'
        );

        /*
         * action 的 label / icon / handler 對同一 action 是穩定的。
         * DOM 只在第一次建立，後續只更新 title；退場時不拆 DOM。
         */
        if (!button) {
          button = createBatchActionButton({
            scope: definition.scope,
            action: definition.action,
            label: definition.label,
            iconSvg: definition.iconSvg,
            disabled: false,
            placement
          });
          if (
            typeof definition.onClick === 'function'
          ) {
            button.addEventListener(
              'click',
              definition.onClick
            );
          }
          slot.append(button);
        }

        button.title =
          definition.title || definition.label;

        transitionBatchMotionState(
          slot,
          shouldShow
        );
      }
    );

    for (const child of Array.from(target.children)) {
      if (
        !(child instanceof HTMLElement) ||
        !child.hasAttribute(
          'data-cgpt-batch-action-slot'
        )
      ) {
        continue;
      }
      const action = child.getAttribute(
        'data-cgpt-batch-action-slot'
      );
      if (!expectedActions.has(action)) {
        transitionBatchMotionState(
          child,
          false
        );
      }
    }
  }

  function buildBatchActionDefinitions(scope, state) {
    const draftCount = state.selectedConversations.size;
    const sessionActive = hasActiveBatchSession(state);
    const packaging =
      state.phase === BATCH_PHASE_PACKAGING;
    const editable = isBatchSelectionEditableState(state);
    const blocked = Boolean(state.sessionBlockedReason);

    return [
      {
        scope,
        action: 'export',
        label: '匯出',
        iconSvg: BATCH_EXPORT_ICON_SVG,
        visible:
          draftCount > 0 &&
          editable &&
          !blocked,
        title: sessionActive
          ? `把目前選取的 ${draftCount} 個對話加入既有批次`
          : `確認要批次匯出的 ${draftCount} 個對話`,
        onClick: () => {
          showBatchConfirmationDialog(scope);
        }
      },
      {
        scope,
        action: 'select-all',
        label: '全選',
        iconSvg: BATCH_SELECT_ALL_ICON_SVG,
        visible:
          editable &&
          !blocked,
        title: state.selectAllMode
          ? '重新全選目前列表，並繼續自動選取後續載入的對話'
          : '全選目前列表，並自動選取後續載入的對話',
        onClick: () => {
          selectAllBatchConversations(scope);
        }
      },
      {
        scope,
        action: 'clear-current-selection',
        label: '取消目前選取',
        iconSvg: BATCH_CANCEL_ICON_SVG,
        visible:
          draftCount > 0 &&
          editable,
        title:
          '只清除尚未加入佇列的目前藍色選取',
        onClick: () => {
          clearCurrentBatchSelection(scope);
        }
      },
      {
        scope,
        action: 'package',
        label: '打包',
        iconSvg: BATCH_PACKAGE_ICON_SVG,
        visible: canPackageBatchSession(state),
        title:
          '把目前 session 已取得的結果封裝成 STORE ZIP 並下載。',
        onClick: () => {
          void packageBatchSession(scope);
        }
      },
      {
        scope,
        action: 'cancel-job',
        label: '取消批次下載作業',
        iconSvg: BATCH_STOP_ICON_SVG,
        visible:
          sessionActive &&
          !packaging,
        title:
          '確認後會重新整理目前網頁，清除尚未打包的批次資料與作業狀態。',
        onClick: () => {
          showCancelBatchJobDialog(scope);
        }
      }
    ];
  }

  function appendBatchActionSet(
    scope,
    target,
    state,
    placement
  ) {
    syncBatchActionSlots(
      target,
      buildBatchActionDefinitions(scope, state),
      placement
    );
  }

  function renderGeneralBatchControls(
    controls,
    context,
    state
  ) {
    if (state.phase === BATCH_PHASE_IDLE) {
      controls.replaceChildren();
      controls.removeAttribute(
        'data-cgpt-batch-panel-scaffold'
      );

      const entry = createBatchActionButton({
        scope: BATCH_SCOPE_GENERAL,
        action: 'start',
        label: '批次匯出',
        iconSvg: BATCH_ENTRY_ICON_SVG,
        disabled: !context.active,
        placement: 'header'
      });
      entry.addEventListener('click', () =>
        beginBatchSelectionMode(
          BATCH_SCOPE_GENERAL
        )
      );
      controls.append(entry);
      return;
    }

    let header = controls.querySelector(
      ':scope > [data-cgpt-batch-general-panel-header]'
    );
    let title = controls.querySelector(
      '[data-cgpt-batch-general-panel-title]'
    );
    let statusList = controls.querySelector(
      '[data-cgpt-batch-general-panel-status-list]'
    );
    let actions = controls.querySelector(
      ':scope > [data-cgpt-batch-general-panel-actions]'
    );
    let close = controls.querySelector(
      '[data-cgpt-batch-general-panel-close]'
    );

    if (!header || !title || !statusList || !actions) {
      controls.replaceChildren();
      controls.setAttribute(
        'data-cgpt-batch-panel-scaffold',
        'true'
      );

      header = document.createElement('div');
      header.setAttribute(
        'data-cgpt-batch-general-panel-header',
        'true'
      );

      const titleWrap = document.createElement('div');
      titleWrap.className = 'min-w-0';

      title = document.createElement('div');
      title.setAttribute(
        'data-cgpt-batch-general-panel-title',
        'true'
      );
      title.textContent = '批次匯出';

      statusList = document.createElement('ul');
      statusList.setAttribute(
        'data-cgpt-batch-general-panel-status-list',
        'true'
      );

      titleWrap.append(title, statusList);
      header.append(titleWrap);

      close = document.createElement('button');
      close.type = 'button';
      close.setAttribute(
        'data-cgpt-batch-general-panel-close',
        'true'
      );
      setBatchMotionStateImmediately(
        close,
        false
      );
      close.setAttribute(
        'aria-label',
        '關閉批次模式'
      );
      close.title = '關閉批次模式';
      close.innerHTML = BATCH_CANCEL_ICON_SVG;
      close.addEventListener('click', () =>
        closeBatchSelectionMode(
          BATCH_SCOPE_GENERAL
        )
      );
      header.append(close);

      actions = document.createElement('div');
      actions.setAttribute(
        'data-cgpt-batch-general-panel-actions',
        'true'
      );

      controls.append(header, actions);
    }

    title.textContent = '批次匯出';

    statusList.replaceChildren();
    for (
      const statusText of getBatchPanelStatusItems(state)
    ) {
      const statusItem =
        document.createElement('li');
      statusItem.textContent = statusText;
      statusList.append(statusItem);
    }

    const showClose = !hasActiveBatchSession(state);
    transitionBatchMotionState(
      close,
      showClose
    );

    appendBatchActionSet(
      BATCH_SCOPE_GENERAL,
      actions,
      state,
      'general-panel'
    );
  }

  function renderProjectBatchControls(
    controls,
    context,
    state
  ) {
    const visible = Boolean(context.active);
    controls.setAttribute(
      'data-cgpt-batch-visible',
      visible ? 'true' : 'false'
    );

    if (state.phase === BATCH_PHASE_IDLE) {
      controls.replaceChildren();
      controls.removeAttribute(
        'data-cgpt-batch-project-action-host'
      );

      const entry = createBatchActionButton({
        scope: BATCH_SCOPE_PROJECT,
        action: 'start',
        label: '批次匯出',
        iconSvg: BATCH_ENTRY_ICON_SVG,
        disabled: !context.active,
        placement: 'project'
      });
      entry.addEventListener('click', () =>
        beginBatchSelectionMode(
          BATCH_SCOPE_PROJECT
        )
      );
      controls.append(entry);
      transitionBatchMotionState(
        controls,
        visible
      );
      return;
    }

    if (
      controls.getAttribute(
        'data-cgpt-batch-project-action-host'
      ) !== 'true'
    ) {
      controls.replaceChildren();
      controls.setAttribute(
        'data-cgpt-batch-project-action-host',
        'true'
      );
    }

    const definitions =
      buildBatchActionDefinitions(
        BATCH_SCOPE_PROJECT,
        state
      );

    definitions.push({
      scope: BATCH_SCOPE_PROJECT,
      action: 'close-mode',
      label: '關閉',
      iconSvg: BATCH_CANCEL_ICON_SVG,
      visible:
        !hasActiveBatchSession(state) &&
        state.phase === BATCH_PHASE_SELECTING,
      title: '關閉批次模式',
      onClick: () => {
        closeBatchSelectionMode(
          BATCH_SCOPE_PROJECT
        );
      }
    });

    syncBatchActionSlots(
      controls,
      definitions,
      'project'
    );

    transitionBatchMotionState(
      controls,
      visible
    );
  }

  function renderBatchControlsForScope(scope, context) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    const controls = getOrCreateBatchControls(scope);
    placeBatchControls(scope, controls, context, state);

    const signature = [
      state.phase,
      context.active ? 'active' : 'inactive',
      state.selectedConversations.size,
      state.selectAllMode ? 'all' : 'manual',
      state.exportKind || 'none',
      state.workerRunning ? 'working' : 'idle-worker',
      state.pendingQueue.length,
      state.sessionTargets.length,
      countBatchStatus(state, BATCH_ITEM_SUCCESS),
      countBatchStatus(state, BATCH_ITEM_FAILED),
      state.sessionBlockedReason ? 'blocked' : 'open'
    ].join(':');

    if (controls.getAttribute('data-cgpt-batch-render-signature') === signature) {
      return;
    }
    controls.setAttribute(
      'data-cgpt-batch-render-signature',
      signature
    );
    controls.setAttribute(
      'data-cgpt-batch-mode',
      state.phase
    );

    if (scope === BATCH_SCOPE_GENERAL) {
      renderGeneralBatchControls(
        controls,
        context,
        state
      );
    } else {
      renderProjectBatchControls(
        controls,
        context,
        state
      );
    }
  }

  function renderBatchControls() {
    const general = findGeneralBatchUiContext();
    if (general) {
      renderBatchControlsForScope(BATCH_SCOPE_GENERAL, general);
    } else {
      removeBatchControlsIfContextMissing(BATCH_SCOPE_GENERAL);
    }

    const project = findProjectBatchUiContext();
    if (project) {
      renderBatchControlsForScope(BATCH_SCOPE_PROJECT, project);
    } else {
      removeBatchControlsIfContextMissing(BATCH_SCOPE_PROJECT);
    }

    syncBatchBeforeUnloadGuard();
  }

  function resetBatchDraftSelection(state) {
    state.selectedConversations.clear();
    state.manuallyExcludedIds.clear();
    state.selectAllMode = false;
    state.closingMode = false;
    state.rangeAnchorConversationId = null;
    state.selectionOrder = 0;
  }

  function resetBatchSessionState(state, { preserveLastResults = true } = {}) {
    state.exportKind = null;
    state.sessionStartedAt = null;
    state.sessionUpdatedAt = null;
    state.sessionBlockedReason = '';
    state.sessionTargets = [];
    state.sessionConversationIds.clear();
    state.pendingQueue = [];
    state.workerRunning = false;
    state.currentConversationId = null;
    state.itemRuntime.clear();
    state.completedPayloads.clear();
    state.sessionResults.clear();
    state.removedWhileProcessingIds.clear();
    state.zipFilename = null;
    if (!preserveLastResults) {
      state.lastBatchResults = null;
    }
  }

  function findBatchScrollableAncestor(element) {
    let node = element?.parentElement || null;
    while (
      node &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      try {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        const isScrollable =
          /^(auto|scroll|overlay)$/.test(overflowY) &&
          node.scrollHeight > node.clientHeight + 1;
        if (isScrollable) {
          return node;
        }
      } catch {
        // 繼續往上尋找可捲動祖先。
      }
      node = node.parentElement;
    }
    return null;
  }

  /*
   * 量測側邊欄 scroll container 頂端實際被 sticky / fixed UI 覆蓋的高度。
   *
   * ChatGPT 目前的側邊欄頂部包含 Logo / 搜尋 / 新對話等固定區塊；
   * 單純把「聊天」header 對齊 scroll container.top，會讓它捲到這些 UI 下方。
   *
   * 不依賴 build class 或固定像素高度，而是在 sidebar 的實際 x 範圍內
   * 掃描頂部一小段畫面，尋找 position: sticky / fixed 的 rendered element，
   * 以最下方的遮蔽邊界作為 scroll offset。
   */
  function measureBatchSidebarTopOcclusion(
    scrollContainer,
    referenceElement
  ) {
    if (
      !scrollContainer ||
      !referenceElement ||
      !scrollContainer.isConnected ||
      !referenceElement.isConnected
    ) {
      return 0;
    }

    const containerRect =
      scrollContainer.getBoundingClientRect();
    const referenceRect =
      referenceElement.getBoundingClientRect();

    if (
      containerRect.width <= 0 ||
      containerRect.height <= 0
    ) {
      return 0;
    }

    const probeX = Math.min(
      containerRect.right - 2,
      Math.max(
        containerRect.left + 2,
        referenceRect.left +
        Math.min(
          Math.max(referenceRect.width * 0.5, 24),
          80
        )
      )
    );

    const scanTop = containerRect.top + 1;
    const scanBottom = Math.min(
      containerRect.bottom - 1,
      scanTop + Math.min(280, containerRect.height * 0.5)
    );

    let occlusionBottom = containerRect.top;

    for (
      let probeY = scanTop;
      probeY <= scanBottom;
      probeY += 8
    ) {
      const elements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(probeX, probeY)
          : [];

      for (const element of elements) {
        if (
          !(element instanceof Element) ||
          element === scrollContainer ||
          element === referenceElement ||
          referenceElement.contains(element)
        ) {
          continue;
        }

        let style;
        try {
          style = getComputedStyle(element);
        } catch {
          continue;
        }

        if (
          style.position !== 'sticky' &&
          style.position !== 'fixed'
        ) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const overlapsContainerHorizontally =
          rect.right > containerRect.left + 1 &&
          rect.left < containerRect.right - 1;
        const overlapsContainerTopArea =
          rect.bottom > containerRect.top &&
          rect.top < scanBottom;

        if (
          !overlapsContainerHorizontally ||
          !overlapsContainerTopArea ||
          rect.width <= 0 ||
          rect.height <= 0
        ) {
          continue;
        }

        occlusionBottom = Math.max(
          occlusionBottom,
          Math.min(rect.bottom, containerRect.bottom)
        );
      }
    }

    /*
     * 額外保留 8px，避免剛好貼住 sticky 區塊下緣。
     */
    const measuredOffset = Math.max(
      0,
      occlusionBottom - containerRect.top
    );
    return measuredOffset > 0
      ? measuredOffset + 8
      : 0;
  }

  function scrollGeneralBatchSectionToTop(context) {
    if (
      context?.scope !== BATCH_SCOPE_GENERAL ||
      !context.header ||
      !context.header.isConnected
    ) {
      return;
    }

    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    /*
     * 連續兩個 rAF：
     * 第一個讓批次面板完成插入；
     * 第二個再量 sticky 區域與最終幾何，避免使用插入前的位置。
     */
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!context.header.isConnected) {
          return;
        }

        const scrollContainer =
          findBatchScrollableAncestor(context.header);

        if (scrollContainer) {
          const headerRect =
            context.header.getBoundingClientRect();
          const containerRect =
            scrollContainer.getBoundingClientRect();
          const topOcclusion =
            measureBatchSidebarTopOcclusion(
              scrollContainer,
              context.header
            );

          const targetTop = Math.max(
            0,
            scrollContainer.scrollTop +
            headerRect.top -
            containerRect.top -
            topOcclusion
          );

          try {
            scrollContainer.scrollTo({
              top: targetTop,
              behavior: reducedMotion
                ? 'auto'
                : 'smooth'
            });
          } catch {
            scrollContainer.scrollTop = targetTop;
          }
          return;
        }

        /*
         * 找不到明確 scroll container 時退回 scrollIntoView。
         * 此 fallback 不自行猜固定 header 高度。
         */
        try {
          context.header.scrollIntoView({
            block: 'start',
            inline: 'nearest',
            behavior: reducedMotion
              ? 'auto'
              : 'smooth'
          });
        } catch {
          context.header.scrollIntoView(true);
        }
      });
    });
  }

  function beginBatchSelectionMode(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || state.phase !== BATCH_PHASE_IDLE) {
      return;
    }
    finalizeBatchConversationRowDecorations(scope);
    const context = getBatchUiContext(scope);
    if (!context?.listRoot || !context.active) {
      alert(
        scope === BATCH_SCOPE_PROJECT
          ? '目前無法進入批次選擇模式。請先切換到此專案的「聊天」分頁。'
          : '目前找不到可選取的一般聊天列表。請確認側邊欄「聊天」區塊已顯示。'
      );
      return;
    }
    resetBatchDraftSelection(state);
    resetBatchSessionState(state);
    state.phase = BATCH_PHASE_SELECTING;
    state.routePathname = location.pathname;
    bindBatchSelectionList(context);
    renderBatchControls();

    if (scope === BATCH_SCOPE_GENERAL) {
      scrollGeneralBatchSectionToTop(context);
    }
  }

  function finalizeCloseBatchSelectionMode(
    scope,
    { silent = false } = {}
  ) {
    const state = getBatchSelectionState(scope);
    if (!state || hasActiveBatchSession(state)) {
      return;
    }

    removeBatchConfirmationDialog();
    detachBatchSelectionListBinding(scope);
    clearBatchConversationRowDecorations(scope);
    resetBatchDraftSelection(state);
    resetBatchSessionState(state);
    state.phase = BATCH_PHASE_IDLE;
    state.routePathname = null;
    state.closingMode = false;

    const controls = document.getElementById(
      scope === BATCH_SCOPE_GENERAL
        ? BATCH_GENERAL_CONTROLS_ID
        : BATCH_PROJECT_CONTROLS_ID
    );
    if (controls) {
      clearBatchMotionLifecycle(controls);
      controls.removeAttribute(
        'data-cgpt-motion-state'
      );
      controls.removeAttribute('inert');
      controls.removeAttribute('aria-hidden');
    }

    renderBatchControls();

    if (!silent) {
      logInfo(
        `已關閉 ${scope === BATCH_SCOPE_PROJECT
          ? '專案'
          : '一般聊天'
        }批次模式。`
      );
    }
  }

  function closeBatchSelectionMode(
    scope,
    { silent = false } = {}
  ) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      state.phase === BATCH_PHASE_IDLE ||
      hasActiveBatchSession(state) ||
      state.closingMode
    ) {
      return;
    }

    const controls = document.getElementById(
      scope === BATCH_SCOPE_GENERAL
        ? BATCH_GENERAL_CONTROLS_ID
        : BATCH_PROJECT_CONTROLS_ID
    );

    if (!controls) {
      finalizeCloseBatchSelectionMode(
        scope,
        { silent }
      );
      return;
    }

    state.closingMode = true;
    transitionBatchMotionState(
      controls,
      false,
      {
        transitionElement: controls,
        transitionProperty:
          scope === BATCH_SCOPE_GENERAL
            ? 'max-height'
            : 'max-width',
        onSettled: () => {
          finalizeCloseBatchSelectionMode(
            scope,
            { silent }
          );
        }
      }
    );
  }

  function cancelBatchSelectionMode(scope, options = {}) {
    closeBatchSelectionMode(scope, options);
  }

  function clearCurrentBatchSelection(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    resetBatchDraftSelection(state);
    syncBatchConversationRows(scope);
    renderBatchControls();
  }

  function selectAllBatchConversations(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    state.selectAllMode = true;
    state.manuallyExcludedIds.clear();
    syncBatchConversationRows(scope, { autoSelectNew: true });
  }

  function removeBatchDialogImmediatelyById(id) {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    clearBatchMotionLifecycle(element);
    element.remove();
  }

  function removeBatchConfirmationDialog() {
    removeBatchDialogImmediatelyById(
      BATCH_DIALOG_ID
    );
  }

  function removeCancelBatchJobDialog() {
    removeBatchDialogImmediatelyById(
      BATCH_CANCEL_JOB_DIALOG_ID
    );
  }

  function ensureBatchSelectionBinding(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchListLockedPhase(state.phase)) {
      return;
    }
    const context = getBatchUiContext(scope);
    if (!context?.listRoot) {
      return;
    }
    if (!context.active && !hasActiveBatchSession(state)) {
      closeBatchSelectionMode(scope, { silent: true });
      return;
    }
    bindBatchSelectionList(context);
  }

  function ensureAllBatchSelectionBindings() {
    ensureBatchSelectionBinding(BATCH_SCOPE_GENERAL);
    ensureBatchSelectionBinding(BATCH_SCOPE_PROJECT);
  }

  function getBatchSelectionSnapshot(scope) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return [];
    }
    return Array.from(state.selectedConversations.values())
      .sort((a, b) => a.selectionOrder - b.selectionOrder)
      .map((item) => ({
        conversationId: item.conversationId,
        title: item.title,
        hrefPath: item.hrefPath
      }));
  }

  function freezeBatchTargets(snapshot) {
    return Object.freeze(
      snapshot.map((item) =>
        Object.freeze({
          conversationId: item.conversationId,
          title: item.title,
          hrefPath: item.hrefPath
        })
      )
    );
  }

  function clampBatchProgress(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  function updateBatchItemRuntime(scope, conversationId, patch, { renderControls = false } = {}) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    const current = state.itemRuntime.get(conversationId) || {
      status: BATCH_ITEM_PENDING,
      stage: 'pending',
      progress: 0,
      progressMode: 'indeterminate',
      error: null
    };
    const next = { ...current, ...patch };
    next.progress = clampBatchProgress(next.progress);
    state.itemRuntime.set(conversationId, next);
    syncSingleBatchConversationRow(scope, conversationId);
    if (renderControls) {
      renderBatchControls();
    }
  }

  function createBatchTransferProgressHandler(scope, conversationId, start, end, stage) {
    const span = Math.max(0, end - start);
    return ({ loaded, total, lengthComputable }) => {
      const state = getBatchSelectionState(scope);
      const current = state?.itemRuntime.get(conversationId);
      if (
        !state ||
        !hasActiveBatchSession(state) ||
        !current ||
        current.status !== BATCH_ITEM_EXPORTING
      ) {
        return;
      }
      if (lengthComputable && total > 0) {
        const ratio = Math.min(1, Math.max(0, loaded / total));
        updateBatchItemRuntime(scope, conversationId, {
          stage,
          progress: start + span * ratio,
          progressMode: 'determinate'
        });
      } else {
        updateBatchItemRuntime(scope, conversationId, {
          stage,
          progress: Math.max(current.progress || 0, start),
          progressMode: 'indeterminate'
        });
      }
    };
  }

  function applyBatchExportStage(scope, conversationId, stage) {
    const stages = {
      'conversation-start': BATCH_PROGRESS_CONVERSATION_START,
      'conversation-ready': BATCH_PROGRESS_CONVERSATION_END,
      'textdocs-start': BATCH_PROGRESS_TEXTDOCS_START,
      'textdocs-ready': BATCH_PROGRESS_TEXTDOCS_END,
      'raw-build': BATCH_PROGRESS_HANDOFF_BUILD,
      'raw-ready': BATCH_PROGRESS_HANDOFF_READY,
      'handoff-build': BATCH_PROGRESS_HANDOFF_BUILD,
      'handoff-ready': BATCH_PROGRESS_HANDOFF_READY
    };
    const progress = stages[stage];
    if (!Number.isFinite(progress)) {
      return;
    }
    updateBatchItemRuntime(scope, conversationId, {
      stage,
      progress,
      progressMode: 'indeterminate'
    });
  }

  function summarizeBatchError(error) {
    const message = toErrorMessage(error).replace(/\s+/g, ' ').trim();
    return message.length <= 700 ? message : `${message.slice(0, 697)}…`;
  }

  function isSystemicBatchFailure(error) {
    const message = toErrorMessage(error);
    return (
      /\bHTTP\s+(401|403)\b/i.test(message) ||
      /無法取得[^。]*request context/i.test(message) ||
      /缺少[^。]*request context/i.test(message) ||
      /目前無法取得此對話的[^。]*請求資訊/i.test(message)
    );
  }

  function releaseBatchConversationLargeData(conversationId) {
    capturedRawByConversationId.delete(conversationId);
  }

  function buildBatchZipFilename(scope, exportKind, timestamp) {
    const scopeLabel = scope === BATCH_SCOPE_PROJECT ? '專案聊天' : '一般聊天';
    const kindLabel = exportKind === BATCH_EXPORT_RAW ? '原始JSON' : '交接JSON';
    return `ChatGPT-${scopeLabel}-批次${kindLabel}-${timestamp}.zip`;
  }

  function buildBatchManifest({ scope, exportKind, startedAt, finishedAt, zipFilename, results }) {
    const success = results.filter((x) => x.status === BATCH_ITEM_SUCCESS).length;
    const failed = results.filter((x) => x.status === BATCH_ITEM_FAILED).length;
    const skipped = results.filter((x) => x.status === BATCH_ITEM_SKIPPED).length;
    return JSON.stringify({
      schema_version: 1,
      export_type: exportKind,
      scope,
      generated_at: new Date(finishedAt).toISOString(),
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      zip: {
        filename: zipFilename,
        format: 'zip',
        compression: 'store',
        compression_method: 0
      },
      total: results.length,
      success,
      failed,
      skipped,
      items: results.map((item) => ({
        conversation_id: item.conversationId,
        title: item.title,
        href_path: item.hrefPath,
        status: item.status,
        files: (item.files || []).map((file) => ({
          kind: file.kind,
          filename: file.filename,
          bytes: file.bytes
        })),
        textdoc_count: Number.isInteger(item.textdocCount) ? item.textdocCount : null,
        error: item.error || null
      }))
    }, null, 4);
  }

  function createStoredPayloadFile(kind, payload) {
    return {
      kind,
      filename: payload.filename,
      text: payload.text,
      bytes: getUtf8ByteLength(payload.text)
    };
  }

  function clearCommittedDraftTargets(state, targets) {
    for (const target of targets) {
      state.selectedConversations.delete(target.conversationId);
      state.manuallyExcludedIds.delete(target.conversationId);
    }
    state.rangeAnchorConversationId = null;
  }

  function commitTargetsToBatchSession(scope, exportKind, targets) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      targets.length === 0 ||
      ![BATCH_EXPORT_RAW, BATCH_EXPORT_HANDOFF].includes(exportKind)
    ) {
      return false;
    }

    if (!hasActiveBatchSession(state)) {
      state.exportKind = exportKind;
      state.sessionStartedAt = Date.now();
      state.sessionUpdatedAt = state.sessionStartedAt;
      state.sessionBlockedReason = '';
      state.zipFilename = buildBatchZipFilename(
        scope,
        exportKind,
        getTimestampString(new Date(state.sessionStartedAt))
      );
    } else if (state.exportKind !== exportKind) {
      return false;
    }

    const added = [];
    for (const target of targets) {
      if (state.sessionConversationIds.has(target.conversationId)) {
        continue;
      }
      state.sessionConversationIds.add(target.conversationId);
      state.sessionTargets.push(target);
      state.pendingQueue.push(target);
      state.itemRuntime.set(target.conversationId, {
        status: BATCH_ITEM_PENDING,
        stage: 'pending',
        progress: 0,
        progressMode: 'indeterminate',
        error: null
      });
      added.push(target);
    }

    if (added.length === 0) {
      return false;
    }

    clearCommittedDraftTargets(state, added);
    state.phase = BATCH_PHASE_SESSION;
    state.sessionUpdatedAt = Date.now();

    const context = getBatchUiContext(scope);
    if (context?.listRoot) {
      bindBatchSelectionList(context);
    }
    syncBatchConversationRows(scope);
    renderBatchControls();
    ensureBatchSessionWorker(scope);
    return true;
  }

  function storeSuccessfulBatchPayload(state, target, buildResult) {
    const files = [];
    if (state.exportKind === BATCH_EXPORT_RAW) {
      files.push(createStoredPayloadFile('conversation', buildResult.rawPayload));
      if (buildResult.textdocsPayload) {
        files.push(createStoredPayloadFile('textdocs', buildResult.textdocsPayload));
      }
    } else {
      files.push(createStoredPayloadFile('handoff', buildResult.handoffPayload));
    }

    state.completedPayloads.set(target.conversationId, { files });
    state.sessionResults.set(target.conversationId, {
      conversationId: target.conversationId,
      title: target.title,
      hrefPath: target.hrefPath,
      status: BATCH_ITEM_SUCCESS,
      files: files.map((file) => ({
        kind: file.kind,
        filename: file.filename,
        bytes: file.bytes
      })),
      textdocCount: buildResult.textdocCount,
      transport: buildResult.transport || null,
      error: null
    });
  }

  function markRemainingQueueSkipped(state, reason) {
    for (const target of state.pendingQueue.splice(0)) {
      updateBatchItemRuntime(state.scope, target.conversationId, {
        status: BATCH_ITEM_SKIPPED,
        stage: 'skipped',
        progress: 0,
        progressMode: 'indeterminate',
        error: reason
      });
      state.sessionResults.set(target.conversationId, {
        conversationId: target.conversationId,
        title: target.title,
        hrefPath: target.hrefPath,
        status: BATCH_ITEM_SKIPPED,
        files: [],
        textdocCount: null,
        transport: null,
        error: reason
      });
    }
  }

  function getNextBatchRequestScope() {
    const scopes = [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT];
    const startIndex = batchRequestSchedulerLastScope === BATCH_SCOPE_GENERAL
      ? 1
      : 0;

    for (let offset = 0; offset < scopes.length; offset += 1) {
      const scope = scopes[(startIndex + offset) % scopes.length];
      const state = getBatchSelectionState(scope);
      if (
        state &&
        hasActiveBatchSession(state) &&
        state.phase !== BATCH_PHASE_PACKAGING &&
        !state.workerRunning &&
        !state.sessionBlockedReason &&
        state.pendingQueue.length > 0
      ) {
        return scope;
      }
    }
    return null;
  }

  function hasPendingBatchRequestWork() {
    return [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT].some((scope) => {
      const state = getBatchSelectionState(scope);
      return Boolean(
        state &&
        hasActiveBatchSession(state) &&
        state.phase !== BATCH_PHASE_PACKAGING &&
        !state.sessionBlockedReason &&
        state.pendingQueue.length > 0
      );
    });
  }

  async function processSingleBatchSessionTarget(scope) {
    const state = getBatchSelectionState(scope);
    if (
      !state ||
      !hasActiveBatchSession(state) ||
      state.workerRunning ||
      state.pendingQueue.length === 0 ||
      state.sessionBlockedReason
    ) {
      return;
    }

    const target = state.pendingQueue.shift();
    if (!target) return;

    state.workerRunning = true;
    state.currentConversationId = target.conversationId;
    state.phase = BATCH_PHASE_SESSION;
    updateBatchItemRuntime(scope, target.conversationId, {
      status: BATCH_ITEM_EXPORTING,
      stage: 'prepare',
      progress: 0.01,
      progressMode: 'indeterminate',
      error: null
    }, { renderControls: true });

    try {
      const options = {
        onStage(stage) {
          applyBatchExportStage(scope, target.conversationId, stage);
        },
        onConversationProgress: createBatchTransferProgressHandler(
          scope,
          target.conversationId,
          BATCH_PROGRESS_CONVERSATION_START,
          BATCH_PROGRESS_CONVERSATION_END,
          'conversation-transfer'
        ),
        onTextdocsProgress: createBatchTransferProgressHandler(
          scope,
          target.conversationId,
          BATCH_PROGRESS_TEXTDOCS_START,
          BATCH_PROGRESS_TEXTDOCS_END,
          'textdocs-transfer'
        )
      };

      const buildResult = state.exportKind === BATCH_EXPORT_RAW
        ? await createRawPayloadForConversationId(target.conversationId, options)
        : await createHandoffPayloadForConversationId(
          target.conversationId,
          { enforceCurrentPage: false, ...options }
        );

      if (!state.removedWhileProcessingIds.has(target.conversationId)) {
        storeSuccessfulBatchPayload(state, target, buildResult);
        updateBatchItemRuntime(scope, target.conversationId, {
          status: BATCH_ITEM_SUCCESS,
          stage: 'complete',
          progress: 1,
          progressMode: 'determinate',
          error: null
        });
      }
    } catch (error) {
      const errorMessage = summarizeBatchError(error);
      const removed = state.removedWhileProcessingIds.has(target.conversationId);

      if (!removed) {
        updateBatchItemRuntime(scope, target.conversationId, {
          status: BATCH_ITEM_FAILED,
          stage: 'failed',
          progress: state.itemRuntime.get(target.conversationId)?.progress || 0,
          progressMode: 'indeterminate',
          error: errorMessage
        });
        state.sessionResults.set(target.conversationId, {
          conversationId: target.conversationId,
          title: target.title,
          hrefPath: target.hrefPath,
          status: BATCH_ITEM_FAILED,
          files: [],
          textdocCount: null,
          transport: null,
          error: errorMessage
        });
      }

      if (isSystemicBatchFailure(error)) {
        state.sessionBlockedReason = errorMessage;
        resetBatchDraftSelection(state);
        markRemainingQueueSkipped(
          state,
          '因此批次的 request context / 驗證狀態失效而未處理。'
        );
      }
    } finally {
      releaseBatchConversationLargeData(target.conversationId);

      if (state.removedWhileProcessingIds.delete(target.conversationId)) {
        state.itemRuntime.delete(target.conversationId);
        state.completedPayloads.delete(target.conversationId);
        state.sessionResults.delete(target.conversationId);
      }

      state.workerRunning = false;
      state.currentConversationId = null;
      state.sessionUpdatedAt = Date.now();
      syncSingleBatchConversationRow(scope, target.conversationId);
      renderBatchControls();
    }
  }

  async function runBatchRequestScheduler() {
    if (batchRequestSchedulerRunning) return;
    batchRequestSchedulerRunning = true;
    try {
      while (true) {
        const scope = getNextBatchRequestScope();
        if (!scope) break;
        batchRequestSchedulerLastScope = scope;
        await processSingleBatchSessionTarget(scope);
      }
    } finally {
      batchRequestSchedulerRunning = false;
      renderBatchControls();
      if (hasPendingBatchRequestWork()) {
        window.queueMicrotask(() => ensureBatchSessionWorker());
      }
    }
  }

  function ensureBatchSessionWorker() {
    if (batchRequestSchedulerRunning || !hasPendingBatchRequestWork()) {
      return;
    }
    void runBatchRequestScheduler();
  }

  function buildBatchCompletionSummary(state, results, zipFilename, zipBytes) {
    const success = results.filter((x) => x.status === BATCH_ITEM_SUCCESS).length;
    const failed = results.filter((x) => x.status === BATCH_ITEM_FAILED).length;
    const skipped = results.filter((x) => x.status === BATCH_ITEM_SKIPPED).length;
    return [
      '批次打包完成。',
      '',
      `類型：${getBatchExportKindLabel(state.exportKind)}`,
      `成功：${success}`,
      `失敗：${failed}`,
      `未處理：${skipped}`,
      '',
      `ZIP：${zipFilename}`,
      `ZIP 大小：${zipBytes.toLocaleString()} bytes`,
      '壓縮方式：STORE（不壓縮）'
    ].join('\n');
  }

  function cleanupPackagedBatchSession(scope, lastBatchResults) {
    const state = getBatchSelectionState(scope);
    if (!state) {
      return;
    }
    detachBatchSelectionListBinding(scope);
    clearBatchConversationRowDecorations(scope);
    removeBatchConfirmationDialog();
    removeCancelBatchJobDialog();
    resetBatchDraftSelection(state);
    resetBatchSessionState(state, { preserveLastResults: true });
    state.lastBatchResults = lastBatchResults;
    state.phase = BATCH_PHASE_IDLE;
    state.routePathname = null;

    renderBatchControls();
  }

  async function packageBatchSession(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !canPackageBatchSession(state)) {
      return;
    }

    state.phase = BATCH_PHASE_PACKAGING;
    renderBatchControls();

    try {
      const zipBuilder = createStoredZipBuilder();

      for (const target of state.sessionTargets) {
        const result = state.sessionResults.get(target.conversationId);
        if (!result || result.status !== BATCH_ITEM_SUCCESS) {
          continue;
        }

        const payload = state.completedPayloads.get(target.conversationId);
        if (!payload) {
          throw new Error(
            `打包失敗：缺少已完成對話 ${target.conversationId} 的記憶體 payload。`
          );
        }

        const checkpoint = zipBuilder.createCheckpoint();
        try {
          const actualFiles = [];
          for (const file of payload.files) {
            const zipFile = zipBuilder.addTextFile(file.filename, file.text);
            actualFiles.push({
              kind: file.kind,
              filename: zipFile.filename,
              bytes: zipFile.bytes
            });
          }
          result.files = actualFiles;
        } catch (error) {
          zipBuilder.rollback(checkpoint);
          throw error;
        }
      }

      const finishedAt = Date.now();
      const results = getBatchSessionResultArray(state);
      const manifestText = buildBatchManifest({
        scope,
        exportKind: state.exportKind,
        startedAt: state.sessionStartedAt,
        finishedAt,
        zipFilename: state.zipFilename,
        results
      });
      zipBuilder.addTextFile('batch-manifest.json', manifestText, new Date(finishedAt));

      const zipBlob = zipBuilder.finalize();
      const zipBytes = zipBlob.size;
      downloadBlobFile(zipBlob, state.zipFilename);

      const lastBatchResults = Object.freeze({
        scope,
        exportKind: state.exportKind,
        zipFilename: state.zipFilename,
        zipBytes,
        startedAt: state.sessionStartedAt,
        finishedAt,
        total: state.sessionTargets.length,
        results: Object.freeze(
          results.map((item) =>
            Object.freeze({
              ...item,
              files: Object.freeze(
                (item.files || []).map((file) => Object.freeze({ ...file }))
              )
            })
          )
        )
      });

      const summary = buildBatchCompletionSummary(
        state,
        results,
        state.zipFilename,
        zipBytes
      );

      await new Promise((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      });
      alert(summary);
      cleanupPackagedBatchSession(scope, lastBatchResults);
    } catch (error) {
      state.phase = BATCH_PHASE_SESSION;
      renderBatchControls();
      alert(
        '批次打包失敗。\n\n' +
        `${summarizeBatchError(error)}\n\n` +
        '目前 session 與已取得資料仍保留在頁面記憶體中；' +
        '你可以再次嘗試打包，或使用「取消批次下載作業」重新整理頁面。'
      );
    }
  }

  function createBatchDialogShell({ id, titleText, testId }) {
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.setAttribute('data-ignore-for-page-load', 'true');
    if (testId) {
      overlay.setAttribute('data-testid', testId);
    }
    overlay.className = 'absolute inset-0';
    overlay.setAttribute(
      'data-cgpt-batch-dialog-shell',
      'true'
    );
    setBatchMotionStateImmediately(
      overlay,
      false
    );

    const backdrop = document.createElement('div');
    backdrop.setAttribute('data-state', 'open');
    backdrop.setAttribute(
      'data-cgpt-batch-dialog-backdrop',
      'true'
    );
    backdrop.className =
      'fixed inset-0 z-50 before:absolute before:inset-0 before:bg-gray-200/50 before:backdrop-blur-[1px] dark:before:bg-black/50';

    const grid = document.createElement('div');
    grid.className =
      'z-50 h-full w-full overflow-y-auto keyboard-open:h-[calc(100%-var(--screen-keyboard-height,0px))] grid grid-cols-[10px_1fr_10px] grid-rows-[minmax(10px,1fr)_auto_minmax(10px,1fr)] md:grid-rows-[minmax(20px,0.8fr)_auto_minmax(20px,1fr)]';

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-state', 'open');
    dialog.setAttribute(
      'data-cgpt-batch-dialog-surface',
      'true'
    );
    dialog.className =
      'popover bg-token-bg-primary relative col-auto col-start-2 row-auto row-start-2 h-full text-start start-1/2 ltr:-translate-x-1/2 rtl:translate-x-1/2 rounded-2xl shadow-long flex flex-col focus:outline-hidden overflow-hidden';
    dialog.style.width = 'max(40vw, 36rem)';
    dialog.style.maxWidth = 'calc(100vw - 2rem)';
    dialog.tabIndex = -1;

    const titleId = `${id}-title`;
    dialog.setAttribute('aria-labelledby', titleId);

    const header = document.createElement('header');
    header.className = 'min-h-header-height flex justify-between p-2.5 ps-4 select-none';
    header.innerHTML = `
      <div class="flex max-w-full items-center">
        <div class="flex max-w-full min-w-0 grow flex-col">
          <h2 id="${titleId}" class="text-token-text-primary text-lg font-normal"></h2>
        </div>
      </div>
      <div class="flex h-[max-content] items-center gap-2"></div>
    `;
    header.querySelector('h2').textContent = titleText;

    const body = document.createElement('div');
    body.className = 'grow overflow-y-auto p-4 pt-1';

    dialog.append(header, body);
    grid.append(dialog);
    backdrop.append(grid);
    overlay.append(backdrop);
    document.body.append(overlay);

    const shell = {
      overlay,
      backdrop,
      dialog,
      body,
      closing: false
    };

    transitionBatchMotionState(
      overlay,
      true,
      {
        transitionElement: dialog,
        transitionProperty: 'opacity',
        onSettled: () => {
          if (dialog.isConnected) {
            dialog.focus();
          }
        }
      }
    );

    return shell;
  }

  function closeBatchDialogShell(
    shell,
    onClosed = null
  ) {
    if (
      !shell?.overlay ||
      shell.closing
    ) {
      return;
    }

    shell.closing = true;
    transitionBatchMotionState(
      shell.overlay,
      false,
      {
        transitionElement: shell.dialog,
        transitionProperty: 'opacity',
        onSettled: () => {
          clearBatchMotionLifecycle(
            shell.overlay
          );
          shell.overlay.remove();
          if (typeof onClosed === 'function') {
            onClosed();
          }
        }
      }
    );
  }

  function createBatchDialogButton(
    label,
    { primary = false, white = false, danger = false, iconSvg = '' } = {}
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = [
      'btn',
      'relative',
      'group-focus-within/dialog:focus-visible:[outline-width:1.5px]',
      'group-focus-within/dialog:focus-visible:[outline-offset:2.5px]',
      'group-focus-within/dialog:focus-visible:[outline-style:solid]',
      'group-focus-within/dialog:focus-visible:[outline-color:var(--text-primary)]',
      primary ? 'btn-primary' : 'btn-secondary'
    ].join(' ');
    if (white) {
      button.setAttribute('data-cgpt-batch-dialog-download', 'true');
    }
    if (danger) {
      button.setAttribute('data-cgpt-batch-dialog-danger', 'true');
    }
    button.innerHTML =
      `<div class="flex items-center justify-center gap-2">${iconSvg}<span>${label}</span></div>`;
    return button;
  }

  function showBatchConfirmationDialog(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !isBatchSelectionEditableState(state)) {
      return;
    }
    const snapshot = getBatchSelectionSnapshot(scope);
    if (snapshot.length === 0) {
      alert('尚未選取任何對話。');
      return;
    }

    const sessionActive = hasActiveBatchSession(state);
    state.phase = BATCH_PHASE_CONFIRMING;
    renderBatchControls();
    removeBatchConfirmationDialog();

    const shell = createBatchDialogShell({
      id: BATCH_DIALOG_ID,
      titleText: sessionActive ? '確認追加批次匯出' : '確認批次匯出',
      testId: 'modal-cgpt-batch-export-confirmation'
    });
    shell.overlay.setAttribute('data-cgpt-batch-export-dialog', 'true');

    const intro = document.createElement('p');
    intro.className = 'text-token-text-primary';
    intro.textContent = sessionActive
      ? `準備追加 ${snapshot.length} 個對話：`
      : `已選取 ${snapshot.length} 個對話：`;

    const list = document.createElement('ol');
    list.setAttribute('data-cgpt-batch-dialog-list', 'true');
    list.className = 'mt-3 list-decimal space-y-2 ps-6 text-sm';
    for (const item of snapshot) {
      const listItem = document.createElement('li');
      listItem.className = 'text-token-text-primary';
      const link = document.createElement('a');
      link.href = new URL(item.hrefPath, location.origin).href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className =
        'text-token-text-primary underline decoration-token-text-tertiary underline-offset-2 hover:text-token-text-secondary';
      link.textContent = item.title || item.conversationId;
      link.setAttribute(
        'aria-label',
        `在新分頁開啟對話：${item.title || item.conversationId}`
      );
      listItem.append(link);
      list.append(listItem);
    }

    const actions = document.createElement('div');
    actions.className =
      'mt-5 flex w-full items-center justify-between gap-4 text-sm select-none sm:mt-4';
    const cancelButton = createBatchDialogButton('取消');
    const rightActions = document.createElement('div');
    rightActions.className = 'flex items-center justify-end gap-3';

    const resumePhase = sessionActive ? BATCH_PHASE_SESSION : BATCH_PHASE_SELECTING;
    const closeDialog = ({ resumeSelection = true } = {}) => {
      closeBatchDialogShell(
        shell,
        () => {
          if (
            resumeSelection &&
            state.phase === BATCH_PHASE_CONFIRMING
          ) {
            state.phase = resumePhase;
            renderBatchControls();
          }
        }
      );
    };
    cancelButton.addEventListener('click', () => closeDialog());

    const targets = freezeBatchTargets(snapshot);
    if (!sessionActive) {
      const rawButton = createBatchDialogButton(
        '批次下載原始 JSON',
        { white: true, iconSvg: RAW_JSON_ICON_SVG }
      );
      const handoffButton = createBatchDialogButton(
        '批次下載交接 JSON',
        { white: true, iconSvg: HANDOFF_ICON_SVG }
      );
      const start = (kind) => {
        const added = commitTargetsToBatchSession(scope, kind, targets);
        if (!added) {
          closeDialog();
          return;
        }
        closeDialog({ resumeSelection: false });
      };
      rawButton.addEventListener('click', () => start(BATCH_EXPORT_RAW));
      handoffButton.addEventListener('click', () => start(BATCH_EXPORT_HANDOFF));
      rightActions.append(rawButton, handoffButton);
    } else {
      const kind = state.exportKind;
      const addButton = createBatchDialogButton(
        `加入批次${getBatchExportKindLabel(kind)}`,
        {
          white: true,
          iconSvg: kind === BATCH_EXPORT_RAW ? RAW_JSON_ICON_SVG : HANDOFF_ICON_SVG
        }
      );
      addButton.addEventListener('click', () => {
        const added = commitTargetsToBatchSession(scope, kind, targets);
        if (!added) {
          closeDialog();
          return;
        }
        closeDialog({ resumeSelection: false });
      });
      rightActions.append(addButton);
    }

    shell.backdrop.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Node) || shell.dialog.contains(event.target)) {
        return;
      }
      closeDialog();
    });
    shell.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
      }
    });

    actions.append(cancelButton, rightActions);
    shell.body.append(intro, list, actions);
  }

  function showCancelBatchJobDialog(scope) {
    const state = getBatchSelectionState(scope);
    if (!state || !hasActiveBatchSession(state)) {
      return;
    }
    removeCancelBatchJobDialog();

    const shell = createBatchDialogShell({
      id: BATCH_CANCEL_JOB_DIALOG_ID,
      titleText: '取消批次下載作業',
      testId: 'modal-cgpt-batch-cancel-job-confirmation'
    });

    const message = document.createElement('p');
    message.className = 'text-token-text-primary';
    message.textContent =
      '確認取消後會直接重新整理目前網頁。尚未打包的批次資料、佇列與目前頁面中的批次作業狀態都會被清除。';

    const actions = document.createElement('div');
    actions.className =
      'mt-5 flex w-full items-center justify-between gap-4 text-sm select-none sm:mt-4';
    const backButton = createBatchDialogButton('返回');
    const confirmButton = createBatchDialogButton(
      '確認取消並重新整理',
      { danger: true, iconSvg: BATCH_STOP_ICON_SVG }
    );

    const closeDialog = () => {
      closeBatchDialogShell(shell);
    };
    backButton.addEventListener('click', closeDialog);
    confirmButton.addEventListener('click', () => {
      allowBatchUnloadOnce = true;
      try {
        window.location.reload();
      } catch (error) {
        allowBatchUnloadOnce = false;
        syncBatchBeforeUnloadGuard();
        throw error;
      }
    });

    shell.backdrop.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof Node) || shell.dialog.contains(event.target)) {
        return;
      }
      closeDialog();
    });
    shell.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDialog();
      }
    });

    actions.append(backButton, confirmButton);
    shell.body.append(message, actions);
  }
  function disconnectBatchProjectTabObserver() {
    if (batchProjectTabObserver) {
      batchProjectTabObserver.disconnect();
    }
    batchProjectTabObserver = null;
    batchProjectObservedTablist = null;
  }
  function ensureBatchProjectTabObserver() {
    const context = findProjectBatchUiContext();
    if (!context?.tablist) {
      disconnectBatchProjectTabObserver();
      return;
    }
    if (batchProjectObservedTablist === context.tablist && batchProjectTabObserver) {
      return;
    }
    disconnectBatchProjectTabObserver();
    batchProjectObservedTablist = context.tablist;
    batchProjectTabObserver = new MutationObserver(() => {
      /*
       * 只監看專案 tab 的 active state。
       * 尚未建立 session 時切到「資料來源」會退出批次選取模式；
       * session 建立後不因 tab 切換而取消，回到「聊天」時可繼續追加或打包。
       */
      ensureAllBatchSelectionBindings();
      renderBatchControls();
    });
    batchProjectTabObserver.observe(context.tablist, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'aria-selected']
    });
  }
  /*
   * 低頻 UI 維護：確保一般側邊欄與專案頁的批次入口存在，
   * 並在 selection / session 狀態中重新綁定被 React 重建的列表。
   */
  function ensureBatchUi() {
    ensureBatchSelectionStyles();
    ensureBatchProjectTabObserver();
    ensureAllBatchSelectionBindings();
    renderBatchControls();
  }

  /*
   * 偵測 SPA path 是否改變。
   */
  function handleRouteMaybeChanged() {
    if (location.pathname === lastPathname) {
      return;
    }
    for (const scope of [BATCH_SCOPE_GENERAL, BATCH_SCOPE_PROJECT]) {
      const state = getBatchSelectionState(scope);
      if (
        state &&
        !hasActiveBatchSession(state) &&
        (
          state.phase === BATCH_PHASE_SELECTING ||
          state.phase === BATCH_PHASE_CONFIRMING
        )
      ) {
        cancelBatchSelectionMode(scope, { silent: true });
      }
      /*
       * 已建立的 session 不因 SPA route change 軟取消。
       * 若要中止，使用「取消批次下載作業」並在確認後重新整理頁面。
       */
    }
    lastPathname = location.pathname;
    activeExportState = null;
    setAllButtonsBusy(false);
    updateButtonState();
    ensureButtonsSoon();
    ensureBatchUi();
  }
  /*
   * 包裝 history.pushState / replaceState。
   *
   * ChatGPT 是 SPA，切換對話時不一定重新載入整頁。
   * 因此需要監聽路由變化，才能在新對話頁補上按鈕。
   */
  function installHistoryListener() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function () {
      const result = originalPushState.apply(this, arguments);
      handleRouteMaybeChanged();
      return result;
    };
    history.replaceState = function () {
      const result = originalReplaceState.apply(this, arguments);
      handleRouteMaybeChanged();
      return result;
    };
    window.addEventListener('popstate', () => {
      handleRouteMaybeChanged();
    });
  }
  /*
   * 低頻輪詢。
   *
   * 用途：
   *   - 補救某些 React 重繪導致按鈕消失的情況。
   *   - 確認非對話頁時移除按鈕。
   *
   * 頻率：
   *   每秒一次，且主要只做輕量檢查。
   */
  function startLightPolling() {
    window.setInterval(() => {
      handleRouteMaybeChanged();
      if (isConversationPage()) {
        insertButtonsOnce();
      } else {
        removeButtonsIfNeeded();
      }
      ensureBatchUi();
    }, 1000);
  }
  /*
   * 監聽 document.title 變化。
   *
   * 使用者修改對話標題後，ChatGPT 可能會更新 document.title。
   * 此時重新整理 tooltip，使按鈕 title 顯示較新的對話標題。
   */
  function installTitleObserver() {
    const titleElement = document.querySelector('title');
    if (!titleElement) {
      return;
    }
    const observer = new MutationObserver(() => {
      ensureButtonsSoon();
    });
    observer.observe(titleElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }
  /*
   * 啟動 UI 相關邏輯。
   */
  // ============================================================
  // UAIOS_08A - UI continuity watchdog (local-only, opt-in)
  // ============================================================
  const UAIOS_WATCHDOG_ENABLED_KEY = 'uaios.continuity.watchdog.enabled.v1';
  const UAIOS_WATCHDOG_EVENTS_KEY = 'uaios.continuity.watchdog.events.v1';
  const UAIOS_WATCHDOG_MAX_ACTIONS = 3;
  const UAIOS_WATCHDOG_WINDOW_MS = 15 * 60 * 1000;
  const UAIOS_WATCHDOG_COOLDOWN_MS = 15 * 1000;
  const UAIOS_WATCHDOG_SCAN_MS = 2500;
  const UAIOS_RATE_LIMIT_UNTIL_KEY = 'uaios.continuity.rateLimitUntil.v1';
  const UAIOS_RATE_LIMIT_BASE_BACKOFF_MS = 3 * 60 * 1000;
  const UAIOS_RATE_LIMIT_MAX_BACKOFF_MS = 10 * 60 * 1000;
  const UAIOS_RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000;
  const UAIOS_WATCHDOG_RETRY_LABELS = [
    'retry', 'try again',
    '\u0e17\u0e33\u0e0b\u0e49\u0e33',
    '\u0e25\u0e2d\u0e07\u0e2d\u0e35\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07',
    '\u0e25\u0e2d\u0e07\u0e43\u0e2b\u0e21\u0e48',
    '\u0e42\u0e1b\u0e23\u0e14\u0e25\u0e2d\u0e07\u0e2d\u0e35\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07'
  ];
  const UAIOS_WATCHDOG_CONTINUE_LABELS = [
    'continue generating', 'keep generating',
    '\u0e14\u0e33\u0e40\u0e19\u0e34\u0e19\u0e01\u0e32\u0e23\u0e15\u0e48\u0e2d'
  ];
  const UAIOS_WATCHDOG_ERROR_MARKERS = [
    'timed out', 'timeout', 'something went wrong', 'network error',
    'error generating', 'there was an error',
    '\u0e2b\u0e21\u0e14\u0e40\u0e27\u0e25\u0e32',
    '\u0e2b\u0e21\u0e14\u0e40\u0e27\u0e25\u0e32\u0e08\u0e31\u0e14\u0e2a\u0e48\u0e07\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21',
    '\u0e40\u0e01\u0e34\u0e14\u0e02\u0e49\u0e2d\u0e1c\u0e34\u0e14\u0e1e\u0e25\u0e32\u0e14'
  ];
  const UAIOS_RATE_LIMIT_MARKERS = [
    'too many requests',
    'requests too quickly',
    'temporarily limited access to your conversation',
    'please wait a few minutes before trying again',
    '\u0e21\u0e35\u0e04\u0e33\u0e02\u0e2d\u0e08\u0e33\u0e19\u0e27\u0e19\u0e21\u0e32\u0e01\u0e40\u0e01\u0e34\u0e19\u0e44\u0e1b',
    '\u0e04\u0e38\u0e13\u0e01\u0e33\u0e25\u0e31\u0e07\u0e2a\u0e23\u0e49\u0e32\u0e07\u0e04\u0e33\u0e02\u0e2d\u0e40\u0e23\u0e47\u0e27\u0e40\u0e01\u0e34\u0e19\u0e44\u0e1b',
    '\u0e42\u0e1b\u0e23\u0e14\u0e23\u0e2d\u0e2a\u0e2d\u0e07\u0e2a\u0e32\u0e21\u0e19\u0e32\u0e17\u0e35\u0e01\u0e48\u0e2d\u0e19\u0e08\u0e30\u0e25\u0e2d\u0e07\u0e2d\u0e35\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07'
  ];
  const UAIOS_RATE_LIMIT_DISMISS_LABELS = [
    'got it', 'understood',
    '\u0e40\u0e02\u0e49\u0e32\u0e43\u0e08\u0e41\u0e25\u0e49\u0e27'
  ];
  const UAIOS_RATE_LIMIT_BLOCKED_MARKERS = [
    'delete', 'purchase', 'payment', 'permission', 'approve', 'allow access',
    '\u0e25\u0e1a', '\u0e0a\u0e33\u0e23\u0e30', '\u0e2d\u0e19\u0e38\u0e0d\u0e32\u0e15', '\u0e2d\u0e19\u0e38\u0e21\u0e31\u0e15\u0e34'
  ];
  let uaiosWatchdogObserver = null;
  let uaiosWatchdogTimer = null;
  let uaiosWatchdogPending = false;
  let uaiosWatchdogLastActionAt = 0;
  function uaiosWatchdogIsEnabled() {
    try {
      return localStorage.getItem(UAIOS_WATCHDOG_ENABLED_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  function uaiosWatchdogSetEnabled(enabled) {
    localStorage.setItem(UAIOS_WATCHDOG_ENABLED_KEY, enabled ? 'true' : 'false');
    uaiosWatchdogRecordEvent(enabled ? 'enabled' : 'disabled');
    if (enabled) {
      uaiosWatchdogScanNow();
    }
    return uaiosWatchdogStatus();
  }

  function uaiosWatchdogNormalizeText(element) {
    if (!element) return '';
    const text = [
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('title') || '',
      element.innerText || '',
      element.textContent || ''
    ].join(' ');
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function uaiosWatchdogMatchesAny(text, patterns) {
    return patterns.some((pattern) => text.includes(pattern));
  }
  function uaiosWatchdogIsClickable(element) {
    if (!element || !element.isConnected) return false;
    if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle?.(element);
    return !style || (style.visibility !== 'hidden' && style.display !== 'none');
  }

  function uaiosWatchdogNearbyText(element) {
    let node = element;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const text = (node.innerText || node.textContent || '').toLowerCase();
      if (text.length >= 30) {
        return text.slice(-6000);
      }
    }
    return '';
  }

  function uaiosWatchdogScopeKey() {
    return getConversationIdFromUrl() || location.pathname || 'unknown';
  }

  function uaiosWatchdogReadEvents() {
    try {
      const parsed = JSON.parse(localStorage.getItem(UAIOS_WATCHDOG_EVENTS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  function uaiosWatchdogRecordEvent(type, details = {}) {
    const events = uaiosWatchdogReadEvents();
    events.push({
      at: new Date().toISOString(),
      type,
      scope: uaiosWatchdogScopeKey(),
      ...details
    });
    try {
      localStorage.setItem(UAIOS_WATCHDOG_EVENTS_KEY, JSON.stringify(events.slice(-50)));
    } catch (_) {
      // Logging must never interfere with ChatGPT.
    }
  }

  function uaiosRateLimitCooldownUntil() {
    try {
      const value = Number(localStorage.getItem(UAIOS_RATE_LIMIT_UNTIL_KEY) || 0);
      return Number.isFinite(value) ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function uaiosRateLimitRemainingMs() {
    return Math.max(0, uaiosRateLimitCooldownUntil() - Date.now());
  }

  function uaiosRateLimitIsCooling() {
    return uaiosRateLimitRemainingMs() > 0;
  }

  function uaiosRateLimitBackoffMs() {
    const cutoff = Date.now() - UAIOS_RATE_LIMIT_WINDOW_MS;
    const recentDetections = uaiosWatchdogReadEvents().filter((event) => {
      const eventTime = Date.parse(event.at || '');
      return event.type === 'rate_limit_detected' &&
        Number.isFinite(eventTime) && eventTime >= cutoff;
    }).length;
    const multiplier = 2 ** Math.min(recentDetections, 2);
    return Math.min(UAIOS_RATE_LIMIT_BASE_BACKOFF_MS * multiplier, UAIOS_RATE_LIMIT_MAX_BACKOFF_MS);
  }

  function uaiosRateLimitStartCooling(reason = '') {
    const duration = uaiosRateLimitBackoffMs();
    const until = Math.max(uaiosRateLimitCooldownUntil(), Date.now() + duration);
    try {
      localStorage.setItem(UAIOS_RATE_LIMIT_UNTIL_KEY, String(until));
    } catch (_) {}
    uaiosWatchdogRecordEvent('rate_limit_detected', {
      cooldown_ms: duration,
      cooldown_until: new Date(until).toISOString(),
      reason: String(reason || '').slice(0, 240)
    });
    uaiosContinuityRenderPanel();
    return until;
  }

  function uaiosRateLimitButtonLabel(element) {
    const raw = element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') || '';
    return String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function uaiosRateLimitFindModal() {
    const dialogs = [...new Set(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))];
    for (const dialog of dialogs) {
      if (!uaiosWatchdogIsClickable(dialog)) continue;
      const dialogText = uaiosWatchdogNormalizeText(dialog);
      if (!uaiosWatchdogMatchesAny(dialogText, UAIOS_RATE_LIMIT_MARKERS)) continue;
      if (uaiosWatchdogMatchesAny(dialogText, UAIOS_RATE_LIMIT_BLOCKED_MARKERS)) continue;
      const button = Array.from(dialog.querySelectorAll('button, [role="button"]')).find((candidate) => {
        if (!uaiosWatchdogIsClickable(candidate)) return false;
        return UAIOS_RATE_LIMIT_DISMISS_LABELS.includes(uaiosRateLimitButtonLabel(candidate));
      });
      if (button) return { dialog, button, dialogText };
    }
    return null;
  }

  function uaiosRateLimitScanAndDismiss() {
    const match = uaiosRateLimitFindModal();
    if (!match) return false;
    if (match.dialog.getAttribute('data-uaios-rate-limit-handled') === 'true') return true;
    match.dialog.setAttribute('data-uaios-rate-limit-handled', 'true');
    uaiosRateLimitStartCooling(match.dialogText);
    if (uaiosWatchdogPending) return true;
    uaiosWatchdogPending = true;
    window.setTimeout(() => {
      try {
        if (!uaiosWatchdogIsEnabled() || !match.dialog.isConnected) return;
        const dialogText = uaiosWatchdogNormalizeText(match.dialog);
        const label = uaiosRateLimitButtonLabel(match.button);
        if (!uaiosWatchdogMatchesAny(dialogText, UAIOS_RATE_LIMIT_MARKERS)) return;
        if (uaiosWatchdogMatchesAny(dialogText, UAIOS_RATE_LIMIT_BLOCKED_MARKERS)) return;
        if (!UAIOS_RATE_LIMIT_DISMISS_LABELS.includes(label)) return;
        if (!uaiosWatchdogIsClickable(match.button)) return;
        match.button.click();
        uaiosWatchdogLastActionAt = Date.now();
        uaiosWatchdogRecordEvent('rate_limit_auto_dismiss', { label, cooldown_until: new Date(uaiosRateLimitCooldownUntil()).toISOString() });
      } finally {
        uaiosWatchdogPending = false;
        uaiosContinuityRenderPanel();
      }
    }, 450);
    return true;
  }

  function uaiosWatchdogBudgetAvailable(action) {
    const now = Date.now();
    const cutoff = now - UAIOS_WATCHDOG_WINDOW_MS;
    const scope = uaiosWatchdogScopeKey();
    const recent = uaiosWatchdogReadEvents().filter((event) => {
      const eventTime = Date.parse(event.at || '');
      return event.type === 'auto_click' && event.action === action &&
        event.scope === scope && Number.isFinite(eventTime) && eventTime >= cutoff;
    });
    return recent.length < UAIOS_WATCHDOG_MAX_ACTIONS;
  }

  function uaiosWatchdogFindCandidate(action) {
    const labels = action === 'retry'
      ? UAIOS_WATCHDOG_RETRY_LABELS
      : UAIOS_WATCHDOG_CONTINUE_LABELS;
    for (const element of document.querySelectorAll('button, [role="button"]')) {
      if (!uaiosWatchdogIsClickable(element)) continue;
      const text = uaiosWatchdogNormalizeText(element);
      if (!text || !uaiosWatchdogMatchesAny(text, labels)) continue;
      if (action === 'retry') {
        const nearby = uaiosWatchdogNearbyText(element);
        if (!uaiosWatchdogMatchesAny(nearby, UAIOS_WATCHDOG_ERROR_MARKERS)) continue;
      }
      return element;
    }
    return null;
  }
  function uaiosWatchdogQueueClick(element, action) {
    const now = Date.now();
    if (uaiosWatchdogPending) return false;
    if (now - uaiosWatchdogLastActionAt < UAIOS_WATCHDOG_COOLDOWN_MS) return false;
    if (!uaiosWatchdogBudgetAvailable(action)) {
      uaiosWatchdogRecordEvent('budget_exhausted', { action });
      return false;
    }
    uaiosWatchdogPending = true;
    window.setTimeout(() => {
      try {
        if (!uaiosWatchdogIsEnabled() || !uaiosWatchdogIsClickable(element)) return;
        const text = uaiosWatchdogNormalizeText(element);
        const expectedLabels = action === 'retry'
          ? UAIOS_WATCHDOG_RETRY_LABELS
          : UAIOS_WATCHDOG_CONTINUE_LABELS;
        if (!uaiosWatchdogMatchesAny(text, expectedLabels)) return;
        if (action === 'retry') {
          const nearby = uaiosWatchdogNearbyText(element);
          if (!uaiosWatchdogMatchesAny(nearby, UAIOS_WATCHDOG_ERROR_MARKERS)) return;
        }
        element.click();
        uaiosWatchdogLastActionAt = Date.now();
        uaiosWatchdogRecordEvent('auto_click', { action, label: text.slice(0, 160) });
      } finally {
        uaiosWatchdogPending = false;
      }
    }, 1800);
    return true;
  }

  function uaiosWatchdogScanNow() {
    if (!uaiosWatchdogIsEnabled() || uaiosWatchdogPending) return false;
    if (!isConversationPage()) return false;
    if (uaiosRateLimitScanAndDismiss()) return true;
    if (uaiosRateLimitIsCooling()) return false;
    const retry = uaiosWatchdogFindCandidate('retry');
    if (retry) return uaiosWatchdogQueueClick(retry, 'retry');
    const continuation = uaiosWatchdogFindCandidate('continue');
    if (continuation) return uaiosWatchdogQueueClick(continuation, 'continue');
    return false;
  }
  function uaiosWatchdogStatus() {
    return {
      enabled: uaiosWatchdogIsEnabled(),
      scope: uaiosWatchdogScopeKey(),
      pending: uaiosWatchdogPending,
      rateLimitCooling: uaiosRateLimitIsCooling(),
      rateLimitRemainingMs: uaiosRateLimitRemainingMs(),
      recentEvents: uaiosWatchdogReadEvents().slice(-10)
    };
  }

  // ============================================================
  // UAIOS_08B/08D - bounded local checkpoint and handoff capsule
  // ============================================================
  const UAIOS_CHECKPOINTS_KEY = 'uaios.continuity.checkpoints.v1';
  const UAIOS_PROJECT_STATES_KEY = 'uaios.continuity.projectStates.v1';
  const UAIOS_CHECKPOINT_MESSAGE_LIMIT = 12;
  const UAIOS_CHECKPOINT_MESSAGE_CHARS = 4000;
  const UAIOS_CHECKPOINT_ARRAY_LIMIT = 50;
  const UAIOS_RECOVERY_DB_NAME = 'uaios-continuity-recovery-v1';
  const UAIOS_RECOVERY_DB_VERSION = 1;
  const UAIOS_RECOVERY_STORE = 'checkpointHistory';
  const UAIOS_RECOVERY_HISTORY_LIMIT = 20;
  const UAIOS_RECOVERY_SCHEMA_VERSION = 1;
  const UAIOS_RECOVERY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

  function uaiosContinuityReadObject(key) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function uaiosContinuityWriteObject(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function uaiosContinuityRecoveryRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function uaiosContinuityRecoveryTxDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(true);
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
  }

  function uaiosContinuityOpenRecoveryDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB is unavailable in this browser context.'));
        return;
      }
      const request = window.indexedDB.open(UAIOS_RECOVERY_DB_NAME, UAIOS_RECOVERY_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        let store;
        if (!db.objectStoreNames.contains(UAIOS_RECOVERY_STORE)) {
          store = db.createObjectStore(UAIOS_RECOVERY_STORE, { keyPath: 'id' });
        } else {
          store = request.transaction.objectStore(UAIOS_RECOVERY_STORE);
        }
        if (!store.indexNames.contains('scope')) store.createIndex('scope', 'scope', { unique: false });
        if (!store.indexNames.contains('captured_at')) store.createIndex('captured_at', 'captured_at', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open recovery history database.'));
      request.onblocked = () => reject(new Error('Recovery history database upgrade is blocked by another tab.'));
    });
  }

  function uaiosContinuityRecoveryClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uaiosContinuityRecoveryId(record) {
    return [record?.scope || 'general', record?.captured_at || new Date().toISOString(), record?.source_conversation_id || 'unknown'].join('::');
  }

  async function uaiosContinuityRecoveryList(scope = uaiosContinuityScopeId()) {
    const db = await uaiosContinuityOpenRecoveryDb();
    try {
      const transaction = db.transaction(UAIOS_RECOVERY_STORE, 'readonly');
      const done = uaiosContinuityRecoveryTxDone(transaction);
      const rows = await uaiosContinuityRecoveryRequest(
        transaction.objectStore(UAIOS_RECOVERY_STORE).index('scope').getAll(scope)
      );
      await done;
      return (Array.isArray(rows) ? rows : [])
        .sort((a, b) => String(b?.captured_at || '').localeCompare(String(a?.captured_at || '')));
    } finally {
      db.close();
    }
  }

  async function uaiosContinuityRecoverySave(record) {
    const entry = {
      ...uaiosContinuityRecoveryClone(record),
      id: uaiosContinuityRecoveryId(record),
      recovery_saved_at: new Date().toISOString()
    };
    let db = await uaiosContinuityOpenRecoveryDb();
    try {
      const transaction = db.transaction(UAIOS_RECOVERY_STORE, 'readwrite');
      const done = uaiosContinuityRecoveryTxDone(transaction);
      await uaiosContinuityRecoveryRequest(transaction.objectStore(UAIOS_RECOVERY_STORE).put(entry));
      await done;
    } finally {
      db.close();
    }

    const history = await uaiosContinuityRecoveryList(record.scope);
    const overflow = history.slice(UAIOS_RECOVERY_HISTORY_LIMIT);
    if (overflow.length) {
      db = await uaiosContinuityOpenRecoveryDb();
      try {
        const transaction = db.transaction(UAIOS_RECOVERY_STORE, 'readwrite');
        const done = uaiosContinuityRecoveryTxDone(transaction);
        const store = transaction.objectStore(UAIOS_RECOVERY_STORE);
        for (const stale of overflow) store.delete(stale.id);
        await done;
      } finally {
        db.close();
      }
    }
    uaiosWatchdogRecordEvent('recovery_history_saved', {
      scope: record.scope,
      retained: Math.min(history.length, UAIOS_RECOVERY_HISTORY_LIMIT)
    });
    return entry;
  }

  function uaiosContinuityDownloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function uaiosContinuityExportRecoverySnapshot() {
    const scope = uaiosContinuityScopeId();
    const latest = uaiosContinuityLatestCheckpoint();
    if (!latest) throw new Error('No checkpoint exists for the current continuity scope.');
    const history = await uaiosContinuityRecoveryList(scope);
    const bundle = {
      schema_version: UAIOS_RECOVERY_SCHEMA_VERSION,
      continuity_version: UAIOS_CONTINUITY_VERSION,
      exported_at: new Date().toISOString(),
      scope,
      project_state: latest.project_state || uaiosContinuityGetState(),
      latest_checkpoint: latest,
      history: history.slice(0, UAIOS_RECOVERY_HISTORY_LIMIT)
    };
    const safeScope = String(scope || 'general').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'general';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    uaiosContinuityDownloadJson(`uaios-recovery-${safeScope}-${stamp}.json`, bundle);
    uaiosWatchdogRecordEvent('recovery_snapshot_exported', { scope, checkpoints: bundle.history.length });
    return bundle;
  }

  function uaiosContinuityValidateRecoveryBundle(bundle, expectedScope = uaiosContinuityScopeId()) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new Error('Recovery snapshot must be a JSON object.');
    }
    if (Number(bundle.schema_version) !== UAIOS_RECOVERY_SCHEMA_VERSION) {
      throw new Error(`Unsupported recovery schema: ${bundle.schema_version ?? 'missing'}.`);
    }
    const scope = String(bundle.scope || '');
    if (!scope) throw new Error('Recovery snapshot is missing scope.');
    if (scope !== expectedScope) {
      throw new Error(`Recovery scope mismatch. Snapshot=${scope}; current=${expectedScope}.`);
    }
    const latest = bundle.latest_checkpoint;
    if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
      throw new Error('Recovery snapshot is missing latest_checkpoint.');
    }
    if (String(latest.scope || '') !== scope) {
      throw new Error('latest_checkpoint scope does not match recovery scope.');
    }
    const history = Array.isArray(bundle.history) ? bundle.history : [];
    for (const record of history) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('Recovery history contains an invalid checkpoint record.');
      }
      if (String(record.scope || '') !== scope) {
        throw new Error('Recovery history contains a checkpoint from another scope.');
      }
    }
    if (bundle.project_state != null && (typeof bundle.project_state !== 'object' || Array.isArray(bundle.project_state))) {
      throw new Error('Recovery project_state must be an object when present.');
    }
    return {
      schema_version: UAIOS_RECOVERY_SCHEMA_VERSION,
      continuity_version: String(bundle.continuity_version || ''),
      exported_at: String(bundle.exported_at || ''),
      scope,
      project_state: bundle.project_state ? uaiosContinuityRecoveryClone(bundle.project_state) : null,
      latest_checkpoint: uaiosContinuityRecoveryClone(latest),
      history: history.slice(0, UAIOS_RECOVERY_HISTORY_LIMIT).map(uaiosContinuityRecoveryClone)
    };
  }

  async function uaiosContinuityRecoveryReplaceHistory(scope, records = []) {
    const deduped = new Map();
    for (const record of records) {
      if (!record || String(record.scope || '') !== scope) continue;
      const clone = uaiosContinuityRecoveryClone(record);
      clone.id = uaiosContinuityRecoveryId(clone);
      clone.recovery_saved_at = clone.recovery_saved_at || new Date().toISOString();
      deduped.set(clone.id, clone);
    }
    const bounded = [...deduped.values()]
      .sort((a, b) => String(b?.captured_at || '').localeCompare(String(a?.captured_at || '')))
      .slice(0, UAIOS_RECOVERY_HISTORY_LIMIT);
    const db = await uaiosContinuityOpenRecoveryDb();
    try {
      const transaction = db.transaction(UAIOS_RECOVERY_STORE, 'readwrite');
      const store = transaction.objectStore(UAIOS_RECOVERY_STORE);
      const existingKeys = await uaiosContinuityRecoveryRequest(store.index('scope').getAllKeys(scope));
      for (const key of existingKeys || []) store.delete(key);
      for (const record of bounded) store.put(record);
      await uaiosContinuityRecoveryTxDone(transaction);
    } finally {
      db.close();
    }
    return bounded.length;
  }

  function uaiosContinuityRestoreProjectState(state, scope) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const states = uaiosContinuityReadObject(UAIOS_PROJECT_STATES_KEY);
    states[scope] = uaiosContinuitySanitizeState(state);
    uaiosContinuityWriteObject(UAIOS_PROJECT_STATES_KEY, states);
    uaiosWatchdogRecordEvent('project_state_restored', { scope });
    return states[scope];
  }

  async function uaiosContinuityRestoreRecoveryBundle(bundle) {
    const validated = uaiosContinuityValidateRecoveryBundle(bundle, uaiosContinuityScopeId());
    const scope = validated.scope;
    const latest = validated.latest_checkpoint;
    const checkpoints = uaiosContinuityReadObject(UAIOS_CHECKPOINTS_KEY);
    checkpoints[scope] = latest;
    uaiosContinuityWriteObject(UAIOS_CHECKPOINTS_KEY, checkpoints);
    const state = validated.project_state || latest.project_state || null;
    if (state) uaiosContinuityRestoreProjectState(state, scope);

    const records = [...validated.history, latest];
    let historyRestored = 0;
    let historyError = '';
    try {
      historyRestored = await uaiosContinuityRecoveryReplaceHistory(scope, records);
    } catch (error) {
      historyError = toErrorMessage(error);
      uaiosWatchdogRecordEvent('recovery_history_restore_failed', { scope, message: historyError });
    }
    uaiosWatchdogRecordEvent('recovery_snapshot_restored', {
      scope,
      historyRestored,
      historyPartial: Boolean(historyError)
    });
    return { validated, historyRestored, historyError };
  }

  function uaiosContinuityRecoveryPreview(bundle) {
    const objective = uaiosContinuitySignalText(
      bundle.project_state?.objective || bundle.latest_checkpoint?.project_state?.objective || '',
      240
    );
    return [
      'Restore this Recovery Snapshot into the current Project?',
      '',
      `Scope: ${bundle.scope}`,
      `Exported: ${bundle.exported_at || 'unknown'}`,
      `Latest checkpoint: ${bundle.latest_checkpoint?.captured_at || 'unknown'}`,
      `History records: ${bundle.history.length}`,
      objective ? `Objective: ${objective}` : '',
      '',
      'This replaces only local Continuity checkpoint/state for this Project.',
      'It does not send a message, open a new chat, or modify ChatGPT server data.'
    ].filter(Boolean).join('\n');
  }

  async function uaiosContinuityImportRecoveryFile(file) {
    if (!file) return null;
    if (file.size > UAIOS_RECOVERY_IMPORT_MAX_BYTES) {
      throw new Error('Recovery snapshot is too large (maximum 5 MB).');
    }
    const raw = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error('Recovery snapshot is not valid JSON.');
    }
    const validated = uaiosContinuityValidateRecoveryBundle(parsed, uaiosContinuityScopeId());
    const confirmed = window.confirm(uaiosContinuityRecoveryPreview(validated));
    if (!confirmed) return { cancelled: true, validated };
    return uaiosContinuityRestoreRecoveryBundle(validated);
  }

  function uaiosContinuityPromptRecoveryImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.setAttribute('data-uaios-recovery-file', '');
    input.addEventListener('change', () => {
      const file = input.files?.[0] || null;
      input.remove();
      if (!file) return;
      void uaiosContinuityRunRecoveryImport(file);
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    (document.body || document.documentElement).appendChild(input);
    input.click();
  }

  function uaiosContinuityScopeId() {
    const path = location.pathname || '';
    const normalize = (value) => {
      const trimmed = String(value || '').replace(/\/+$/, '');
      return !trimmed || trimmed === '/' ? 'general' : trimmed;
    };
    // ChatGPT conversation routes may append a human-readable slug to g-p-<id>,
    // while the canonical fresh Project landing uses only the bare g-p-<id>.
    const projectRoute = path.match(/^\/g\/(g-p-[0-9a-f]+)(?:-[^/]+)?(?:\/|$)/i);
    if (projectRoute) return normalize(`/g/${projectRoute[1]}`);
    const conversationRoute = path.match(/^(.*)\/c\/[^/]+(?:\/.*)?$/);
    if (conversationRoute) return normalize(conversationRoute[1]);
    const projectLandingRoute = path.match(/^(\/g\/g-p-[^/]+)\/project(?:\/.*)?$/i);
    if (projectLandingRoute) return normalize(projectLandingRoute[1]);
    const conversationId = getConversationIdFromUrl();
    if (conversationId) {
      const marker = `/c/${conversationId}`;
      const index = path.lastIndexOf(marker);
      if (index >= 0) return normalize(path.slice(0, index));
    }
    return normalize(path);
  }
  function uaiosContinuityBoundString(value, maxChars = UAIOS_CHECKPOINT_MESSAGE_CHARS) {
    if (value == null) return '';
    const text = String(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[truncated]`;
  }

  function uaiosContinuityBoundArray(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-UAIOS_CHECKPOINT_ARRAY_LIMIT).map((item) => {
      if (typeof item === 'string') return uaiosContinuityBoundString(item, 2000);
      if (item && typeof item === 'object') {
        try {
          return JSON.parse(JSON.stringify(item));
        } catch (_) {
          return String(item);
        }
      }
      return item;
    });
  }

  function uaiosContinuitySanitizeState(input = {}) {
    return {
      objective: uaiosContinuityBoundString(input.objective, 2000),
      phase: uaiosContinuityBoundString(input.phase, 300),
      progress: uaiosContinuityBoundString(input.progress, 100),
      current_task: uaiosContinuityBoundString(input.current_task ?? input.currentTask, 2000),
      next_action: uaiosContinuityBoundString(input.next_action ?? input.nextAction, 2000),
      completed: uaiosContinuityBoundArray(input.completed),
      blockers: uaiosContinuityBoundArray(input.blockers),
      decisions: uaiosContinuityBoundArray(input.decisions),
      evidence: uaiosContinuityBoundArray(input.evidence),
      do_not_redo: uaiosContinuityBoundArray(input.do_not_redo ?? input.doNotRedo),
      notes: uaiosContinuityBoundString(input.notes, 4000),
      state_source: uaiosContinuityBoundString(input.state_source, 80),
      confidence: uaiosContinuityBoundString(input.confidence, 40),
      generated_at: uaiosContinuityBoundString(input.generated_at, 80),
      manual_updated_at: uaiosContinuityBoundString(input.manual_updated_at, 80),
      updated_at: new Date().toISOString()
    };
  }

  function uaiosContinuitySignalText(value, maxChars = 1200) {
    return uaiosContinuityBoundString(
      String(value || '').replace(/[*_>#]+/g, ' ').replace(/\s+/g, ' ').trim(),
      maxChars
    );
  }

  function uaiosContinuityUniqueSignals(items, limit = 8) {
    const output = [];
    const seen = new Set();
    for (const item of items || []) {
      const text = uaiosContinuitySignalText(item);
      if (!text) continue;
      const key = text.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(text);
      if (output.length >= limit) break;
    }
    return output;
  }

  function uaiosContinuityLastSignal(lines, pattern, maxChars = 1200) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (pattern.test(lines[index])) return uaiosContinuitySignalText(lines[index], maxChars);
    }
    return '';
  }

  function uaiosContinuityResolutionBoundary(linesByRole) {
    const positivePattern = /(end-to-end\s+pass|e2e\s+pass|cross-chat[^\n]*pass|ผ่านเต็มระบบ|สำเร็จแล้ว|resolved|fixed|\bPASS\b|Bridge:\s*OK|online แล้ว)/i;
    const negativePattern = /(❌|\bFAIL\b|failed|blocker|error|bug|remaining issue|still failing|ยังไม่ผ่าน|ยังติด|ปัญหา)/i;
    for (let index = linesByRole.length - 1; index >= 0; index -= 1) {
      const item = linesByRole[index];
      if (
        item?.role === 'assistant' &&
        positivePattern.test(item.text) &&
        !negativePattern.test(item.text)
      ) {
        return index;
      }
    }
    return -1;
  }

  function uaiosContinuityNextActionFromAssistant(message) {
    const raw = String(message || '');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => uaiosContinuitySignalText(line, 1600))
      .filter(Boolean);
    const actionPattern = /(next action|next step|ขั้นต่อไป|ต่อจาก|ดำเนินการต่อ|ตอนนี้เหลือ|ให้กด|กด\s|แล้วผมจะ|จากนั้น|ทดสอบ.*ต่อ|ตรวจ.*ต่อ|ทำ.*ต่อ)/i;
    const explicit = [...lines].reverse().find((line) => actionPattern.test(line));
    return explicit || uaiosContinuitySignalText(message, 1800);
  }

  function uaiosContinuityIsBootstrapMessage(message) {
    if (message?.role !== 'user') return false;
    const text = String(message?.content || '').trimStart();
    return text.startsWith('UAIOS CONTINUITY BOOTSTRAP') && text.includes('BOUNDED CONTINUITY PAYLOAD');
  }

  function uaiosContinuityDeriveProjectState(messages = [], title = '') {
    const recent = (Array.isArray(messages) ? messages : [])
      .filter((message) => !uaiosContinuityIsBootstrapMessage(message))
      .slice(-12);
    const linesByRole = recent.flatMap((message, messageIndex) => {
      const role = String(message?.role || 'unknown');
      return String(message?.content || '')
        .split(/\r?\n/)
        .map((line) => uaiosContinuitySignalText(line))
        .filter((line) => line.length >= 6)
        .map((text, lineIndex) => ({ role, text, messageIndex, lineIndex }));
    });
    const lines = linesByRole.map((item) => item.text);
    const assistantMessages = recent
      .filter((message) => message?.role === 'assistant')
      .map((message) => uaiosContinuitySignalText(message?.content, 1800))
      .filter(Boolean);
    const userMessages = recent
      .filter((message) => message?.role === 'user')
      .map((message) => uaiosContinuitySignalText(message?.content, 1800))
      .filter(Boolean);
    const latestSubstantialUser = [...userMessages].reverse().find((text) => text.length >= 40) || '';
    const latestAssistant = assistantMessages[assistantMessages.length - 1] || '';
    const objective = latestSubstantialUser || (title ? 'Continue project: ' + uaiosContinuitySignalText(title, 500) : '');
    const phase = uaiosContinuityLastSignal(lines, /(phase\s*[A-Z0-9._-]+|v\d+\.\d+\.\d+)/i, 300);
    const progress = uaiosContinuityLastSignal(lines, /((progress)[^%]{0,80}\d{1,3}%|\b\d{1,3}%\b)/i, 100);
    const currentTask = latestAssistant || latestSubstantialUser || objective;
    const nextAction = uaiosContinuityNextActionFromAssistant(latestAssistant) || currentTask;

    const resolutionBoundary = uaiosContinuityResolutionBoundary(linesByRole);
    const unresolvedWindow = resolutionBoundary >= 0 ? linesByRole.slice(resolutionBoundary + 1) : linesByRole.slice(-40);
    const evidenceWindow = linesByRole.slice(-60);

    const completed = uaiosContinuityUniqueSignals(
      evidenceWindow
        .filter((item) => /(✅|\bPASS\b|success|successful|completed|done|\bmerged\b|merge into|สำเร็จ|ผ่านเต็มระบบ)/i.test(item.text))
        .map((item) => item.text)
        .reverse(),
      8
    ).reverse();

    const blockers = uaiosContinuityUniqueSignals(
      unresolvedWindow
        .filter((item) => /(❌|\bFAIL\b|failed|blocker|error|bug|remaining issue|still failing|ยังไม่ผ่าน|ยังติด|ปัญหา)/i.test(item.text))
        .map((item) => item.text)
        .reverse(),
      6
    ).reverse();

    const decisions = uaiosContinuityUniqueSignals(
      evidenceWindow
        .filter((item) => /(root cause|architecture|decision|changed from|changed to|switch to|use .* instead|ตัดสินใจ|สาเหตุ|แนวทาง)/i.test(item.text))
        .map((item) => item.text)
        .reverse(),
      8
    ).reverse();

    const evidence = uaiosContinuityUniqueSignals(
      evidenceWindow
        .filter((item) => /(PR\s*#\d+|commit|main\b|v\d+\.\d+\.\d+|https?:\/\/|Bridge:\s*OK|\b[0-9a-f]{7,40}\b|HEAD=|CI\b)/i.test(item.text))
        .map((item) => item.text)
        .reverse(),
      10
    ).reverse();

    const doNotRedo = uaiosContinuityUniqueSignals(
      evidenceWindow
        .filter((item) => /(do not|don't|must not|avoid repeating|do not redo|ห้าม|ไม่ต้องทำซ้ำ|อย่าย้อน)/i.test(item.text))
        .map((item) => item.text)
        .reverse(),
      6
    ).reverse();

    const confidence = objective && currentTask && (completed.length || evidence.length) ? 'medium-high' : objective ? 'medium' : 'low';
    return uaiosContinuitySanitizeState({
      objective, phase, progress, current_task: currentTask, next_action: nextAction,
      completed, blockers, decisions, evidence, do_not_redo: doNotRedo,
      notes: resolutionBoundary >= 0
        ? 'Auto-derived from recent conversation evidence after the latest resolved/PASS boundary. Re-verify mutable external status from canonical sources.'
        : 'Auto-derived from bounded recent conversation evidence. Re-verify mutable external status from canonical sources.',
      state_source: 'autopilot-v2', confidence, generated_at: new Date().toISOString()
    });
  }

  function uaiosContinuityMergeProjectState(autoState, manualState) {
    if (!manualState || typeof manualState !== 'object') return autoState;
    const merged = { ...(autoState || {}) };
    for (const field of ['objective', 'phase', 'progress', 'current_task', 'next_action', 'notes']) {
      const value = uaiosContinuitySignalText(manualState[field], field === 'progress' ? 100 : 2000);
      if (value) merged[field] = value;
    }
    for (const field of ['completed', 'blockers', 'decisions', 'evidence', 'do_not_redo']) {
      if (Array.isArray(manualState[field]) && manualState[field].length) {
        merged[field] = uaiosContinuityUniqueSignals([...manualState[field], ...(Array.isArray(merged[field]) ? merged[field] : [])], 12);
      }
    }
    merged.state_source = 'manual+autopilot-v2';
    merged.manual_updated_at = manualState.updated_at || null;
    merged.generated_at = autoState?.generated_at || new Date().toISOString();
    return uaiosContinuitySanitizeState(merged);
  }

  function uaiosContinuityFormatProjectState(state) {
    if (!state) return 'PROJECT STATE SNAPSHOT\nState unavailable; rely on recent conversation evidence.';
    const lines = [
      'PROJECT STATE SNAPSHOT',
      'Source: ' + (state.state_source || 'unknown') + ' | Confidence: ' + (state.confidence || 'unknown'),
      state.objective ? 'Objective: ' + state.objective : '',
      state.phase ? 'Phase: ' + state.phase : '',
      state.progress ? 'Progress: ' + state.progress : '',
      state.current_task ? 'Current task: ' + state.current_task : '',
      state.next_action ? 'Next action: ' + state.next_action : ''
    ].filter(Boolean);
    const appendList = (label, values, limit = 5) => {
      if (!Array.isArray(values) || !values.length) return;
      lines.push(label + ':');
      for (const value of values.slice(-limit)) lines.push('- ' + uaiosContinuitySignalText(value, 1200));
    };
    appendList('Completed', state.completed);
    appendList('Blockers / unresolved signals', state.blockers);
    appendList('Decisions / architecture signals', state.decisions);
    appendList('Canonical evidence hints', state.evidence);
    appendList('Do not redo / constraints', state.do_not_redo);
    return lines.join('\n');
  }

  function uaiosContinuityGetState() {
    const states = uaiosContinuityReadObject(UAIOS_PROJECT_STATES_KEY);
    return states[uaiosContinuityScopeId()] || null;
  }

  function uaiosContinuitySetState(patch = {}) {
    const states = uaiosContinuityReadObject(UAIOS_PROJECT_STATES_KEY);
    const scope = uaiosContinuityScopeId();
    const current = states[scope] || {};
    states[scope] = uaiosContinuitySanitizeState({ ...current, ...patch });
    uaiosContinuityWriteObject(UAIOS_PROJECT_STATES_KEY, states);
    uaiosWatchdogRecordEvent('project_state_saved', { scope });
    return states[scope];
  }

  function uaiosContinuityLatestCheckpoint() {
    const checkpoints = uaiosContinuityReadObject(UAIOS_CHECKPOINTS_KEY);
    return checkpoints[uaiosContinuityScopeId()] || null;
  }

  function uaiosContinuitySaveCheckpointRecord(record) {
    const checkpoints = uaiosContinuityReadObject(UAIOS_CHECKPOINTS_KEY);
    checkpoints[record.scope] = record;
    uaiosContinuityWriteObject(UAIOS_CHECKPOINTS_KEY, checkpoints);
    uaiosWatchdogRecordEvent('checkpoint_saved', {
      scope: record.scope,
      conversationId: record.source_conversation_id,
      totalMessages: record.total_message_count
    });
    void uaiosContinuityRecoverySave(record).catch((error) => {
      uaiosWatchdogRecordEvent('recovery_history_save_failed', {
        scope: record.scope,
        message: toErrorMessage(error)
      });
    });
    return record;
  }
  async function uaiosContinuityCheckpointNow() {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId || !isConversationPage()) {
      throw new Error('Checkpoint requires an active ChatGPT conversation page.');
    }
    const result = await createHandoffPayloadForConversationId(conversationId, {
      enforceCurrentPage: true
    });
    const handoff = JSON.parse(result.handoffPayload.text);
    const allMessages = Array.isArray(handoff.messages) ? handoff.messages : [];
    const recentMessages = allMessages.slice(-UAIOS_CHECKPOINT_MESSAGE_LIMIT).map((message) => ({
      id: message.id,
      role: message.role,
      content: uaiosContinuityBoundString(message.content),
      cite_sources: Array.isArray(message.cite_sources)
        ? message.cite_sources.slice(0, 20)
        : undefined
    }));
    const textdocs = Array.isArray(handoff.textdocs)
      ? handoff.textdocs.slice(0, 50).map((doc) => ({
        id: doc.id ?? null,
        title: doc.title ?? null,
        version: doc.version ?? null,
        updated_at: doc.updated_at ?? null
      }))
      : [];
    const autoProjectState = uaiosContinuityDeriveProjectState(allMessages, handoff.title || '');
    const projectState = uaiosContinuityMergeProjectState(autoProjectState, uaiosContinuityGetState());
    const record = {
      schema_version: 1,
      project_state_schema_version: 1,
      scope: uaiosContinuityScopeId(),
      captured_at: new Date().toISOString(),
      source_conversation_id: handoff.conversation_id || conversationId,
      title: handoff.title || null,
      source_update_time: handoff.update_time || null,
      total_message_count: allMessages.length,
      total_content_chars: allMessages.reduce((sum, message) => sum + String(message?.content || '').length, 0),
      recent_messages: recentMessages,
      textdocs,
      project_state: projectState,
      transport: result.transport || null
    };
    return uaiosContinuitySaveCheckpointRecord(record);
  }
  function uaiosContinuityBuildBootstrap(checkpoint = uaiosContinuityLatestCheckpoint()) {
    if (!checkpoint) return null;
    const autoFallbackState = uaiosContinuityDeriveProjectState(checkpoint.recent_messages || [], checkpoint.title || '');
    const projectState = checkpoint.project_state ||
      uaiosContinuityMergeProjectState(autoFallbackState, uaiosContinuityGetState());
    const payload = {
      schema_version: checkpoint.schema_version,
      project_state_schema_version: checkpoint.project_state_schema_version || 1,
      scope: checkpoint.scope,
      captured_at: checkpoint.captured_at,
      source_conversation_id: checkpoint.source_conversation_id,
      title: checkpoint.title,
      source_update_time: checkpoint.source_update_time,
      total_message_count: checkpoint.total_message_count,
      total_content_chars: checkpoint.total_content_chars || 0,
      project_state: projectState,
      recent_messages: checkpoint.recent_messages || [],
      textdocs: checkpoint.textdocs || []
    };
    return [
      'UAIOS CONTINUITY BOOTSTRAP',
      'Use the Project State Snapshot for orientation, then use recent evidence and canonical sources to verify mutable status.',
      'Do not assume old branch/PR/workflow status is still current solely because it appears below.',
      'If project_state is missing or stale, reconstruct a provisional project state from recent_messages before continuing.',
      'Prioritize the latest explicit user goal, completed work, blockers, decisions, verified evidence, and next action.',
      'Do not ask the user to repeat context already present in this bootstrap. Continue when the next action is clear.',
      '',
      uaiosContinuityFormatProjectState(projectState),
      '',
      'BOUNDED CONTINUITY PAYLOAD',
      JSON.stringify(payload, null, 2)
    ].join('\n');
  }

  function uaiosContinuityUpgradeLegacyBootstrap(text) {
    const raw = String(text || '');
    const marker = '\nBOUNDED CONTINUITY PAYLOAD\n';
    const markerIndex = raw.indexOf(marker);
    if (markerIndex < 0) return raw;
    try {
      const payload = JSON.parse(raw.slice(markerIndex + marker.length));
      const source = String(payload?.project_state?.state_source || '');
      if (source.includes('autopilot-v2')) return raw;
      const autoState = uaiosContinuityDeriveProjectState(payload?.recent_messages || [], payload?.title || '');
      const projectState = uaiosContinuityMergeProjectState(autoState, uaiosContinuityGetState());
      payload.project_state = projectState;
      return [
        'UAIOS CONTINUITY BOOTSTRAP',
        'Use the Project State Snapshot for orientation, then use recent evidence and canonical sources to verify mutable status.',
        'Do not assume old branch/PR/workflow status is still current solely because it appears below.',
        'If project_state is missing or stale, reconstruct a provisional project state from recent_messages before continuing.',
        'Prioritize the latest explicit user goal, completed work, blockers, decisions, verified evidence, and next action.',
        'Do not ask the user to repeat context already present in this bootstrap. Continue when the next action is clear.',
        '',
        uaiosContinuityFormatProjectState(projectState),
        '',
        'BOUNDED CONTINUITY PAYLOAD',
        JSON.stringify(payload, null, 2)
      ].join('\n');
    } catch (_) {
      return raw;
    }
  }

  async function uaiosContinuityCopyBootstrap() {
    const text = uaiosContinuityBuildBootstrap();
    if (!text) throw new Error('No checkpoint exists for the current continuity scope.');
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('Clipboard API is unavailable. Use UAIOSContinuity.buildBootstrap() instead.');
    }
    await navigator.clipboard.writeText(text);
    uaiosWatchdogRecordEvent('bootstrap_copied', { scope: uaiosContinuityScopeId() });
    return text;
  }

  function uaiosContinuityClearCheckpoint() {
    const checkpoints = uaiosContinuityReadObject(UAIOS_CHECKPOINTS_KEY);
    const scope = uaiosContinuityScopeId();
    const existed = Object.prototype.hasOwnProperty.call(checkpoints, scope);
    delete checkpoints[scope];
    uaiosContinuityWriteObject(UAIOS_CHECKPOINTS_KEY, checkpoints);
    if (existed) uaiosWatchdogRecordEvent('checkpoint_cleared', { scope });
    return existed;
  }

  // ============================================================
  // UAIOS_08E - proactive session rollover and visible controls
  // ============================================================
  const UAIOS_PENDING_ROLLOVERS_KEY = 'uaios.continuity.pendingRollovers.v1';
  const UAIOS_CONTINUITY_VERSION = '1.8.5';
  const UAIOS_BRIDGE_MAIN_SOURCE = 'uaios-continuity-main-v1';
  const UAIOS_BRIDGE_REPLY_SOURCE = 'uaios-continuity-bridge-v1';
  const UAIOS_BRIDGE_REQUEST_MAILBOX_ID = 'uaios-continuity-bridge-request-mailbox';
  const UAIOS_BRIDGE_REPLY_MAILBOX_ID = 'uaios-continuity-bridge-reply-mailbox';
  const UAIOS_CONTINUITY_PANEL_ID = 'uaios-continuity-panel';
  const UAIOS_CONTINUITY_STYLE_ID = 'uaios-continuity-style';
  const UAIOS_CONTINUITY_PANEL_POSITION_KEY = 'uaios.continuity.panelPosition.v1';
  const UAIOS_AUTO_CHECKPOINT_MS = 10 * 60 * 1000;
  const UAIOS_AUTO_HANDOFF_MESSAGE_THRESHOLD = 110;
  const UAIOS_AUTO_HANDOFF_CHAR_THRESHOLD = 150000;
  const UAIOS_AUTO_HANDOFF_QUEUE_KEY = 'uaios.continuity.autoHandoffQueue.v1';
  const UAIOS_AUTO_HANDOFF_HANDLED_KEY = 'uaios.continuity.autoHandoffHandledConversation.v1';
  const UAIOS_AUTO_HANDOFF_RETRY_MS = 60 * 1000;
  const UAIOS_PENDING_ROLLOVER_TTL_MS = 30 * 60 * 1000;
  const UAIOS_STAGED_HANDOFF_WAIT_MS = 4000;
  let uaiosAutoCheckpointTimer = null;
  let uaiosAutoHandoffInFlight = false;
  let uaiosCheckpointInFlight = false;
  let uaiosExportInFlight = false;
  let uaiosRecoveryImportInFlight = false;
  let uaiosPanelNoteTimer = null;
  let uaiosBridgeHealth = 'unknown';

  function uaiosContinuityLoadAssessment(checkpoint = uaiosContinuityLatestCheckpoint()) {
    const messages = Number(checkpoint?.total_message_count || 0);
    const chars = Number(checkpoint?.total_content_chars || 0);
    let level = 'normal';
    if (messages >= 220 || chars >= 360000) level = 'critical';
    else if (messages >= 140 || chars >= 220000) level = 'high';
    else if (messages >= 80 || chars >= 100000) level = 'elevated';
    return { level, messages, chars };
  }

  function uaiosContinuityAutoHandoffEligible(load = uaiosContinuityLoadAssessment()) {
    return load.messages >= UAIOS_AUTO_HANDOFF_MESSAGE_THRESHOLD ||
      load.chars >= UAIOS_AUTO_HANDOFF_CHAR_THRESHOLD ||
      load.level === 'high' ||
      load.level === 'critical';
  }

  function uaiosContinuityReadAutoHandoffQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(UAIOS_AUTO_HANDOFF_QUEUE_KEY) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function uaiosContinuityWriteAutoHandoffQueue(record) {
    try {
      if (record) localStorage.setItem(UAIOS_AUTO_HANDOFF_QUEUE_KEY, JSON.stringify(record));
      else localStorage.removeItem(UAIOS_AUTO_HANDOFF_QUEUE_KEY);
    } catch (_) {}
    return record || null;
  }

  function uaiosContinuityAutoHandoffHandled(conversationId = getConversationIdFromUrl()) {
    if (!conversationId) return false;
    try {
      return localStorage.getItem(UAIOS_AUTO_HANDOFF_HANDLED_KEY) === conversationId;
    } catch (_) {
      return false;
    }
  }

  function uaiosContinuityMarkAutoHandoffHandled(conversationId = getConversationIdFromUrl()) {
    if (!conversationId) return false;
    try {
      localStorage.setItem(UAIOS_AUTO_HANDOFF_HANDLED_KEY, conversationId);
      return true;
    } catch (_) {
      return false;
    }
  }

  function uaiosContinuityQueueAutoHandoff(reason = 'threshold') {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId || !isConversationPage()) return null;
    const existing = uaiosContinuityReadAutoHandoffQueue();
    if (existing?.source_conversation_id === conversationId) return existing;
    const record = {
      scope: uaiosContinuityScopeId(),
      source_conversation_id: conversationId,
      queued_at: new Date().toISOString(),
      reason,
      next_attempt_at: 0
    };
    uaiosContinuityWriteAutoHandoffQueue(record);
    uaiosWatchdogRecordEvent('auto_handoff_queued', {
      sourceConversationId: conversationId,
      reason,
      cooldown_until: uaiosRateLimitCooldownUntil()
        ? new Date(uaiosRateLimitCooldownUntil()).toISOString()
        : null
    });
    uaiosContinuityRenderPanel();
    return record;
  }

  function uaiosContinuityBridgeMailbox(id) {
    let node = document.getElementById(id);
    if (!node) {
      node = document.createElement('div');
      node.id = id;
      node.hidden = true;
      (document.documentElement || document).appendChild(node);
    }
    return node;
  }

  function uaiosContinuityBridgeRequest(type, payload = {}, timeoutMs = 1800) {
    const requestId = `uaios-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      let settled = false;
      const replyNode = uaiosContinuityBridgeMailbox(UAIOS_BRIDGE_REPLY_MAILBOX_ID);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve(value);
      };
      const onReply = () => {
        try {
          const message = JSON.parse(String(replyNode.textContent || '{}'));
          if (!message || message.source !== UAIOS_BRIDGE_REPLY_SOURCE || message.request_id !== requestId) return;
          uaiosBridgeHealth = message.ok ? 'ok' : 'fail';
          uaiosContinuityRenderPanel();
          finish(message.ok ? message.record ?? true : null);
        } catch (_) {}
      };
      const observer = new MutationObserver(onReply);
      observer.observe(replyNode, { childList: true, characterData: true, subtree: true });
      const requestNode = uaiosContinuityBridgeMailbox(UAIOS_BRIDGE_REQUEST_MAILBOX_ID);
      requestNode.textContent = JSON.stringify({ source: UAIOS_BRIDGE_MAIN_SOURCE, request_id: requestId, type, ...payload });
      onReply();
      window.setTimeout(() => {
        if (!settled) {
          uaiosBridgeHealth = 'fail';
          uaiosContinuityRenderPanel();
        }
        finish(null);
      }, timeoutMs);
    });
  }

  async function uaiosContinuityProbeBridge() {
    const result = await uaiosContinuityBridgeRequest('ping', {}, 1200);
    uaiosBridgeHealth = result ? 'ok' : 'fail';
    uaiosContinuityRenderPanel();
    return uaiosBridgeHealth;
  }

  function uaiosContinuityReadPendingRollovers() {
    return uaiosContinuityReadObject(UAIOS_PENDING_ROLLOVERS_KEY);
  }
  function uaiosContinuitySetPendingRollover(record) {
    const pending = uaiosContinuityReadPendingRollovers();
    pending[record.scope] = record;
    uaiosContinuityWriteObject(UAIOS_PENDING_ROLLOVERS_KEY, pending);
    return record;
  }

  function uaiosContinuityGetPendingRollover() {
    const pending = uaiosContinuityReadPendingRollovers();
    const scope = uaiosContinuityScopeId();
    const record = pending[scope] || null;
    if (!record) return null;
    const createdAt = Date.parse(record.created_at || '');
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > UAIOS_PENDING_ROLLOVER_TTL_MS) {
      delete pending[scope];
      uaiosContinuityWriteObject(UAIOS_PENDING_ROLLOVERS_KEY, pending);
      return null;
    }
    return record;
  }

  function uaiosContinuityClearPendingRollover(scope = uaiosContinuityScopeId()) {
    const pending = uaiosContinuityReadPendingRollovers();
    const existed = Object.prototype.hasOwnProperty.call(pending, scope);
    delete pending[scope];
    uaiosContinuityWriteObject(UAIOS_PENDING_ROLLOVERS_KEY, pending);
    return existed;
  }
  function uaiosContinuityIsVisibleComposer(element) {
    if (!element || !(element instanceof HTMLElement)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 20 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function uaiosContinuityFindComposer() {
    const selectors = [
      '#prompt-textarea',
      'textarea[placeholder]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]'
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
      .filter((element) => uaiosContinuityIsVisibleComposer(element))
      .map((element) => {
        let score = 0;
        if (element.id === 'prompt-textarea') score += 1000;
        if (element.getAttribute('data-lexical-editor') === 'true') score += 400;
        if (element.getAttribute('role') === 'textbox') score += 250;
        if (element.getAttribute('contenteditable') === 'true') score += 150;
        if (element.matches('textarea[placeholder]')) score += 120;
        if (element.closest('form')) score += 80;
        const rect = element.getBoundingClientRect();
        score += Math.min(100, Math.round(rect.width / 10));
        return { element, score };
      })
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function uaiosContinuityComposerText(composer) {
    if (!composer) return '';
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return String(composer.value || '');
    }
    return String(composer.innerText || composer.textContent || '');
  }

  async function uaiosContinuityFillComposer(text) {
    if (!text) return false;
    const expected = String(text).trim();
    const looksHydrated = () => {
      const current = uaiosContinuityFindComposer();
      if (!current || !uaiosContinuityIsVisibleComposer(current)) return false;
      const observed = uaiosContinuityComposerText(current).trim();
      return Boolean(
        observed.startsWith('UAIOS CONTINUITY BOOTSTRAP') &&
        observed.length >= Math.min(120, expected.length)
      );
    };
    const insertOnce = () => {
      const composer = uaiosContinuityFindComposer();
      if (!composer) return false;
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(composer, text);
        else composer.value = text;
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text
        }));
        return true;
      }
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection?.removeAllRanges();
        selection?.addRange(range);
        composer.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          composed: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        }));
        if (document.execCommand?.('insertText', false, text)) return true;
      } catch (_) {}
      composer.replaceChildren(document.createTextNode(text));
      composer.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text
      }));
      return true;
    };

    // ChatGPT/React can briefly accept a DOM write and then reconcile it away.
    // Require the bootstrap to survive multiple render cycles before declaring success.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!insertOnce()) return false;
      let stable = true;
      for (const delay of [180, 650, 1400]) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (!looksHydrated()) {
          stable = false;
          break;
        }
      }
      if (stable) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    return false;
  }

  function uaiosContinuityProjectLandingUrl(scope = uaiosContinuityScopeId()) {
    if (!scope || scope === 'general' || scope === '/') return `${location.origin}/`;
    if (/^\/g\/g-p-[^/]+$/i.test(scope)) return new URL(`${scope}/project`, location.origin).href;
    return new URL(scope, location.origin).href;
  }

  function uaiosContinuityDiscoverProjectLandingHref(scope = uaiosContinuityScopeId()) {
    if (!scope || scope === 'general' || scope === '/') return `${location.origin}/`;
    const normalizePath = (value) => String(value || '').replace(/\/+$/, '') || '/';
    const targetPath = normalizePath(scope);
    const preferredLandingPath = /^\/g\/g-p-[^/]+$/i.test(targetPath) ? `${targetPath}/project` : targetPath;
    const candidates = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => { try { return new URL(anchor.href, location.href); } catch (_) { return null; } })
      .filter((url) => url && url.origin === location.origin);
    const exact = candidates.find((url) => normalizePath(url.pathname) === preferredLandingPath);
    if (exact) return exact.href;
    return uaiosContinuityProjectLandingUrl(scope);
  }
  function uaiosContinuityRecoverProjectLanding() {
    if (isConversationPage() || uaiosContinuityScopeId() !== 'general') return false;
    const pending = uaiosContinuityReadPendingRollovers();
    const now = Date.now();
    const candidates = Object.values(pending).filter((record) => {
      const createdAt = Date.parse(record?.created_at || '');
      return Number.isFinite(createdAt) && now - createdAt <= UAIOS_PENDING_ROLLOVER_TTL_MS
        && /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/project(?:[?#].*)?$/i.test(String(record?.project_href || ''));
    }).sort((a,b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const record = candidates[0];
    if (!record || Number(record.redirect_attempts || 0) >= 1) return false;
    record.redirect_attempts = Number(record.redirect_attempts || 0) + 1;
    pending[record.scope] = record;
    uaiosContinuityWriteObject(UAIOS_PENDING_ROLLOVERS_KEY, pending);
    location.replace(record.project_href);
    return true;
  }

  async function uaiosContinuityApplyPendingRollover() {
    if (uaiosContinuityRecoverProjectLanding()) return false;
    let pending = uaiosContinuityGetPendingRollover();
    if (!pending) {
      const bridged = await uaiosContinuityBridgeRequest('getPending');
      if (bridged && bridged.scope === uaiosContinuityScopeId()) {
        pending = uaiosContinuitySetPendingRollover(bridged);
        uaiosContinuityRenderPanel();
      }
    }
    if (!pending || isConversationPage()) return false;
    if (pending.handoff_state === 'staged') {
      const createdAt = Date.parse(pending.created_at || '');
      if (Number.isFinite(createdAt) && Date.now() - createdAt < UAIOS_STAGED_HANDOFF_WAIT_MS) return false;
    }
    const upgradedBootstrap = uaiosContinuityUpgradeLegacyBootstrap(pending.bootstrap);
    if (upgradedBootstrap && upgradedBootstrap !== pending.bootstrap) {
      pending = uaiosContinuitySetPendingRollover({ ...pending, bootstrap: upgradedBootstrap });
      void uaiosContinuityBridgeRequest('savePending', { record: pending }, 1200);
      uaiosWatchdogRecordEvent('legacy_bootstrap_upgraded', {
        scope: pending.scope,
        sourceConversationId: pending.source_conversation_id
      });
    }
    if (!await uaiosContinuityFillComposer(pending.bootstrap)) {
      uaiosWatchdogRecordEvent('rollover_bootstrap_fill_failed', {
        scope: pending.scope,
        sourceConversationId: pending.source_conversation_id
      });
      uaiosContinuitySetPanelNote('Composer hydration failed; pending handoff kept. Use Resume Handoff.', 'warn');
      uaiosContinuityRenderPanel();
      return false;
    }
    uaiosContinuityClearPendingRollover(pending.scope);
    void uaiosContinuityBridgeRequest('clearPending');
    uaiosWatchdogRecordEvent('rollover_bootstrap_applied', {
      scope: pending.scope,
      sourceConversationId: pending.source_conversation_id
    });
    uaiosContinuitySetPanelNote('Handoff loaded into the composer. Review, then send.', 'success');
    return true;
  }

  function uaiosContinuityStageRollover() {
    const checkpoint = uaiosContinuityLatestCheckpoint();
    if (!checkpoint) return null;
    const projectHref = uaiosContinuityDiscoverProjectLandingHref(checkpoint.scope);
    const record = uaiosContinuitySetPendingRollover({
      scope: checkpoint.scope, created_at: new Date().toISOString(),
      source_conversation_id: checkpoint.source_conversation_id, source_url: location.href,
      project_href: projectHref, redirect_attempts: 0, bootstrap: uaiosContinuityBuildBootstrap(checkpoint),
      handoff_state: 'staged', handoff_id: `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
    void uaiosContinuityBridgeRequest('savePending', { record }, 1200);
    return record;
  }

  async function uaiosContinuityPrepareRollover(preopenedTab = null, stagedRecord = null) {
    if (uaiosCheckpointInFlight) return null;
    uaiosCheckpointInFlight = true;
    uaiosContinuityRenderPanel();
    try {
      const checkpoint = await uaiosContinuityCheckpointNow();
      const bootstrap = uaiosContinuityBuildBootstrap(checkpoint);
      const projectHref = uaiosContinuityDiscoverProjectLandingHref(checkpoint.scope);
      const record = uaiosContinuitySetPendingRollover({
        scope: checkpoint.scope,
        created_at: stagedRecord?.created_at || new Date().toISOString(),
        source_conversation_id: checkpoint.source_conversation_id,
        source_url: location.href,
        project_href: projectHref,
        redirect_attempts: Number(stagedRecord?.redirect_attempts || 0),
        bootstrap,
        handoff_state: 'ready',
        handoff_id: stagedRecord?.handoff_id || `handoff-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
      await uaiosContinuityBridgeRequest('savePending', { record });
      try {
        await navigator.clipboard?.writeText?.(bootstrap);
      } catch (_) {
        // Clipboard is a convenience fallback only.
      }
      uaiosWatchdogRecordEvent('rollover_prepared', {
        scope: record.scope,
        sourceConversationId: record.source_conversation_id
      });
      const targetUrl = record.project_href || uaiosContinuityProjectLandingUrl(record.scope);
      let opened = false;
      if (preopenedTab && !preopenedTab.closed) {
        opened = true;
        uaiosContinuitySetPanelNote('Project tab opened. Waiting for bootstrap hydration.', 'success');
      }
      if (!opened) opened = Boolean(await uaiosContinuityBridgeRequest('openHandoffTab', { record }, 5000));
      if (!opened) {
        const fallbackTab = window.open(targetUrl, '_blank', 'noopener');
        if (!fallbackTab) uaiosContinuitySetPanelNote('Browser handoff controller unavailable. Bootstrap copied; open a fresh chat in this Project.', 'warn');
      }
      return record;
    } catch (error) {
      throw error;
    } finally {
      uaiosCheckpointInFlight = false;
      uaiosContinuityRenderPanel();
    }
  }
  function uaiosContinuityEnsureStyles() {
    if (document.getElementById(UAIOS_CONTINUITY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = UAIOS_CONTINUITY_STYLE_ID;
    style.textContent = `
      #${UAIOS_CONTINUITY_PANEL_ID} {
        position: fixed; right: 14px; bottom: 72px; z-index: 2147483000;
        display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
        width: fit-content; max-width: min(720px, calc(100vw - 28px)); padding: 5px 6px;
        border: 1px solid rgba(127,127,127,.22); border-radius: 11px;
        background: color-mix(in srgb, var(--main-surface-primary, #fff) 92%, transparent);
        box-shadow: 0 8px 26px rgba(0,0,0,.12); font: 11px/1.15 system-ui, sans-serif;
        backdrop-filter: blur(12px) saturate(118%);
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-version],
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-bridge],
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-state],
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-rate-limit],
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-load] {
        padding: 3px 6px; border: 1px solid rgba(127,127,127,.16); border-radius: 999px;
        background: color-mix(in srgb, var(--main-surface-secondary, #f4f4f4) 76%, transparent);
        font-weight: 600; letter-spacing: .005em; white-space: nowrap;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} button {
        border: 1px solid rgba(127,127,127,.22); border-radius: 7px;
        padding: 4px 7px; background: color-mix(in srgb, var(--main-surface-secondary, #f4f4f4) 90%, transparent);
        color: inherit; cursor: pointer; white-space: nowrap; transition: background .16s ease, border-color .16s ease, transform .16s ease;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} button:hover:not(:disabled) {
        background: color-mix(in srgb, #2563eb 8%, var(--main-surface-secondary, #f4f4f4));
        border-color: color-mix(in srgb, #2563eb 34%, rgba(127,127,127,.22));
        transform: translateY(-1px);
      }
      #${UAIOS_CONTINUITY_PANEL_ID} button:disabled { opacity: .55; cursor: wait; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-action="toggle"][data-uaios-status="on"] {
        color: color-mix(in srgb, #059669 82%, currentColor);
        background: color-mix(in srgb, #10b981 10%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #10b981 34%, rgba(127,127,127,.18)); font-weight: 750;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-action="toggle"][data-uaios-status="off"] {
        color: color-mix(in srgb, #64748b 78%, currentColor);
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-version] {
        color: color-mix(in srgb, #64748b 74%, currentColor);
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-bridge="ok"] {
        color: color-mix(in srgb, #0f766e 82%, currentColor);
        background: color-mix(in srgb, #14b8a6 9%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #14b8a6 28%, rgba(127,127,127,.16));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-bridge="fail"] {
        color: color-mix(in srgb, #b91c1c 82%, currentColor);
        background: color-mix(in srgb, #ef4444 9%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #ef4444 30%, rgba(127,127,127,.16));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-state]:not([data-uaios-state="wait"]) {
        color: color-mix(in srgb, #4f46e5 78%, currentColor);
        background: color-mix(in srgb, #6366f1 8%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #6366f1 24%, rgba(127,127,127,.16));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-rate-limit="cooling"] {
        color: color-mix(in srgb, #b45309 86%, currentColor);
        background: color-mix(in srgb, #f59e0b 11%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #f59e0b 32%, rgba(127,127,127,.16));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-load="normal"] {
        color: color-mix(in srgb, #475569 78%, currentColor);
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-load="elevated"] {
        color: color-mix(in srgb, #a16207 84%, currentColor);
        background: color-mix(in srgb, #eab308 9%, var(--main-surface-primary, #fff));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-load="high"] {
        color: color-mix(in srgb, #c2410c 86%, currentColor);
        background: color-mix(in srgb, #f97316 10%, var(--main-surface-primary, #fff));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} > [data-uaios-load="critical"] {
        color: color-mix(in srgb, #b91c1c 86%, currentColor);
        background: color-mix(in srgb, #ef4444 10%, var(--main-surface-primary, #fff));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-action="handoff"] {
        color: color-mix(in srgb, #1d4ed8 82%, currentColor);
        background: color-mix(in srgb, #3b82f6 9%, var(--main-surface-primary, #fff));
        border-color: color-mix(in srgb, #3b82f6 30%, rgba(127,127,127,.18)); font-weight: 700;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-drag-handle] {
        display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 22px; border-radius: 6px;
        cursor: grab; user-select: none; touch-action: none; opacity: .62;
      }
      #${UAIOS_CONTINUITY_PANEL_ID}[data-uaios-dragging="true"] [data-uaios-drag-handle] { cursor: grabbing; opacity: 1; }
      #${UAIOS_CONTINUITY_PANEL_ID}[data-uaios-load="high"], #${UAIOS_CONTINUITY_PANEL_ID}[data-uaios-load="critical"] { border-color: rgba(245,158,11,.8); }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-status="on"] { font-weight: 700; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-load="high"],
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-load="critical"] { font-weight: 700; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-note] { flex-basis: 100%; opacity: .78; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-note]:empty { display: none; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more] { position: relative; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more] > summary {
        list-style: none; border: 1px solid rgba(127,127,127,.20); border-radius: 7px;
        padding: 4px 8px; background: color-mix(in srgb, var(--main-surface-secondary, #f4f4f4) 88%, transparent);
        color: color-mix(in srgb, #64748b 70%, currentColor); cursor: pointer; user-select: none; font-weight: 700;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more] > summary:hover {
        background: color-mix(in srgb, #2563eb 7%, var(--main-surface-secondary, #f4f4f4));
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more] > summary::-webkit-details-marker { display: none; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more-menu] {
        position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 2;
        min-width: 210px; padding: 8px; border: 1px solid rgba(127,127,127,.28);
        border-radius: 12px; background: var(--main-surface-primary, #fff);
        box-shadow: 0 8px 24px rgba(0,0,0,.16);
        display: grid; gap: 6px;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more-menu] [data-uaios-menu-title] {
        padding: 2px 4px 4px; opacity: .66; font-size: 11px; font-weight: 700;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-more-menu] button { width: 100%; text-align: left; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-submenu] { position: relative; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-submenu] > summary {
        list-style: none; width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px;
        cursor: pointer; user-select: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-submenu] > summary:hover { background: rgba(127,127,127,.10); }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-submenu] > summary::after { content: '›'; opacity: .55; font-size: 16px; line-height: 1; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-submenu] > summary::-webkit-details-marker { display: none; }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-menu] {
        position: absolute; right: calc(100% + 8px); bottom: 0; z-index: 3;
        min-width: 178px; padding: 8px; border: 1px solid rgba(127,127,127,.28);
        border-radius: 12px; background: var(--main-surface-primary, #fff);
        box-shadow: 0 8px 24px rgba(0,0,0,.16); display: grid; gap: 6px;
      }
      #${UAIOS_CONTINUITY_PANEL_ID} [data-uaios-recovery-menu] button { width: 100%; text-align: left; }
      @media (max-width: 700px) { #${UAIOS_CONTINUITY_PANEL_ID} { left: 10px; right: 10px; bottom: 72px; } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  function uaiosContinuityReadPanelPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(UAIOS_CONTINUITY_PANEL_POSITION_KEY) || 'null');
      const x = Number(value?.x);
      const y = Number(value?.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch (_) {
      return null;
    }
  }

  function uaiosContinuityClampPanelPosition(panel, x, y) {
    const margin = 8;
    const rect = panel.getBoundingClientRect();
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      x: Math.min(Math.max(margin, Number(x) || margin), maxX),
      y: Math.min(Math.max(margin, Number(y) || margin), maxY)
    };
  }

  function uaiosContinuityApplyPanelPosition(panel, position = uaiosContinuityReadPanelPosition()) {
    if (!panel || !position) return false;
    const clamped = uaiosContinuityClampPanelPosition(panel, position.x, position.y);
    panel.style.left = `${Math.round(clamped.x)}px`;
    panel.style.top = `${Math.round(clamped.y)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.dataset.uaiosPositioned = 'true';
    return clamped;
  }

  function uaiosContinuitySavePanelPosition(panel) {
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const clamped = uaiosContinuityClampPanelPosition(panel, rect.left, rect.top);
    localStorage.setItem(UAIOS_CONTINUITY_PANEL_POSITION_KEY, JSON.stringify(clamped));
    return clamped;
  }

  function uaiosContinuityResetPanelPosition(panel) {
    localStorage.removeItem(UAIOS_CONTINUITY_PANEL_POSITION_KEY);
    panel.style.removeProperty('left');
    panel.style.removeProperty('top');
    panel.style.removeProperty('right');
    panel.style.removeProperty('bottom');
    delete panel.dataset.uaiosPositioned;
  }

  function uaiosContinuityInstallPanelDragging(panel) {
    if (!panel || panel.dataset.uaiosDragReady === 'true') return;
    const handle = panel.querySelector('[data-uaios-drag-handle]');
    if (!handle) return;
    panel.dataset.uaiosDragReady = 'true';
    let drag = null;
    let lastHandleClickAt = 0;
    let lastHandleClickPoint = null;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        startX: event.clientX,
        startY: event.clientY
      };
      panel.dataset.uaiosDragging = 'true';
      try { handle.setPointerCapture(event.pointerId); } catch (_) {}
      // Keep compatibility mouse events enabled; reset is also handled from pointer releases.
    });

    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const position = uaiosContinuityClampPanelPosition(
        panel,
        event.clientX - drag.offsetX,
        event.clientY - drag.offsetY
      );
      uaiosContinuityApplyPanelPosition(panel, position);
      event.preventDefault();
    });

    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = event.type === 'pointercancel' ||
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6;
      if (moved) {
        uaiosContinuitySavePanelPosition(panel);
        lastHandleClickAt = 0;
        lastHandleClickPoint = null;
      } else {
        const now = Date.now();
        const closeEnough = lastHandleClickPoint &&
          Math.hypot(event.clientX - lastHandleClickPoint.x, event.clientY - lastHandleClickPoint.y) <= 8;
        if (lastHandleClickAt && now - lastHandleClickAt <= 450 && closeEnough) {
          uaiosContinuityResetPanelPosition(panel);
          lastHandleClickAt = 0;
          lastHandleClickPoint = null;
        } else {
          uaiosContinuitySavePanelPosition(panel);
          lastHandleClickAt = now;
          lastHandleClickPoint = { x: event.clientX, y: event.clientY };
        }
      }
      drag = null;
      delete panel.dataset.uaiosDragging;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);

    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      uaiosContinuityResetPanelPosition(panel);
    });

    window.addEventListener('resize', () => {
      if (!panel.isConnected || panel.dataset.uaiosPositioned !== 'true') return;
      const rect = panel.getBoundingClientRect();
      const position = uaiosContinuityClampPanelPosition(panel, rect.left, rect.top);
      uaiosContinuityApplyPanelPosition(panel, position);
      localStorage.setItem(UAIOS_CONTINUITY_PANEL_POSITION_KEY, JSON.stringify(position));
    }, { passive: true });
  }

  function uaiosContinuitySetPanelNote(message, kind = 'info') {
    const panel = document.getElementById(UAIOS_CONTINUITY_PANEL_ID);
    const note = panel?.querySelector('[data-uaios-note]');
    if (!note) return;
    note.textContent = message || '';
    note.dataset.kind = kind;
    window.clearTimeout(uaiosPanelNoteTimer);
    if (message) {
      uaiosPanelNoteTimer = window.setTimeout(() => {
        if (note.isConnected) note.textContent = '';
      }, 9000);
    }
  }

  function uaiosContinuityRenderPanel() {
    const panel = document.getElementById(UAIOS_CONTINUITY_PANEL_ID);
    if (!panel) return;
    const enabled = uaiosWatchdogIsEnabled();
    const load = uaiosContinuityLoadAssessment();
    const pending = uaiosContinuityGetPendingRollover();
    const toggle = panel.querySelector('[data-uaios-action="toggle"]');
    const loadEl = panel.querySelector('[data-uaios-load]');
    const bridgeEl = panel.querySelector('[data-uaios-bridge]');
    const stateEl = panel.querySelector('[data-uaios-state]');
    const rateLimitEl = panel.querySelector('[data-uaios-rate-limit]');
    const checkpoint = panel.querySelector('[data-uaios-action="checkpoint"]');
    const handoff = panel.querySelector('[data-uaios-action="handoff"]');
    const resume = panel.querySelector('[data-uaios-action="resume"]');
    const exportRaw = panel.querySelector('[data-uaios-action="export-raw"]');
    const exportHandoff = panel.querySelector('[data-uaios-action="export-handoff"]');
    const exportRecovery = panel.querySelector('[data-uaios-action="export-recovery"]');
    const importRecovery = panel.querySelector('[data-uaios-action="import-recovery"]');
    toggle.textContent = enabled ? 'Continuity ON' : 'Continuity OFF';
    toggle.title = enabled
      ? 'Continuity automation is enabled.'
      : 'Continuity automation is paused.';
    toggle.dataset.uaiosStatus = enabled ? 'on' : 'off';
    bridgeEl.textContent = `Bridge ${uaiosBridgeHealth === 'ok' ? 'OK' : uaiosBridgeHealth === 'fail' ? 'FAIL' : '…'}`;
    bridgeEl.title = 'Bridge is the local MAIN ↔ extension handoff channel. OK means cross-tab continuity transport is available.';
    bridgeEl.dataset.uaiosBridge = uaiosBridgeHealth;
    const stateSource = uaiosContinuityLatestCheckpoint()?.project_state?.state_source || '';
    stateEl.textContent = 'State ' + (stateSource.includes('manual') ? 'M+A' : stateSource ? 'AUTO' : 'WAIT');
    stateEl.title = stateSource.includes('manual')
      ? 'Project State combines manual state with auto-derived continuity state.'
      : stateSource
        ? 'Project State is auto-derived from recent conversation evidence.'
        : 'Project State is not ready yet.';
    stateEl.dataset.uaiosState = stateSource || 'wait';
    const rateLimitRemainingMs = uaiosRateLimitRemainingMs();
    const rateLimitCooling = rateLimitRemainingMs > 0;
    if (rateLimitEl) {
      if (rateLimitCooling) {
        const totalSeconds = Math.max(0, Math.ceil(rateLimitRemainingMs / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        rateLimitEl.hidden = false;
        rateLimitEl.textContent = `Cool ${minutes}:${seconds}`;
        rateLimitEl.title = 'Local rate-limit cooling. Continuity waits before making request-generating actions.';
        rateLimitEl.dataset.uaiosRateLimit = 'cooling';
      } else {
        rateLimitEl.hidden = true;
        rateLimitEl.textContent = '';
        rateLimitEl.dataset.uaiosRateLimit = 'idle';
      }
    }
    loadEl.textContent = `Load ${load.level} · ${load.messages}/${Math.round(load.chars / 1000)}k`;
    loadEl.title = `Heuristic conversation load: ${load.messages} messages and ${load.chars.toLocaleString()} content characters. This is not a token meter.`;
    loadEl.dataset.uaiosLoad = load.level;
    panel.dataset.uaiosLoad = load.level;
    const currentConversationId = getConversationIdFromUrl();
    const autoHandoffQueue = uaiosContinuityReadAutoHandoffQueue();
    const handoffQueued = Boolean(
      currentConversationId &&
      autoHandoffQueue?.source_conversation_id === currentConversationId
    );
    const coolingSeconds = Math.max(0, Math.ceil(rateLimitRemainingMs / 1000));
    const coolingMinutes = Math.floor(coolingSeconds / 60);
    const coolingRemainder = String(coolingSeconds % 60).padStart(2, '0');
    if (uaiosAutoHandoffInFlight) {
      handoff.textContent = 'Opening New Chat…';
    } else if (rateLimitCooling && handoffQueued) {
      handoff.textContent = `Handoff QUEUED · ${coolingMinutes}:${coolingRemainder}`;
    } else if (rateLimitCooling) {
      handoff.textContent = `Queue Handoff · ${coolingMinutes}:${coolingRemainder}`;
    } else {
      handoff.textContent = ['high', 'critical'].includes(load.level) ||
        uaiosContinuityAutoHandoffEligible(load)
        ? '⚠ New Chat Handoff'
        : 'New Chat Handoff';
    }
    const generationActive = uaiosContinuityGenerationInProgress();
    checkpoint.disabled = uaiosCheckpointInFlight || generationActive || rateLimitCooling || !isConversationPage();
    handoff.disabled = uaiosCheckpointInFlight || uaiosAutoHandoffInFlight || generationActive || !isConversationPage();
    if (exportRaw) exportRaw.disabled = uaiosExportInFlight || generationActive || rateLimitCooling || !isConversationPage();
    if (exportHandoff) exportHandoff.disabled = uaiosExportInFlight || generationActive || rateLimitCooling || !isConversationPage();
    if (exportRecovery) exportRecovery.disabled = uaiosExportInFlight || uaiosRecoveryImportInFlight || generationActive || !uaiosContinuityLatestCheckpoint();
    if (importRecovery) importRecovery.disabled = uaiosExportInFlight || uaiosRecoveryImportInFlight;
    resume.hidden = !pending || isConversationPage();
  }
  async function uaiosContinuityRunRecoveryImport(file) {
    if (uaiosRecoveryImportInFlight) return;
    uaiosRecoveryImportInFlight = true;
    uaiosContinuityRenderPanel();
    uaiosContinuitySetPanelNote('Validating Recovery Snapshot…', 'info');
    try {
      const result = await uaiosContinuityImportRecoveryFile(file);
      if (result?.cancelled) {
        uaiosContinuitySetPanelNote('Recovery restore cancelled. No local state changed.', 'info');
      } else if (result) {
        const suffix = result.historyError
          ? ` Latest checkpoint/state restored; history import warning: ${result.historyError}`
          : ` Restored ${result.historyRestored} history checkpoints.`;
        uaiosContinuitySetPanelNote(`Manual recovery complete.${suffix} No message sent.`, result.historyError ? 'warn' : 'success');
      }
    } catch (error) {
      uaiosWatchdogRecordEvent('recovery_snapshot_import_failed', { message: toErrorMessage(error) });
      uaiosContinuitySetPanelNote(`Recovery import failed: ${toErrorMessage(error)}`, 'error');
    } finally {
      uaiosRecoveryImportInFlight = false;
      uaiosContinuityRenderPanel();
    }
  }

  function uaiosContinuityCloseMenus() {
    const panel = document.getElementById(UAIOS_CONTINUITY_PANEL_ID);
    const recovery = panel?.querySelector('[data-uaios-recovery-submenu]');
    const more = panel?.querySelector('[data-uaios-more]');
    if (recovery) recovery.open = false;
    if (more) more.open = false;
  }

  async function uaiosContinuityHandlePanelAction(action) {
    if (action === 'toggle') {
      uaiosWatchdogSetEnabled(!uaiosWatchdogIsEnabled());
      uaiosContinuityRenderPanel();
      return;
    }
    if (action === 'import-recovery') {
      uaiosContinuityCloseMenus();
      if (uaiosRecoveryImportInFlight) return;
      uaiosContinuityPromptRecoveryImport();
      return;
    }
    if (action === 'export-recovery') {
      if (uaiosExportInFlight) return;
      uaiosContinuityCloseMenus();
      if (!uaiosContinuityLatestCheckpoint()) {
        uaiosContinuitySetPanelNote('Save a Checkpoint before exporting recovery history.', 'warn');
        return;
      }
      uaiosExportInFlight = true;
      uaiosContinuityRenderPanel();
      uaiosContinuitySetPanelNote('Building recovery snapshot…', 'info');
      try {
        const bundle = await uaiosContinuityExportRecoverySnapshot();
        uaiosContinuitySetPanelNote(`Recovery snapshot downloaded: ${bundle.history.length} checkpoints.`, 'success');
      } catch (error) {
        uaiosWatchdogRecordEvent('recovery_snapshot_export_failed', { message: toErrorMessage(error) });
        uaiosContinuitySetPanelNote(`Recovery export failed: ${toErrorMessage(error)}`, 'error');
      } finally {
        uaiosExportInFlight = false;
        uaiosContinuityRenderPanel();
      }
      return;
    }
    if (action === 'export-raw' || action === 'export-handoff') {
      if (uaiosExportInFlight) return;
      uaiosContinuityCloseMenus();
      const conversationId = getConversationIdFromUrl();
      if (!conversationId) {
        uaiosContinuitySetPanelNote('Open a saved ChatGPT conversation before exporting.', 'warn');
        return;
      }
      uaiosExportInFlight = true;
      uaiosContinuityRenderPanel();
      const isRaw = action === 'export-raw';
      uaiosContinuitySetPanelNote(isRaw ? 'Exporting Raw JSON…' : 'Exporting Handoff JSON…', 'info');
      try {
        assertConversationStillCurrent(conversationId, 'export start');
        if (isRaw) {
          await exportRawConversationFiles(conversationId, () => {});
        } else {
          await exportHandoffFile(conversationId, () => {});
        }
        assertConversationStillCurrent(conversationId, 'export finish');
        uaiosContinuitySetPanelNote(isRaw ? 'Raw JSON download started.' : 'Handoff JSON download started.', 'success');
      } catch (error) {
        logError(isRaw ? 'Raw JSON export failed.' : 'Handoff JSON export failed.', error);
        uaiosContinuitySetPanelNote(`Export failed: ${toErrorMessage(error)}`, 'error');
      } finally {
        uaiosExportInFlight = false;
        uaiosContinuityRenderPanel();
      }
      return;
    }
    if (action === 'checkpoint') {
      if (uaiosCheckpointInFlight) return;
      uaiosCheckpointInFlight = true;
      uaiosContinuityRenderPanel();
      try {
        const record = await uaiosContinuityCheckpointNow();
        uaiosContinuitySetPanelNote(`Checkpoint saved: ${record.total_message_count} messages.`, 'success');
      } catch (error) {
        uaiosContinuitySetPanelNote(`Checkpoint failed: ${toErrorMessage(error)}`, 'error');
      } finally {
        uaiosCheckpointInFlight = false;
        uaiosContinuityRenderPanel();
      }
      return;
    }
    if (action === 'handoff') {
      if (uaiosRateLimitIsCooling()) {
        const queued = uaiosContinuityQueueAutoHandoff('manual-during-cooling');
        if (queued) {
          const remainingSeconds = Math.max(0, Math.ceil(uaiosRateLimitRemainingMs() / 1000));
          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = String(remainingSeconds % 60).padStart(2, '0');
          uaiosContinuitySetPanelNote(
            `Handoff queued. New Chat will open automatically after cooling (${minutes}:${seconds}).`,
            'success'
          );
        } else {
          uaiosContinuitySetPanelNote('Unable to queue Handoff on this page.', 'warn');
        }
        uaiosContinuityRenderPanel();
        return;
      }
      let preopenedTab = null;
      try {
        const stagedRecord = uaiosContinuityStageRollover();
        if (!stagedRecord) {
          uaiosContinuitySetPanelNote('No validated checkpoint yet. Save Checkpoint once, then retry Handoff.', 'warn');
          return;
        }
        preopenedTab = window.open(stagedRecord.project_href, '_blank');
        if (preopenedTab) {
          try { preopenedTab.opener = null; } catch (_) {}
        }
        uaiosContinuitySetPanelNote('Handoff staged locally; refreshing checkpoint…', 'info');
        await uaiosContinuityPrepareRollover(preopenedTab, stagedRecord);
        uaiosContinuityMarkAutoHandoffHandled(stagedRecord.source_conversation_id);
        uaiosContinuityWriteAutoHandoffQueue(null);
      } catch (error) {
        try { if (preopenedTab && !preopenedTab.closed) preopenedTab.close(); } catch (_) {}
        uaiosContinuitySetPanelNote(`Handoff failed: ${toErrorMessage(error)}`, 'error');
      }
      return;
    }
    if (action === 'resume') {
      if (!await uaiosContinuityApplyPendingRollover()) {
        uaiosContinuitySetPanelNote('Composer is not ready yet. Try Resume again.', 'warn');
      }
    }
  }
  function uaiosContinuityEnsurePanel() {
    uaiosContinuityEnsureStyles();
    let panel = document.getElementById(UAIOS_CONTINUITY_PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = UAIOS_CONTINUITY_PANEL_ID;
      panel.innerHTML = `
        <span data-uaios-drag-handle title="Drag to move · double-click to reset" aria-label="Drag Continuity panel">⠿</span>
        <button type="button" data-uaios-action="toggle">Continuity OFF</button>
        <span data-uaios-version>v${UAIOS_CONTINUITY_VERSION}</span>
        <span data-uaios-bridge="unknown">Bridge: …</span>
        <span data-uaios-state="wait">State: WAIT</span>
        <span data-uaios-rate-limit="idle" hidden></span>
        <span data-uaios-load="normal">Load unknown</span>
        <button type="button" data-uaios-action="handoff" title="Open or queue a fresh chat in the same Project with a continuity bootstrap.">New Chat Handoff</button>
        <details data-uaios-more>
          <summary aria-label="More Continuity actions" title="More actions">⋯</summary>
          <div data-uaios-more-menu role="menu">
            <div data-uaios-menu-title>Actions</div>
            <button type="button" data-uaios-action="checkpoint" role="menuitem">Save Checkpoint</button>
            <div data-uaios-menu-title>Advanced / Export</div>
            <button type="button" data-uaios-action="export-raw" role="menuitem">Download Raw JSON</button>
            <button type="button" data-uaios-action="export-handoff" role="menuitem">Download Handoff JSON</button>
            <details data-uaios-recovery-submenu>
              <summary role="menuitem">Recovery…</summary>
              <div data-uaios-recovery-menu role="menu" aria-label="Recovery">
                <button type="button" data-uaios-action="export-recovery" role="menuitem">Backup snapshot</button>
                <button type="button" data-uaios-action="import-recovery" role="menuitem">Restore snapshot…</button>
              </div>
            </details>
          </div>
        </details>
        <button type="button" data-uaios-action="resume" hidden>Resume Handoff</button>
        <span data-uaios-note aria-live="polite"></span>
      `;
      const moreMenu = panel.querySelector('[data-uaios-more]');
      moreMenu?.addEventListener('toggle', () => {
        if (moreMenu.open) return;
        const recoveryMenu = moreMenu.querySelector('[data-uaios-recovery-submenu]');
        if (recoveryMenu) recoveryMenu.open = false;
      });
      panel.addEventListener('click', (event) => {
        const button = event.target.closest?.('[data-uaios-action]');
        if (!button) return;
        void uaiosContinuityHandlePanelAction(button.dataset.uaiosAction);
      });
      (document.body || document.documentElement).appendChild(panel);
      uaiosContinuityInstallPanelDragging(panel);
      uaiosContinuityApplyPanelPosition(panel);
    }
    uaiosContinuityRenderPanel();
    return panel;
  }

  function uaiosContinuityGenerationInProgress() {
    if (document.querySelector('[data-testid="stop-button"]')) return true;
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      const text = uaiosWatchdogNormalizeText(button);
      if (text.includes('stop generating') || text.includes('หยุดการสร้าง') || text.includes('หยุดสร้าง')) return true;
    }
    return false;
  }

  async function uaiosContinuityAutoHandoffTick() {
    if (!uaiosWatchdogIsEnabled() || !isConversationPage()) return false;
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) return false;

    let queue = uaiosContinuityReadAutoHandoffQueue();
    const queuedForCurrent = queue?.source_conversation_id === conversationId;
    if (uaiosContinuityAutoHandoffHandled(conversationId)) {
      if (queuedForCurrent) uaiosContinuityWriteAutoHandoffQueue(null);
      return false;
    }
    if (uaiosContinuityGetPendingRollover()) return false;

    const load = uaiosContinuityLoadAssessment();
    if (!uaiosContinuityAutoHandoffEligible(load) && !queuedForCurrent) return false;
    if (!queuedForCurrent) {
      queue = uaiosContinuityQueueAutoHandoff('threshold');
    }
    if (!queue) return false;

    if (uaiosRateLimitIsCooling()) {
      uaiosContinuityRenderPanel();
      return true;
    }

    const nextAttemptAt = Number(queue.next_attempt_at || 0);
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) return false;
    if (
      document.visibilityState !== 'visible' ||
      uaiosAutoHandoffInFlight ||
      uaiosCheckpointInFlight ||
      uaiosContinuityGenerationInProgress()
    ) {
      return false;
    }

    uaiosAutoHandoffInFlight = true;
    uaiosContinuityWriteAutoHandoffQueue({
      ...queue,
      next_attempt_at: Date.now() + UAIOS_AUTO_HANDOFF_RETRY_MS
    });
    uaiosContinuityRenderPanel();
    uaiosContinuitySetPanelNote('Preparing automatic New Chat Handoff…', 'info');
    try {
      const record = await uaiosContinuityPrepareRollover();
      if (!record) throw new Error('handoff preparation did not return a rollover record');
      uaiosContinuityMarkAutoHandoffHandled(conversationId);
      uaiosContinuityWriteAutoHandoffQueue(null);
      uaiosWatchdogRecordEvent('auto_handoff_opened', {
        sourceConversationId: conversationId,
        load_level: load.level,
        messages: load.messages,
        chars: load.chars
      });
      uaiosContinuitySetPanelNote(
        'New Chat Handoff opened automatically. Review the bootstrap, then send.',
        'success'
      );
      return true;
    } catch (error) {
      const currentQueue = uaiosContinuityReadAutoHandoffQueue();
      if (currentQueue?.source_conversation_id === conversationId) {
        uaiosContinuityWriteAutoHandoffQueue({
          ...currentQueue,
          next_attempt_at: Date.now() + UAIOS_AUTO_HANDOFF_RETRY_MS
        });
      }
      uaiosWatchdogRecordEvent('auto_handoff_failed', {
        sourceConversationId: conversationId,
        message: toErrorMessage(error)
      });
      uaiosContinuitySetPanelNote(
        'Auto Handoff retry queued; no message was sent.',
        'warn'
      );
      return false;
    } finally {
      uaiosAutoHandoffInFlight = false;
      uaiosContinuityRenderPanel();
    }
  }

  async function uaiosContinuityAutoCheckpointTick() {
    if (!uaiosWatchdogIsEnabled() || !isConversationPage()) return false;
    if (uaiosRateLimitIsCooling()) return false;
    if (document.visibilityState !== 'visible' || uaiosCheckpointInFlight || uaiosContinuityGenerationInProgress()) return false;
    const latest = uaiosContinuityLatestCheckpoint();
    const lastAt = Date.parse(latest?.captured_at || '');
    if (Number.isFinite(lastAt) && Date.now() - lastAt < UAIOS_AUTO_CHECKPOINT_MS) return false;
    uaiosCheckpointInFlight = true;
    uaiosContinuityRenderPanel();
    try {
      await uaiosContinuityCheckpointNow();
      uaiosContinuityRenderPanel();
      return true;
    } catch (error) {
      uaiosWatchdogRecordEvent('auto_checkpoint_failed', { message: toErrorMessage(error) });
      return false;
    } finally {
      uaiosCheckpointInFlight = false;
      uaiosContinuityRenderPanel();
    }
  }
  function startContinuitySessionManager() {
    uaiosContinuityEnsurePanel();
    void uaiosContinuityProbeBridge();
    if (uaiosAutoCheckpointTimer) return;
    const tick = () => {
      uaiosContinuityEnsurePanel();
      void uaiosContinuityApplyPendingRollover();
      void uaiosContinuityAutoHandoffTick();
      void uaiosContinuityAutoCheckpointTick();
    };
    uaiosAutoCheckpointTimer = window.setInterval(tick, 3000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
    window.setTimeout(tick, 800);
  }

  function startContinuityWatchdog() {
    if (uaiosWatchdogTimer) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    uaiosWatchdogObserver = new MutationObserver(() => {
      if (uaiosWatchdogIsEnabled()) uaiosWatchdogScanNow();
    });
    uaiosWatchdogObserver.observe(root, { childList: true, subtree: true });
    uaiosWatchdogTimer = window.setInterval(uaiosWatchdogScanNow, UAIOS_WATCHDOG_SCAN_MS);
    window.UAIOSContinuity = Object.freeze({
      enable: () => uaiosWatchdogSetEnabled(true),
      disable: () => uaiosWatchdogSetEnabled(false),
      status: uaiosWatchdogStatus,
      scanNow: uaiosWatchdogScanNow,
      recentEvents: () => uaiosWatchdogReadEvents().slice(-50),
      scopeId: uaiosContinuityScopeId,
      getState: uaiosContinuityGetState,
      setState: uaiosContinuitySetState,
      deriveState: (messages, title) => uaiosContinuityDeriveProjectState(messages, title),
      formatState: uaiosContinuityFormatProjectState,
      checkpointNow: uaiosContinuityCheckpointNow,
      latestCheckpoint: uaiosContinuityLatestCheckpoint,
      buildBootstrap: uaiosContinuityBuildBootstrap,
      copyBootstrap: uaiosContinuityCopyBootstrap,
      clearCheckpoint: uaiosContinuityClearCheckpoint,
      recoveryHistory: () => uaiosContinuityRecoveryList(),
      exportRecoverySnapshot: uaiosContinuityExportRecoverySnapshot,
      validateRecoverySnapshot: (bundle) => uaiosContinuityValidateRecoveryBundle(bundle, uaiosContinuityScopeId()),
      restoreRecoverySnapshot: uaiosContinuityRestoreRecoveryBundle,
      loadAssessment: uaiosContinuityLoadAssessment,
      prepareRollover: uaiosContinuityPrepareRollover,
      pendingRollover: uaiosContinuityGetPendingRollover,
      applyPendingRollover: uaiosContinuityApplyPendingRollover,
      probeBridge: uaiosContinuityProbeBridge,
      bridgeStatus: () => uaiosBridgeHealth
    });
    uaiosWatchdogRecordEvent('watchdog_loaded', { enabled: uaiosWatchdogIsEnabled() });
    if (uaiosWatchdogIsEnabled()) uaiosWatchdogScanNow();
  }

  function startUi() {
    if (uiStarted) {
      return;
    }
    uiStarted = true;
    installHistoryListener();
    installTitleObserver();
    ensureButtonsSoon();
    ensureBatchUi();
    startContinuityWatchdog();
    startContinuitySessionManager();
    startLightPolling();
  }
  // ============================================================
  // 七、啟動腳本
  // ============================================================
  /*
   * 越早包裝 fetch，越有機會被動取得 ChatGPT request context 與 observed response。
   * 正式匯出仍會使用獨立重抓與完整性驗證，不把被動 capture 視為 authoritative raw。
   *
   * UI 插入則等 DOM 可用後再開始。
   */
  installFetchInterceptor();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startUi, { once: true });
  } else {
    startUi();
  }
})();