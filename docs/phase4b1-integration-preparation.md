# Phase 4B-1：真實交易驗證與 React API 準備

## 本輪範圍

主看板仍使用原本的 localStorage。沒有修改 page.js、任務面板、行事曆、統計、小組件或 Client API Contract；沒有匯入真實使用者資料，沒有實作 Release HTTP 端點，也沒有 commit/push/merge。

檢查確認 page.js 仍在初始化讀取 slowly-workspace-v2，缺少新版時讀 slowly-board-v1，ready 後寫回 workspace；Task Panel 仍為同步儲存介面，未接入 async Hook。API DTO 外層 id/version 與內層 data.id 的差異、Board 父版本與 WIP 規則均沿用。

## 新增／修改檔案

| 檔案 | 用途 |
| --- | --- |
| scripts/phase4b1-dynamodb-test.mjs | 獨立測試表、真實 DynamoDB 交易、原表雜湊保護及限定清理 |
| src/lib/client/data-source.mjs | 明確且預設 localStorage 的資料來源政策 |
| src/lib/client/resource-controller.mjs | 與 React 無關的訂閱式 API 狀態、scope、取消、版本與 ID Mapping |
| src/hooks/use-slowly-api.mjs | useSlowlyWorkspace／Boards／Tasks／Widgets，未接入正式 UI |
| tests/resource-controller.test.mjs | 資料來源與 controller 狀態／競爭測試 |
| tests/react-api-hooks.test.mjs | 真實 React/ReactDOM Hook 與 Adapter 整合測試 |
| tests/helpers/react-hook-host.mjs | 僅支援 null 輸出的最小 DOM host，沒有替換 React 的 Hook dispatcher |
| package.json | 新增 test:react-api 與 test:db:migration |
| .gitignore | 忽略本機整合測試報告 |
| docs/phase4b1-integration-preparation.md | 本文件，含尚待核准的 Release API 方案 |
| docs/phase4a1-migration-safety.md | 補上後續真實 Local 驗證的文件連結 |

## DynamoDB Local 真實整合結果

確認 http://127.0.0.1:9000 可存取，原 SlowlyTasks 為 ACTIVE。Windows 找不到 Docker CLI；唯讀列舉 WSL 可看到 docker-desktop，但該 distribution 明確不支援直接使用 Docker CLI。因此沒有把容器名稱／埠映射檢查說成已成功，後續以 DynamoDB API 的實際交易結果驗證服務。

執行：

```powershell
npm.cmd run test:db:migration -- --isolated-table
```

只允許固定本機 endpoint。腳本先核對原表可讀，再使用含唯一 run UUID 的新表，主鍵與 GSI 對應現有模型。測試用 DocumentClient 包裝器會拒絕任何指向其他 TableName 的測試／寫入指令；原表只做 Describe 與強一致 Scan 雜湊比對。

本次 runId：`7df3b847-09ea-4c20-8504-956491932fde`。

獨立表：`Slowly_Phase4B1_7df3b84709ea4c208504956491932fde`。

14 項全部通過：

1. 部分登記後恢復 Session／Manifest。
2. 目標與 Receipt 持久化。
3. 真實 TransactWrite 其中一項條件失敗，其他寫入也全部取消。
4. 相同操作重送，不重複寫入或計數。
5. Fingerprint 衝突 HTTP 409。
6. 實際交易成功後注入回應遺失，從 API Receipt 查詢並重送恢復。
7. 多個子操作並發，父版本及計數正確。
8. 外部修改父版本後拒絕新增子項目。
9. Lock 阻擋 CRUD，包含讀取後、提交前才取得 Lock 的真實競爭。
10. Migration Verify。
11. completedAt、Timer、未知欄位與 Widget Presence 全資料往返。
12. Rollback Preview 純讀取。
13. 條件回滾與計數更新。
14. 部分回滾提交後回應遺失，再從持久狀態恢復。

回應遺失為實際 SDK 提交後的可控故障注入，API 是實際 Route Handler factory 搭配該測試表；沒有額外啟動或終止使用者的 Next dev 伺服器，也沒有聲稱模擬了真實 TCP 斷線。

清理前有 43 筆本次控制／測試資料及 3 個刻意保留衝突的測試 Lock。腳本只刪除本次成功建立且名稱相符的獨立測試表，不清空或刪除 SlowlyTasks。刪表後確認不存在，本次資料與 Lock 殘留均為 0。原表 1 筆資料前後完整雜湊一致，仍為 ACTIVE。

