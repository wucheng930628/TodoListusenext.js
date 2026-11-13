# Phase 3 本機 Route Handlers

主看板 UI 與 localStorage 完全維持原流程，沒有自動匯入。Repository、資料模型及現有索引沒有變更。以下 API 只提供已明確啟用的單人本機開發環境，不是正式授權機制。

## 啟動與限制

```powershell
npm.cmd run dev:api
```

此指令將 Next dev 綁定在 `127.0.0.1:3000`，程序內啟用 `SLOWLY_LOCAL_API=1`，並設定本機 origin 及 DynamoDB endpoint。使用 `http://127.0.0.1:3000` 存取。若 3000 已使用，請自行結束原本開發伺服器後再啟動；腳本不會終止其他伺服器。

一般 `npm run dev` 預設不啟用 API；production 一律拒絕存取，即使啟用變數存在也回傳 403。不要部署本專案到公開環境。Host 必須符合指定 loopback origin，寫入必須帶相同 Origin；跨來源、非 loopback 代理資訊會被拒絕，不提供 CORS 存取。Next dev 內部可能將 Request.url 正規化為 localhost，因此在仍嚴格核對原始 Host、port、Origin 的條件下允許此正規化。

所有 handler 使用 Node.js runtime、動態處理及 no-store。AWS SDK、Repository 都留在 server-only 模組，通過存取檢查後才載入資料庫入口。SDK Client 拒絕真實 AWS endpoint。

## 共同格式

請使用 `encodeURIComponent` 編碼路徑與 query 的資料庫 ID，因為 ID 內含 `#`。

成功單筆回應（POST 為 201，其他讀取／更新為 200）：

```json
{
  "data": {
    "id": "SLOWLY#TASK#<UUID>",
    "version": 1,
    "position": 0,
    "createdAt": "<ISO>",
    "updatedAt": "<ISO>",
    "workspaceId": "SLOWLY#WORKSPACE#<UUID>",
    "boardId": "SLOWLY#BOARD#<UUID>",
    "data": { "id": "frontend-id", "title": "任務", "status": "todo" }
  }
}
```

範例 data 為節錄，實際 Task 回傳完整前端欄位。外層 id 是資料庫 ID，data.id 保留前端 ID。列表使用 `{ "data": [...] }`。不回傳 entityType、GSI 欄位、計數等內部 metadata。DELETE 成功回傳 204，沒有 JSON body。

錯誤回應：

```json
{ "error": { "code": "CONFLICT", "message": "Version conflict. Reload before retrying." } }
```

| HTTP | code | 意義 |
| --- | --- | --- |
| 400 | VALIDATION | JSON、欄位、ID、日期或版本格式錯誤 |
| 403 | FORBIDDEN | 本機開發限制、Host 或 Origin 不符 |
| 403 | OWNERSHIP | 指定的 Workspace／Board 與資源關聯不符 |
| 404 | NOT_FOUND | 資源不存在 |
| 409 | CONFLICT | 版本衝突 |
| 409 | WIP_LIMIT | WIP 超額或設定低於進行中數量 |
| 409 | NOT_EMPTY | 看板仍有任務或小組件 |
| 500 | INTERNAL | 資料庫或未預期錯誤，回應不包含底層細節 |
| 501 | NOT_SUPPORTED | Repository 未支援的 Workspace 列舉 |

只接受 application/json。Body 上限 200,000 bytes，資料巢狀深度上限 12；未知或重複 query 參數一律 400。PATCH 是 data 第一層欄位合併；config/settings/subtasks 等指定欄位整體替換，呼叫者需傳完整新值。

## Endpoint 與 Request Body

`W`、`B`、`T`、`G` 分別代表 Workspace、Board、Task、Widget 的資料庫 ID。

