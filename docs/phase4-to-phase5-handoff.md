# slowly. Phase 4 至 Phase 5 交接

Phase 4 正式唯讀 Cutover 與 Chrome 人工驗收已完成。首頁重新整理仍預設 localStorage。本次正式唯讀授權已到期，歷史驗收紀錄保留。Phase 5 從已驗證的 DynamoDB Local 資料與唯讀安全邊界接手，開發須等使用者授權。

## 從哪裡接手

| 領域 | 程式與契約 |
| --- | --- |
| 首頁與來源 | `src/app/main-ui.js`、`src/app/workspace-board.js`、`src/hooks/use-main-workspace.mjs`、`src/lib/client/main-workspace-controller.mjs` |
| 伺服器狀態 | `src/lib/api/workspace-view.mjs`、`src/lib/api/handlers.mjs`、`src/lib/slowly-repository.mjs` |
| Migration 與 Release | `src/lib/migration/service.mjs`、`plan-v2.mjs`、`store.mjs`，持久化控制紀錄與 Receipt |
| 證據與授權 | `src/lib/api/formal-workspace.mjs`、`formal-evidence.mjs`、`src/lib/migration/trusted-evidence.mjs`、`cutover-readiness.mjs`、`cutover-authorization.mjs`，以及私有操作者 CLI |
| 回復 | `src/lib/client/recovery-journal.mjs`、`safe-create.mjs`、`slowly-api.mjs` |

正式資料、Evidence 效期、驗證結果與 Gate A／B／C 邊界見 [Phase 4 最終報告](phase4-final-report.md)。申請、核准、兌換與切換各有授權；即時瀏覽器複檢與來源凍結不能沿用隔離結果代替。

## Phase 5 開發計畫

| 順序 | 開發項目 | 驗收條件 |
| --- | --- | --- |
| 1 | 正式寫入授權 | 定義伺服器端 Workspace 與操作範圍授權、期限、撤銷與稽核。逐筆拒絕未授權、越權及失效請求。Phase 4 Release 快照保留作為遷移基線，合法業務新版本由 runtime 寫入權限及稽核紀錄驗證 |
| 2 | Workspace／Board／Task／Widget CRUD | 盤點既有 API 與 Repository，補齊正式入口所需的明確操作。隔離驗證新增、編輯、刪除及排序，保留 WIP、歸屬、Safe Create、原子交易、Receipt 與 Workspace Barrier |
| 3 | 版本控制與同步 | 以 entity 和 parent version 做條件更新。驗證兩分頁競爭時舊版本回傳 409 並保留草稿。寫入確認後重讀最新 View，舊回應、切換看板及亂序請求均不能覆蓋新版本 |
| 4 | 失敗復原 | UI 區分拒絕、確認與 UNKNOWN。保存原意圖、scope、Idempotency-Key 與 Journal。逾時、斷線、Reload 或回應遺失先查 Receipt，驗證無重複 Create，也不覆蓋 localStorage |
| 5 | 持久化驗收 | 先以隔離表和獨立 Chrome profile 實測 Reload、伺服器重新啟動、跨分頁版本競爭、來源與 Workspace 恢復。若要讓 API Mode 在 Reload 後延續，先確立範圍驗證和未決操作的處置契約。正式 CRUD 須另行授權，使用明確測試資料及逐步核對的清理方案 |

補強測試覆蓋 API、React、DynamoDB Local、Chrome E2E、Build 與 ESLint。優先補齊 SSR、離頁保護與草稿回復覆蓋，再處理既有 3 項 WorkspaceBoard lint 問題。量測正式 View 強一致讀取與寫後重讀成本，優化前先固定保護條件。部署前再規劃可驗證身分、最小角色權限、金鑰輪替與審計。Phase 5 首個開發交付是隔離環境中可驗證的正式寫入授權與 CRUD 契約。

## Recovery 交接

遇到資料差異或 409，先暫停新寫入，保留最新 View、草稿、Journal、Receipt 及錯誤時間。UNKNOWN 使用原 Workspace／Operation Key 查 Receipt，CONFIRMED 後重讀最新資料。Pending 或 UNKNOWN 未清楚前不可切換或自動重送。切回 localStorage 只是變更顯示來源，兩邊資料與原始備份都保留。已提交 DynamoDB 資料的修復或復原須另行審核及授權。
