# Phase 4B-2：受控 React API 整合

## 範圍與使用方式

正式 `/`、Task Panel、Widget Dashboard 與 localStorage 完全維持原樣。新增開發專用 `/dev/api-board`，未啟用明確的隔離 fixture 時不提供頁面。這不是登入／正式授權系統。

## 檔案清單

| 狀態 | 路徑 | 用途 |
| --- | --- | --- |
| 新增 | `src/hooks/controlled-api-provider.mjs` | 明確 Workspace/readiness/write grant 與四種 resource scope |
| 新增 | `src/app/dev/api-board/page.js` | 開發模式、Host/Origin 與 fixture 檢查的 Server Component |
| 新增 | `src/app/dev/api-board/view.mjs` | 隔離控制台、Task/note Widget CRUD、排序與錯誤草稿 |
| 新增 | `src/lib/testing/controlled-environment.mjs` | 專屬表名、fixture proof、Workspace allowlist、Repository 限制 |
| 新增 | `scripts/phase4b2-integration.mjs` | 真實 DynamoDB/React/API 測試、HTTP smoke、人工入口與安全清理 |
| 新增 | `tests/controlled-ui.test.mjs` | Provider／真實 Handler／Memory Repository 整合測試 |
| 新增 | `tests/controlled-view.test.mjs` | 初始 SSR controls 與實際 React 表單事件測試 |
| 新增 | `tests/helpers/controlled-provider-host.mjs` | StrictMode 真實 React Provider test harness |
| 新增 | `tests/helpers/server-only-loader.mjs` | 僅測試程序的 server-only resolver，不進入應用程式 |
| 新增 | `docs/phase4b2-controlled-ui.md` | 操作、架構、限制、Release 提案、測試紀錄 |
| 修改 | `src/lib/api/local-routes.mjs` | 明確隔離程序才注入 fixture Repository |
| 修改 | `src/lib/api/migrations.mjs` | 隔離程序禁止使用普通 Migration Service |
| 修改 | `next.config.mjs` | 隔離 Next build cache |
| 修改 | `eslint.config.mjs` | 忽略隔離生成產物 |
| 修改 | `.gitignore` | 忽略測試報告與隔離生成產物 |
| 修改 | `package.json` | 新增兩個測試指令 |

沒有刪除檔案或新增依賴。

```powershell
npm.cmd run test:controlled-ui
npm.cmd run test:db:controlled-ui -- --isolated-table
npm.cmd run test:db:controlled-ui -- --isolated-table --http-smoke
# 明確建立暫時測試資料，開啟供人工操作的隔離伺服器：
npm.cmd run test:db:controlled-ui -- --isolated-table --serve
```

`--serve` 先執行隔離驗證，保留本次建立的測試 Workspace，再開啟 `http://127.0.0.1:3113/dev/api-board`。選 Workspace、勾選 API Ready、啟用唯讀模式；另輸入目前 Workspace 的完整資料庫 ID 才授權測試寫入。換 Workspace／Board 會撤回寫入授權。Ctrl+C 僅停止本次伺服器並刪除本次測試表。不得將這組變數配置在原有正式資料的伺服器上。

不要在原本的 3000 開發伺服器啟用隔離變數：普通 CRUD 路由會在該程序中整體綁定隔離 Repository。使用獨立 3113 程序與 `.next-controlled-ui`，避免主畫面資料混用。隔離程序中的 Migration API 會在安全檢查時直接回傳 403，避免誤用普通 Migration Service 接觸 SlowlyTasks；正常程序的 Migration Contract 不變。`/db-test` 既有讀取頁面不屬於此測試入口。

每次 run 先產生 UUID，測試表必須精確為 `Slowly_Phase4B2_<無連字號 UUID>`；無任意表名 API。環境證明 Item、兩個測試 Workspace 及 Board/widget presence metadata 都在該表。Workspace settings 必須標記本次 runId。伺服器每次 CRUD 重新驗證 proof 與 Workspace 標記，拒絕未列入的 Workspace，結構性 Workspace／Board 寫入也被禁止。原本 API request/response 不變。

