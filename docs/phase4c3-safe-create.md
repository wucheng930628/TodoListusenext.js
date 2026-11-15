# Phase 4C-3 — Safe Create 與瀏覽器驗收

2026-11-15。已實作一般 CRUD Create 的原子 Receipt、結果查詢及前端 UNKNOWN 恢復。首頁預設 localStorage，API Mode 沿用 Phase 4C-2 的開發環境、隔離測試表、Workspace allowlist 與另外授權寫入限制。

## API Contract

四種 `POST /api/{workspaces|boards|tasks|widgets}` 保留既有 Body 與 `{ data: DTO }` 成功 envelope，新增選填 Header `Idempotency-Key`。

| 狀況 | HTTP | Response Header／錯誤代碼 |
| --- | --- | --- |
| 新 Key 首次建立 | 201 | `Idempotency-Status: created`、`Operation-Id: <key>` |
| 同 Key、相同 canonical request 重送 | 200 | `Idempotency-Status: replayed`、同一 Operation ID |
| 同 Key、不同內容／資源／父層範圍 | 409 | `OPERATION_CONFLICT` |
| 原有未帶 Key 的 POST | 201 | `Idempotency-Status: unprotected`，沒有安全重送保證 |
| Key 格式或 Body 不合法 | 400 | `VALIDATION` |
| 父層版本競爭、WIP、Migration Lock | 409 | 沿用既有 `CONFLICT`／`WIP_LIMIT`／`MIGRATION_LOCKED` |
| 儲存／連線錯誤 | 500 | 安全錯誤訊息，結果可能為 UNKNOWN |

Key 必須是 36 字元、小寫 UUID v4，前端以 `crypto.randomUUID()` 產生約 122 位元隨機性。伺服器驗證格式，呼叫端負責使用密碼學隨機來源。Header 重複合併、空值、任意資料庫 Key 均無法通過驗證。

伺服器將原始、已驗證 Request Body 依物件 Key 排序，保留 Array 順序與欄位有無，計算 SHA-256。Fingerprint 包含 protocol、CREATE、資源、父層範圍與原始 input。省略 `priority` 與明確傳 `priority: "一般"` 仍是不同 request，即使資料模型會補成相同預設值。前端不傳 Fingerprint、Receipt 或 DynamoDB 操作參數。

每個 Key 在同一表內全域保留，因此換 Workspace、Board 或資源重用 Key 都會衝突。Workspace Create 使用固定範圍 `local-workspace-create-v1`，不依附尚未建立的 Workspace。

### Receipt 查詢

`GET /api/operations/[operationId]` 必須提供對應範圍。

| 資源 | Query |
| --- | --- |
| Workspace | `resource=workspaces&scope=local-workspace-create-v1` |
| Board | `resource=boards&workspaceId=<DB Workspace ID>` |
| Task | `resource=tasks&workspaceId=<DB Workspace ID>&boardId=<DB Board ID>` |
| Widget | `resource=widgets&workspaceId=<DB Workspace ID>&boardId=<DB Board ID>` |

參數需 URL encode。多餘或重複 Query、缺少父層、非法 ID 回 400。範圍與 Receipt 不符回 409 `OPERATION_CONFLICT`，不回傳原 Payload 或 DTO。受控測試伺服器另驗證 Workspace proof，非 allowlist Workspace 回 403。

成功範例

```js
{
  data: {
    operationId: "<UUID v4>",
    state: "CONFIRMED",
    resource: "tasks",
    workspaceId: "SLOWLY#WORKSPACE#<uuid>",
    boardId: "SLOWLY#BOARD#<uuid>",
    targetId: "SLOWLY#TASK#<uuid>",
    createdAt: "<ISO time>",
    result: { id, version, position, workspaceId, boardId, createdAt, updatedAt, data }
  }
}
```

沒有可見 Receipt 回 HTTP 404 與 `error.code: OPERATION_NOT_FOUND`、`error.state: NOT_FOUND`。這表示尚未查到已確認交易，不能證明 Create 失敗或交易未在執行。儲存錯誤回 500 `OPERATION_UNKNOWN`／`UNKNOWN`。範圍不符回 409／`CONFLICT`。Adapter 將特定 Receipt 404 轉成 `{ state: "NOT_FOUND" }`，其他 HTTP 404 維持原錯誤行為。

