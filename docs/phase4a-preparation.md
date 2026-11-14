# Phase 4A：前端 Adapter 與安全遷移準備

## 範圍與目前狀態

本階段新增獨立工具，不匯入主畫面、不切換資料來源、不變更 Phase 2/3 Contract。沒有真實瀏覽器資料讀取、DynamoDB 連線／寫入、遷移執行器、新 API 或自動下載。測試僅使用 fixture、記憶體 DocumentClient 及可控 fetch。

Client 工具放在 `src/lib/client/`，使用 `.mjs` 與現有資料層一致，也讓原生 Node 測試不需要改變整個專案的 module type。它們沒有 server-only、AWS SDK、Node API、React 或環境變數依賴。Preview 放在 server-only 的 `src/lib/migration/preparation.mjs`，才能直接重用現有 `data-model.mjs`，避免把 Node crypto 或模型伺服器邊界帶進 Client Bundle。

## 檢查結果

- `page.js` 只直接呼叫三次 localStorage：讀 `slowly-workspace-v2`、缺少新版時讀 `slowly-board-v1`、ready 後寫回整份 v2 workspace。
- v2 是 `{activeBoardId, boards:[{id,name,description,wipLimit,tasks,widgets?,analyticsSize?}]}`。Task 包含描述、優先級、日期／時間、狀態、子任務、備註及完成時間。Widget 包含 type、span、height、manualSize、config。
- 任務狀態經 setTasks/completionUpdate 更新；UI 依陣列順序顯示。Widget 拖曳／左右移動實際重排陣列，尺寸最後寫入狀態，筆記每次輸入更新 config。
- Task Panel 的 onSave 仍是同步介面。本階段未更動；未來接 API 時必須處理 await、儲存中、失敗與保留草稿。
- API 回傳 `{data: DTO}`；DTO 外層 id 是資料庫 ID，內層 data.id 是原前端 ID。列表 data 是陣列，DELETE 為 204。
- 修改／刪除需 version；子項目寫入會增加 Board 版本。Board 只有在沒有 Task/Widget 時可刪除。排序最多 99 個項目。
- API 預設關閉、僅允許明確啟用的本機 development；沒有登入授權，不能公開部署。
- `GET /api/workspaces` 沒有 id 時為 501，`?id=...` 為單筆集合查詢，不能當成完整 Workspace 列表。

## API Adapter

```js
import { createSlowlyApi, SlowlyApiError } from '@/lib/client/slowly-api.mjs';
const api = createSlowlyApi(); // 不會發出請求
```

可注入 `createSlowlyApi({fetchImpl})`；所有方法最後一個參數支援 `{signal}`。方法回傳 Promise，解析並回傳外層 `{data: ...}` 裡的 DTO／DTO[]，保留 DTO.id、DTO.version、DTO.data.id，DELETE 回傳 null。缺少動態 ID 等參數會直接拋 SlowlyApiError，其餘非同步錯誤由 Promise 拒絕。

| 函式 | 參數 | 回傳 |
| --- | --- | --- |
| listWorkspaces | `({id?}, options?)` | DTO[]；無 id 時保留 501 |
| createWorkspace | `({data}, options?)` | DTO |
| getWorkspace | `(id, options?)` | DTO |
| updateWorkspace | `(id, {version,data}, options?)` | DTO |
| listBoards | `({workspaceId}, options?)` | DTO[] |
| createBoard | `({workspaceId,position?,data}, options?)` | DTO |
| getBoard | `(id, {workspaceId?}?, options?)` | DTO |
| updateBoard | `(id, {workspaceId,version,data}, options?)` | DTO |
| deleteBoard | `(id, {workspaceId,version}, options?)` | null |
| reorderBoards | `({workspaceId,entries}, options?)` | DTO[] |
| listTasks / listWidgets | `({boardId,workspaceId?}, options?)` | DTO[] |
| createTask / createWidget | `({boardId,workspaceId?,position?,data}, options?)` | DTO |
| getTask / getWidget | `(id, {boardId?,workspaceId?}?, options?)` | DTO |
| updateTask / updateWidget | `(id, {boardId,workspaceId?,version,data}, options?)` | DTO |
| deleteTask / deleteWidget | `(id, {boardId,workspaceId?,version}, options?)` | null |
| reorderTasks / reorderWidgets | `({boardId,workspaceId?,entries}, options?)` | DTO[] |

