# Phase 4D-2B：Cutover 安全準備

本階段只修改程式與執行 Mock／React 測試。沒有讀取真實 localStorage、原始備份或正式 SlowlyTasks；沒有啟用 API Mode、Migration、Release、Rollback、Cutover，亦未變更環境設定。

## 正式 Workspace View：預設關閉、先讀後授權

原本 GET `/api/workspaces/[id]/view` 的隔離流程保留。新增正式的 server-only 精確綁定；Request／Response 的既有 data envelope 不變，沒有客戶端 TableName 參數。

未來另行授權後，由本機開發程序設定：`SLOWLY_LOCAL_API=1`、`SLOWLY_FORMAL_VIEW_ENABLED=1`、`SLOWLY_FORMAL_VIEW_WORKSPACE=<確定的 DB Workspace ID>`、`SLOWLY_FORMAL_VIEW_PLAN=<確定的 Plan ID>`。只接受 Development、Loopback、精確 Host／Origin、`http://127.0.0.1:9000`，禁止與 controlled/test binding 混用。這一輪沒有設定這些值。

未授權或非指定 Workspace 時，在取得 Repository 前回 403。指定 Workspace 必須屬於綁定的 Migration，且完整 RELEASED，否則回 409。完整 DTO、Widget presence、GSI/base-table 一致性、版本 fences 與父子關係，重用 readWorkspaceView。

正式 View 可作為唯讀 staging probe，不等於正式 Cutover。正式回應有 `formalCutoverRequired`；未注入可信任的 `cutoverReadiness` provider 時，寫入能力保持關閉。Provider 必須回傳綁定相同 Workspace／Plan／Session Version、未過期且通過全部檢查的 Gate 報告。Client 授權及每次送出前均檢查此能力與期限。Route 預設沒有正式 Cutover provider，仍唯讀；下一輪需在明確授權後接入實際的可信任 evidence/provider，不能把測試的 `isolation: () => true` 帶入正式 Route。

這是本機單一使用者的範圍限制，不是登入系統或公開部署授權機制。既有 CRUD API 不新增偽造的授權 token；不可把此 UI 限制當成完整後端多使用者存取控制。

## 草稿與切換

Task Panel、Board 設定／空 Workspace 新 Board 表單及 Widget notes／失敗配置，均登記為獨立草稿，不混入已確認 DTO 或 localStorage。切換來源、Workspace 或 Board 前，controller 會阻擋 Pending、UNKNOWN 及未儲存草稿。編輯器取消需明確確認；可檢視草稿後明確捨棄，沒有自動丟棄或儲存到另一個 Workspace 的流程。

寫入失敗不清除輸入；409 保留草稿及原版本，重新採用最新資料仍需明確確認。Widget 配置失敗會保留 before/after 及版本供人工檢視；不自動重送。beforeunload 提示只能協助避免誤離開，未提交草稿仍是頁面記憶體，並未宣稱瀏覽器強制終止後仍有完整草稿備份。

## IndexedDB 操作紀錄與 Reload

新的恢復紀錄使用獨立 IndexedDB，完全不使用或改寫 slowly-workspace-v2／slowly-board-v1。正式與隔離入口使用不同 DB namespace，避免測試操作紀錄帶入正式首頁。SSR 不開啟 IndexedDB；client mount 後只檢查操作紀錄，維持 localStorage mode。檢查未完成或有未確認操作時，本機編輯暫停，使用者必須明確選擇原 Workspace 進行恢復；不自動啟用 API。

每次 API mutation 先在 readwrite transaction claim 唯一 active slot，transaction 完成後才送出請求。Create 紀錄包含固定 Key、原始 Payload、資源及 Workspace／Board scope；不得覆寫另一個 active operation。IndexedDB 無法使用、格式不合法、claim 失敗或其他 Workspace 有未確認操作時，一律停止寫入，不能退回記憶體冒充持久化。

Reload 後的 API activation 必須先載入原紀錄，再通過 API Ready／Readiness。Create 只查既有 Receipt：

- CONFIRMED：讀取當前伺服器快照，成功後清除原紀錄，不套用可能過期的 create result，也不自動重新授權寫入。
- NOT_FOUND／網路錯誤：仍是 UNKNOWN。只能明確使用原 Key／原 Payload 重送，不能產生新 Key。
- 409 scope/payload conflict：保留輸入及紀錄供人工處理，不強制覆寫。
- 既有 Receipt Contract 沒有持久化 FAILED 狀態；不偽造這個狀態。確定被拒絕的 400／WIP 等失敗，可保留表單並讓使用者明確修正後重試；不能把 Receipt NOT_FOUND 當成 FAILED。

