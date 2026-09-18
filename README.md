# ChatGPT Conversation Handoff Exporter

Tampermonkey userscript，用來在 ChatGPT 網頁版對話頁匯出目前對話的原始 JSON，或直接產出精簡交接用 handoff JSON。
這個工具的目標是取代手動從 DevTools 複製長 JSON response 的流程，讓使用者可以在目前正在看的單一對話中，透過頁面右上角按鈕匯出資料。

## 功能特色

- 在 ChatGPT 對話頁右上角新增兩個按鈕：
  - **下載原始 JSON**
  - **下載交接 JSON**
- 支援一般對話網址與 GPT / project 內的對話網址。
- 點擊按鈕時會即時重新抓取目前對話的最新 raw conversation JSON。
- 正式匯出 conversation JSON 時會驗證 response 完整性，不直接把頁面被動觀察到的 response 視為可信原始資料。
- conversation 與 textdocs 預設使用 XMLHttpRequest 取得；主要通道無法直接驗證時，才使用 `window.fetch` 作第二通道交叉確認，降低頁面腳本、userscript 或瀏覽器擴充功能改寫 Fetch response 導致匯出缺漏的風險。
- 會利用瀏覽器 Resource Timing 與實際 response bytes 進行完整性檢查；若無法確認 conversation 完整性，會停止 raw / handoff 匯出，避免靜默產生缺漏檔案。
- 原始 JSON 會以 4 空白縮排輸出，方便閱讀與保存。
- 若對話包含畫布 / textdocs，下載原始 JSON 時會一併下載 textdocs 原始 JSON。
- 交接 JSON 會保留目前主分支上的可見 `user` / `assistant` 訊息。
- 交接 JSON 會包含畫布 / textdocs 的內容、註解與精簡生命週期資訊。
- textdocs 抓取失敗、回傳空內容，或格式與預期不同時，會以空陣列 `[]` 處理，並繼續完成主要匯出。
- 匯出過程中，按鈕會顯示目前進度，例如正在擷取原始 JSON、正在擷取 textdocs、正在產出交接 JSON。
- 錯誤提示會盡量提供可操作建議，例如重新整理頁面、重新登入、等待對話載入完成或稍後再試。
- 不需要手動複製 DevTools response。
- 不需要執行 Python 腳本。
- 透過 Tampermonkey metadata 支援自動更新。

## 安裝

### 推薦方式：Raw URL 安裝

建議使用 Raw URL 安裝，這樣 Tampermonkey 可以依照腳本中的 `@updateURL` / `@downloadURL` 檢查更新。

1. 安裝 Tampermonkey。
2. 開啟以下 Raw URL：

   ```text
   https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
   ```

3. Tampermonkey 會開啟 userscript 安裝頁面。
4. 按下安裝。
5. 重新整理 ChatGPT 對話頁。

### 備用方式：手動安裝

如果 Raw URL 沒有自動開啟 Tampermonkey 安裝頁，也可以手動安裝：

1. 建立新的 userscript。
2. 將 `chatgpt-conversation-handoff-exporter.user.js` 的內容貼進 Tampermonkey 編輯器。
3. 儲存腳本。
4. 重新整理 ChatGPT 對話頁。

> 手動貼上安裝通常仍可使用，但自動更新行為可能不如 Raw URL 安裝穩定。

## 自動更新

若透過 Raw URL 安裝，Tampermonkey 可依照腳本中的 `@updateURL` / `@downloadURL` 檢查遠端版本。
腳本目前使用的更新來源為：

```text
https://raw.githubusercontent.com/SunnyLeu/ChatGPT-Conversation-Handoff-Exporter/main/chatgpt-conversation-handoff-exporter.user.js
```

Tampermonkey 會依照其自身設定定期檢查更新；也可以在 Tampermonkey 管理頁中手動檢查 userscript 更新。

## 使用方式

進入任一 ChatGPT 對話頁後，右上角會出現兩個按鈕：

- **下載原始 JSON**
- **下載交接 JSON**

### 下載原始 JSON

點擊 **下載原始 JSON** 會下載目前對話的原始 conversation JSON：

```text
{對話標題}-{yyyyMMddHHmmss}.json
```

如果該對話包含畫布 / textdocs，會額外下載：