此 API 沿用 Development、Loopback、Host、Origin、proxy 檢查。這是單一使用者的本機開發限制與資料歸屬核對，目前沒有登入或正式授權系統。Operation ID 本身不能代替資源範圍驗證，也不具正式使用者身分隔離能力。

## CRUD_OPERATION 與交易

Item 使用現有 `id` Partition Key，不增加索引。

```js
{
  id: "SLOWLY#CRUD_OPERATION#<operation UUID>",
  entityType: "CRUD_OPERATION", schemaVersion: 1,
  operationId: "<operation UUID>", attemptId: "<server-generated UUID>",
  action: "CREATE", resource: "tasks", type: "TASK",
  parentScope: "SLOWLY#BOARD#<uuid>",
  fingerprint: "<server SHA-256>", state: "CONFIRMED",
  targetId: "SLOWLY#TASK#<operation UUID>",
  workspaceId: "SLOWLY#WORKSPACE#<uuid>", boardId: "SLOWLY#BOARD#<uuid>",
  createdAt: "<ISO time>",
  result: /* 首次建立的完整 Target 快照 */
}
```

Target ID 由伺服器依資源類型與已驗證 Operation UUID 組合。條件式 `attribute_not_exists(id)` 保護 Target 與 Receipt。沒有接受任意 DB Key 的入口。

`createOnce()` 重用原 Repository Create、WIP、版本與 Workspace Barrier。單次交易包含 Target Put、必要 Parent Put、Receipt Put，以及需要的 Workspace ConditionCheck，最多四個 action。Board Create 的 Workspace Put 已含原子鎖定與版本條件，無需再對同一 Item 加 ConditionCheck。

Item 採既有 350 KB 保守預算，交易採 100 actions／3.5 MB 保守預算，HTTP Body 維持 200 KB。超限在送出交易前拒絕，不分批假裝完成單次 Create。

並發相同 Key 只有一筆交易能提交。敗方以強一致 Get 讀 Receipt，Fingerprint 相符才回原結果。暫時尚未看見勝方 Receipt 時可回 409；同一 Key 後續查詢／明確重送仍可恢復。

SDK 回應遺失時也先讀 Receipt。Receipt 的 server `attemptId` 能判斷該交易是否由本次 HTTP attempt 建立，維持首次 201、後續重送 200，不能只靠 SDK token 推測是否提交。

Receipt 僅在成功交易中出現 CONFIRMED，沒有另外預先寫入可被誤判的成功紀錄。Create 被拒絕前未提交的 Key 沒有永久綁定；前端仍保存同一意圖與原內容以處理競爭中的交易。

Receipt 永久保留、不設定 TTL，也沒有刪除 Receipt 的產品 API。Target 後來被修改或刪除仍回原建立快照，不覆寫新版本、不重新建立 Target。Receipt 會保留首次內容，因此需要儲存空間與保留政策。未來若引入清除功能，必須先設計永久 Key tombstone 或等效防重機制。人工直接刪除控制 Item／資料表會破壞協定前提；測試表整體清理僅適用於明確隔離且可拋棄的 fixture。

## 前端流程

`createSafeCreateIntent()` 支援四種資源，保存在頁面記憶體中的原始 JSON 副本、Key 與 scope。`send()` 的進行中 Promise 可共用，`resend()` 維持同一 Key 與原內容。每個新意圖才建立新 Key。

首頁聚合 Controller 與既有 per-resource Hooks 都使用此 helper。Workspace 的明確建立可使用 Adapter／intent helper，既有 Workspace Hook 仍保留獨立 setup 的限制，不在啟動效果中建立 Workspace。

流程如下

