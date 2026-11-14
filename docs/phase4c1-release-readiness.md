# Phase 4C-1：Migration Release 與 Cutover Readiness

本階段新增 Release API、Workspace 交易屏障、純讀取前置檢查、Widget UI 投影與獨立非同步表單狀態。首頁仍為原本的 localStorage 來源，沒有遷移使用者資料、修改 SlowlyTasks、變更資料表結構、部署或 Git 提交。

## Release Contract

沿用既有動態參數 `[migrationId]`（URL 中就是使用者指定的 `[id]`）。兩個 POST 都使用既有 local development、127.0.0.1 Host、Origin／proxy guard；隔離 API UI 程序維持禁止 Migration API，沒有擴張到雲端或公開環境。

### POST `/api/migrations/[migrationId]/release-preview`

Request：`{ "expectedSessionVersion": 25 }`。

Response 200：

```json
{
  "data": {
    "migrationId": "<64 hex>",
    "sessionVersion": 25,
    "eligible": true,
    "blockers": [],
    "verificationHash": "<64 hex>",
    "confirmedCount": 9,
    "totalCount": 9,
    "releasedCount": 0,
    "lockState": "HELD",
    "nextAction": "start-release"
  }
}
```

純讀取，不會呼叫會寫入 Session 的 `verify()`、記錄 conflict 或解除鎖。尚未 Verify、receipt 不完整、版本／ownership／內容／鎖狀態不符時，`eligible:false` 並列出 blocker；預期 Session version 過時則 409。

### POST `/api/migrations/[migrationId]/release`

```json
{
  "expectedSessionVersion": 25,
  "expectedVerificationHash": "<preview returned hash>",
  "confirmation": "<same migrationId>"
}
```

Response：`{ data: { session: <existing session DTO>, verificationHash, nextAction } }`。分批過程回傳 202，`nextAction:"resume-release"`；全部完成才 200，`nextAction:null`。每次請求最多推進一個持久化階段／一個 target，沒有背景自動執行器。

格式／未知欄位 400、local/Origin 拒絕 403、找不到 Session 404、版本競爭 CONFLICT／RELEASE_BLOCKED／VERIFICATION_STALE 409、未預期錯誤 500。沿用 `{error:{code,message}}`，不回傳內部 SDK 錯誤。伺服器重算所有驗證，不接收 target IDs、manifest 或資料庫參數。

## 交易與狀態機

1. VERIFIED + HELD：確認完整 manifest、CONFIRMED receipts、Verify hash/counts、所有 managed target 完整快照／schema／ownership／version、WIP/counters 及父子關係。
2. 首次 Release 交易同時對 Workspace 完整快照做 ConditionCheck，CAS Session 進入 `state:RELEASING, lockState:RELEASING`，持久化 `releaseProtocolVersion:2`、`releaseRequestVersion`、`releaseVerificationHash`、`releaseStartedAt`。
3. 按 manifest **反向**解鎖，Workspace 必須最後。每筆交易包含 target snapshot-conditioned Put、Receipt CAS 更新 managedVersion/hash/releasedAt、Session CAS cursor/count，以及 Workspace 的快照 ConditionCheck。每次繼續前再次檢查完整的混合鎖定快照。
4. 最後一筆交易原子地把 Workspace `migrationLock:false, migrationReleaseVersion:2`、更新其 Receipt，並把 Session 設為 RELEASED + RELEASED、releasedCount=total、releasedAt。沒有「root 解鎖但 Session 還在進行」的中間窗口。Session 另保存 releaseWorkspaceId，完成後 Preview 仍會確認該 root 的 ownership／release 標記／鎖狀態。

Workspace 上既有的 `migrationLock:true` 就是持久化 barrier，不另建平行 Lock Item。新增／修改／刪除／排序的所有 Repository 寫入，在同一交易檢查 root barrier：已有 Workspace Put 的交易直接用該 Put 的 lock condition，其餘新增 root ConditionCheck（type/schema/lock），不存在的 root 也不通過。有 migrationOwner 的 root 還必須通過 `migrationReleaseVersion:2` 條件；舊版已解鎖但缺乏新協定證明的 Workspace 同樣阻擋，不能繞過新安全機制，也不自動回填標記。預讀只是提前回報，交易才是最終判斷。

Task/Widget 排序需保留 child entries + Board Put + root Check，因此單筆上限 **98**；Board 排序 entries + Workspace Put 上限仍 **99**。超過回 400，不會偷偷拆成部分成功的排序。交易仍限制最多 100 actions、保守序列化大小 <3.5MB，且不得在同一交易重複操作同一 Item。