```text
{對話標題}-{yyyyMMddHHmmss}.textdocs.json
```

如果該對話沒有畫布 / textdocs，或 textdocs endpoint 無法取得可用內容，則只會下載原始 conversation JSON。

### 下載交接 JSON

點擊 **下載交接 JSON** 會下載：

```text
{對話標題}-{yyyyMMddHHmmss}.handoff.json
```

交接 JSON 會把對話訊息與畫布 / textdocs 整合在同一份檔案中。

### 匯出進度

按下匯出按鈕後，按鈕文字會顯示目前處理階段，例如：

- 正在擷取原始 JSON…
- 正在下載原始 JSON…
- 正在擷取 textdocs…
- 正在下載 textdocs…
- 正在產出交接 JSON…
- 正在下載交接 JSON…

這些文字只代表瀏覽器端流程已執行到對應階段；實際下載檔案是否已寫入下載資料夾，仍以瀏覽器下載管理器為準。

> 瀏覽器可能會在第一次下載多個檔案時詢問是否允許 `chatgpt.com` 下載多個檔案。這是瀏覽器的正常安全提示。

## 匯出行為與容錯

### 對話資料

工具會被動觀察 ChatGPT 頁面自己發出的 backend API 請求，取得目前對話重新抓取資料所需的 request context。
被動觀察到的 conversation response 只作為輔助資料，不會直接視為正式匯出的可信 raw JSON。
使用者按下匯出按鈕後，工具會：

1. 重新抓取目前 conversation JSON。
2. 優先使用 XMLHttpRequest 作為正式取得通道。
3. 比較 JavaScript 實際取得的 UTF-8 response bytes 與瀏覽器 Resource Timing 的 `decodedBodySize`。
4. 若主要通道無法直接驗證，才使用第二取得通道交叉確認。
5. 只有完整性可以確認的 conversation snapshot 才會進入 raw JSON 或 handoff JSON。

若 response 大小、conversation revision 或 `mapping` 結構出現無法安全判定的差異，工具會中止本次 raw / handoff 匯出，而不是下載可能不完整的 JSON。
若目前尚未捕捉到可重用請求資訊，工具會提示使用者等待對話載入完成、重新整理頁面，或重新進入該對話後再試。

### textdocs / 畫布資料

textdocs 也會使用與 conversation 類似的 response 完整性檢查：

- 預設先使用 XMLHttpRequest 取得。
- 若主要通道無法直接確認完整性，才使用 `window.fetch` 作第二通道比較。
- 會比較 JavaScript 實際取得的 response bytes 與瀏覽器 Resource Timing。
- 若兩個通道都缺少足夠的網路層證據，只有在正規化後的 textdocs 內容完全一致時才接受。
- 不會單純因為某一份 textdocs 數量較多，就猜測它比較完整。

textdocs 是附加資料，不應阻斷主要對話匯出。
以下情況會以空陣列 `[]` 處理 textdocs，並繼續完成主要匯出：

- textdocs endpoint 無法取得。
- endpoint 回傳 `204`、`205`、`404`。
- endpoint 回傳空內容。
- endpoint 回傳非 JSON。
- endpoint 回傳格式與預期不同。
- textdocs response 無法通過完整性驗證。
- 兩個取得通道的 textdocs 內容不同，且沒有足夠證據判定哪一份可信。
- 單一 textdoc 項目格式不完整或不支援。

### 錯誤提示

匯出失敗時，工具會盡量提供具體建議：

- `401` / `403`：可能是登入狀態失效，可重新整理或重新登入後再試。
- `404`：可能已切換對話或目前 conversation ID 不一致，可確認頁面後再試。
- `408` / `425` / `429`：可能需要稍候片刻再試。
- `5xx`：可能是 ChatGPT 後端暫時異常，可稍後再試。
- 非 JSON 或非完整 conversation JSON：可重新整理頁面，等待對話載入完成後再試。
- conversation response 完整性無法確認：可能有頁面腳本、userscript 或瀏覽器擴充功能修改 API response，也可能是在驗證期間對話剛好更新。工具會停止 raw / handoff 匯出，避免輸出可能缺漏的資料。
- textdocs response 完整性無法確認：會略過 textdocs，並繼續主要 conversation 匯出。

## 交接 JSON 格式

