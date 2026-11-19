# Phase 4D-4D 正式 Cutover 授權前最終稽核

2026-11-19，Asia/Taipei。**PRE_CUTOVER_AUDIT: BLOCKED**。正式資料、備份與準備證據驗證通過。正式寫入的伺服器授權及寫入後的證據生命週期仍待補齊。正式首頁維持 localStorage。Phase 4D-4E 已校正本報告的 HTTP 驗收預期，詳見 [Contract 與 Recovery 報告](phase4d4e-cutover-contract-recovery.md)。

## 正式資料庫與 Workspace View

本次在暫時程序環境直接呼叫既有正式伺服器 GET handler，以 DynamoDB Local 的 `SlowlyTasks` 做唯讀驗證。常駐伺服器及首頁設定維持原樣。

| 檢查 | 結果 |
| --- | --- |
| Session／Migration Lock | 版本 35，均為 `RELEASED`，Release protocol v2 |
| Manifest、Receipt、Ownership | 10 筆 Manifest 與 Plan 相符，10/10 Receipt `CONFIRMED`，10/10 釋放。Ownership、目標版本、內容與鎖狀態相符 |
| SlowlyTasks | 33 筆前後完全一致。10 筆業務資料、22 筆 Migration 控制紀錄，原有未知 Item 1 筆且完整雜湊與基準一致 |
| 業務數量 | 1 Workspace、2 Boards、6 Tasks、1 Widget，0 Subtasks |
| Data Fidelity | 差異 0。正式投影逐欄等於原始 Primary，含 ID Mapping、父子歸屬、排序、WIP、日期、completedAt 與 Widget 設定 |
| Workspace SHA-256 | `2d7918f8c204cbf57edd076cbeae8b59de5ea04512e3ef8f50b5ad3279fc0a19` |
| Release Verification Hash | `bfa13497147f9237108113a76bfbd106aab2e85faa92f70502e77555fc42fd4c` |
| 正確 Workspace／其他 Workspace | `200`／`403` |
| 錯誤 Plan／錯誤 Namespace | 均被拒絕，回傳 `409 MIGRATION_NOT_READY`，符合既有持久化綁定衝突契約 |
| 隔離設定混入 | `403`，本輪正式驗證未存取隔離表 |

## Backup、Evidence 與 Gate

原始 verified JSON 備份仍存在，格式與 Payload SHA-256 重驗通過，檔案內容前後一致。Primary 為 `slowly-workspace-v2`，Legacy `slowly-board-v1` 的 2 筆 Tasks 按既有政策排除。

| 綁定項目 | 值 |
| --- | --- |
| Workspace ID | `SLOWLY#WORKSPACE#cd5aa79a-3fb4-8b5c-b610-aadd79b8f49c` |
| Migration ID／Plan ID | `51684a8d9688456849e25c5e59a2119febecbb37fa4635e671dda8792cfdf197` |
| Source Namespace | `dryrun-6edab0e2-c674-4044-91a1-dbb276e8f418` |
| Backup Payload SHA-256 | `4c9b8fc3a2a1eafcd64f657eb7927298863dc485b08179323e9cef030f12cbc7` |

台北時間 02:14:07 的首次稽核通過後，原 v2 `release-preparation` Bundle 於 02:41:01 到期。已使用 [既有唯讀準備工具](phase4d4a-release-evidence.md) 重簽。14:41:18 最終複驗確認新 Bundle 的 HMAC-SHA256、期限、用途與全部綁定均通過，正式 Session、Manifest、Receipt、Verify、Release、Ownership、資料版本與完整 View 相符。新 Bundle 到期時間為台北時間 **2026-11-19 15:41:17**。若下一階段已逾期，須重新簽署及複驗。金鑰維持在私人目錄。

| Gate／安全項目 | 結果 |
| --- | --- |
| `evidenceVerified` | `true` |
| `ready`／`cutoverEnabled` | `false`／`false` |
| reason | `CUTOVER_APPROVAL_REQUIRED`（Provider 的 `blockers`） |
| Workspace Binding | 指定 Workspace／Plan／Namespace 通過，跨 Workspace 與持久化綁定衝突依契約拒絕 |
| Pending Operation／Draft Safety | `USER_CONFIRMED`。隔離測試另外覆蓋保護機制 |
| Recovery Readiness | 隔離測試通過，正式瀏覽器 Journal 無 active 為 `USER_CONFIRMED` |