同一 hash、已進入 v2 release 的舊版本請求可安全讀回最新進度，**不再次推進**。Client 應重新 preview／GET Session，使用目前版本繼續。並發只有一個 Session CAS 能推進；衝突回 409，沒有無條件覆寫。HTTP 回應遺失不等於未提交，重新建立 Service 仍可從持久化 Session/Receipts 恢復。

進入 RELEASING 起就禁止 Rollback（不必等到全部完成），也不允許 execute/verify 重新開始；中斷保留 barrier。成功 RELEASED 後同樣不允許 migration 自動刪除資料。沒有 TTL 解鎖或強制解鎖。舊版 `state:RELEASED, lockState:RELEASING` 的半完成 Release 直接阻擋，不能假裝具備新協定保護或自動修復。

屏障保護所有本專案 Repository 寫入；直接用管理工具繞過 Repository 修改 DynamoDB 不在此安全保證內。每步完整 snapshot/hash 檢查可偵測外部修改並阻擋，不能宣稱抵抗任意管理者在檢查後直接改資料的能力。需限制實際資料庫存取權限。

## Widget / Task Fidelity

重用既有 Plan v2 的 `restoreShape.dataKeys/widgetsPresent`，沒有另建 Migration schema 或重新推測預設值。`projectWorkspaceForUi()` 是無 SDK／storage／網路的純函式：驗證單一 Workspace、唯一 DB ID、同父項下 frontend ID/position、親子 scope、schema、來源欄位存在，再重建原始 UI model，另回傳資料庫 ID/version/position mapping 與 Widget presence。

測試涵蓋缺省 widgets、明確空陣列、ID/type/config、位置／順序、span/height/manualSize、未知頂層／巢狀欄位、Timer 絕對 endsAt、taskId、Task completedAt 原始毫秒與時區字串。React review component 不會套用 `boardWidgets()` 的隱式預設、過濾或 clamp，更不回存顯示用尺寸。

補正既有 Widget PATCH：已儲存 config 的未知 extension keys 在修改時保留，客戶端仍不能提交不支援的新 keys；原本已知 config keys 的 replacement 語意維持。不能透過 `{config:{}}` 默默清掉未知來源欄位。

投影是**受管理、尚未開始使用者編輯的遷移快照**。正式 CRUD DTO 目前沒有 restoreShape，這個純函式沒有新增一個公開的 projection API。後續首頁整合需批准權威 projection 的讀取 Contract，並定義寫入後新增／刪除欄位、Widget absent→present、restoreShape metadata 的更新規則；不能直接將舊 restoreShape 用來投影任意編輯後的資料，否則可能漏掉新欄位。Readiness 會拒絕與 managed receipt 快照不一致的資料。

## 正式首頁最小 Cutover 設計（未接入）

目前 page.js 的 `setTasks()` 直接改 nested workspace，兩個 storage effects 載入／回存本機資料；`save()/move()/saveBoard()/deleteTask()` 都是同步本機動作，`TaskPanel` 的 onSubmit 立即呼叫 onSave，而 WidgetDashboard 傳 functional updater 給 onChange。不能把 Promise 直接塞進這些回呼。

建議下階段以小步驟實作，完成後另行驗收：

1. 保留 `LocalWorkspaceScreen` 管理原本的 state/effects。新增分開掛載的 `ApiWorkspaceScreen` 使用既有 API Hooks；Mode selector 在兩者上層，預設本機，API error 不回退到 localStorage 寫入。API store 絕不傳入本機 workspace setter，畫面不共享 cache。
2. Workspace 使用**明確 DB ID**輸入／選取。現有 GET workspaces 必須帶 id，不能假設支援枚舉。先驗證指定 Workspace、readiness 與完整 RELEASED，預設唯讀，寫入另行授權；禁止偵測 API 可用即自動切換。
3. 切換前使用既有 Backup capture/export，由使用者明確保存完整兩個 storage key JSON；重新讀回驗證來源版本／fingerprint，與計畫 sourceRevision 核對。切換時若本機來源又變動，失效原 preview/checkpoint；不刪除本機來源。
4. API 區塊處理 Loading/Error/Empty，讀取失敗不當成空清單、不補預設看板。需要權威 restore metadata 及 DB↔frontend mapping；activeBoardId/timer taskId 保持前端 ID，在 parent scope 內映射到 DB ID，不能只用全域 frontend ID Map。
5. `TaskPanel` 後續新增明確的 async handler/saving/error props：event.preventDefault 在同步事件執行，save handler 回傳 Promise；完成才關閉／顯示成功。草稿保留原 DTO version，409 保留內容並讓使用者重新讀取／比較後重送，不自動覆寫或重試。新 `useAsyncDraft()` 已獨立驗證 single-flight、錯誤、取消與過時回應，不掛載到正式 panel。不能直接 POST 全部 source data：目前 CRUD 不接受 completedAt 或任意未知欄位，Subtask 的未知來源欄位也需要先定義依 ID 保留的修改規則；欄位白名單與 server merge 必須一起設計，不能只在前端刪掉未知欄位來通過驗證。
6. Board 切換以 Workspace+Board DB IDs 作 scope/key。離開有未存草稿時明確確認；取消 request/關閉面板不代表取消 server write。舊 completion 不關閉新 Board 面板。AbortController、generation 與 versioned merge 重用現有 Hooks。
7. WidgetDashboard 後續將同步 updater 轉成明確 commands（create/update/delete/order/configure/resize）；layout measurement 只用於呈現，resize 結束／明確輸入才寫入。筆記草稿與 API 快照分離，同一 widget single-flight；Timer 儲存原 endsAt，不每秒寫入；已知／未知欄位保持保真，API 成功 DTO 才更新確認狀態。不可將 entire-array updater 直接當 API PUT。
8. Task/Widget 排序 >98、Board >99 時先阻擋，不能自動分批冒充單次原子排序；要支援更大清單需另設可恢復 order command。
9. API 切換失敗只回到保留的本機分支，保留 API 診斷／草稿，不用舊 localStorage 覆蓋遠端。Release 前可使用條件式 Rollback；Release 啟動後只能前進恢復，回本機不是 DB rollback。API 使用後本機快照已可能過時，回本機不會合併或寫回 API，需明確告知。