報告保存於 `.phase4b1-test-runs/<runId>.json`，已忽略，不含原資料內容或憑證。若無法建立隔離表會在業務寫入前停止；若清理失敗，保存本次表名及錯誤，不嘗試刪除其他表。

## React 資料層

```js
import { useSlowlyTasks } from '@/hooks/use-slowly-api.mjs';

// 僅為未接入正式 UI 的示範。
const tasks = useSlowlyTasks({
  mode: 'api',
  workspaceId: workspaceDatabaseId,
  boardId: boardDatabaseId,
  apiReady: true,   // 由未來已確認的來源流程提供，不是 DB 自動偵測
  allowWrites: false,
});
```

四個 Hook 共用 `createSlowlyApi()` 與 framework-independent controller：

- useSlowlyWorkspace：getWorkspace，僅提供 update；不透過 Hook 自動建立 Workspace。
- useSlowlyBoards：listBoards 與明確 create/update/remove/reorder。
- useSlowlyTasks／useSlowlyWidgets：依 Board 取得資料並提供相同操作。

共用 options 為 api（測試可注入）、mode、workspaceId、boardId、apiReady、allowWrites。回傳 status、loaded、loading、success、error、data、source、idMapping、mutation，以及 refresh/cancel/create/update/remove/reorder。Workspace update 也傳資料庫 id，必須符合目前 scope。首次讀取未成功前拒絕寫入，避免把失敗後的空值當成完整集合。

```js
await tasks.update(taskDatabaseId, {
  version: taskVersion,
  data: { title: '更新名稱' },
});
```

data 保留完整 DTO；沒有把 data.id 覆蓋成資料庫 ID。idMapping 是每個 scope 的陣列，包含 databaseId/frontendId/version/position/workspaceId/boardId；重複前端 ID 不會互相覆蓋。Body parent scope 不能由呼叫者改成其他 Workspace／Board。

### Loading／Error／Cancellation

讀取狀態為 idle/loading/success/error；另外有 local-storage、migration-required、scope-required。寫入狀態獨立放在 mutation，失敗保留已載入資料與版本，不模擬成功。

AbortController 傳入原 Adapter；refresh、切 scope、cancel、unmount 都會失效舊請求。scope generation 與 read sequence 另外檢查，即使 transport 忽略 abort，晚到的 A Board 結果也不能蓋掉 B。Hook 在新 scope 的 effect 執行前也遮蔽舊 data；舊 scope callback 會回 STALE_SCOPE。

寫入採 single-flight；不自動重試 POST/PATCH/DELETE。取消不代表伺服器回滾，outcome=not-confirmed 必須重新查詢，不能盲目重送。舊寫入取消後可讀取新 Board；舊寫入未結束前不啟動下一個寫入。寫入開始時取消舊讀取，避免舊快照蓋掉已確認的新版本。

HTTP 400/403/404/409/500、Network Error 保留 Adapter 的 status/code/message/outcome。409 交由未來 UI 保留草稿並處理衝突，不自動覆寫。沒有因錯誤而切回 localStorage。

## 明確資料來源切換方案

`resolveDataSource()` 不讀取 storage、環境變數、URL 或 DB：

| 設定 | 結果 |
| --- | --- |
| 未指定 mode | localStorage，不讀 API、不寫 API |
| mode=localStorage，即使 DB 可用或其他旗標為 true | 仍維持 localStorage |
| mode=api，但沒有 workspaceId 或 apiReady=false | migration-required，不發請求 |
| mode=api、明確 workspaceId、apiReady=true | 可讀 API |
| 上述條件再加 allowWrites=true | 可明確寫 API，仍受伺服器 Lock/Version 控制 |

apiReady 是前端流程準備狀態，不是權限或已驗證 Receipt 的替代品。Phase 4B-2 應從明確選定的 Workspace／Migration 狀態取得此值，禁止用「DB 可連線」或現有 localStorage 有資料直接設 true。

Hook 的 local-storage 狀態不會讀取本機 workspace，data 是未載入的空值；未來 localStorage provider 必須沿用既有資料流，不能把這個空值當作可覆寫來源的資料。

未修改目前 UI 架構。未來整合建議只在一個資料來源邊界選取既有 localStorage provider 或新 API provider，保留現有任務元件的 DTO 轉換與回呼介面；Task Panel 非同步儲存另行實作，不能直接替換同步 onSave。

