# Phase 2 伺服器資料層

目前 UI 與 localStorage 未接入這個資料層。此階段沒有自動匯入、建立預設看板或認證系統。所有新模組均使用 `server-only`；獨立 Node 測試使用 `--conditions=react-server`。

## Item 與 ID

沿用 `SlowlyTasks`，Partition Key 為字串 `id`。新實體使用 `SLOWLY#類型#UUID`，建立時以 `attribute_not_exists(id)` 防止覆蓋。原有測試資料不搬移、不補欄位。

每筆新 Item 包含 `entityType`、`schemaVersion: 1`、`version`、`createdAt`、`updatedAt`、`position` 和 `data`。資料庫 ID 與 `data.id` 分離；後者保留前端原始 ID。任何查改操作需要資料庫 ID，不能把 `default` 或前端 UUID 當成資料庫 ID。

```js
// WORKSPACE
{
  id: 'SLOWLY#WORKSPACE#<uuid>', entityType: 'WORKSPACE',
  schemaVersion: 1, version: 1, position: 0,
  createdAt: '<ISO>', updatedAt: '<ISO>',
  data: { activeBoardId: 'default', settings: {} }
}

// BOARD
{
  id: 'SLOWLY#BOARD#<uuid>', entityType: 'BOARD',
  schemaVersion: 1, version: 1, position: 0,
  createdAt: '<ISO>', updatedAt: '<ISO>',
  workspaceId: 'SLOWLY#WORKSPACE#<uuid>',
  parentId: 'SLOWLY#WORKSPACE#<uuid>',
  gsi1pk: 'SLOWLY#WORKSPACE#<uuid>',
  gsi1sk: 'BOARD#000000000000#SLOWLY#BOARD#<uuid>',
  taskCount: 0, widgetCount: 0, doingCount: 0,
  data: { id: 'default', name: '我的看板', description: '', wipLimit: 4 }
}

// TASK（省略共通時間、版本與索引欄位）
{
  id: 'SLOWLY#TASK#<uuid>', entityType: 'TASK',
  boardId: 'SLOWLY#BOARD#<uuid>', workspaceId: 'SLOWLY#WORKSPACE#<uuid>',
  parentId: 'SLOWLY#BOARD#<uuid>', position: 0,
  data: {
    id: '1', title: '任務', description: '', status: 'todo',
    tag: '個人', priority: '一般', urgent: false,
    date: '2026-11-13', time: '10:30',
    subtasks: [{ id: 'sub-1', title: '步驟', done: false }],
    notes: '', completedAt: null
  }
}

// WIDGET（省略共通時間、版本與索引欄位）
{
  id: 'SLOWLY#WIDGET#<uuid>', entityType: 'WIDGET',
  boardId: 'SLOWLY#BOARD#<uuid>', workspaceId: 'SLOWLY#WORKSPACE#<uuid>',
  parentId: 'SLOWLY#BOARD#<uuid>', position: 0,
  data: { id: 'note-1', type: 'note', span: 6, height: 260,
    manualSize: true, config: { text: '筆記內容' } }
}
```

`position` 保存陣列順序，尺寸保留既有 `span`、`height`、`manualSize`。現有小組件沒有固定 x/y 座標，排版由前端 grid 決定；不新增座標語意。`config` 保留計時器、筆記等設定。額外 JSON 設定保留於 `data`。

## 轉換

`fromFrontend(type, value)` 將 Board 的 tasks/widgets、Workspace 的 boards 分開；Task 缺少的舊欄位使用現有預設值。明確不將英文 `high` 自動猜成中文優先級。`toFrontend(item)` 回傳原前端形狀，不混入資料庫 metadata。

`splitFrontendWorkspace(value)` 與 `joinFrontendWorkspace(snapshot)` 是純函式，保存看板、任務、小組件順序與設定，區分未設定 widgets 與空陣列。它們不讀 localStorage、不寫 DB。未來匯入仍需建立前端 ID 到資料庫 ID 的對照與遷移紀錄。

一般建立／更新任務時，完成狀態時間遵循現有 UI 行為：進入 done 記錄伺服器時間、持續 done 保留時間、離開 done 清空。未來明確匯入歷史任務時，可以呼叫 `createTask(boardId, data, position, { preserveCompletionTime: true })` 保留原完成時間或 null；此功能不會自行執行。

## GSI（等待核准，尚未執行建立）

名稱 `SlowlyByParent`，Partition Key `gsi1pk` (String)，Sort Key `gsi1sk` (String)，Projection `ALL`。