交接 JSON 是從 ChatGPT 原始 conversation JSON 與 textdocs JSON 轉換而來的精簡格式，目標是讓新的 ChatGPT 對話能快速理解前一段對話的實際進度、訊息脈絡與畫布內容。
完整結構大致如下：

```json
{
  "title": "ChatGPT-Conversation-Handoff-Exporter",
  "create_time": "2026-05-05T07:10:00.000+00:00",
  "update_time": "2026-05-05T07:30:00.000+00:00",
  "conversation_id": "69f98abc-3ac4-8320-9afb-ad658dac4e9b",
  "messages": [
    {
      "id": "u01",
      "role": "user",
      "content": "請先完整閱讀這兩份檔案\n並掌握對話進度和程式內容"
    },
    {
      "id": "a01",
      "role": "assistant",
      "content": "已完整閱讀並掌握兩份檔案。"
    },
    {
      "id": "u02",
      "role": "user",
      "content": "幫我比較 Bookmarklet 與 Userscript 的差異"
    },
    {
      "id": "a02",
      "role": "assistant",
      "content": "以目前需求來看，Userscript 會比 Bookmarklet 更適合長期使用。",
      "cite_sources": [
        {
          "url": "https://example.com/article",
          "title": "Example Article",
          "snippet": "A short summary or excerpt of the referenced source.",
          "pub_date": "2026-05-05T00:00:00.000+00:00",
          "attribution": "Example Site"
        }
      ]
    }
  ],
  "textdocs": [
    {
      "id": "td01",
      "version": 7,
      "title": "程式碼畫布",
      "textdoc_type": "code/other",
      "created_at": "2026-05-06T03:25:27.868+00:00",
      "updated_at": "2026-05-06T03:48:35.854+00:00",
      "create_source": "model",
      "lifecycle": {
        "latest_version": 7,
        "created_version": 1,
        "update_count": 2,
        "comment_event_count": 1,
        "last_canvas_event_at": "2026-05-06T03:48:35.854+00:00"
      },
      "content": "# 超簡單 Python 程式：打招呼\n...",
      "comments": [
        {
          "id": "tdc01",
          "start": 0,
          "end": 19,
          "target_text": "# 超簡單 Python 程式：打招呼",
          "content": "這個標題很清楚；若這份程式要給初學者看，可以再補一句說明它展示的是「輸入與輸出」基本概念。"
        }
      ]
    }
  ]
}
```

## 欄位說明

### 頂層欄位

| 欄位              | 型別             | 說明                                                                                                 |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `title`           | `string \| null` | 原始 ChatGPT 對話標題。若原始資料沒有標題，可能為 `null`。                                           |
| `create_time`     | `string \| null` | 對話建立時間。若原始值是 Unix timestamp，會轉成 UTC ISO 格式，例如 `2026-05-05T07:10:00.000+00:00`。 |
| `update_time`     | `string \| null` | 對話最後更新時間。格式同 `create_time`。                                                             |
| `conversation_id` | `string \| null` | ChatGPT 原始 conversation ID。通常會對應網址中的 `/c/{conversation_id}`。                            |
| `messages`        | `array`          | 精簡後的訊息陣列，只保留目前主分支上的可見 `user` / `assistant` 訊息。                               |
| `textdocs`        | `array`          | 畫布 / textdocs 陣列。若沒有可用畫布資料，會輸出空陣列 `[]`。                                        |

### `messages[]` 單一訊息欄位

| 欄位           | 型別                    | 說明                                                                                                                                         |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `string`                | 交接檔內部使用的簡短訊息 ID。`user` 訊息會編成 `u01`, `u02`, ...；`assistant` 訊息會編成 `a01`, `a02`, ...。這不是 ChatGPT 原始 message ID。 |
| `role`         | `"user" \| "assistant"` | 訊息角色。交接檔只保留使用者與助理的實際對話訊息。                                                                                           |
| `content`      | `string`                | 訊息文字內容。會排除非文字 asset pointer，並移除 ChatGPT 內嵌引用標記，例如 `...`。                                                        |
| `cite_sources` | `array`，選填           | 僅在 `assistant` 訊息有可解析的引用來源 metadata 時出現。若沒有引用來源，這個欄位不會輸出。                                                  |

### `cite_sources[]` 引用來源欄位