準備 Bundle 分支只驗證 Release 後證據。其 blocker 不代表完整 Cutover Bundle 的所有檢查已執行。仍缺明確授權、切換時來源凍結及完整的 v2 `cutover` 簽章證據。現有產生工具只產出準備用途，完整授權證據須經受控簽署及驗證流程。

## Chrome 人工紀錄與切換前複檢

以下均為使用者在原 Chrome 設定檔及原 slowly. 頁籤的 **USER_CONFIRMED** 紀錄。稽核程序未讀取真實 Chrome 或 localStorage。

1. 原首頁資料完整。
2. 無未儲存草稿及寫入中的操作。
3. IndexedDB 的 `slowly-api-recovery-v1-formal` → `operations` 無 active、Pending 或 UNKNOWN。
4. 原始 JSON 備份存在，SHA-256 驗證一致。

正式操作前重新確認原 Chrome profile、原 origin 與 localStorage 模式，先保留既有頁籤。查看所有同站頁籤及 Task、Board、Widget 表單，透過「檢視未儲存草稿」與 DevTools 唯讀檢查上述 Journal。需要清空頁面或 Journal 才能繼續時，應停止並保留現況。將切換前來源、origin、Workspace ID、Plan ID、備份指紋與檢查時間記入私人操作紀錄，並由使用者再次確認來源仍與備份一致及凍結編輯。

## Cutover Runbook

以下步驟供後續取得授權時使用。本輪停在唯讀稽核。

1. **備份與授權。** 重驗原始備份格式、Payload SHA-256 與同一 Plan。來源若已變，保留原始備份並停止，另行驗證新匯出的私人副本。取得對固定 origin、Workspace、Migration／Plan 與備份指紋的明確、限時 Cutover 授權，記錄唯讀切換範圍。若要驗證正式寫入，另列允許的實體、操作、合成測試資料及清理範圍，另外授權。
2. **伺服器預檢。** 使用受控 loopback 開發伺服器及六項私人綁定設定。以已審核的瀏覽器、測試、同 Plan 隔離 Dry Run、凍結與授權資料建立完整簽章證據。從伺服器 Provider 確認 `ready: true`、`cutoverEnabled: true`、綁定相符及有效期。再用 GET `/api/workspaces/{encodedWorkspaceId}/view` 核對 200、`formalCutoverEnabled: true` 與未逾期的 `formalCutoverExpiresAt`。Workspace View API 回傳的是 capability，完整 Gate 結果由伺服器端 Provider 取得。任一條件缺失即停。
3. **唯讀切換。** 在原 localhost 開發首頁展開「資料來源」，填入上述正式 Workspace ID、勾選「我已確認 API Ready」，由使用者按「啟用唯讀 API Mode」。確認顯示 API／唯讀且 Workspace 正確。以 View 與畫面核對 2 Boards、6 Tasks、1 Widget、內容、排序及版本。保留原始 localStorage、原始備份及 Journal。
4. **重整。** 目前首頁的控制器每次載入預設 localStorage，沒有持久化 API 模式或選取 Workspace。重整前先處理 Pending、UNKNOWN 與草稿。重整後確認顯示 localStorage、啟動恢復檢查符合預期，再以私人操作紀錄中的**同一個** Workspace ID 手動啟用唯讀 API。重新比對 GET 與畫面。任何不明來源或存在 Journal 記錄即停。
5. **新增、修改、刪除、排序。** 現階段僅在隔離表演練完整流程。正式驗證前須先解決下述伺服器授權和寫入後證據阻擋。取得另行授權後，才可在 UI 輸入相同 Workspace ID 並按「另外授權寫入」。只使用經核准的合成項目，新增後查 Receipt，修改前讀最新版本，排序使用當前完整清單及版本且不得擾動原有順序，只刪除本次明確核對歸屬的合成項目。每步後重讀 GET，重整後手動選回同一 Workspace，再核對持久化內容、排序與版本。遇到證據失效、非預期版本或資料差異即停止，保留已提交結果，交由操作者審查。Workspace 刪除目前無 API。