1. 使用者提交，TaskPanel 的 `useAsyncDraft` 與同步 submit gate 阻擋連點，Controller 阻擋其他進行中寫入。
2. 帶 Key 的 Create 預設等待上限 30 秒，可由 Adapter 的 `timeoutMs` 指定 1–120000 ms。Network Error、Timeout、取消或不合法成功回應皆保留未知結果。
3. 未知結果先查詢 Receipt，暫停一般寫入。
4. CONFIRMED 後重新讀取當前 server view，才解除 UNKNOWN，維持唯讀等待重新授權。舊 Create 快照不直接合併進最新資料。
5. NOT_FOUND 仍是 UNKNOWN，可再查詢，或由使用者確認「以原 Key 與原內容重送」。不自動產生新 Key。
6. 首頁確認人工恢復後重新掛載看板，關閉原新增表單，避免同一張已完成表單再次產生新意圖。Widget 備註草稿仍由既有分 scope 的記憶體 store 保存。
7. CONFLICT 保留問題並停止重送；切換資料來源不清除尚未確認的意圖，也不合併 API 與 localStorage。

Adapter 驗證 `Operation-Id` 與 `Idempotency-Status` 成功 Header。伺服器若忽略 Key，回報 `UNPROTECTED_CREATE_RESPONSE` 並禁止該意圖重送，避免把舊版無保護 POST 當成安全 Create。

意圖 journal 目前為頁面記憶體。關閉或重新載入頁面會失去未確認意圖與原 Payload；Receipt 在伺服器持久化，可憑已記錄的 Key 與 scope 查詢。尚未實作跨 reload 的持久化恢復 UI。遇到 UNKNOWN 時應保留畫面上的 Key 並完成核對，避免把重新填表當作同一次意圖的恢復。本輪沒有新增自動 localStorage 寫入或資料匯出。

## 實際測試

| 指令 | 通過 | 失敗 |
| --- | ---: | ---: |
| `npm.cmd run test:server` | 6 | 0 |
| `npm.cmd run test:api` | 7 | 0 |
| `npm.cmd run test:phase4a` | 25 | 0 |
| `npm.cmd run test:migration` | 24 | 0 |
| `npm.cmd run test:react-api` | 21 | 0 |
| `npm.cmd run test:controlled-ui` | 6 | 0 |
| `npm.cmd run test:release` | 12 | 0 |
| `npm.cmd run test:cutover-react` | 2 | 0 |
| `npm.cmd run test:main-ui` | 15 | 0 |
| `npm.cmd run test:main-ui:react` | 7 | 0 |
| `npm.cmd run test:safe-create` | 23（包含 8 個子測試） | 0 |
| Node／React 合計 | **148** | **0** |
| `npm.cmd run test:db:migration -- --isolated-table` | 14 組 | 0 |
| `npm.cmd run test:db:controlled-ui -- --isolated-table` | 6 組 | 0 |
| `npm.cmd run test:db:release -- --isolated-table` | 13 組 | 0 |
| `npm.cmd run test:db:main-ui -- --isolated-table --safe-create --http-smoke` | 20 組 | 0 |

DynamoDB／Next HTTP 共 53 組情境。最後 server attempt 區分調整另以無 HTTP 的同一隔離腳本重跑 19 組，與 20 組中的 SDK／React 情境重疊，不重複加總。

測試覆蓋四種 Create、相同 Key 重送／不同範圍衝突、原始欄位 presence、並發、父層版本與鎖競爭、交易／HTTP 回應遺失、查詢歸屬、Target 修改／刪除、Timeout、NOT_FOUND、舊版 POST、忽略 Key 的伺服器、StrictMode 與連點，以及 UNKNOWN 人工恢復關閉表單。

Build 通過，本次修改檔案 targeted ESLint 通過。完整 `npm.cmd run lint` 仍有 Phase 4C-2 已存在的三個 errors 與一個 warning，位於 `workspace-board.js` 的兩處 set-state-in-effect／一處 Link，以及 `task-analytics.js` 的 dependency warning。

測試寫入限定本次新表 `Slowly_Phase4C2_<run UUID>`。既有 `SlowlyTasks` 只做唯讀雜湊與 ACTIVE 核對。成功 HTTP run `9be55345-261e-4f1f-9a09-fa0c6b208aaf` 已清理伺服器與測試表，remainingItems／remainingLocks 都為 0，原表雜湊一致。

最終 SDK／React 重跑 run `c0e06c9b-6131-49c2-8ca7-9f5b60905c08` 同樣 19 組全數通過並清理完成，原表 ACTIVE 且雜湊一致。各輪詳細報告與 Node 摘要留在 Git 忽略的 `.phase4c2-test-runs/`。