| 欄位          | 型別             | 說明                                             |
| ------------- | ---------------- | ------------------------------------------------ |
| `url`         | `string \| null` | 引用來源 URL。                                   |
| `title`       | `string \| null` | 引用來源標題。                                   |
| `snippet`     | `string \| null` | 引用來源摘要、片段或簡短描述。                   |
| `pub_date`    | `string \| null` | 引用來源發布時間。若可轉換，會轉成可讀時間格式。 |
| `attribution` | `string \| null` | 來源站台、作者、發布者或歸屬資訊。               |

### `textdocs[]` 畫布欄位

| 欄位            | 型別             | 說明                                                                                           |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| `id`            | `string`         | 交接檔內部使用的畫布 ID，例如 `td01`, `td02`, ...。畫布會依建立時間由舊到新排序。              |
| `version`       | `number \| null` | 畫布目前版本。                                                                                 |
| `title`         | `string \| null` | 畫布標題。                                                                                     |
| `textdoc_type`  | `string \| null` | 畫布類型，例如 `document`、`code/other`。                                                      |
| `created_at`    | `string`，選填   | 畫布建立時間。從原始 conversation JSON 中的 canvas tool event 推得。                           |
| `updated_at`    | `string`，選填   | 畫布最後更新時間。來自 textdocs endpoint。時間會整理成毫秒 3 位與 `+00:00` UTC offset 格式。   |
| `create_source` | `string`，選填   | 畫布建立來源，例如 `model`。                                                                   |
| `lifecycle`     | `object`，選填   | 畫布生命週期摘要，例如目前版本、建立版本、更新次數、註解事件次數、最後一次 canvas event 時間。 |
| `content`       | `string`         | 畫布完整內容。若 endpoint 缺少內容，會使用空字串。                                             |
| `metadata`      | `object`，選填   | 若 textdocs endpoint 回傳非空 metadata，會保留。空物件不會輸出。                               |
| `comments`      | `array`          | 畫布註解陣列。若沒有註解，會是空陣列 `[]`。                                                    |

### `textdocs[].lifecycle` 欄位

| 欄位                   | 型別           | 說明                                                             |
| ---------------------- | -------------- | ---------------------------------------------------------------- |
| `latest_version`       | `number`，選填 | 已知最新版本。通常會等於 `version`。                             |
| `created_version`      | `number`，選填 | 建立畫布時的版本。通常是 `1`。                                   |
| `update_count`         | `number`，選填 | 從原始 conversation JSON 中觀察到的 `update_textdoc` 次數。      |
| `comment_event_count`  | `number`，選填 | 從原始 conversation JSON 中觀察到的 `comment_textdoc` 事件次數。 |
| `last_canvas_event_at` | `string`，選填 | 原始 conversation JSON 中最後一次 canvas tool event 時間。       |

### `textdocs[].comments[]` 畫布註解欄位

| 欄位          | 型別             | 說明                                                                          |
| ------------- | ---------------- | ----------------------------------------------------------------------------- |
| `id`          | `string`         | 交接檔內部使用的註解 ID，例如 `tdc01`, `tdc02`, ...。                         |
| `start`       | `number \| null` | 註解對應內容的起始位置。                                                      |
| `end`         | `number \| null` | 註解對應內容的結束位置。                                                      |
| `target_text` | `string \| null` | 根據 `start` / `end` 從 `content` 擷取出的目標文字。若位置無效，會是 `null`。 |
| `content`     | `string`         | 註解內容。                                                                    |

## 訊息順序與主分支

ChatGPT 原始 conversation JSON 的 `mapping` 是樹狀結構，不是單純的訊息陣列。
本工具會從 `current_node` 沿著 `parent` 一路回推，取得目前 UI 實際採用的主分支，再依順序輸出到 `messages`。
這代表：

- 若使用者編輯過訊息，通常會輸出目前主分支上的版本。
- 若 assistant 回覆曾重新產生，通常會輸出目前主分支採用的回覆。
- 舊分支、被替換的訊息、非目前路徑上的內容不會出現在交接 JSON。

## 轉換規則

交接 JSON 會保留：

- 對話標題
- 建立時間
- 更新時間
- conversation ID
- 目前主分支上的 `user` / `assistant` 訊息
- assistant 訊息中可取得的引用來源 metadata
- 畫布 / textdocs 目前內容
- 畫布註解
- 畫布精簡生命週期資訊