一般 CRUD POST 仍沒有原子 Operation Receipt（Migration Release 的冪等性不等於普通 CRUD 的冪等性）。斷網後新增結果不明時，不能依賴 GSI 空結果判定未提交並重送。正式 UI 必須停在 not-confirmed，先核對；若要保證可安全重送新增，需要另外批准穩定 command ID／create receipt 或唯一來源 ID 的條件寫入設計。本階段沒有擅自變更 CRUD 新增 Contract。

本次沒有修改 page.js、TaskPanel、WidgetDashboard、widgets.js 或其樣式；不在這輪做上述元件重構。

## Readiness 使用與限制

`checkCutoverReadiness()` 是 server/CLI-only、純讀取檢查，不新增未批准的 HTTP Contract。trusted runner 注入本機連線、API/Repository 測試、React API 測試與可讀回的備份 artifact probes；不存在／失敗的 probe 直接阻擋，不能接受瀏覽器傳來 `testsPassed:true`。資料檢查重用 Plan v2、持久化 Session/Receipts、target ownership/version/hash、完整 UI 投影及 GSI 列出的實際 children；不自動建立或解鎖任何資料。

結果分開提供 `prerequisitesPassed` 與 `ready/cutoverEnabled`。本階段後兩者固定 false，帶 `FORMAL_UI_CUTOVER_NOT_IMPLEMENTED`，`assertCutoverReady()` 拒絕切換。這是檢查報告，**不是持久化授權 token 或原子資料凍結**。GSI 最終一致性可能造成暫時阻擋，重新檢查即可，不把查不到當成不存在或據此建立資料。檢查範圍是指定 migration/workspace，未宣稱掃描整張真實資料表的全部歷史鎖。

正式使用前還需要權威 projection Contract、正式 async 畫面接線及瀏覽器驗收、明確使用者切換授權，以及避免報告後來源改動的最後凍結／重驗策略。直接更改 report 的布林值不構成伺服器安全授權。現在可在隔離環境驗證全部技術前置條件，尚未允許正式使用者遷移與首頁切換。

## 檔案清單

| 類型 | 檔案 | 用途 |
| --- | --- | --- |
| 修改 | `src/lib/slowly-repository.mjs` | 所有寫入原子檢查 Workspace barrier，排序容量 |
| 修改 | `src/lib/migration/store.mjs` | snapshot ConditionCheck，交易唯一 Item 檢查 |
| 修改 | `src/lib/migration/service.mjs` | 純讀 Release Preview、v2 release 狀態機／冪等恢復 |
| 修改 | `src/lib/api/migrations.mjs` | 新端點驗證、status/code、原有 local guard |
| 修改 | `src/lib/api/handlers.mjs` | child order 上限、Widget unknown config 保留 |
| 新增 | `src/app/api/migrations/[migrationId]/release-preview/route.js` | Preview POST route |
| 新增 | `src/app/api/migrations/[migrationId]/release/route.js` | Release POST route |
| 新增 | `src/lib/client/workspace-projection.mjs` | 保真 UI 投影與 ID mapping |
| 新增 | `src/lib/migration/cutover-readiness.mjs` | 可重複、無寫入的 readiness gate |
| 新增 | `src/lib/client/async-draft.mjs` | async form 草稿／single-flight／stale completion |
| 新增 | `src/hooks/use-async-draft.mjs` | 獨立 React form hook |
| 新增 | `src/components/managed-workspace-preview.mjs` | 獨立 React fidelity review 元件 |
| 新增 | `tests/helpers/release-fixture.mjs` | 共用隔離 fixture，不讀真實 storage |
| 新增 | `tests/release.test.mjs` | Release/API/barrier/readiness/ownership 測試 |
| 新增 | `tests/cutover-react.test.mjs` | async form 與 Widget 真實 React/Adapter/Handler 往返 |
| 新增 | `scripts/phase4c1-integration.mjs` | 專屬 DynamoDB table、備份 artifact、真實交易／React 整合 |
| 修改 | `tests/helpers/memory-client.mjs` | mock 支援真正的 transaction ConditionCheck |
| 修改 | `tests/phase2.test.mjs` | 重用具完整 condition 支援的 mock |
| 修改 | `tests/migration-service.test.mjs` | 新 Release 協定、98 entries 安全上限驗收 |
| 修改 | `package.json` | 三個可重複測試指令 |
| 修改 | `.gitignore` | 隔離報告／fixture backup artifact |
| 新增 | `docs/phase4c1-release-readiness.md` | 本文件 |

