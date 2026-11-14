# Phase 4C-2：Main UI API Integration

首頁已接入共用看板畫面與獨立 API store，**預設仍為 localStorage**。API 僅能由使用者明確啟用，唯讀開啟，另行確認 Workspace ID 才授權寫入。這一階段只允許明確的隔離測試 Table／Workspace；沒有遷移真實使用者資料、寫入 SlowlyTasks 或變更預設資料來源。

## 操作與測試入口

```powershell
npm.cmd run test:main-ui
npm.cmd run test:main-ui:react
npm.cmd run test:db:main-ui -- --isolated-table
npm.cmd run test:db:main-ui -- --isolated-table --http-smoke
# 明確建立暫時 fixture，保留供人工驗收：
npm.cmd run test:db:main-ui -- --isolated-table --http-smoke --serve
```

人工測試開啟 `http://127.0.0.1:3114/dev/main-api`。此入口預設為未啟用的 localStorage 模式，但**不掛載本機資料元件**，不讀寫 storage。展開「資料來源控制」，輸入 runner 輸出的 TEST_WORKSPACE、勾選 API Ready，按「啟用唯讀 API Mode」。成功後再輸入同一 Workspace ID，按「另外授權寫入」。切換 Workspace／Board 會撤回寫入授權；切回本機模式不合併 API cache。

正常 `/` 使用同一個 MainUi，預設掛載原本的本機看板。Production 不顯示切換控制；未明確設定隔離環境時，即使開發首頁勾選 API Ready，新 view endpoint 仍回 403，不能接觸真實資料。不要把隔離變數配置在使用真實資料的開發程序上。

runner 只連 `http://127.0.0.1:9000`，建立 `Slowly_Phase4C2_<本次 UUID>`，不接受客戶端 TableName。伺服器要求 `SLOWLY_MAIN_UI_TEST=1`、精確表名/runId、fixture proof 與 Workspace marker 一致。使用 `.next-main-ui`，不與原本 `.next` 或 3113 的 `.next-controlled-ui` 衝突。只有此模式開放 allowlist 中的 Board CRUD；Workspace 建立仍不由 UI／啟動流程自動執行。Migration HTTP 在隔離 UI 程序持續禁止。

測試報告、PID、測試 IDs、STOP_FILE 留在被 Git 忽略的 `.phase4c2-test-runs/`。`--serve` 可 Ctrl+C 或建立報告指定的 stop 檔結束；先停止它自行啟動的程序樹，才刪除本次成功建立的表。無法停止時保留表與復原紀錄。沒有清理其他程序或既有 Table 的步驟。

## 已批准的最小後端補強

本輪發現既有 DTO 無法區分 Widget 缺省／空陣列、Readiness 尚無 HTTP 入口、Subtask 白名單會阻擋未知來源欄位。使用者已明確批准新增唯讀 view endpoint、交易內 Widget presence 維護與依 Subtask ID 保留欄位。原 CRUD URL、Request／Response JSON envelope 不變；一般 CRUD 的冪等 Receipt **沒有實作**。

### GET `/api/workspaces/[id]/view`

無 Request Body，無額外 Query Parameters。沿用 Development、Loopback、Host/Origin/proxy guard，並額外要求 Phase 4C-2 隔離環境。回應：

```js
{
  data: {
    workspace: { id, version, position, createdAt, updatedAt, data },
    boards: [{
      board: { id, version, position, workspaceId, createdAt, updatedAt, data },
      tasks: [/* 原 Task DTO，含完整 data */],
      widgets: [/* 原 Widget DTO，含完整 data */],
      widgetsPresence: "absent" | "present"
    }],
    readiness: {
      workspaceId, apiReady: true, eligible, blockers, checkedAt,
      phase: "api-runtime", migration,
      capabilities: { widgetPresenceWrites: true, subtaskExtensions: true }
    }
  }
}
```

