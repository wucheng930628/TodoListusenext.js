# Phase 4A.1：Migration Safety 與原子冪等性

本階段只建立伺服器基礎設施及隔離測試。UI、Client Adapter、localStorage 流程皆未接入 Migration；沒有讀取真實瀏覽器資料或對 DynamoDB Local／AWS 執行任何讀寫。沒有 Git commit/push/merge。以下持久化操作是程式提供的能力，不表示已對目前資料表執行。

## 檔案與責任

| 檔案 | 用途 |
| --- | --- |
| src/lib/migration/plan-v2.mjs | 伺服器重算 Plan v2、fingerprint、來源欄位存在資訊與 Workspace 還原 |
| src/lib/migration/store.mjs | SDK v3 強一致 Get、條件 Put/Delete、TransactWrite |
| src/lib/migration/service.mjs | 持久化 Session、Manifest、Receipt、執行、驗證、回滾與內部解除鎖定 |
| src/lib/migration/index.mjs | 本機 server-only Client 入口，僅在 API 檢查通過後載入 |
| src/lib/api/migrations.mjs | Migration Request 驗證、安全錯誤、DTO 與共享環境限制 |
| src/app/api/migrations/**/route.js | 八個 Route 檔案，九個 HTTP 方法 |
| src/lib/migration/preparation.mjs | 修正來源版本、Widget presence fingerprint 與明確父層檢查 |
| src/lib/slowly-repository.mjs | 每個既有 Put/Delete 的交易條件加入 Migration Lock |
| src/lib/api/handlers.mjs | 共用 Host/Origin/Body 檢查；新增已批准的 MIGRATION_LOCKED 409 |
| tests/helpers/memory-client.mjs | 評估實際產生的條件式、原子提交及可控競爭／回應遺失 |
| tests/migration-service.test.mjs | 服務、原子性、鎖定、保真、回滾與隔離測試 |
| tests/migration-api.test.mjs | 九個 API 方法與既有 CRUD 的整合測試 |
| package.json | 新增 test:migration |

既有 CRUD 的 Request 及成功 Response 格式保持不變。新增鎖定資源可能回傳已批准的 409 MIGRATION_LOCKED。

## API Contract

以 `npm.cmd run dev:api` 明確啟用，伺服器綁定 127.0.0.1:3000。Production 一律拒絕，即使啟用變數存在；沿用 Host、Origin、代理及 Fetch Metadata 檢查，不能透過公開代理／隧道使用。沒有登入與正式權限系統。

所有成功回應為 `{data: ...}`，錯誤為 `{error:{code,message,issues?}}`。不回傳 SDK 診斷、stack、憑證或任意底層 cause。回應 no-store。Migration Body 上限 2 MiB，不截斷超出資料。舊 CRUD 保持原本 200,000 bytes 限制。

### 預覽及建立 Session

```js
// POST /api/migrations/preview
{
  backup, // Phase 4A Backup v1，含原始 Storage JSON
  sourceNamespace: "device-fixed-source-uuid", // 請換成明確保存的固定來源識別
  policies: {
    widgets: "preserve-implicit",
    timer: "preserve-absolute",
    // 僅 legacy 來源需明確提供，禁止猜測或提供 children：
    // legacyBoard: { id: "legacy", name: "確認名稱", description: "", wipLimit: 4 }
  }
}
```

sourceNamespace 僅接受 8–128 位英數、`.`、`_`、`-`。可省略 policies，採用已批准的保真政策，不能使用 reset timer 等其他值。

預覽 200 回傳 planId/migrationId、formatVersion:2、counts、sourceRevision、issues 與操作摘要 operationId/type/targetId/parentId/fingerprint，不寫入資料。

`POST /api/migrations` 使用相同 Body 加 `expectedPlanId`。伺服器重新計算計畫並核對，首次 201，既有相同 Session 200。客戶端不能提供 Manifest、目標 Key、TableName、資料庫運算式或自行指派 operationId。

Session 建立不等於已匯入。第一次只登記操作意圖：每次請求最多嘗試登記 32 筆，可能回 PREPARING；須以完全相同的 Backup/namespace/policies/expectedPlanId 再次 POST 才繼續。所有登記完成並核對 Manifest digest 後才 READY。沒有背景自動執行或自動來源匯入。

### Session、操作與查詢