entries 是 `[{id: databaseId,version,position}]`。參數對應現有 API，不把整個 DTO 當成可寫 Body，也不默默移除不支援欄位。詳見 Phase 3 文件的允許欄位。

```js
const task = await api.updateTask(databaseId, {
  boardId: boardDatabaseId,
  version: currentVersion,
  data: { notes: '編輯內容' },
});
```

集中處理 JSON、Accept/Content-Type、no-store、同源 credentials/mode、禁止 redirect，對每個 path/query 值呼叫 encodeURIComponent。瀏覽器自行帶同源 Origin，Adapter 不偽造 Host/Origin。

SlowlyApiError 保留 status、code、message、method、path、outcome；網路錯誤的 status 為 null，不假裝 500。已知 HTTP 回應保留原本 400/403/404/409/500/501 與錯誤 code；無效 JSON 回應仍保留 HTTP status，code 為 INVALID_JSON_RESPONSE。另有 NETWORK_ERROR、ABORTED、INVALID_RESPONSE、SERIALIZATION_ERROR、INVALID_ARGUMENT。

POST/PATCH/DELETE 不重試。即使收到 500、AbortError 或無效成功回應，寫入也可能已成功；outcome=not-confirmed，不代表安全重送。只有發送前序列化／參數失敗是 not-sent；可讀的 4xx 回應是 rejected。

## Backup

只有明確呼叫才會讀取資料，只有上述兩個 Key；沒有 setItem、removeItem、clear、Blob、下載按鈕或自動匯出。

```js
import {
  captureWorkspaceBackup, exportBackupJson, validateBackup, readBackupSource,
} from '@/lib/client/workspace-backup.mjs';

// 範例僅供之後在使用者明確觸發的事件中執行。
const backup = captureWorkspaceBackup();
const json = exportBackupJson(backup); // 僅回傳字串，不下載或寫檔
const verifiedBackup = validateBackup(json);
```

可注入 `{storage,createdAt}` 供測試使用。

```json
{
  "format": "slowly-workspace-backup",
  "formatVersion": 1,
  "createdAt": "<ISO UTC>",
  "selectedSourceKey": "slowly-workspace-v2",
  "sources": [{
    "key": "slowly-workspace-v2",
    "storageVersion": 2,
    "raw": "<原始 JSON 字串，完整保留空白與未知欄位>",
    "summary": {"boards": 2,"tasks": 3,"subtasks": 3,"widgets": 3}
  }]
}
```

若兩個 Key 皆存在就都保留，預設選 v2 作遷移來源，不將舊資料合併進新版造成重複。新版毀損時明確報錯，不偷偷回退。legacy 的 raw 仍是原任務陣列，不補上猜測的看板。

驗證 JSON、格式／來源版本、來源存在性、摘要、時間與來源容器結構。缺少資料、空字串、壞 JSON、未知版本、摘要不符、無法存取 storage 都有 BackupError.code。空陣列可備份，但 Preview 會阻止空 Workspace 切換。

Backup 格式驗證不等於符合任務模型；深層 Schema 與關聯檢查交由 Preview，讓原始資料先保留。未知合法欄位不正規化或刪除。疑似 API Key、Token、Credentials 等欄位會拒絕匯出而非靜默刪除。工具不讀環境變數或其他 Storage Key；自由文字內若被人手動貼入機密，無法靠欄位檢查保證辨識，匯出前仍須人工檢視。備份包含私人任務與筆記，不應提交 Git 或公開。

## Preview 與可重現 ID Mapping

```js
// 僅限 server module 或 node --conditions=react-server 的離線工具。
import { previewMigration, prepareMigration } from '@/lib/migration/preparation.mjs';
const options = { sourceNamespace: 'confirmed-source-uuid' }; // 換成明確保存的固定來源識別
const preview = previewMigration(verifiedBackup, options);
const plan = prepareMigration(verifiedBackup, options);
```