非 Create 的不明結果也會跨 Reload 阻擋新寫入，但既有 API 沒有更新／刪除／排序 Receipt，因此不自動重送；須重新讀取並人工核對後，以正確 Workspace 明確確認。版本條件仍保留。

多個 API tab 的 active slot claim 受到 IndexedDB transaction 保護。此紀錄不是抵抗同源 XSS／開發者工具竄改的授權機制；私有模式、清除網站資料或使用者移除 IndexedDB 仍會破壞恢復能力，不能在未核對狀態前清除。

## Legacy 與 localStorage

本機初始化只採用 Primary。Primary 缺失而 Legacy 存在時，顯示阻擋、不解析匯入、不自動建立 v2、不修改 v1。初始化成功也不因正規化而自動重寫 v2；保留 root 未知欄位。正常本機模式仍只在使用者明確編輯後執行原有持久化；本輪沒有對真實瀏覽器執行這些流程。

## 正式 Readiness Gate

checkCutoverReadiness 保留既有 technical prerequisites 的意義，新增全部必須成立的正式檢查：完整 Verified Backup／Plan、相同 Fingerprint／Plan／Mapping／排除政策／Workspace hash 的已清理 Dry Run 證據、正式 View、來源凍結、草稿／Pending／UNKNOWN／Reload／Legacy 保護及完整 Verify／Release。

最後必須有同一 Workspace／Plan／備份的明確、未過期 Cutover authorization；缺少任一證據，ready/cutoverEnabled 都為 false。成功報告最多有效 30 秒，並包含 Session Version；這是可信任 runner 的純讀取 preflight，不是持久化 Cutover certificate 或原子資料凍結。Probes/provider 只能由可信任 server/runner 提供，不能接受瀏覽器自行宣稱 testsPassed。

實際正式 Session 尚不存在，也未設定正式 binding 或接入實際 evidence provider，故本輪不宣稱正式 Cutover READY。正式資料遷移、實際 provider 配置、正式瀏覽器驗收與寫入授權仍需下一階段明確批准。

## 測試

`npm.cmd run test:cutover-safety`：IndexedDB adapter double、跨 controller Reload、原 Key／Payload、最新版本、失敗與衝突、草稿／Pending、正式 View guard、Legacy 與 Gate 證據綁定。

`npm.cmd run test:cutover-safety:react`：實際共用 WorkspaceBoard 的 Legacy 阻擋、掛載不寫 storage、Task Panel 草稿阻擋 Board 切換。使用合成 storage 與 React minimal host；不宣稱真實瀏覽器／IndexedDB engine 的端對端驗收。

## 檔案清單

新增：

- `src/lib/api/formal-workspace.mjs`：正式 Workspace／Plan 的 server-only 綁定。
- `src/lib/client/recovery-journal.mjs`：IndexedDB 原子操作紀錄與可注入的 Memory test double。
- `src/lib/client/local-primary.mjs`：唯讀 Primary 選擇，不自動還原 Legacy。
- `tests/cutover-safety.test.mjs`：17 項核心／API／Gate／恢復測試。
- `tests/cutover-safety-react.test.mjs`：2 項實際 React 元件測試。
- `tests/helpers/indexed-db-double.mjs`：IndexedDB adapter mock。
- `docs/phase4d2b-cutover-safety.md`：本文件。

修改：

- `src/app/api/workspaces/[id]/view/route.js`、`src/lib/api/workspace-view.mjs`：正式唯讀 View 與 Cutover capability 分離。
- `src/lib/client/main-workspace-controller.mjs`、`src/lib/client/safe-create.mjs`：先保存再送出、恢復、切換屏障與原始 Intent。
- `src/lib/client/main-ui-session.mjs`：草稿 scope 與失敗 Widget 配置保留。
- `src/app/main-ui.js`：明確恢復控制、beforeunload、草稿檢視與新 namespace。
- `src/app/workspace-board.js`：表單草稿、Legacy 防護、初始化不改寫 storage。
- `src/app/widget-dashboard.js`、`src/app/widgets.js`：恢復檢查未完成時停用編輯。
- `src/lib/migration/cutover-readiness.mjs`：實際證據與限時人工授權的正式 Gate。
- `tests/helpers/main-ui-fixture.mjs`、`tests/main-ui.test.mjs`、`tests/main-ui-react.test.mjs`、`tests/safe-create.test.mjs`：注入獨立 journal，更新更嚴格的切換規則。
- `package.json`：新增兩個測試指令。

本輪去重後共 207 項 Node／React／Mock 測試通過，0 失敗；Build 通過。ESLint 仍有既有 workspace-board 的兩個同步 effect setState 與 anchor 規則（3 errors），及 task-analytics dependency（1 warning），未宣稱全專案 Lint 通過。沒有執行真實 DynamoDB 或瀏覽器測試，也沒有存取私人備份。