交接 JSON 會排除：

- `system` 訊息
- `tool` 訊息
- hidden 訊息
- 模型思考過程
- `reasoning_recap`
- `user_editable_context`
- 非文字 `image_asset_pointer`
- 非文字 `asset_pointer`
- assistant 工具操作 payload，例如 `search_query`, `open`, `find`, `click`
- ChatGPT 內嵌引用標記，例如 `...`
- canvas tool event 的內部追蹤欄位，例如 `request_id`、`turn_exchange_id`、`async_source`、`stream_topic_id`

## 隱私與安全

本腳本設計為手動匯出目前正在看的單一對話。
它不會：

- 上傳資料到第三方伺服器
- 批次匯出所有對話
- 背景定時抓取對話或畫布內容
- 將 token、cookie 或 session 寫死在程式碼
- 主動讀取 `document.cookie`
- 將 raw JSON 或敏感 headers 印到 Console
- 將 raw JSON 寫入 localStorage、IndexedDB 或 cookie

request context 只暫存在目前頁面的記憶體中；重新抓取同源 backend JSON 時，cookie / session 由瀏覽器透過既有登入狀態自行處理，不會手動保存或寫入 cookie header。
完整性檢查的 Console 摘要只包含必要的非內容資訊，例如 conversation ID、取得通道、response bytes、network bytes、`mapping` 節點數或 textdoc 數量；不會輸出 raw JSON、textdoc 內容、完整 headers、token 或 cookie。
textdocs 內容只會在使用者按下 **下載原始 JSON** 或 **下載交接 JSON** 時抓取。

## 限制

- 本腳本依賴 ChatGPT 網頁版目前的 DOM 與內部請求格式。
- conversation / textdocs 完整性驗證會使用瀏覽器 Resource Timing；若瀏覽器無法提供足夠資訊，工具會改用第二取得通道交叉確認，仍無法確認時會採保守處理。
- 若 ChatGPT 前端或內部 endpoint 改版，腳本可能需要更新。
- 本腳本不是 OpenAI 官方 API，也不是官方匯出功能。
- 本工具主要面向可安裝 Tampermonkey / userscript 的桌面 Chromium 瀏覽器環境。

## License

MIT

## UAIOS continuity fork additions

This fork adds an opt-in, local-only UI continuity watchdog for recoverable ChatGPT conversation interruptions.

The watchdog is disabled by default. After installing this forked userscript, enable it once from the ChatGPT browser console:

```js
UAIOSContinuity.enable()
```

Useful commands:

```js
UAIOSContinuity.status()
UAIOSContinuity.scanNow()
UAIOSContinuity.recentEvents()
UAIOSContinuity.disable()
```

Safety behavior: it only runs on conversation pages, requires an explicit Retry/Try again or Continue-generating style control, rate-limits automatic clicks, keeps only a small local event log, and does not send continuity data to any external service. External UAIOS/n8n synchronization is intentionally not part of this phase.

### Local continuity checkpoints

The fork can also save a bounded local checkpoint for the current conversation. It reuses the upstream validated handoff acquisition path, then stores only the latest 12 messages (each bounded), textdoc metadata, and optional structured project state in browser localStorage.

```js
UAIOSContinuity.setState({
  phase: 'A06',
  current_task: 'Validate staging router',
  next_action: 'Run acceptance test',
  blockers: [],
  decisions: ['GitHub is canonical evidence']
})

await UAIOSContinuity.checkpointNow()
UAIOSContinuity.latestCheckpoint()
UAIOSContinuity.buildBootstrap()
await UAIOSContinuity.copyBootstrap()
```

The bootstrap explicitly tells the next chat to verify mutable external state from canonical sources instead of trusting stale branch/PR/workflow status from the old conversation. Checkpoints remain local to the browser and no external synchronization is performed in this phase.

### Chrome unpacked extension installation

This fork can be loaded directly in current Chrome without Tampermonkey.

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the repository folder containing `manifest.json`.
5. Refresh any open `chatgpt.com` tabs.

The extension runs the upstream exporter in Chrome's `MAIN` world at `document_start` and a continuity bridge in an `ISOLATED` world. A local MV3 background service worker is used only for browser-local handoff tab control. No external endpoint or credential is included.