400 輸入錯誤、403 guard／隔離／歸屬失敗、404 找不到資源、409 SNAPSHOT_NOT_READY/MIGRATION_NOT_READY/INTEGRITY_CONFLICT、500 不含內部 SDK 詳情。metadata 缺失、鎖未解除等可回 200 + eligible:false/blockers，前端仍不啟用。空清單只有在完整計數一致且 Readiness 通過後才作 Empty State。

server 以 GSI 查 IDs，再強一致讀取 base Items，核對父子歸屬、資料格式、WIP/counters、鎖與 Migration Session/Receipts。完整第一輪收集結束後再讀取所有 Board versions，最後核對 Workspace version，避免合併跨版本快照。GSI 尚未收斂或版本變動回 409，不自動補預設資料、不將查不到視為不存在。

為能偵測 Board GSI 漏項，新建 Workspace／Migration target 有伺服器內部 `boardCount`；Board 建立／刪除或 Migration/rollback 的 parent change 在**原有同一筆交易**更新它，不增加 transaction action 數。新建 API Workspace 另有 `viewOrigin:"api"`。這些欄位不放進 frontend data，不改原 DTO。

Widget presence 使用 Board 內部 `widgetPresence`，新建 Board 為 absent；每次 Widget 寫入的同筆 Board Put 設為 present，刪除最後一個 Widget 仍為 present（明確空陣列）。既有 Migration 的初始讀取可使用 immutable `restoreShape.widgetsPresent`。不修改來源 restoreShape/audit 來假裝編輯後快照仍等於原始備份。

舊資料缺少 count/origin/presence 時回報 blocker；**不掃描後猜測回填、不修改既有 Item**。正式使用前需獨立審閱相容性與明確的 metadata upgrade。

Subtask PATCH 仍只接受 id/title/done。伺服器對保留的 ID 合併原有未知欄位；刪除整個子任務是使用者明確行為，不把它當保真還原。前端只在 server capability 已確認時送出已知欄位；嘗試改未知欄位會明確拒絕，不靜默丟棄。

### 兩種 Readiness 的分工

Phase 4C-1 的來源備份／managedHash／Verify 檢查適用於**實際遷移與首次 Cutover**，仍維持 formal gate=false。新 view 的 api-runtime Readiness 驗證**編輯後的當前一致性**；若已有 migrationOwner，必須完整 RELEASED、v2 root certificate、正確 Session/Receipt ownership。合法 API 編輯後不能再要求資料 hash 等於最初來源，否則每次編輯都會被誤判損壞。新原生 API fixture 必須有受信任的 API origin。兩者不互相替代，不把 runtime eligible=true 當作真實 Cutover 授權。

## UI / Store / Adapter 資料流

`page.js → MainUi → useMainWorkspace → main-workspace-controller → createSlowlyApi → 原 CRUD / 新 view Route → Repository`。

`WorkspaceBoard` 由原 page.js 抽出，沿用卡片、搜尋、篩選、優先 lane、週/月曆、TaskPanel、WidgetDashboard 與 Analytics。Local mode 保留原 state、三處 storage 存取、完成時間計算與同步 callback；API mode 提前跳過 storage effects，不呼叫 local setter 或 client completionUpdate。UI 已修改以加入資料來源控制與非同步能力，沒有更換既有樣式檔或視覺系統。

聚合 view store 負責全 Workspace 與 Sidebar/Analytics 所需的清單；既有每 resource Hooks 保留給舊隔離入口，沒有假設它們會回傳整個 workspace。API 請求重用既有 Adapter（新增 getWorkspaceView），不在 Components 引入 SDK。useAsyncDraft 重用於正式 TaskPanel 的 async 分支。

Snapshot、已確認的 DTO、未儲存草稿分開。Mapping 保留 databaseId、frontendId、parent Board、version、position；UI id 保持原 frontend ID，不把它直接當 DB key。同名 task/widget frontend IDs 可跨 Board／Workspace，不能在同一父項重複；重複／不合法／不完整資料明確阻擋。