報告寫在被 Git 忽略的 `.phase4b2-test-runs/<runId>.json`。若服務無法停止，保留表及 PID 紀錄，清理前先確認該 PID 確實是本次程序且已停止；不得刪除 SlowlyTasks。無自動過期／強制解鎖。測試前後僅唯讀掃描 SlowlyTasks，核對完整內容雜湊；不對它執行寫入。

## React 資料流

`ControlledApiProvider → 四個現有 useSlowly* Hooks → resource-controller → createSlowlyApi → 既有 Route Handlers → 隔離 Repository → DynamoDB Local`。

預設 `localStorage` 是隔離控制台的停用狀態，完全不讀寫瀏覽器 storage；返回 `/` 才使用既有本機看板。不是把 API cache 合併到本機看板，也不會在連線失敗後寫入本機資料。

Provider 先載入指定 Workspace 並核對 fixture marker，才啟用 Board／Task／Widget 讀取。Loading、Error、空清單、父子 scope、AbortController、response generation、ID mapping、CAS version 與 mutation outcome 重用既有 Hook／controller。StrictMode effects 只有讀取；所有新增／修改／刪除／排序均由使用者事件發起，無自動重試。

UI 使用外層資料庫 `id/version/position` 操作 API，`data.id` 僅保留為前端 ID；顯示兩種 ID 供核對。排序使用當前完整清單的資料庫 ID、版本與新 position。409 保留草稿與最後確認的資料，使用者先重新讀取再明確重送；失敗不顯示成功。取消等待會失效化舊回應，但不能證明伺服器停止寫入。換 Board 會卸載舊編輯器；舊資源回應不能覆蓋新 scope。

Task 隔離編輯器示範名稱新增／修改／刪除／排序，Widget 編輯器示範 note 新增／修改／刪除／排序。它不取代正式 Task Panel 的完整欄位編輯器，API 更新仍保留未修改欄位。未重構現有同步表單為非同步表單。

## Widget 缺省

既有 CRUD DTO 無 restoreShape/widgetsPresent；空 list 無法證明來源是否明確有 `widgets: []`。此入口使用伺服器 fixture proof 的 `boardWidgetPresence`，明確區分 absent、present+空陣列與 unknown。absent／unknown 不產生預設分析組件且禁止 UI Widget 寫入；與非空 API 回應矛盾時顯示阻擋。一般遷移後資料要安全還原，仍需先批准一個具權威性的 restore projection，不能憑空清單推測。

## Lock Release API 提案（未實作，等待批准）

現有內部 `release()` 並非 HTTP contract。它先驗證、持久化 RELEASING，再逐項解除，網路中斷後可恢復；但已解鎖項目可被普通 CRUD 修改，因此不能宣稱整個 Workspace 原子解鎖。公開前必須處理這個中間狀態。

建議先批准以下 contract 與全域 barrier／一致性修改，再實作：

| Endpoint | Request | Response |
| --- | --- | --- |
| POST `/api/migrations/[migrationId]/release-preview` | `{ expectedSessionVersion }` | 200 `{ data: { migrationId, sessionVersion, eligible, blockers, verificationHash, confirmedCount, totalCount, lockState, releasedCount, nextAction } }` |
| POST `/api/migrations/[migrationId]/release` | `{ expectedSessionVersion, expectedVerificationHash, confirmation: migrationId }` | 202 同一狀態摘要，`nextAction: "resume-release"`；全部完成才 200，`lockState: "RELEASED"`、`nextAction: null` |

preview 純讀取、不更動 Session。release 不接受任意 target ID、manifest、交易參數或前端計算的驗證值；伺服器重新載入全部權威資料，核對 supplied hash/version。錯誤維持 `{error:{code,message}}`：400 格式、403 local/Origin/ownership、404 session、409 VERSION_CONFLICT/RELEASE_BLOCKED/VERIFICATION_STALE、500 不含內部細節。維持 Development Only、127.0.0.1 Host、Origin／proxy 安全檢查。不強制解鎖、不 TTL 自動解鎖、不將失敗視為可釋放。

安全前提：