sourceNamespace 要使用 8–128 字元英數、`.`、`_`、`-`。建議由使用者確認並另存一個來源 UUID，不以相同預設任務內容當來源身分，也不在每次預覽重新產生。工具不自行寫入 namespace 到 localStorage。

Preview 直接重用 fromFrontend、splitFrontendWorkspace、assertItemSize。檢查：

- Workspace/Board/Task/Widget/Subtask 數量、來源順序及父子對照。
- 看板 ID 與同父層 Task/Widget/Subtask ID 重複，並檢查候選目標 ID 碰撞。
- 明確 boardId/workspaceId 是否與巢狀位置衝突、activeBoardId 是否存在。
- WIP、模型格式、大小、數字精度、非 done 任務仍帶完成時間等問題。
- 未指定 widgets 與空 widgets 的差異、計時器失效軟參照、額外 position 與陣列順序不一致等警告。
- 模型允許但現有 API 無法接收的完成時間或額外欄位。

同一前端 Task ID 在不同 Board 可以存在，其 source identity 包含父 Board，候選 ID 不同。Subtasks 保留在 Task.data，另外提供來源到目標 Task 的 inline 對照，不建立獨立 Subtask Item。

legacy 需明確提供 `{legacyBoard:{id,name,description,wipLimit}}`；沒有設定時回報 LEGACY_BOARD_METADATA_REQUIRED，不猜名稱、限制或正式歸屬。小組件 fractional height 可能被現有模型拒絕；不自動取整。原始 JSON 仍保留於 Backup。

候選 ID 使用 SHA-256(namespace + entityType + scoped frontend identity) 產生 UUIDv8 格式，再加 `SLOWLY#TYPE#`。它們只是規劃 ID，沒有建立 Item。相同來源重跑、內容編輯及陣列重排都保留候選 ID；不同 namespace 產生不同 ID。

sourceRevision 對選定 raw 與 legacy 設定計算，planId 再綁定所有 payload fingerprint。新的備份建立時間不影響計畫，但來源內容改變會產生不同計畫，不能沿用舊 checkpoint。hash 是完整性比對，不是簽章或授權憑證。完整來源仍須保留原 Backup；Plan 不能取代 Backup。

modelValid 只代表來源模型與關聯可準備計畫。所有 Preview/Plan/Progress 的 executable 皆為 false，API blockers 不會被當作已修復。

## 恢復與驗證基礎

提供下列純函式，不接 transport、不寫檔、不保存 checkpoint、不呼叫 API：

- createMigrationCheckpoint(plan)：建立 pending 清單。
- recordMigrationOutcome(plan,checkpoint,key,outcome)：記錄 in-flight、unknown、failed。
- reconcileMigration(plan,checkpoint,observations)：比對未來權威服務提供的目標資料與 operation receipt。
- migrationProgress(plan,checkpoint)：進度、各狀態與錯誤摘要。
- verifyMigration(plan,checkpoint,observations)：逐筆 payload、版本、父子關聯與數量核對。

checkpoint 可以由呼叫者明確匯出 JSON 並重新讀入；恢復函式會檢查 planId、ID 對照、payload fingerprint、重複項目、來源及數量。當前工具不自行持久化到 localStorage。

網路中斷是 unknown，不能直接轉 in-flight 重送。未收到 observation 也不等於不存在。只有未來權威服務的明確 absent 可以回 pending；有相符 planId、operationId、targetId、完整 payload、位置及版本的 receipt 才能 confirmed。已確認資料消失、版本不同、外來資料占用候選 ID 都進 conflict，沒有自動覆寫或刪除。

verifyMigration 會輸出 expectedCounts、observedCounts、countsMatch、relationsValid。它只能核對提供的完整 receipt 集合，不能偵測資料庫中未列出的額外 Item；未來仍需權威 session manifest 的完整性驗證。

## 為何現在不能執行正式 Migration

