# slowly. Phase 4 至 Phase 5 交接

本文件提供交接基線。正式 Cutover、正式執行驗收與正式寫入技術阻擋未結案。正式首頁目前預設 localStorage。唯讀正式 View 是已遷移資料的診斷與切換驗證入口。

## 從哪裡接手

| 領域 | 程式與契約 |
| --- | --- |
| 首頁與來源 | `src/app/main-ui.js`、`src/app/workspace-board.js`、`src/hooks/use-main-workspace.mjs`、`src/lib/client/main-workspace-controller.mjs` |
| 伺服器狀態 | `src/lib/api/workspace-view.mjs`、`src/lib/api/handlers.mjs`、`src/lib/slowly-repository.mjs` |
| Migration 與 Release | `src/lib/migration/service.mjs`、`plan-v2.mjs`、`store.mjs`，持久化控制紀錄與 Receipt |
| 證據與授權 | `src/lib/api/formal-workspace.mjs`、`formal-evidence.mjs`、`src/lib/migration/trusted-evidence.mjs`、`cutover-readiness.mjs`、`cutover-authorization.mjs`，以及私有操作者 CLI |
| 回復 | `src/lib/client/recovery-journal.mjs`、`safe-create.mjs`、`slowly-api.mjs` |

正式資料、Evidence 效期、驗證結果與 Gate A／B／C 邊界見 [Phase 4 最終報告](phase4-final-report.md)。申請、核准、兌換與切換各有授權；即時瀏覽器複檢與來源凍結不能沿用隔離結果代替。

## Phase 5 優先項目

1. **API Mode 穩定性與效能。** 先補正式 mutation 的伺服器授權、版本演進、撤銷及稽核，再量測 Workspace View 的強一致讀取與刷新成本。保留交易條件、父版本、Receipt 與 Workspace Barrier。
2. **同步與錯誤恢復。** 明確區分已拒絕、已確認與結果不明。保留 Idempotency-Key、原始意圖及條件更新，加入版本衝突比對及可觀察的 Pending 狀態。
3. **UI／UX。** 清楚呈現唯讀、寫入授權、409 及已失效狀態。調整本機 hydration 前先鎖定 SSR、離頁保護與草稿回復行為，再處理剩餘 ESLint。
4. **E2E。** Chrome fresh profile 與獨立表驗證來源、隔離、Reload、Recovery、401／403／409 和資料版本。不將隔離結果替代正式 Chrome 人工驗收。
5. **部署身分與權限。** 現有 loopback、Host／Origin 與本機配置用於本機流程。部署前增加可驗證身分、Workspace 授權、最小角色權限、金鑰輪替及審計，覆蓋所有寫入入口。

## Recovery 交接

遇到資料差異或 409，先暫停新寫入，保留最新 View、草稿、Journal、Receipt 及錯誤時間。UNKNOWN 使用原 Workspace／Operation Key 查 Receipt，CONFIRMED 後重讀最新資料。Pending 或 UNKNOWN 未清楚前不可切換或自動重送。切回 localStorage 只是變更顯示來源，兩邊資料與原始備份都保留。已提交 DynamoDB 資料的修復或復原須另行審核及授權。