| 查詢 | gsi1pk | gsi1sk 前綴 |
| --- | --- | --- |
| Workspace 的看板 | Workspace 資料庫 ID | `BOARD#` |
| Board 的任務 | Board 資料庫 ID | `TASK#` |
| Board 的小組件 | Board 資料庫 ID | `WIDGET#` |

完整 sort key 為 `類型#12位補零position#資料庫ID`。集合查詢使用分頁 Query，不使用 Scan。

計畫只對現有表執行 UpdateTable，新增上述 GSI，不修改主鍵、不刪除或重建表、不更新既有 Item。沒有索引鍵的舊資料不會出現在這個稀疏索引。Projection ALL 會增加索引儲存及寫入負擔；建立期間 GSI 可能尚未 ACTIVE。

`npm.cmd run db:index:plan` 只 DescribeTable 並列出計畫。只有核准後才可附加 `-- --apply` 執行結構變更。若同名索引定義不相容，程式停止，不自動刪除或重建。

GSI 是最終一致讀取；成功寫入後，API 應使用回傳 Item 更新畫面，不能立即以舊查詢覆蓋。單筆 get 使用強一致讀取。

## 呼叫方式

```js
import { slowly } from '@/lib/slowly.mjs';
import { fromFrontend, toFrontend } from '@/lib/data-model.mjs';

// 僅示範。必須由呼叫者明確提供已知歸屬，不會建立預設 Workspace。
const item = await slowly.createTask(boardDatabaseId, fromFrontend('TASK', draft), 0);
const result = { task: toFrontend(item), databaseId: item.id, version: item.version };
```

提供 Workspace create/get/save；Board、Task、Widget CRUD；listBoards/listTasks/listWidgets；setTaskStatus；reorderBoards/reorderTasks/reorderWidgets。更新採完整實體資料替換，呼叫者須保留未編輯的欄位，並帶入預期 version。

每次子項目變更，交易會同時條件更新 Board 版本與計數。避免 WIP 並行超額，以及刪除看板與新增子項目的競態。Board 只允許刪除空看板，不執行隱含級聯刪除。Workspace 不提供刪除。

排序輸入為 `[{ id: databaseId, version, position }]`。每次最多 99 筆，加上父項目最多 100 筆交易；位置相同時以資料庫 ID 決定穩定順序。大型集合需要後續設計，不會分批造成部分成功。程式額外限制交易 JSON 低於 3.5 MB、Item JSON 低於 350 KB，保留大小餘裕。

`DataError.code` 包含 VALIDATION、NOT_FOUND、OWNERSHIP、WIP_LIMIT、NOT_EMPTY、CONFLICT、STORAGE。衝突後重新載入並由呼叫者決定重試，不自動覆蓋。讀取 SDK 失敗仍會拋出原始錯誤，未來 API 必須統一轉成安全訊息，不回傳 cause。

## 本機限制

Client 只允許 HTTP `127.0.0.1:9000` 或 `localhost:9000`，拒絕真實 AWS endpoint。`server-only` 阻止 Client Component 引入。沒有讀取或列印環境檔的腳本；執行時使用程序環境的既有設定，沒有 endpoint 時使用已確認的本機預設。獨立 Node 腳本不自動載入 `.env.local`；需確認執行程序的 Region／本機憑證與現有應用一致，避免連到不同的 DynamoDB Local namespace。

## 測試

- `npm.cmd run test:server`：記憶體 DocumentClient 替身，不連線 DB，驗證模型轉換、CRUD、查詢分頁、排序、並行 WIP、版本衝突、跨 Board 防護及舊資料保留。
- `npm.cmd run test:db`：預設拒絕寫入。
- 核准後才可執行 `npm.cmd run test:db -- --write-test-data`。先確認索引 ACTIVE，再建立 1 Workspace、2 Board、2 Task、2 Widget，全數有獨立 run ID。最後只針對本次記錄的 ID，以 run ID 與版本條件清理；不 Scan、不清空表。
- 若程序遭強制終止，finally 可能未執行。此時只能依本次 run ID 與 ID 清單檢查清理，不能刪除其他資料。

本階段實際驗證結果：隔離測試通過；完整 build 通過（第一次字型下載失敗，允許沙箱外重試後成功）。全專案 lint 有既有 UI 的 3 errors／1 warning；本次未修改相關 React 元件。真實資料庫整合與 GSI 建立等待核准。

## 下一階段

以 Node.js Route Handlers 或 Server Actions 包裝資料層，回傳前端 DTO、資料庫 ID、version；提供錯誤及儲存狀態後，再調整 React 資料接入。Client 不可直接取得 repository。需要另外設計匯入追蹤、離線策略、去重及多裝置偏好同步，本階段沒有自動匯入或同步。