沒有刪除檔案、新增 npm 依賴或修改環境憑證。

## 驗證指令

```powershell
npm.cmd run test:server
npm.cmd run test:api
npm.cmd run test:migration
npm.cmd run test:phase4a
npm.cmd run test:react-api
npm.cmd run test:controlled-ui
npm.cmd run test:release
npm.cmd run test:cutover-react
npm.cmd run test:db:migration -- --isolated-table
npm.cmd run test:db:controlled-ui -- --isolated-table
npm.cmd run test:db:release -- --isolated-table
npm.cmd run build
npm.cmd run lint
```

DB runner 只連 http://127.0.0.1:9000。新表名稱精確為本次 `Slowly_Phase4C1_<runId>`，所有測試文件指令再次驗證 TableName，清理僅刪除它自行成功建立的表；記錄 target IDs/migrationId、備份 artifact、進度與清理結果。SlowlyTasks 只讀取前後雜湊／ACTIVE，不用於任何測試寫入。報告保留在被 Git 忽略的 `.phase4c1-test-runs/`，中斷可依本次 UUID 精確辨識表，不使用模糊前綴刪除。正式備份工具沒有自動下載或讀使用者 storage。

本次實體 Release API 使用真實 Request/Response/Handlers 加 DynamoDB；React 使用真實 React/ReactDOM minimal host 與 SSR review。不是新端點的瀏覽器端到端／排版驗收，也未假稱已完成正式首頁驗收。Next Build 會驗證新 route 載入。

## 實際結果（2026-11-14）

| 指令 | 通過 | 失敗 |
| --- | ---: | ---: |
| `test:server` | 6 | 0 |
| `test:api` | 7 | 0 |
| `test:migration` | 24 | 0 |
| `test:phase4a` | 25 | 0 |
| `test:react-api` | 21 | 0 |
| `test:controlled-ui` | 6 | 0 |
| `test:release` | 12 | 0 |
| `test:cutover-react` | 2 | 0 |
| Node 合計 | **103** | **0** |
| `test:db:migration -- --isolated-table` | 14 組 | 0 |
| `test:db:controlled-ui -- --isolated-table` | 6 組 | 0 |
| `test:db:release -- --isolated-table` | 13 組 | 0 |
| 實體 DynamoDB 合計 | **33 組** | **0** |

Build 通過；本次新增／修改 JS/mjs 的 ESLint 通過。全專案 Lint 剩原有 page.js 106/137 的 set-state-in-effect、227 的 Link 規則（3 errors），task-analytics.js 99 的 dependency warning（1 warning）。未修改這些正式 UI 檔案。Build 仍有既有父目錄 package-lock 提醒。

最後 Release DB testRun：`93bf0e62-39ae-4a1f-9214-c4a8bd140005`。13 組含實際 React API 在另一個明確建立的測試 Workspace 新增／修改／排序／刪除 Widget，再檢查受管理 Workspace 的保真快照；readiness 不以寫入自己的目標來「修復」或通過驗證。報告顯示 prerequisitesPassed=true、ready=false、cutoverEnabled=false。測試表已刪除，remainingItems=0、remainingLocks=0；SlowlyTasks 雜湊未變、ACTIVE。

初次整合 fixture 曾用 schema 不支援的 30 分鐘而得到 400，已改用既有支援的 45 分鐘後重跑通過，沒有放寬 schema。Phase 2 原先簡化 mock 不認識 ConditionCheck，已改用共用完整條件 mock，回歸通過。這些不是遺留失敗項目。沒有改寫任何真實使用者 Item／localStorage，沒有執行 Commit/Push/Merge。