1. 現有 POST 每次產生隨機 ID，沒有 idempotency key 或原子 receipt；網路回應遺失後再送可能產生重複資料。整合測試已用記憶體實際驗證此缺口。
2. API 不接受規劃的資料庫 ID、completedAt、任意額外欄位，不能無損使用現有 CRUD 匯入。
3. 沒有 session、operation lookup 或完整匯入驗證 API；GSI 最終一致，不能用一次空查詢判定沒寫入。
4. Workspace/Board 會因子項目交易正常增加版本；未來 session 必須區分自己造成的父版本增加與外部修改。當前 checkpoint 採保守衝突處理，mock 不代表已解決此協調問題。

本階段沒有 production executor。測試中的 MockMigrationService 假設未來已具備原子 create-if-absent + receipt，僅用來驗證規劃、部分失敗、恢復與不覆寫規則，不代表目前 API 已具備這些保證。

## Phase 4B 建議設計（尚未實作，需確認）

- 新增獨立本機 migration session/operation 介面，保持原有 CRUD Contract 不變。接收經確認的 Backup、namespace 與 sourceRevision，伺服器重新驗證／計算目標 ID，不信任客戶端自行指定 Key。
- 為 session 與 operation 增加記錄 Item、來源標記及 receipt。可評估重用現有 GSI 查 session；新 entityType／欄位設計須先核准，不重建表。
- 每次操作以交易原子建立 Item、receipt 及必要的父計數，使用 attribute_not_exists 和版本條件。只重用來源／payload／receipt 全部吻合的既有資料；任何不符都停止，不覆蓋。
- 匯入端明確保留 completedAt/null、未知合法欄位、前端 ID 與排序；使用既有 preserveCompletionTime 能力但不對一般 API 開放此寫入權限。
- 使用強一致 key/receipt 查詢處理模糊結果；由 session 維護父項目的合法版本演進、完整數量／關聯與外部修改衝突。
- 明確保存 Backup、Plan、checkpoint；完成驗證前保留原 localStorage。切換與回滾另行實作，不自動刪除來源，也不將舊快照蓋回遠端。

進入 4B 前需要確認：來源 namespace 如何保存、legacy 看板設定、缺少 widgets 的還原方式、來源異常的處理、是否同意新增 migration API/receipt Item、何時允許寫入及切換 UI，以及回滾／離線策略。

## 測試與安全確認

```powershell
npm.cmd run test:phase4a
node --test tests/client-adapter.test.mjs tests/workspace-backup.test.mjs
npm.cmd run test:server
npm.cmd run test:api
npm.cmd run lint
npm.cmd run build
```

Phase 4A 25 tests 全數通過，包含 Adapter → 真實 Handler → 真實 Repository → 記憶體 Client 的整合測試；原生 client tests 15 個通過（為前述子集，另以不啟用 react-server 的環境驗證），Phase 2 的 6 tests、Phase 3 的 7 tests 通過。沒有執行 test:db 或 test:api:http。

`npm.cmd run build` 通過；本次新增程式沒有 lint 問題。完整 `npm.cmd run lint` 仍因既有 page.js 的 3 errors（effect 內 setState、首頁 a 連結）與 task-analytics.js 的 1 warning 未通過；這些 UI 檔案依範圍限制沒有修改。Build 另有既有上層 package-lock.json 不在 Git root 的提示，未調整專案根目錄。

測試涵蓋：22 個方法路徑、編碼、204、400/403/404/409/500/501、JSON/網路/Abort/版本錯誤、兩個 Storage Key、未知欄位、只讀保存、重複 ID、跨父層關聯、排序、WIP、穩定 mapping、來源變更、部分寫入、回應遺失、receipt 重播、版本衝突與既有資料保護。測試中原有記憶體 fixture 資料未修改。

安全確認：未修改 React UI 資料來源；未修改／刪除 localStorage；未讀取真實瀏覽器資料；未寫入真實 DynamoDB；未更動既有 API Contract；未執行 commit/push/merge。正常 build 會由 Next 載入既有環境設定，工具沒有檢視或列印憑證。