projection 複製完整 DTO data，不 trim、重設日期、補猜測預設值或移除未知欄位。Task 的 Subtasks/Notes/Priority/Status/Date/Time/completedAt、Widget type/config/span/height/manualSize、順序與 WIP 均保留。server 權威 widgetsPresence 決定有沒有 widgets property，不能靠空 list 推測。

寫入只產生**實際變更的已知欄位**；未知但未修改的欄位由 server 保留，未知欄位被改動則拒絕。completedAt 仍由 server 控制，既有 done 任務的原字串保留；狀態改變後採用 server 回應，Analytics 不自行改寫資料。

## CRUD 與非同步互動

- Task：新增、修改、刪除、狀態、Priority、Date/Time、Notes、Subtasks、拖曳排序。欄間 drop 只改狀態，同狀態卡片間 drop 才排序。WIP 由交易最終決定。Drawer 固定草稿初始 version，refresh 不會偷偷把 stale 草稿換成新 version 後覆寫；409 保留草稿，提供明確「重新讀取並採用最新任務」的取代選項。
- Board：選擇、建立、更新、拖曳排序；空 Workspace 不補預設看板，使用者另外授權後才可明確建立。切換 Board 撤回寫入權並使舊 UI facade 失效。
- Widget：新增尾端、修改配置、單筆刪除、整體排序、resize、Timer 設定。缺省時的 analytics 僅為原本 UI 的檢視，不建立資料；使用者按「建立統計小組件」才明確寫入並轉 present。刪除最後一個後維持 widgets:[]。
- API notes：按鍵只改草稿，blur 才提交。保存原 version，失敗不清空。頁面記憶體草稿依 Workspace/Board/Widget 分開，切換後仍可找回，不混進 DTO 或 localStorage；有「未儲存草稿」標示。重新載入整個頁面仍會失去未提交的記憶體草稿，沒有宣稱具備持久化 draft。
- 單一 API write in flight；成功回應先合併 DTO，再讀取新 view/parent versions。寫入已確認但後續讀取失敗時保留已確認內容，另顯示 refresh error 並停用後續寫入，不把它誤報為 write failure。
- HTTP 409、Network Error、取消均無自動 write retry。AbortController/generation/scope revision 阻止舊 response 或舊 callback 覆蓋／修改新看板。取消等待不代表 server 取消 transaction。
- POST 結果不明、成功回應不合法，以及新增時的 ambiguous CONFLICT 都暫停後續寫入。切換 source／Workspace 或單純 refresh 不清除 uncertain flag；讀取仍可核對，不能據 GSI 空結果自動重送。

### 明確停用的複合操作

現有 CRUD 不能將下列動作放在一個業務交易，API mode 不會偷偷分批：

1. 拖入中間位置同時新增 Widget 並重排：只開放加入尾端，介面顯示原因。
2. 一次清空多個 Widget：按鈕停用並提示逐一移除，client command 也拒絕。
3. 跨狀態移動同時排序 Task：提示先改狀態再排序。

單次 Task/Widget 原子排序上限 98、Board 99；不把部分成功當全部成功。Local mode 保留原行為。

## 普通 POST 冪等性的最小後續方案（未實作）

建議另行批准 optional `Idempotency-Key`、Workspace/type scoped CRUD_OPERATION Receipt，並新增 `GET /api/operations/[operationId]?workspaceId=...` 查詢結果端點。key 與 canonical payload fingerprint 綁定，target ID 由受信任 server 以 scoped operation key 穩定產生；target + parent counters + Receipt 在同一交易，仍包含 Workspace barrier。相同 key/payload 回原結果，不同 payload 回 409；同時提交僅一筆交易能建立 target/Receipt。新建 201、冪等重送 200，仍回原 DTO envelope。Receipt 包含 operationId/workspaceId/resource/targetId/fingerprint/CONFIRMED/必要結果摘要，沿用 Local/Host/Origin 與歸屬檢查。