After loading, a small **Continuity** control panel appears on ChatGPT pages. Use the visible ON/OFF control; the console API remains available for diagnostics but is no longer required for normal use. v1.5.9 also shows **Bridge: OK/FAIL** so cross-world handoff transport is observable before starting a rollover.

### Proactive session rollover (v1.3)

When Continuity is ON, the extension keeps a validated local checkpoint for the visible active conversation at most once every 10 minutes. The panel shows a **heuristic conversation load** based on message count and message text size; this is not an OpenAI token meter and does not claim to know the model context limit.

Use **New Chat Handoff** before a long conversation becomes unreliable. v1.5.6 canonicalizes ChatGPT Project routes to the bare `g-p-<id>` because conversation URLs may include a human-readable slug while the fresh Project landing omits it; the fresh composer is therefore opened at `/g/g-p-<id>/project`. The extension-owned background controller opens the Project tab directly and tracks that tab. If ChatGPT falls back to Home, the controller performs a bounded recovery back to the stored Project landing. Pending handoff state is mirrored in `chrome.storage.local`, so recovery no longer depends on page-local storage surviving the tab transition. v1.5.5 moves MAIN↔ISOLATED communication to a shared DOM mailbox observed with `MutationObserver`, avoiding Window-wrapper identity assumptions between Chrome execution worlds. Before opening the fresh Project tab, v1.5.5 stages the latest already-validated checkpoint and bootstrap in same-origin local state and immediately mirrors that staged record through the extension bridge. The user click then opens the canonical Project landing directly; the old tab refreshes the checkpoint in the background and upgrades the same handoff record to `ready`. The fresh page waits briefly for that upgrade and can fall back to the staged checkpoint if the old chat becomes unreliable, avoiding both an `about:blank` hop and a dependency on finishing a new checkpoint before navigation. The extension refreshes the checkpoint, creates a bounded bootstrap capsule, opens the same Project in a fresh tab, and attempts to place the bootstrap into the new composer without sending it. If automatic insertion is unavailable, the bootstrap is also copied to the clipboard and **Resume Handoff** remains available.

v1.6.0 adds Project State Autopilot. Every checkpoint now derives a bounded state snapshot from recent conversation evidence: objective, phase/progress hints, current task, next action, completed work, blockers, decisions, canonical evidence hints, and do-not-redo constraints. Manually supplied state fields override or augment the derived state. The bootstrap renders this snapshot before the bounded raw continuity payload so a fresh chat can orient quickly without treating the heuristic summary as canonical truth.\n\nv1.5.9 only targets a visible, on-screen ChatGPT composer and scores the canonical #prompt-textarea highest. Hidden/off-screen contenteditable nodes are excluded from both insertion and hydration verification, preventing a false PASS from clearing pending state while the visible composer remains empty.

v1.5.8 hardens composer hydration against React reconciliation. The bootstrap must remain visible across multiple render cycles before pending state is cleared; if ChatGPT removes the programmatic text after an initial transient insert, the extension retries once and otherwise keeps the handoff recoverable through **Resume Handoff**.

v1.5.7 also makes the isolated-world DOM mailbox bridge self-healing: if ChatGPT rebuilds the early document DOM and replaces the request mailbox after document_start, the bridge detects the detached/replaced node and rebinds its MutationObserver automatically. This prevents the visible Bridge status from briefly showing OK and then falling back to FAIL on subsequent getPending calls.

v1.5.6 verifies that the bootstrap is actually visible in the ChatGPT composer before clearing pending handoff state. Contenteditable composers use a user-input-like insert path with a post-insert readback; if hydration is not confirmed, the pending handoff is kept and **Resume Handoff** remains available instead of silently discarding recovery state.

The fresh chat receives current project state, the latest bounded conversation evidence, checkpoint metadata, and a reminder to re-verify mutable external state from canonical sources. No conversation content is sent to an external continuity service.

In v1.4.0, only the short-lived pending handoff record is mirrored into `chrome.storage.local` through an isolated extension bridge. This lets a fresh tab recover the Project destination and bootstrap even when page-local state is unavailable. The bridge record expires after 30 minutes, is cleared after a successful resume, never auto-sends the composer, and is not transmitted off-device.