| Method | Endpoint | Body／Query | 成功 |
| --- | --- | --- | --- |
| GET | /api/migrations/[migrationId] | 無 | 200 Session 摘要 |
| GET | /api/migrations/[migrationId]/operations | cursor=0、limit=25；limit 1–50 | 200 `{items,nextCursor}` |
| GET | /api/migrations/[migrationId]/operations/[operationId] | 無 | 200 Receipt 摘要 |
| PUT | /api/migrations/[migrationId]/operations/[operationId] | `{expectedPayloadFingerprint}` | 201 首次；200 replay |
| POST | /api/migrations/[migrationId]/verify | `{}` | 200 驗證結果 |
| POST | /api/migrations/[migrationId]/rollback-preview | `{}` | 200 刪除計畫與衝突 |
| POST | /api/migrations/[migrationId]/rollback | `{expectedSessionVersion,confirmation:migrationId}` | 200 回滾進度 |

migrationId 與 operationId 均為伺服器計算的 64 位 hex。PUT 從已封存的伺服器操作取 Payload，只接受 fingerprint 作為預期值比較。Body 不接受替換資料或目標 Key。相同 ID 搭配不同 fingerprint 為 409 IDEMPOTENCY_KEY_REUSE，不會污染原 Receipt。

Receipt 摘要含 migrationId、operationId、targetId、type、state、fingerprint、managedVersion、writeVersion、confirmedAt、rolledBackAt、lastError。首次執行為 replayed:false，重播 replayed:true；managedVersion 可能因遷移自己的父項目更新而增加，writeVersion 保留首次建立版本。

其他狀態碼：400 格式／參數錯誤；403 非本機來源；404 Session／Operation 不存在；409 PLAN_CONFLICT、SOURCE_CONFLICT、SESSION_STATE、DEPENDENCY_CONFLICT、TARGET_CONFLICT、INTEGRITY_CONFLICT、ROLLBACK_CONFLICT、WIP_LIMIT 等；413 過大 Body；422 PREVIEW_INVALID／UNSUPPORTED_SCHEMA；500 安全化的儲存或未預期錯誤。

## 持久化控制 Item

沿用 SlowlyTasks、String id 主鍵，不需要建表、重建或 GSI 變更。每個控制 Item 有 entityType、schemaVersion:1、version、createdAt、updatedAt。

| entityType | id 格式 | 關鍵資料 |
| --- | --- | --- |
| MIGRATION_SOURCE | `SLOWLY#MIGRATION_SOURCE#hash(namespace)` | migrationId、sourceRevision、來源識別 hash |
| MIGRATION_SESSION | `SLOWLY#MIGRATION_SESSION#migrationId` | 狀態、lockState、Plan/Schema 版本、政策、Manifest hash、來源 hash、數量與進度 |
| MIGRATION_MANIFEST | `SLOWLY#MIGRATION_MANIFEST#migrationId#12位index` | index、operationId、source key、targetId、fingerprint 摘要 |
| MIGRATION_OPERATION | `SLOWLY#MIGRATION_OPERATION#migrationId#operationId` | 不可變操作 Payload、restoreShape、狀態、writeVersion、managedVersion、managedHash、時間與錯誤 |

每個 Manifest 頁目前只有一筆操作摘要，Key 可推導，因此不需靠 GSI 找齊所有操作。完整計畫不塞進單一 Session Item。登記時 Manifest、PENDING Operation、Session registeredCount 同交易建立。

同一來源 namespace 綁定一個 migrationId。來源改變會有新 Plan，但不能自動占用原來源的候選目標；回 409 SOURCE_CONFLICT，需另行審查。即使回滾，綁定與收據也保留，不刪除或設 TTL，以免舊請求重播重建。

新建業務 Item 仍為 WORKSPACE／BOARD／TASK／WIDGET、schemaVersion:1，新增伺服器欄位：

```js
{
  migrationLock: true,
  migrationOwner: { migrationId, operationId },
  restoreShape: { dataKeys: ["原始存在的欄位"], widgetsPresent: true } // 後者僅 Board
}
```

歸屬與鎖定只會放在本次建立的資料，沒有針對既有使用者 Item 執行更新或接管。原有資料即使剛好占用候選 Key、或內容相同但沒有匹配收據，也會拒絕。

## 原子冪等性與並發

一筆 Task 操作最多五項 TransactWrite：新 Task、Operation→CONFIRMED、父 Board 計數／版本、父 Operation 受控版本／hash、Session 進度／版本。Workspace 根操作為三項。每項 Key 不重複。