查不到 Receipt 不代表沒有 in-flight transaction；若要重送，只能使用相同 key 與同一 payload，不能重新生成 ID。取得已確認結果後仍需讀取當前 DTO，不能用舊 create 回應覆寫較新 cache，或將後來已刪除的任務重新建立。Receipt 必須與資料寫入原子一致，不能只靠 SDK token 或 client checkpoint。

這會新增 Contract／控制 Item，**本輪沒有擅自實作**。目前 frontend 每個動作只送一次，結果不明時凍結寫入；重新載入頁面後的人工重送沒有跨頁面冪等保證。正式使用前應補上可靠結果查詢／恢復流程。

## 檔案清單

| 狀態 | 檔案 | 用途 |
| --- | --- | --- |
| 修改 | `src/app/page.js` | 首頁入口，預設 Local |
| 新增 | `src/app/main-ui.js` | 模式控制、備份觸發、權限確認、空狀態 |
| 新增 | `src/app/workspace-board.js` | 原看板 UI，共用 Local/API 分支 |
| 修改 | `src/app/task-panel.js` | async draft、pending、409、採用最新版本 |
| 修改 | `src/app/widget-dashboard.js` | async command 回饋、版本、明確停用複合操作 |
| 修改 | `src/app/widgets.js` | API readonly／async note props；保留原 Local 分支 |
| 新增 | `src/components/async-widget-note.mjs` | 只在 blur 提交、失敗／跨 scope 草稿保留 |
| 新增 | `src/hooks/use-main-workspace.mjs` | React 訂閱聚合 store |
| 新增 | `src/lib/client/main-view-model.mjs` | 純投影、ID mapping、無損 patch/create 編碼 |
| 新增 | `src/lib/client/main-workspace-controller.mjs` | scoped source/read/write/cancellation/unknown outcome |
| 新增 | `src/lib/client/main-ui-session.mjs` | 綁定 UI scope、版本、Widget command 分類與 draft cache |
| 修改 | `src/lib/client/slowly-api.mjs` | 新增 getWorkspaceView，保留原方法 |
| 新增 | `src/lib/api/workspace-view.mjs` | 最新一致性與權威 metadata/readiness |
| 新增 | `src/app/api/workspaces/[id]/view/route.js` | 已批准 GET Route |
| 修改 | `src/lib/api/handlers.mjs` | 共用 Request ID validator、Subtask 依 ID merge |
| 修改 | `src/lib/slowly-repository.mjs` | Board count、native origin、Widget presence 同交易維護 |
| 修改 | `src/lib/migration/service.mjs` | 新 target count 與 migration/rollback parent count |
| 修改 | `src/lib/testing/controlled-environment.mjs` | C2 專屬表驗證、只開放本次 fixture Board CRUD |
| 新增 | `src/app/dev/main-api/page.js` | 不掛載 Local storage effects 的隔離入口 |
| 新增 | `tests/helpers/main-ui-fixture.mjs` | 實際 API/Repository/Service 測試 fixture |
| 新增 | `tests/helpers/main-ui-scenario.mjs` | 真實 React 主介面情境，Memory/DB 共用 |
| 新增 | `tests/helpers/ui-module-loader.mjs` | 僅測試程序使用已安裝 Next SWC 載入實際 JSX |
| 新增 | `tests/main-ui.test.mjs` | Model/controller/API/錯誤/隔離測試 |
| 新增 | `tests/main-ui-react.test.mjs` | 實際首頁、TaskPanel、Note 的 React 事件／SSR |
| 修改 | `tests/client-adapter.test.mjs` | 新 endpoint encoding 與完整 Adapter 覆蓋 |
| 新增 | `scripts/phase4c2-integration.mjs` | 專屬 DB／React／Next HTTP 驗證與清理 |
| 修改 | `package.json` | 三個重複驗證指令 |
| 修改 | `next.config.mjs` | 專屬 .next-main-ui |
| 修改 | `eslint.config.mjs` | 忽略新 cache 生成物 |
| 修改 | `.gitignore` | 忽略 cache、隔離測試報告 |
| 新增 | `docs/phase4c2-main-ui.md` | 本文件 |