| Method | Endpoint | Body／Query | 成功 |
| --- | --- | --- | --- |
| GET | /api/workspaces | `?id=W` 單筆集合查詢；沒有 id 時 501 | 200 |
| POST | /api/workspaces | `{data: workspaceData}` | 201 |
| GET | /api/workspaces/[id] | 無 | 200 |
| PATCH | /api/workspaces/[id] | `{version, data: workspacePatch}` | 200 |
| GET | /api/boards | `?workspaceId=W` | 200 |
| POST | /api/boards | `{workspaceId:W, position:0, data:boardData}` | 201 |
| GET | /api/boards/[id] | 可選 `?workspaceId=W`，提供即檢查關聯 | 200 |
| PATCH | /api/boards/[id] | `{workspaceId:W, version, data:boardPatch}` | 200 |
| DELETE | /api/boards/[id] | `{workspaceId:W, version}` | 204 |
| GET | /api/tasks | `?boardId=B`，可選 workspaceId | 200 |
| POST | /api/tasks | `{boardId:B, position:0, data:taskData}`，可選 workspaceId | 201 |
| GET | /api/tasks/[id] | 可選 boardId、workspaceId，提供即檢查關聯 | 200 |
| PATCH | /api/tasks/[id] | `{boardId:B, version, data:taskPatch}`，可選 workspaceId | 200 |
| DELETE | /api/tasks/[id] | `{boardId:B, version}`，可選 workspaceId | 204 |
| GET | /api/widgets | `?boardId=B`，可選 workspaceId | 200 |
| POST | /api/widgets | `{boardId:B, position:0, data:widgetData}`，可選 workspaceId | 201 |
| GET | /api/widgets/[id] | 可選 boardId、workspaceId，提供即檢查關聯 | 200 |
| PATCH | /api/widgets/[id] | `{boardId:B, version, data:widgetPatch}`，可選 workspaceId | 200 |
| DELETE | /api/widgets/[id] | `{boardId:B, version}`，可選 workspaceId | 204 |
| PATCH | /api/boards/order | `{workspaceId:W, entries:[{id:B,version,position}]}` | 200 |
| PATCH | /api/tasks/order | `{boardId:B, entries:[{id:T,version,position}]}`，可選 workspaceId | 200 |
| PATCH | /api/widgets/order | `{boardId:B, entries:[{id:G,version,position}]}`，可選 workspaceId | 200 |

Repository 沒有 listWorkspaces，因此 API 不實作全表列舉、不使用 Scan 補救、不改模型。未提供 Workspace DELETE，因為 Repository 沒有這項操作。

### 新增 Body 範例

```js
// POST /api/workspaces
{ data: { settings: { theme: "slowly" } } }

// POST /api/boards
{ workspaceId: W, position: 0,
  data: { id: "frontend-board", name: "工作", description: "", wipLimit: 4 } }

// POST /api/tasks
{ boardId: B, position: 0,
  data: { id: "frontend-task", title: "準備報告", status: "todo",
    priority: "高", tag: "工作", urgent: false,
    date: "2026-11-20", time: "14:00", description: "內容",
    subtasks: [{ id: "sub-1", title: "整理資料", done: false }], notes: "" } }

// POST /api/widgets
{ boardId: B, position: 0,
  data: { id: "frontend-widget", type: "note", span: 6, height: 260,
    manualSize: true, config: { text: "筆記" } } }
```

Workspace 允許 activeBoardId、settings。Board 允許 id、name、description、wipLimit、analyticsSize、settings。Task 允許既有可編輯欄位；completedAt 由伺服器管理，不能由 API 輸入或用此 API 匯入歷史。Widget 保留 id、type、span、height、manualSize、config。config 支援 text、minutes、taskId、endsAt、remaining、showCompleted。

未知 data 欄位及內部欄位（包含巢狀設定中的 entityType、GSI、version 等）會被拒絕，不會默默移除。data.id 是前端識別，不接受 SLOWLY# 開頭的資料庫 Key；更新不可變更。此限制是 API 的明確轉換契約，既有 Repository 的完整匯入功能未改變。

## 刪除與一致性

Board 必須 taskCount、widgetCount 皆為零才能刪除；不級聯刪除。Task 刪除包含其內嵌 Subtasks，並由交易更新 Board 計數；Widget 刪除包含 config。父項目的版本條件避免和新增子項目同時產生孤兒資料。