- 新資料使用 attribute_not_exists(id)。
- Operation／Session 使用版本條件，不會只更新前端 Checkpoint。
- 目標與 CONFIRMED 收據同交易，全部成功或全部失敗，父計數只增加一次。
- 同 Session 的不同操作由 Session CAS 序列化；已證明是條件取消／TransactionConflict 時最多重讀重試 16 次，其餘回 409。網路錯誤不自動當成未提交重送。
- 已提交但回應遺失，Get Receipt 或相同 PUT 會讀到 CONFIRMED，不再建立資料。
- 不依賴 ClientRequestToken 的時效。持久 Receipt 與條件寫入提供長期防重播。
- 每筆交易最多 100 個不同 Item、JSON request 預算低於 3.5 MB；每個 Item JSON 預算低於 350 KB。登記前先檢查所有待寫 Item，過大則拒絕，不先建立來源綁定。

整個 Workspace 不是單一原子交易。PREPARING／部分 RUNNING 都有持久進度，可由新 service instance 讀 Receipt 恢復，不需要 Client Checkpoint。

## Lock 與 TOCTOU

既有 Repository 每一個更新 Put／Delete 都在原交易條件加入：

```text
version = expected AND entityType = expected
AND (attribute_not_exists(migrationLock) OR migrationLock = false)
```

程式另有事前檢查供錯誤提示，但原子條件才是防線。包含 Workspace 儲存、Board CRUD、Task/Widget CRUD、狀態切換及三種排序。新增子項目本來就會更新父項目，父 Put 的 Lock 條件同時阻擋新增，不另加交易 Item，仍支援 99 筆排序＋父項目，共 100 項。

新遷移 Item 從建立的同一交易開始就帶 Lock；本功能不會鎖定或匯入既有目標資料。一般 CRUD 不能修改這些頂層伺服器欄位。鎖定條件也會檢查 parent Put，因此不能藉建立新子項目繞過。

Session 網路失敗、FAILED、CONFLICT、VERIFYING、VERIFIED 都不會自動解除 Item Lock。

內部 `release(migrationId, expectedVersion)` 僅能從 VERIFIED 明確呼叫；沒有 HTTP release endpoint、也沒有 UI 呼叫。它先把 Session 永久轉為 RELEASED（停止匯入與自動回滾），再每次以交易解除一筆 Item 並更新 Receipt/cursor。部分失敗保留 RELEASING 進度，可明確恢復；未完成解除的 Item 仍鎖定。Phase 4C 必須另外設計觸發入口。

## Data Fidelity

- source schemaVersion 僅接受缺省或 1；Backup/Storage 格式另行驗證，控制 Item 版本與 Plan 版本也有獨立檢查。
- Plan v2 的 fingerprint 納入 restoreShape、Widget presence、來源 ID、父層、位置、完整 data 與 schemaVersion；政策亦參與 migrationId。
- v1 Widget presence 完整性檢查已修正，舊 v1 計畫／Checkpoint 需重新產生，不能自動升級為可執行 v2。
- completedAt 原值、null 或缺省都保留，不呼叫一般 CRUD 的完成時間更新邏輯，不用現在時間補填。
- 既有 fromFrontend 的明確預設值用於資料模型相容；dataKeys 保存原始存在性，還原時不把補出的預設誤認為來源欄位。缺少必要看板設定仍阻擋，不猜名稱/WIP。
- 未知合法 JSON 欄位、Widget config 及 Subtask 額外欄位保留，Subtasks 維持內嵌。
- Widget 缺省與 [] 不混用，不自動建立 analytics；Timer endsAt 保留原絕對值。
- 依來源陣列保存 Board／Task／Widget position。父層 identity 區隔相同前端 ID，禁止跨 Workspace／Session 套用操作。
- WIP 超額、無效日期、重複 ID、矛盾完成時間、未知 Schema、明確父層不一致、非可安全表示數值及過大 Item 均阻擋，沒有為了通過而丟欄位或取整。

Verify 將 Session CAS 轉 VERIFYING，凍結新的遷移寫入，普通 CRUD 仍受 Lock 保護。使用強一致 Key 逐筆核對完整 Manifest、Receipt、目標版本／完整 hash、歸屬、Board 計數及 WIP，重組 Workspace 與伺服器保存的 expectedWorkspaceHash、counts 比對後才 VERIFIED。Verify 本身不解除 Lock。