沒有刪除檔案、新增依賴、修改環境憑證、部署或執行 Commit/Push/Merge。

## 測試與準備度

回歸指令沿用 Phase 4C-1 文件，新增上方三個測試指令。Node 測試含真實 React/ReactDOM + 原始 JSX 經 Next SWC，不是手寫 UI 複製品；使用 minimal host/事件 handler/SSR，未宣稱完整瀏覽器排版測試。SDK 測試全部使用獨立表，SlowlyTasks 僅唯讀核對前後雜湊／ACTIVE。

實際瀏覽器驗收未完成：內嵌瀏覽器 host 不可用；Windows Computer Use 無法可靠辨識目前 URL，安全檢查停止後沒有繼續操作或換方式操控瀏覽器。Next HTTP smoke 仍完成，但它不等於瀏覽器互動驗收。

正式 Cutover **尚未具備條件**：仍需瀏覽器人工驗收、普通 POST 冪等結果恢復、舊 metadata 的明確升級計畫、真實 Backup/Migration/Verify/Release 的專案授權與驗收，以及解除「僅隔離測試表」限制的獨立決策。本輪只完成首頁能力與隔離驗證，不會將 runtime Readiness 當成正式資料遷移授權。

## 實際執行結果（2026-11-14）

| 指令 | 通過 | 失敗 |
| --- | ---: | ---: |
| `npm.cmd run test:server` | 6 | 0 |
| `npm.cmd run test:api` | 7 | 0 |
| `npm.cmd run test:migration` | 24 | 0 |
| `npm.cmd run test:phase4a` | 25 | 0 |
| `npm.cmd run test:react-api` | 21 | 0 |
| `npm.cmd run test:controlled-ui` | 6 | 0 |
| `npm.cmd run test:release` | 12 | 0 |
| `npm.cmd run test:cutover-react` | 2 | 0 |
| `npm.cmd run test:main-ui` | 16 | 0 |
| `npm.cmd run test:main-ui:react` | 5 | 0 |
| Node 合計 | **124** | **0** |
| `npm.cmd run test:db:migration -- --isolated-table` | 14 組 | 0 |
| `npm.cmd run test:db:controlled-ui -- --isolated-table` | 6 組 | 0 |
| `npm.cmd run test:db:release -- --isolated-table` | 13 組 | 0 |
| `npm.cmd run test:db:main-ui -- --isolated-table --http-smoke` | 9 組 | 0 |
| 實體 DynamoDB/Next HTTP 合計 | **42 組** | **0** |

最終 Build 通過。首次因既有 Google Fonts 網路下載失敗，提升權限重跑通過，沒有修改字型或版面來迴避問題。新邏輯 targeted ESLint 通過；全專案仍有原來 3 個 errors、1 個 warning：原 page.js 的 2 個 set-state-in-effect 與 1 個 Link error 搬到 workspace-board.js（112/144/274），task-analytics.js 99 的 dependency warning 未變，沒有關閉 lint 規則。`git diff --check` 通過。

最後成功 testRun：`461341f6-ba2f-4652-a800-045c63bfcb4b`。Next route/page 200、非 allowlist Workspace 403；serverStopped=true、cleaned=true、remainingItems=0、remainingLocks=0、originalUnchanged=true，SlowlyTasks 仍為 ACTIVE。先前發現既有 3113 伺服器佔用舊 cache，沒有停止它；另建 `.next-main-ui` 後重新完整驗證。初次測試 assertion/fixture 問題已修正並重跑，沒有未處理的自動化測試失敗。

實際瀏覽器操作／視覺驗收是未完成項，不能以 Node/HTTP 成功替代。所有本輪測試寫入只發生於明確的專屬表；未操作真實 localStorage、未遷移真實資料、未修改 SlowlyTasks、未新增公開部署能力，未執行 Git Commit/Push/Merge。