刪除任務後，Widget config.taskId 可能仍保留原前端 ID，這與現有 UI 的選擇器行為一致，是軟參照；目前 API 不自動清除其他設定。未新增歷史統計系統。

每次更動需使用最新 version。修改子項目也會增加 Board 版本，因此編輯 Board 前需要重新讀取。排序最多 99 筆，父項目也包含在交易中。GSI 有最終一致延遲，儲存後應合併 API 回傳資料，不要立刻用舊列表覆蓋。

## React fetch 範例

以下僅為未接入 UI 的示範；請從上述 127.0.0.1 網址開啟頁面。

```js
const response = await fetch(`/api/tasks/${encodeURIComponent(databaseId)}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ boardId, version, data: { status: "doing" } }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
// 瀏覽器會為同源 PATCH 帶 Origin。
// result.data 包含新的 version 與原形狀 result.data.data。
```

CLI 呼叫需要自行帶 `Origin: http://127.0.0.1:3000`。收到 409 時保留編輯草稿，重新載入並讓使用者處理，不要自動覆寫。

## 測試與紀錄

```powershell
npm.cmd run test:api
npm.cmd run test:server
npm.cmd run test:api:http -- --isolated-local-writes
```

API 測試使用實際 Repository 搭配每組獨立的記憶體 DocumentClient，驗證 HTTP 狀態、格式、CRUD、分頁、排序、WIP、衝突、關聯、production/CSRF 防護及資料庫失敗時的安全錯誤回應。

HTTP 測試另外啟動 `127.0.0.1:3107` 的 Next dev，使用專屬 `.next-phase3-api` 編譯目錄，避免干擾既有 dev session。只在 test 環境變數啟用時改用該目錄，正常 UI/build 設定維持原目錄。Windows 需允許腳本清理自己啟動的程序；未能清理會記錄 PID 並回報失敗，不忽略錯誤。

本次真實 HTTP 測試成功執行 50 次請求，建立 2 Workspace、2 Board、2 Task、2 Widget；本次資料全部清理，原有 1 筆資料雜湊一致。連線失敗使用可控的 DocumentClient 故障注入驗證，不停止 Docker 或影響原開發服務。

最後驗證：7 組 API 測試與 6 組 Phase 2 迴歸測試全部通過，build 通過。本次新增／修改的程式通過 lint；全專案 lint 仍有既有 page.js 的 3 errors 與 task-analytics.js 的 1 warning，依本階段限制沒有修改 UI 以消除這些問題。

`.phase3-test-runs/<runId>/report.json` 保存請求結果、建立 ID、清理及前後雜湊，next-dev.log 保存測試伺服器日誌，均不納入 Git。API 正式查詢不使用 Scan；HTTP 測試的 Scan 僅用於前後完整性比對與辨識本次標記資料。清理同時檢查非 baseline ID、本次唯一標記及版本，不清空表、不修改既有 Item。

首次測試因已有 dev session 無法啟動；其後發現 Next Request.url 的 localhost 正規化造成 403，已修正並加入迴歸測試。這些失敗嘗試沒有寫入資料，皆完成 baseline 驗證。正式成功紀錄為 `2481973d-6f18-4780-8292-e494074aa291`。

## 尚未解決的安全與整合事項

- 沒有登入與使用者授權。親子關聯檢查只能防止指定錯誤歸屬；知道 ID 的本機程式仍能操作其他本機資料。
- Host/Origin 檢查不能取代 loopback 綁定，也無法阻止同機惡意程式。不要以代理、隧道或容器映射公開此服務。
- 尚無速率限制、分頁 API 契約、離線佇列及重試去重；底層集合查詢會讀完各頁。
- 舊 `/db-test` 沒有改動，仍為除錯入口；本專案整體尚不適合公開部署。
- 未來需要前端 adapter 保存資料庫 ID/version，處理載入、409、500；Workspace 選擇先使用明確 ID，列舉需另行確認設計。
- 此階段不接 UI、不切換 localStorage、不自動遷移資料。