第一次 run `2317c7af-1c1b-4e7d-a39d-a6bfb3aa76fd` 的 sandbox 無法停止其自建伺服器，因此保留測試表。後續已提升權限核對該 PID 命令列、停止自有程序樹、確認 3114 關閉後，僅清理該 run 的表，保留原錯誤與復原紀錄。之後的隔離 HTTP run 皆正常清理。

## 人工 Browser Acceptance

截至文件建立時，真實瀏覽器驗收尚未完成。專案沒有安裝 Playwright／Puppeteer；先前 Browser 工具回報 host unavailable，Windows Computer Use 因無法可靠辨識 URL 而停止。React JSX／HTTP 測試有保留，但沒有可宣稱為瀏覽器操作的通過結果、截圖或 Trace。

本輪最後再次檢查，Browser inventory 仍回報 `The browser access host is unavailable`。原生 Chrome 此次可讀取初始頁面，也成功建立獨立無痕視窗，但在輸入 `http://127.0.0.1:3114/` 時又被 URL confidence guard 停止。此後停止所有瀏覽器輸入，透過該 run 的 STOP_FILE 清理自建 fixture。對應驗收 run 為 `013615af-035c-4619-adf6-a47e2bfcc261`，沒有取得 slowly. 的實際網頁操作或截圖，無痕視窗交由使用者關閉。

### 啟動與資料隔離

在專案根目錄執行

```powershell
npm.cmd run test:db:main-ui -- --isolated-table --safe-create --http-smoke --serve
```

runner 先建立全新測試表與合成 fixture，再顯示 `TEST_WORKSPACE` 與 `STOP_FILE`，最多保留約 15 分鐘。需要較長測試時應另開一輪新 fixture。這個程序專用於 `http://127.0.0.1:3114`，沿用 `.next-main-ui`，不要手動把真實 SlowlyTasks 配到此程序。

使用全新臨時瀏覽器 profile 或新無痕工作階段，開啟正式首頁 `http://127.0.0.1:3114/`。該瀏覽器儲存空間只放人工建立的合成 local 測試任務；不要在原本使用者 profile 驗收 Local Mode。若只測 API，`/dev/main-api` 提供同一個 MainUi 的隔離入口，初始不掛載 localStorage 元件。

### 操作與預期結果

| 操作 | 預期 |
| --- | --- |
| 新 profile 開首頁，建立兩筆合成 Local 任務 | 初始為 localStorage Mode；在 DevTools Application 記錄 `slowly-workspace-v2`、`slowly-board-v1` 原始字串作基準 |
| 展開資料來源控制，填 runner 的 TEST_WORKSPACE、勾 API Ready、啟用唯讀 | 成功讀取隔離 Workspace；新增／儲存預設停用 |
| 填相同 Workspace ID，另外授權寫入 | 可操作 API；切換 Board 或 Workspace 後需重新授權 |
| 開新增 Task 表單並連點儲存 | 只有一筆任務與一個 Operation Key，Network 應見 201 |
| 修改名稱、優先級、日期、Notes、Subtasks | 儲存成功才更新畫面；重新開啟內容一致 |
| 同狀態任務卡片間拖曳排序；跨欄改狀態 | 重新讀取後順序／狀態保持；WIP 滿時顯示 409 |
| 新增、配置、resize、排序與移除單一 Widget | 重新讀取後配置保持；最後一個刪除後為明確空清單 |
| 快速切換 Board | 舊請求取消或忽略，舊 Board 資料不覆蓋新 Board |
| 用兩個頁面啟用同一 Workspace，第二頁更新第一頁已開的 Task，再在第一頁儲存 | 第一頁顯示 409，草稿保留；明確採用最新版本才替換草稿 |
| DevTools 切 Offline 後新增 Task，再恢復 Online | 顯示 UNKNOWN，禁止新寫入；先查詢 Receipt，尚未查到仍為 UNKNOWN |
| 點「以原 Key 與原內容重送」並確認 | Network 的 Key／Body 與原請求一致，只出現一筆任務；確認後關閉原新增表單、需再授權 |
| DevTools 加入網路延遲、封鎖一次 GET view | Loading 與 Error 可見；讀取錯誤不改用 Local 寫入，解除封鎖後明確重新讀取 |
| 新增空 Board 並切換 | 呈現空狀態，沒有自動建立任務／Widget |
| API 儲存後重新整理，再明確啟用同一 Workspace | API 資料仍在；重新整理後預設來源仍為 Local，沒有自動啟用 API |
| 比對 API 操作前後的 Local storage 原始字串，再切回 Local | 與基準完全相同，原合成 Local 任務仍在 |
| 刪除本輪合成 API Task | 成功後消失，重新讀取仍不存在 |