- Session 只能 VERIFIED 或同一 release 流程的 RELEASING；RELEASED 可冪等讀回，舊 expectedVersion 仍應要求重新讀取。READY/RUNNING/FAILED/VERIFYING、任何 rollback／conflict 狀態都不能釋放。
- Manifest 完整封存、所有 Operation Receipt 已 CONFIRMED，沒有 Pending/Failed/Conflict 或部分 Rollback；重新核對 ownership、父子關係、數量、內容雜湊、版本、schema、完整 Verify 結果。
- 首次取得 release barrier 與 Session 狀態 CAS 必須在同一交易中。所有既有 CRUD 寫入須原子驗證 Workspace barrier，不得只做預檢。現有 99 個排序項目加 parent 已滿 100，若新增 ConditionCheck 需降低 batch 容量或把 barrier 條件合併到既有 parent Put；這涉及 Repository/排序限制調整，需另外批准。
- 每個解除操作都 CAS Session、ownership、item version、release token，持久化 cursor/count；中斷持續持鎖，只有相同 Session 可恢復。不得解別的 Session 的鎖。
- 全部 target 解鎖後，最後交易才解除 Workspace barrier 並標記 RELEASED。API UI 只有在完整 RELEASED 才能授權寫入。先前部分解鎖的 target 仍被 Workspace barrier 保護。
- 網路不明時先 GET Session，不盲目重試舊 version。Rollback/release 互斥；釋放之後的外部修改不再保證可回滾。

這個提案沒有新增路由、變更 Migration Schema、CRUD Contract 或內部 release 行為。以上 barrier 及確切 status/code 是下一次需要確認的架構決策。

## 測試邊界與 Phase 4C

新增測試使用真實 React／ReactDOM 的 minimal host，包含 StrictMode、Provider/Adapter/Handler/Repository 整合、草稿事件、SSR controls；不是完整瀏覽器排版、點擊或可及性驗證。原有 Hook/controller tests 覆蓋快速切換、取消、過時 response、HTTP 400/403/404/409/500、network error 與 write race。實體 DynamoDB 整合用獨立表；HTTP smoke 另啟動真實 Next server 驗證頁面與 scope guard。

進 Phase 4C 前：批准並測試 Release contract/barrier、一般 Workspace 的 Widget presence/Timer/restore projection、完整正式表單的 async interaction 設計、人工瀏覽器驗收、明確資料源切換／回滾流程、備份與遷移操作確認。目前只具備隔離 API UI 驗證條件，尚不能安全切換真實使用者資料。

## 本次執行結果（2026-11-14）

| 指令 | 結果 |
| --- | --- |
| `npm.cmd run test:controlled-ui` | 6 通過、0 失敗 |
| `npm.cmd run test:react-api` | 21 通過、0 失敗 |
| `npm.cmd run test:migration` | 24 通過、0 失敗 |
| `npm.cmd run test:phase4a` | 25 通過、0 失敗 |
| `npm.cmd run test:server` | 6 通過、0 失敗 |
| `npm.cmd run test:api` | 7 通過、0 失敗 |
| `npm.cmd run test:db:migration -- --isolated-table` | 14 通過，測試表刪除、0 殘留 Item/Lock，原表 ACTIVE、1 個原始 Item 未改變 |
| `npm.cmd run test:db:controlled-ui -- --isolated-table --http-smoke` | 7 組通過，伺服器已停止、測試表已刪除、原表雜湊一致 |
| `npm.cmd run build` | 通過；有既存父目錄 lockfile 提醒 |
| 針對本次修改檔案執行 ESLint | 通過 |
| `npm.cmd run lint` | 既有 3 errors、1 warning；主頁 set-state-in-effect 106/137、Link 規則 227；analytics dependency warning 99 |

Node 測試合計 89 項，另外實體 DynamoDB 整合合計 21 組。最後成功的受控 UI testRun：`a4668bc2-5ca2-49b4-a254-6e81cf3ecb5b`；Migration testRun：`904637d4-ec81-4bc3-8731-3e8f55b30b21`。首次 HTTP 測試遇到沙箱無法 taskkill，已透過提升權限停止該次程序，修正 cleanup guard 後重跑完整通過。沒有修改使用者 Item、storage、既有 CRUD payload/DTO，沒有 Commit/Push/Merge。