回切 localStorage 也必須明確觸發，使用保留的本機資料／Backup；不自動以舊快照蓋遠端，不刪除來源。Release 前可先安全回滾 Migration；Release 後有使用者寫入時禁止自動刪除雲端資料，需另外規劃同步／復原。

## Lock Release API 提案（尚未實作，等待確認）

現有 release() 只允許 VERIFIED 或已開始的 RELEASED 恢復。首次會再 Verify；PREPARING、RUNNING、FAILED、CONFLICT、VERIFYING、部分 ROLLBACK 均不允許。Receipt 必須全數 CONFIRMED，資料、計數與受控版本一致。

目前內部方法先標記 Session RELEASED/RELEASING，使回滾不可再執行，再分筆解鎖。斷線不會把剩餘 Lock 全部清掉，可依 releasedCount 恢復。它不是整個 Workspace 的原子解鎖，已解鎖項目可能先允許 CRUD；因此 UI 不得在看到 Session.state=RELEASED 時就假定全部解鎖完成，必須檢查 lockState=RELEASED 且 releasedCount=total。

建議新增下列兩個本機端點，但本輪沒有新增：

1. `POST /api/migrations/[id]/release-preview`，Body `{}`。重新核對狀態／Verify／所有 Operation，回傳 canRelease/canResume、sessionVersion、verificationHash、remainingLocks、irreversible 與原因。若要保持 Preview 完全唯讀，需抽出現有 Verify 的純檢查部分，不能直接呼叫會變更狀態的 Verify。
2. `POST /api/migrations/[id]/release`，Body `{expectedSessionVersion,expectedVerificationHash,confirmation:migrationId}`。伺服器重新核對 fingerprint 與版本，不信任客戶端提供的結果；每次推進有限項目。未完成回 202 + releasedCount/total + nextAction=resume-release，完成才 200。過期版本、部分回滾或衝突回 409，錯誤沿用安全格式。

沒有背景 worker，202 不表示系統會自行繼續；需明確查詢與恢復。解除前必須提示不可逆及自動回滾停用。若要求所有 Item 在同一瞬間解除，需要額外的伺服器 Session Gate 設計，並處理現有 99 筆排序的交易上限；不能宣稱現有分筆解鎖已具備此保證。

## 測試方式與界限

```powershell
npm.cmd run test:react-api
npm.cmd run test:db:migration -- --isolated-table
npm.cmd run test:migration
npm.cmd run test:phase4a
npm.cmd run test:server
npm.cmd run test:api
npm.cmd run build
npm.cmd run lint
```

React/controller 共 21 個測試。Hook 使用實際 React 與 ReactDOM/act，只有 host DOM 為最小 test shim，Probe 回傳 null；驗證的是真實 React effect/subscription/state 更新，不宣稱覆蓋版面或瀏覽器互動。沒有新增測試套件依賴，registry 查詢無法連線也不影響執行。

涵蓋 Adapter → Hook 狀態、四個 Hook 合約、快速切 Board、舊 callback、AbortSignal、卸載、400/403/404/409/500/Network、寫入版本、204、single-flight、錯誤保留資料、default localStorage 與 API 不自動啟用。資料來源工具無任何 localStorage 寫入或 Migration 呼叫。

既有 62 個測試另行迴歸。DynamoDB 整合的 14 個案例與 React/controller 21 個為新增驗收，合計 97 項全部通過。Build 與本次程式 lint 通過；完整 lint 仍有既有 page.js 的 3 errors 及 task-analytics.js 的 1 warning，相關 UI 檔案未修改。Build 另有上層 package-lock.json 不在 Git root 的既有提示。

## Phase 4B-2 待辦

- 核准 Release API Contract 與分筆解鎖語意；本輪停在提案。
- 明確的 Workspace／Migration 選擇與 apiReady/allowWrites 授權流程。
- 正式資料來源 provider 邊界、Task Panel 非同步儲存及 DTO projection；先提出 UI 接入方案。
- 保留 Widget presence、原始欄位與版本的完整 Workspace 載入／顯示策略。
- UI loading/error/conflict、寫入不明結果提示、離線與回切模式流程。
- 真實來源 Backup/namespace 與遷移前後確認；本輪不代表已獲得匯入真實資料的授權。