若操作失敗，記錄 runId、Workspace／Board、步驟、預期／實際、HTTP code、Operation Key，保存失敗畫面截圖與只含合成 fixture 的 HAR 到該 run 的驗收目錄。人工 Offline 測試不能證明「提交後遺失回應」，此情境由隔離 SDK／HTTP 模擬測試另外驗證。

完成後 Ctrl+C 或建立該輪輸出的 STOP_FILE，等待報告確認 serverStopped／cleaned。權限不足時保留 run 紀錄與表，確認自有程序身分後再恢復清理。沒有操作既有 SlowlyTasks 的清理步驟。

## 檔案清單

| 狀態 | 檔案 | 用途 |
| --- | --- | --- |
| 新增 | `src/lib/crud-operation.mjs` | Key、canonical fingerprint、Receipt、scope |
| 新增 | `src/lib/api/operations.mjs` | Receipt 查詢驗證與安全錯誤 |
| 新增 | `src/app/api/operations/[operationId]/route.js` | Local-only GET Route |
| 新增 | `src/lib/client/safe-create.mjs` | 不可變的單次新增意圖與查詢／明確重送 |
| 新增 | `tests/helpers/safe-create-scenario.mjs` | Memory／真實隔離 DB 共用情境與交易競爭 |
| 新增 | `tests/safe-create.test.mjs` | Safe Create 與 UNKNOWN 測試 |
| 新增 | `docs/phase4c3-safe-create.md` | Contract、實作、測試與人工驗收 |
| 修改 | `src/lib/slowly-repository.mjs` | 原交易內加入 Receipt、重送解析、結果查詢 |
| 修改 | `src/lib/api/handlers.mjs` | 選填 Key、201／200／409 與舊 POST 標示 |
| 修改 | `src/lib/testing/controlled-environment.mjs` | 控制新方法的 fixture scope |
| 修改 | `src/lib/client/slowly-api.mjs` | Header、Receipt GET、timeout 與協定驗證 |
| 修改 | `src/lib/client/main-workspace-controller.mjs` | UNKNOWN 查詢、明確重送、確認後 fresh view |
| 修改 | `src/lib/client/resource-controller.mjs` | 既有 Hooks 的 Safe Create 與恢復狀態 |
| 修改 | `src/hooks/use-slowly-api.mjs` | 暴露 recoverCreate／resendCreate |
| 修改 | `src/app/main-ui.js` | 恢復按鈕、Key 顯示與確認後表單關閉 |
| 修改 | `scripts/phase4c2-integration.mjs` | 重用隔離環境驗證真實 Safe Create／GET Route |
| 修改 | `tests/helpers/main-ui-fixture.mjs` | 實際 Operation handler 與 key/body 記錄 |
| 修改 | `tests/helpers/main-ui-scenario.mjs` | 已提交 POST 回應遺失後的恢復情境 |
| 修改 | `tests/main-ui-react.test.mjs` | StrictMode／useAsyncDraft／人工恢復表單測試 |
| 修改 | `tests/main-ui.test.mjs` | 更新 UNKNOWN／Receipt 行為預期 |
| 修改 | `tests/adapter-api.integration.test.mjs` | 明確保留無 Key 的舊 POST 測試語意 |
| 修改 | `package.json` | 增加 test:safe-create 指令 |

## Cutover 準備度

Safe Create 的伺服器原子保護與頁面內 UNKNOWN 恢復已完成。正式資料遷移／Cutover 仍待真實瀏覽器驗收、跨 reload 未確認意圖的恢復方案、既有 metadata 升級審閱，以及真實 Backup／Migration／Verify／Release 的獨立授權。現有 local-only scope 檢查不能取代登入與正式授權。

本輪沒有真實使用者資料遷移、既有 localStorage 操作、SlowlyTasks 寫入、正式部署或 Git Commit／Push／Merge。