## Recovery 與 Rollback 邊界

- **409／資料差異。** 保留草稿與診斷資訊，記下 Workspace ID、操作範圍、版本、Receipt 與錯誤時間，停止新增寫入。409 顯示衝突，草稿保留，與伺服器最新 View 比對後再決定處理方式。控制器會忽略已取消或過時的讀取，讀取錯誤停用寫入。
- **斷線／UNKNOWN。** 有 Pending 時等待。取消等待無法撤銷伺服器提交。保留 Journal 及原本 Key／payload／scope。新增先查 Receipt，CONFIRMED 後重讀最新 View。NOT_FOUND 仍屬不明，維持封鎖。手動重送須具備當下有效寫入授權並使用原 Key 與原 payload。更新、刪除或排序的 UNKNOWN 要先以伺服器狀態人工核對。Legacy v1 不會自動重新匯入。
- **切回 localStorage 顯示。** Pending、UNKNOWN、草稿均已安全處理後，使用「切回 localStorage Mode」。若 API 已有新寫入，先分別備份與比對兩個來源。切換只選擇本機快照作為顯示來源，API 寫入留在 DynamoDB。
- **DynamoDB 資料回復。** 既有 Migration Rollback 只用於受鎖定的適用階段。此 Session 已 Release，正式資料修復或還原需另行審核與授權。本 Runbook 不提供自動覆寫正式資料的路徑。

## 剩餘阻擋與授權

1. **HTTP 契約。** Phase 4D-4E 確認錯誤 Plan 或 Namespace 回 409 符合既有契約，原先要求 403 的稽核預期已校正。
2. **正式寫入授權。** 現有 Gate 影響正式 Workspace View capability 與首頁 controller。一般 mutation route 具本機 Origin、版本、ownership 等檢查，尚未看到它們逐筆重驗同一份正式 Cutover authority。這是程式碼檢查結果，本輪未向正式表送出寫入探針。正式寫入驗收前須驗證伺服器端攔截與 scope。
3. **寫入後 Evidence。** 現有 Provider 將 Evidence 固定於 Release 後的目標版本、Receipt 與完整 View。正常寫入造成版本／內容變動會使該快照證據失配。正式寫入與後續刷新前須確認安全的授權生命週期，才能驗收多步 CRUD 與排序。
4. **人工授權。** 已確認原 Chrome 四項與先前 Migration、Release。仍待切換當下複檢、來源凍結、對指定 Workspace／Plan 的正式 Cutover 授權，以及完整簽章 Evidence。正式寫入測試與必要清理範圍須另行授權。

現階段不符合進入正式 Cutover 執行階段的條件。本輪只有稽核文件變更。正式資料、真實 localStorage、Recovery Journal 與原始備份保持原狀。沒有執行正式 Mode 切換、Migration、Release、Rollback、Cutover 或 Git 提交。

## 自動化測試與清理

| 範圍 | 結果 |
| --- | --- |
| Node、React、API、Migration／Release、Recovery、Cutover Safety、Trusted Evidence | 225 通過、0 失敗、0 跳過，含 6 項 DynamoDB Local 隔離 Dry Run |
| 額外 DynamoDB Local 隔離驗證 | Trusted Evidence 7、Release 13、Main UI／Safe Create 19，均通過並清理本輪表 |
| Build | 通過，提示外層 Git 工作樹之外的 lockfile 被忽略 |
| ESLint／Git whitespace | 本輪只新增 Markdown，無修改程式檔需 lint。相關既有程式針對性 ESLint、`git diff --check` 及新增文件行尾檢查通過 |
| 真實 Chrome | 本輪正式狀態採 `USER_CONFIRMED`。前階段隔離 Chrome 8/8 PASS 為既有驗收紀錄 |

```text
PRE_CUTOVER_AUDIT: BLOCKED
EVIDENCE_VALID: true
BROWSER_USER_CONFIRMED: true
CUTOVER_AUTHORIZED: false
CUTOVER_EXECUTED: false
```