## 狀態與安全回滾

主要 Session 狀態：PREPARING → READY → RUNNING → VERIFYING → VERIFIED。衝突為 CONFLICT，已確定提交前拒絕可為 FAILED；兩者都保留 Lock。只有 FAILED 可在問題排除後明確重送，已存在資料或不相容 Payload 不會強制接管。網路不明結果保持查詢收據的語意，不能捏造 FAILED。

回滾狀態為 ROLLING_BACK → ROLLED_BACK，衝突為 ROLLBACK_CONFLICT。Operation 的 CONFIRMED 寫入歷史保留 confirmedAt/writeVersion，回滾後記 ROLLED_BACK/rolledBackAt。lastError 與版本亦持久保存。

rollback-preview 純讀取，輸出 sessionVersion、canRollback、deletable、conflicts。真正回滾必須帶這個預期版本與 confirmation=migrationId。每次只回滾一筆，反向依 Manifest 順序刪除子項目，再刪父項目，最後一次呼叫關閉 Session；須依回傳版本明確繼續，不在 HTTP timeout 後盲目重送舊版本。

每次刪除交易核對完整觀察到的欄位快照（包含 ownership、lock、version、data、位置、shape、計數），同交易更新 Receipt、父計數／受控版本與 Session。外部編輯即使沒有增加 version，預檢的完整 hash 也會偵測；已知欄位在預檢後被修改，Delete 條件會失敗。目標不存在、沒有匹配 Receipt、跨 Session 或版本／內容異常都拒絕，不會因「看起來像測試資料」而刪除。

部分回滾成功但回應遺失，可由持久 Receipt 的 ROLLED_BACK 與 Session 版本恢復；並發回滾不會重複扣計數。控制資料與來源 Backup/localStorage 不刪除。RELEASED 一律禁止自動回滾，避免刪除後續使用者編輯。

## 測試與限制

```powershell
npm.cmd run test:migration
npm.cmd run test:phase4a
npm.cmd run test:server
npm.cmd run test:api
npm.cmd run build
npm.cmd run lint
```

本輪 Migration 24 tests、Phase 4A 25、Phase 2 6、Phase 3 7，全數通過，合計 62 tests。Build 與本次變更檔案 lint 通過。全專案 lint 的既有 UI 問題另列，不修改 UI 以消除。

完整 lint 仍有 page.js 的 3 errors（effect 內 setState、首頁 a 連結）與 task-analytics.js 的 1 warning。這些檔案未修改。Build 的上層 package-lock.json／Git root 提示也維持原狀。

測試使用實際 SDK Command、實際服務與 Repository，搭配隔離的記憶體 Client；驗證條件式的 AND/OR、快照相等、原子提交及提交前／後故障注入。涵蓋九個 API 方法、同操作重送、不同 Payload、網路回應遺失、並發登記／執行／回滾、持久恢復、父版本、CRUD TOCTOU、99 筆排序上限、Schema/presence/保真、回滾衝突與原有 fixture 保護。

尚未對真實 DynamoDB Local 執行這套新服務的整合測試，因此不把 mock 通過說成已驗證 Local 執行。進入真實資料 Phase 4B 前，應先以獨立 namespace、隔離資料與完整紀錄驗證 Local 的交易／條件式，再取得真實來源遷移授權。

其他限制：

- Item Lock 防護涵蓋本專案 Repository 路徑；有直接 DynamoDB 寫入權限的程式可繞過應用程式，不能當成資料庫層登入授權。不得同時用手動工具改寫受保護資料。
- Verify 在應用程式寫入凍結下驗證已封存 Manifest，不宣稱能防禦具有直接 DB 權限、同時偽造版本／所有權的對手，也不掃描並清理表中其他資料。
- 來源與控制 Item 不設自動過期；不同來源修訂不能自動取代已綁定來源。清理／重新綁定需未來明確審核工具。
- 2 MiB 以上的 Backup 目前拒絕，沒有實作分段上傳。
- 所有登記狀態需要呼叫者明確繼續，沒有背景 worker。
- UI 的讀取 adapter、Migration 按鈕、release 入口與切換／回滾使用者流程仍屬 Phase 4B/4C。
- 舊 db-test 仍為本機除錯頁，會 Scan 混合資料表；本專案不可公開部署。
